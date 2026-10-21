/**
 * @fileoverview Protein annotation maps in budget-bounded segments of whole, discontinuous matches.
 * @module mcp-server/tools/definitions/interpro-get-protein-domains.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BUDGET_LABEL,
  fitWithinBudget,
  jsonByteLength,
  RESPONSE_BYTE_BUDGET,
} from '@/services/interpro/budget.js';
import {
  compareText,
  continuation,
  cursorScope,
  decodePositionCursor,
  encodePositionCursor,
} from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  detailSchema,
  ExtraFeaturesSchema,
  isAccession,
  type LocationSchema,
  listSchema,
  MatchSchema,
  optionalString,
  ProteinAccessionSchema,
  ProteinMetadataSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const OPERATION = 'interpro_get_protein_domains';
const PAGE_SIZE = 200;
const MAX_PAGES = 3;

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
  totalMatches: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Upstream unfiltered total match count; a segment holding only extra features repeats the count the match list reported.',
    ),
  scannedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Match records this segment covered, before residue filtering; across a complete walk the segments sum to totalMatches.',
    ),
  returnedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe('Selected match records in this segment.'),
  totalFeatures: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Selected extra features for this protein and residue; present with extraFeatures.'),
  returnedFeatures: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Extra features in this segment; present with extraFeatures.'),
  complete: z
    .boolean()
    .describe(
      'True only when this call starts without a cursor and returns the whole map: every match and every requested extra feature.',
    ),
  hasMore: z
    .boolean()
    .describe('Whether another segment remains, holding more matches or requested extra features.'),
  nextCursor: z
    .string()
    .optional()
    .describe(
      'Opaque cursor resuming at the next whole match or extra feature, for the same protein and selection.',
    ),
});
/**
 * Where a continuation resumes: `skip` records into an upstream match page (`page` is that
 * page's upstream cursor, absent for the first page), or `features` selected extra features into
 * the feature list that follows the last match. `after` names the last record an earlier segment
 * covered, so a page or feature list that changed since the cursor was minted is rejected.
 */
const PositionSchema = z.union([
  z
    .object({
      page: z.string().min(1).optional(),
      skip: z.number().int().nonnegative(),
      after: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (point) =>
        point.skip > 0 === (point.after !== undefined) &&
        (point.page !== undefined || point.skip > 0),
    ),
  z
    .object({
      features: z.number().int().nonnegative(),
      after: z.string().min(1).optional(),
      totalMatches: z.number().int().nonnegative(),
    })
    .strict()
    .refine((point) => point.features > 0 === (point.after !== undefined)),
]);
type Position = z.infer<typeof PositionSchema>;
type Match = z.infer<typeof MatchSchema>;
type ExtraFeatures = z.infer<typeof ExtraFeaturesSchema>;
type Location = z.infer<typeof LocationSchema>;
/** One whole item of the walk, with the position a continuation resumes at to return it. */
type Item = { at: Position; scannedBefore: number } & (
  | { kind: 'match'; match: Match }
  | { kind: 'feature'; key: string; feature: ExtraFeatures[string] }
);

function contains(locations: readonly Location[], position: number): boolean {
  return locations.some((location) =>
    location.fragments.some((fragment) => fragment.start <= position && position <= fragment.end),
  );
}
function earliest(match: Match): number {
  return Math.min(
    ...match.proteins.flatMap((protein) =>
      protein.entry_protein_locations.flatMap((location) =>
        location.fragments.map((fragment) => fragment.start),
      ),
    ),
  );
}
/** Earliest fragment start, then accession, then canonical JSON: one total order for any page. */
function byCoordinate(left: Match, right: Match): number {
  return (
    earliest(left) - earliest(right) ||
    compareText(left.metadata.accession, right.metadata.accession) ||
    compareText(cursorScope(left), cursorScope(right))
  );
}

/** Map signatures to sequence coordinates in budget-bounded segments with explicit coverage. */
export const interproGetProteinDomains = tool('interpro_get_protein_domains', {
  title: 'Map protein domains',
  description:
    'Retrieve InterPro and member-signature matches on a canonical UniProt protein, preserving every location and discontinuous fragment. Optionally retain matches covering a residue and include extra predicted features. Large maps arrive in segments of whole matches that fit the response budget: the first segment carries the protein metadata, requested extra features follow the last match, and coverage.nextCursor continues until hasMore is false.',
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
      .describe(
        'Include complete extra predicted features, returned after the last match; defaults to false.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque coverage.nextCursor with unchanged accession, residuePosition, and includeExtraFeatures.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical UniProt accession.'),
    protein: ProteinMetadataSchema.optional().describe(
      'Complete upstream protein metadata on the first segment, the call without cursor; continuation segments omit it.',
    ),
    matches: z
      .array(MatchSchema.describe('Complete entry match record.'))
      .describe(
        'Whole selected match records in this segment, sorted by earliest coordinate then accession; a match is never split across segments.',
      ),
    extraFeatures: ExtraFeaturesSchema.optional().describe(
      'Whole selected extra features in this segment, in feature-key order; {} when none are selected. Omitted when not requested or when this segment ends before the features that follow the last match.',
    ),
    selection: SelectionSchema.describe('Applied residue and extra-feature selection.'),
    coverage: CoverageSchema.describe(
      'Where this segment sits in the protein map: every match, then requested extra features.',
    ),
    url: z.string().describe('Canonical protein website URL.'),
    sourceUrl: z.string().describe('Official protein API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation, continuation, or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More segments remain.'),
    shown: z.number().int().optional().describe('Selected match records in this segment.'),
    cap: z
      .number()
      .int()
      .optional()
      .describe(
        'Most match records one call reads; a segment can stop sooner at the response byte budget.',
      ),
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
      when: 'Cursor decoding or scope fails, the records it resumes inside changed or disagree with it, or upstream rejects continuation.',
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
    ...UPSTREAM_ERRORS,
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
    const residue = input.residuePosition;
    const selection = {
      ...(residue !== undefined ? { residuePosition: residue } : {}),
      includeExtraFeatures: input.includeExtraFeatures,
    };
    const scope = { accession, ...selection };
    const start = decodePositionCursor(input.cursor, OPERATION, scope, PositionSchema);
    const stale = () =>
      ctx.fail(
        'invalid_cursor',
        'Cursor no longer matches the InterPro records it resumes inside.',
      );
    if (start && 'features' in start && !input.includeExtraFeatures) throw stale();
    const resumed = start !== undefined;
    const covers = (locations: readonly Location[]) =>
      residue === undefined || contains(locations, residue);
    const service = getInterproService();
    const call = service.begin(ctx);
    const detail = await service.request(
      call,
      ['protein', 'uniprot', accession],
      {},
      detailSchema(ProteinMetadataSchema),
      { missing: { reason: 'protein_not_found', accession, sourceDatabase: 'uniprot' } },
    );
    if (!detail.data)
      throw ctx.fail('upstream_shape_invalid', 'Protein metadata response is missing.');
    const protein = normalizeImages(detail.data.metadata);
    if (residue !== undefined && residue > protein.length)
      throw ctx.fail(
        'residue_out_of_range',
        `Residue ${residue} exceeds the ${protein.length}-residue length of ${accession}.`,
        { accession, proteinLength: protein.length, residuePosition: residue },
      );

    /** Whole candidate items in walk order: every match, then every selected extra feature. */
    const items: Item[] = [];
    let scanned = 0;
    let totalMatches = start && 'features' in start ? start.totalMatches : 0;
    let totalFeatures: number | undefined;
    /** Where the walk resumes after the last gathered item; undefined once the walk ends. */
    let end: Position | undefined;
    const segment = (count: number) => {
      const stop = items[count];
      const resume = stop ? stop.at : end;
      const matches: Match[] = [];
      const features: [string, ExtraFeatures[string]][] = [];
      for (const item of items.slice(0, count))
        if (item.kind === 'match') matches.push(item.match);
        else features.push([item.key, item.feature]);
      const featureTotal = totalFeatures;
      const reachedFeatures =
        featureTotal !== undefined && (features.length > 0 || resume === undefined);
      return {
        accession,
        ...(resumed ? {} : { protein }),
        matches: matches.toSorted(byCoordinate),
        ...(reachedFeatures ? { extraFeatures: Object.fromEntries(features) } : {}),
        selection,
        coverage: {
          totalMatches,
          scannedMatches: stop ? stop.scannedBefore : scanned,
          returnedMatches: matches.length,
          ...(reachedFeatures
            ? { totalFeatures: featureTotal, returnedFeatures: features.length }
            : {}),
          complete: !resumed && resume === undefined,
          hasMore: resume !== undefined,
          ...(resume ? { nextCursor: encodePositionCursor(OPERATION, scope, resume) } : {}),
        },
        url: `https://www.ebi.ac.uk/interpro/protein/UniProt/${accession}/`,
        sourceUrl: detail.sourceUrl,
      };
    };
    const overflows = () =>
      items.length > 0 && jsonByteLength(segment(items.length)) > RESPONSE_BYTE_BUDGET;

    if (!start || 'skip' in start) {
      let page = start?.page;
      let skip = start?.skip ?? 0;
      const seen = new Set<string>(page ? [page] : []);
      for (let read = 1; ; read++) {
        const response = await service.request(
          call,
          ['entry', 'all', 'protein', 'uniprot', accession],
          { page_size: PAGE_SIZE, cursor: page },
          listSchema(MatchSchema),
          { continuation: page !== undefined },
        );
        if (read === 1) totalMatches = response.data?.count ?? 0;
        const records = normalizeImages(response.data?.results ?? []).toSorted(byCoordinate);
        if (
          skip > 0 &&
          (skip >= records.length || records[skip - 1]?.metadata.accession !== start?.after)
        )
          throw stale();
        for (let index = skip; index < records.length; index++) {
          const match = records[index] as Match;
          if (match.proteins.some((record) => covers(record.entry_protein_locations)))
            items.push({
              kind: 'match',
              match,
              scannedBefore: scanned,
              at: {
                ...(page ? { page } : {}),
                skip: index,
                ...(index ? { after: (records[index - 1] as Match).metadata.accession } : {}),
              },
            });
          scanned += 1;
        }
        const next = continuation(response.data?.next ?? null, seen);
        end = next ? { page: next, skip: 0 } : undefined;
        if (!next) break;
        seen.add(next);
        page = next;
        skip = 0;
        if (read === MAX_PAGES || overflows()) break;
      }
    }
    if (input.includeExtraFeatures && end === undefined) {
      // Read extras only when the matches fit beside the cursor that would resume at them.
      end = { features: 0, totalMatches };
      if (!overflows()) {
        end = undefined;
        const extras = await service.request(
          call,
          ['protein', 'uniprot', accession],
          { extra_features: '' },
          ExtraFeaturesSchema,
        );
        if (!extras.data)
          throw ctx.fail('upstream_shape_invalid', 'Extra feature response is missing.');
        const selected = Object.entries(normalizeImages(extras.data))
          .filter(([, feature]) => covers(feature.locations))
          .toSorted(([a], [b]) => compareText(a, b));
        const resumeAt = start && 'features' in start ? start : undefined;
        const skip = resumeAt?.features ?? 0;
        if (skip > 0 && (skip >= selected.length || selected[skip - 1]?.[0] !== resumeAt?.after))
          throw stale();
        totalFeatures = selected.length;
        for (let index = skip; index < selected.length; index++) {
          const [key, feature] = selected[index] as [string, ExtraFeatures[string]];
          items.push({
            kind: 'feature',
            key,
            feature,
            scannedBefore: scanned,
            at: {
              features: index,
              ...(index ? { after: (selected[index - 1] as [string, unknown])[0] } : {}),
              totalMatches,
            },
          });
        }
      }
    }

    const { count, output, oversized } = fitWithinBudget(items.length, segment);
    const { coverage } = output;
    const stop = items[count];
    const notices: string[] = [];
    if (oversized) {
      const only = items[0] as Item;
      const [named, unnamed, id] =
        only.kind === 'feature'
          ? ['Extra feature', 'This extra feature', only.key]
          : ['Match', 'This match', only.match.metadata.accession];
      notices.push(
        `${isAccession(id) ? `${named} ${id}` : unnamed} cannot be split, so this segment holds it alone and exceeds the ${BUDGET_LABEL}.`,
      );
    }
    if (coverage.nextCursor) {
      const reason = stop
        ? ` and stopped at the ${BUDGET_LABEL} before the next whole ${stop.kind === 'match' ? 'match' : 'extra feature'}`
        : oversized
          ? ''
          : ` and reached the ${MAX_PAGES}-page read limit after ${coverage.scannedMatches} match records`;
      const nextCall = {
        accession,
        ...(residue !== undefined ? { residuePosition: residue } : {}),
        ...(input.includeExtraFeatures ? { includeExtraFeatures: true } : {}),
        cursor: coverage.nextCursor,
      };
      notices.push(
        `This segment covers part of the protein map${reason}. Continue with interpro_get_protein_domains ${JSON.stringify(nextCall)} before concluding that a residue has no annotation.`,
      );
    } else if (resumed)
      notices.push(
        'This is the final resumed segment. Only the combined segments cover the traversal; upstream pagination is not a snapshot.' +
          (coverage.returnedMatches || 'features' in start
            ? ''
            : ' No match was selected in this segment.'),
      );
    else if (!coverage.returnedMatches)
      notices.push(
        residue === undefined
          ? 'The protein has no returned signature matches. Annotation is not a clinical interpretation.'
          : 'No match contains this position. Annotation is not a clinical interpretation.',
      );
    if (resumed)
      notices.push('Continuation segments omit the protein metadata the first segment returned.');
    ctx.enrich.total(totalMatches);
    ctx.enrich.echo(JSON.stringify(scope));
    if (coverage.nextCursor)
      ctx.enrich.truncated({ shown: coverage.returnedMatches, cap: MAX_PAGES * PAGE_SIZE });
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    return output;
  },
  format: formatInterpro,
});
