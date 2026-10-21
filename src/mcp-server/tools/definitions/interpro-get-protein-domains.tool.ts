/**
 * @fileoverview Bounded protein annotation maps retaining discontinuous match coordinates.
 * @module mcp-server/tools/definitions/interpro-get-protein-domains.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { continuation, decodeCursor, encodeCursor } from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  detailSchema,
  ExtraFeaturesSchema,
  type LocationSchema,
  listSchema,
  MatchSchema,
  optionalString,
  ProteinAccessionSchema,
  ProteinMetadataSchema,
} from '@/services/interpro/schemas.js';

const SelectionSchema = z.object({
  residuePosition: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Selected 1-based inclusive residue position.'),
  includeExtraFeatures: z.boolean().describe('Whether extra predicted features were requested.'),
});
const CoverageSchema = z.object({
  totalMatches: z.number().int().nonnegative().describe('Upstream unfiltered total match count.'),
  scannedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe('Records read in this invocation before residue filtering.'),
  returnedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe('Selected match records in this segment.'),
  complete: z
    .boolean()
    .describe('True only when this call starts at the beginning and reaches the end.'),
  hasMore: z.boolean().describe('Whether another match segment remains.'),
  nextCursor: z.string().optional().describe('Opaque cursor for the same protein and selection.'),
});
type Location = z.infer<typeof LocationSchema>;
function contains(locations: readonly Location[], position: number): boolean {
  return locations.some((location) =>
    location.fragments.some((fragment) => fragment.start <= position && position <= fragment.end),
  );
}
function earliest(match: z.infer<typeof MatchSchema>): number {
  return Math.min(
    ...match.proteins.flatMap((protein) =>
      protein.entry_protein_locations.flatMap((location) =>
        location.fragments.map((fragment) => fragment.start),
      ),
    ),
  );
}

/** Map signatures to sequence coordinates with explicit segment coverage. */
export const interproGetProteinDomains = tool('interpro_get_protein_domains', {
  title: 'Map protein domains',
  description:
    'Retrieve InterPro and member-signature matches on a canonical UniProt protein, preserving every location and discontinuous fragment. Optionally retain matches covering a residue and include extra predicted features.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_protein_domains:read'],
  input: z.object({
    accession: ProteinAccessionSchema,
    residuePosition: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Residue position, 1-based and inclusive; must not exceed protein length.'),
    includeExtraFeatures: z
      .boolean()
      .default(false)
      .describe('Include complete extra predicted features; defaults to false.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged accession, residuePosition, and includeExtraFeatures.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical UniProt accession.'),
    protein: ProteinMetadataSchema.describe('Complete upstream protein metadata.'),
    matches: z
      .array(MatchSchema.describe('Complete entry match record.'))
      .describe(
        'Complete selected match records, sorted within this segment by earliest coordinate then accession.',
      ),
    extraFeatures: ExtraFeaturesSchema.optional().describe(
      'Complete selected extra features; omitted when not requested.',
    ),
    selection: SelectionSchema.describe('Applied residue and extra-feature selection.'),
    coverage: CoverageSchema.describe(
      'Coverage of the underlying match traversal, independent of extra features.',
    ),
    url: z.string().describe('Canonical protein website URL.'),
    sourceUrl: z.string().describe('Official protein API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More records remain.'),
    shown: z.number().int().optional().describe('Selected records returned.'),
    cap: z.number().int().optional().describe('Maximum records scanned.'),
    effectiveQuery: z.string().optional().describe('Applied selection as JSON.'),
  },
  errors: [
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires across protein metadata, match pages, and extra features.',
      retryable: true,
      recovery:
        'Retry interpro_get_protein_domains after waiting; omit extra features when they are not needed.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor decoding or scope fails, or upstream rejects continuation.',
      retryable: false,
      recovery:
        'Repeat the same tool without cursor to restart pagination, keeping the intended filters.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_withdrawn',
      code: JsonRpcErrorCode.NotFound,
      when: 'InterPro reports a withdrawn record with HTTP 410.',
      retryable: false,
      recovery:
        'Call interpro_search_entries for a current replacement; consult interpro_list_reference with topic databases for source names.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream JSON, structure, or continuation is incompatible.',
      retryable: false,
      recovery:
        'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An upstream response exceeds 4 MiB.',
      retryable: false,
      recovery:
        'Retry list tools with a smaller limit, or retrieve individual members with interpro_get_entry instead of a large clan.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'InterPro returns an unhandled redirect or client rejection.',
      retryable: false,
      recovery:
        'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'InterPro has a network or server failure; HTTP 501 is not retryable.',
      retryable: true,
      recovery:
        'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'InterPro returns HTTP 408/504 or an attempt exceeds its deadline.',
      retryable: true,
      recovery:
        'Retry with a smaller limit where available, then repeat the same tool after waiting.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'InterPro returns HTTP 429.',
      retryable: true,
      recovery:
        'Wait for retryAfter when supplied, then repeat the same tool with fewer concurrent calls.',
      thrownBy: 'service',
    },
    {
      reason: 'protein_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Canonical protein detail returns HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Use a canonical UniProt accession returned by interpro_find_proteins_by_domain, then retry interpro_get_protein_domains.',
      thrownBy: 'service',
    },
    {
      reason: 'residue_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Requested position exceeds the fetched protein length.',
      retryable: false,
      recovery:
        'Retry interpro_get_protein_domains with residuePosition between one and the returned protein length.',
    },
  ],
  async handler(input, ctx) {
    const accession = input.accession.toUpperCase();
    const selection = {
      ...(input.residuePosition !== undefined ? { residuePosition: input.residuePosition } : {}),
      includeExtraFeatures: input.includeExtraFeatures,
    };
    const scope = { accession, ...selection };
    let cursor = decodeCursor(input.cursor, 'interpro_get_protein_domains', scope);
    const resumed = cursor !== undefined;
    const seen = new Set<string>(cursor ? [cursor] : []);
    const service = getInterproService();
    const call = service.begin(ctx);
    const detail = await service.request(
      call,
      ['protein', 'uniprot', accession],
      {},
      detailSchema(ProteinMetadataSchema),
      { missing: 'protein_not_found' },
    );
    if (!detail.data)
      throw ctx.fail('upstream_shape_invalid', 'Protein metadata response is missing.');
    const protein = normalizeImages(detail.data.metadata);
    if (input.residuePosition !== undefined && input.residuePosition > protein.length)
      throw ctx.fail('residue_out_of_range', 'Requested residue exceeds protein length.', {
        accession,
        proteinLength: protein.length,
        residuePosition: input.residuePosition,
      });
    const scanned: z.infer<typeof MatchSchema>[] = [];
    let totalMatches = 0;
    for (let page = 0; page < 3; page++) {
      const response = await service.request(
        call,
        ['entry', 'all', 'protein', 'uniprot', accession],
        { page_size: 200, cursor },
        listSchema(MatchSchema),
        { continuation: cursor !== undefined },
      );
      if (page === 0) totalMatches = response.data?.count ?? 0;
      scanned.push(...(response.data?.results ?? []));
      cursor = continuation(response.data?.next ?? null, seen);
      if (!cursor) break;
      seen.add(cursor);
    }
    const position = input.residuePosition;
    const matches = normalizeImages(
      scanned.filter(
        (match) =>
          position === undefined ||
          match.proteins.some((protein) => contains(protein.entry_protein_locations, position)),
      ),
    ).sort(
      (left, right) =>
        earliest(left) - earliest(right) ||
        left.metadata.accession.localeCompare(right.metadata.accession),
    );
    let extraFeatures: z.infer<typeof ExtraFeaturesSchema> | undefined;
    if (input.includeExtraFeatures) {
      const extras = await service.request(
        call,
        ['protein', 'uniprot', accession],
        { extra_features: '' },
        ExtraFeaturesSchema,
      );
      if (!extras.data)
        throw ctx.fail('upstream_shape_invalid', 'Extra feature response is missing.');
      extraFeatures = normalizeImages(
        Object.fromEntries(
          Object.entries(extras.data).filter(
            ([, feature]) => position === undefined || contains(feature.locations, position),
          ),
        ),
      );
    }
    const coverage = {
      totalMatches,
      scannedMatches: scanned.length,
      returnedMatches: matches.length,
      complete: !resumed && cursor === undefined,
      hasMore: cursor !== undefined,
      ...(cursor
        ? { nextCursor: encodeCursor('interpro_get_protein_domains', scope, cursor) }
        : {}),
    };
    ctx.enrich.total(totalMatches);
    ctx.enrich.echo(JSON.stringify(scope));
    if (cursor) {
      ctx.enrich.truncated({ shown: matches.length, cap: 600 });
      ctx.enrich.notice(
        'This call scanned part of the match map. Continue interpro_get_protein_domains with nextCursor and unchanged selection before concluding that a residue has no annotation.',
      );
    } else if (resumed) {
      ctx.enrich.notice(
        'This is the final resumed segment. Only the combined segments cover the traversal; upstream pagination is not a snapshot.' +
          (matches.length ? '' : ' No match was selected in this segment.'),
      );
    } else if (!matches.length) {
      ctx.enrich.notice(
        position === undefined
          ? 'The protein has no returned signature matches. Annotation is not a clinical interpretation.'
          : 'No match contains this position. Annotation is not a clinical interpretation.',
      );
    }
    return {
      accession,
      protein,
      matches,
      ...(extraFeatures !== undefined ? { extraFeatures } : {}),
      selection,
      coverage,
      url: `https://www.ebi.ac.uk/interpro/protein/UniProt/${accession}/`,
      sourceUrl: detail.sourceUrl,
    };
  },
  format: formatInterpro,
});
