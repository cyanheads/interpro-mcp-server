/**
 * @fileoverview Protein annotation maps in limit-sized segments of whole, discontinuous matches.
 * @module mcp-server/tools/definitions/interpro-get-protein-domains.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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
  IsoformListSchema,
  IsoformMetadataSchema,
  IsoformSchema,
  type LocationSchema,
  listSchema,
  MatchSchema,
  optionalString,
  ProteinMetadataSchema,
  ProteinOrIsoformAccessionSchema,
  ResidueAnnotationsSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const OPERATION = 'interpro_get_protein_domains';
const PAGE_SIZE = 200;
const MAX_PAGES = 3;
const DEFAULT_LIMIT = 20;
/** One upstream page, so a full segment never needs a third page read outside residue filtering. */
const MAX_LIMIT = 200;
/** The isoform count canonical protein detail reports; the list is read only when it is positive. */
const IsoformCountSchema = z.object({ counters: z.object({ isoforms: z.number() }) });

const SelectionSchema = z.object({
  residuePosition: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Selected 1-based inclusive residue position.'),
  includeExtraFeatures: z.boolean().describe('Whether extra predicted features were requested.'),
  includeResidueAnnotations: z
    .literal(true)
    .optional()
    .describe('Present only when residue rules were requested.'),
});
const CoverageSchema = z.object({
  totalMatches: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Upstream unfiltered total match count; extra-feature-only and residue-rule-only segments repeat the count reported by the match list.',
    ),
  scannedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Match records this segment covered, before residue filtering; totalMatches is upstream's reported count, and a complete walk can cover a different number.",
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
  totalResidueAnnotations: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Selected residue rules; present only when the residue stage is reached.'),
  returnedResidueAnnotations: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Whole residue rules returned in this segment.'),
  complete: z
    .boolean()
    .describe(
      'True only when this call starts without a cursor and returns every match, requested extra feature, and requested residue rule.',
    ),
  hasMore: z
    .boolean()
    .describe(
      'Whether another segment remains, holding matches, requested extras, or requested residue rules.',
    ),
  nextCursor: z
    .string()
    .optional()
    .describe(
      'Opaque cursor resuming at the next whole match, extra feature, or residue rule for the same protein and selection.',
    ),
});
/**
 * Where a continuation resumes: `skip` records into an upstream match page (`page` is that
 * page's upstream cursor, absent for the first page), or `features` selected extra features into
 * the feature list that follows the last match, or `residues` selected rules after the extras.
 * `after` names the last record an earlier segment covered, so changed lists are rejected.
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
  z
    .object({
      residues: z.number().int().nonnegative(),
      after: z.string().min(1).optional(),
      totalMatches: z.number().int().nonnegative(),
    })
    .strict()
    .refine((point) => point.residues > 0 === (point.after !== undefined)),
]);
type Position = z.infer<typeof PositionSchema>;
type Match = z.infer<typeof MatchSchema>;
type ExtraFeatures = z.infer<typeof ExtraFeaturesSchema>;
type ResidueAnnotations = z.infer<typeof ResidueAnnotationsSchema>;
type Location = z.infer<typeof LocationSchema>;
/** One whole item of the walk, with the position a continuation resumes at to return it. */
type Item = { at: Position; scannedBefore: number } & (
  | { kind: 'match'; match: Match }
  | { kind: 'feature'; key: string; feature: ExtraFeatures[string] }
  | { kind: 'residue'; key: string; rule: ResidueAnnotations[string] }
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

/** Map signatures to sequence coordinates in limit-sized segments with explicit coverage. */
export const interproGetProteinDomains = tool('interpro_get_protein_domains', {
  title: 'Map protein domains',
  description:
    'Retrieve InterPro and member-signature matches on a UniProt protein or one of its isoforms, preserving every location and discontinuous fragment. Optionally select records covering a residue; for canonical proteins, also include extra predicted features and functional residue rules with provenance. Each segment holds up to limit whole records in order: matches, requested extras, then requested residue rules sorted by key. The first segment carries protein metadata, and for a canonical protein with isoforms their accessions; continue coverage.nextCursor until hasMore is false.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_protein_domains:read'],
  input: z.object({
    accession: ProteinOrIsoformAccessionSchema,
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
        'Include complete extra predicted features, returned after the last match; canonical accessions only; defaults to false.',
      ),
    includeResidueAnnotations: z
      .boolean()
      .default(false)
      .describe(
        'Include complete functional residue rules after matches and requested extras; canonical accessions only; defaults to false.',
      ),
    includeSequence: z
      .boolean()
      .default(false)
      .describe(
        'Include protein.sequence on the first segment; defaults to false, and protein.length always gives the residue count.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(DEFAULT_LIMIT)
      .describe(
        'Positive integer segment size in whole records (matches, then requested extras and residue rules); values above 200 are clamped to 200 with a notice; defaults to 20.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque coverage.nextCursor with unchanged accession, residuePosition, includeExtraFeatures, and includeResidueAnnotations; limit and includeSequence may change.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Requested UniProt accession, canonical or isoform, uppercase.'),
    protein: z
      .union([
        ProteinMetadataSchema.describe('Complete canonical protein detail.'),
        IsoformMetadataSchema.describe(
          'Complete isoform record without its features, which become matches.',
        ),
      ])
      .optional()
      .describe(
        'Upstream metadata on the first segment, the call without cursor: canonical protein detail, or the isoform record for an isoform, with sequence only when includeSequence is true; continuation segments omit it.',
      ),
    isoforms: z
      .array(z.string().describe('Isoform accession, such as P04637-2.'))
      .optional()
      .describe(
        'Isoform accessions InterPro lists for this canonical protein, in upstream order; numbering can skip. Pass one as accession to map that isoform. Present on the first canonical segment when protein.counters.isoforms is above zero and the list was read.',
      ),
    matches: z
      .array(MatchSchema.describe('Complete entry match record.'))
      .describe(
        'Whole selected match records in this segment, sorted by earliest coordinate then accession; a match is never split across segments.',
      ),
    extraFeatures: ExtraFeaturesSchema.optional().describe(
      'Whole selected extra features in this segment, in feature-key order; {} when none are selected. Omitted when not requested or when this segment ends before the features that follow the last match.',
    ),
    residueAnnotations: ResidueAnnotationsSchema.optional().describe(
      'Whole selected residue rules sorted by key; {} means the stage was reached with no selected rules. Omitted when unrequested or unreached.',
    ),
    selection: SelectionSchema.describe(
      'Applied residue, extra-feature, and residue-rule selection.',
    ),
    coverage: CoverageSchema.describe(
      'Where this segment sits in the protein map: matches, requested extra features, then requested residue rules.',
    ),
    url: z.string().describe('Canonical protein website URL.'),
    sourceUrl: z.string().describe('Official protein API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation, continuation, or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More segments remain.'),
    shown: z
      .number()
      .int()
      .optional()
      .describe('Whole records in this segment: matches, extra features, and residue rules.'),
    cap: z.number().int().optional().describe('Effective segment size after clamping.'),
    effectiveQuery: z.string().optional().describe('Applied selection as JSON.'),
  },
  errors: [
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second deadline expires across protein or isoform metadata, match pages, extra features, residue rules, and the isoform list.',
      retryable: true,
      recovery:
        'Retry interpro_get_protein_domains after waiting; omit optional annotations when they are not needed.',
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
      reason: 'isoform_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The isoform read returns HTTP 204 or 404: InterPro has no isoform by that number under the canonical accession.',
      retryable: false,
      recovery:
        'Call interpro_get_protein_domains with the canonical accession; its first segment lists isoform accessions in isoforms when the protein has any.',
      thrownBy: 'service',
    },
    {
      reason: 'isoform_annotations_unavailable',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An isoform accession is combined with includeExtraFeatures or includeResidueAnnotations, which InterPro serves for canonical proteins only.',
      retryable: false,
      recovery:
        'Retry interpro_get_protein_domains for the isoform without includeExtraFeatures and includeResidueAnnotations, or request them with the canonical accession.',
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
    /** The canonical accession an isoform belongs to; the accession itself when canonical. */
    const canonical = accession.replace(/-[0-9]+$/, '');
    const isoform = canonical !== accession;
    if (isoform && (input.includeExtraFeatures || input.includeResidueAnnotations))
      throw ctx.fail(
        'isoform_annotations_unavailable',
        `InterPro serves extra features and residue rules for canonical proteins only, not isoform ${accession}.`,
        { accession },
      );
    const limit = Math.min(input.limit, MAX_LIMIT);
    const residue = input.residuePosition;
    const selection = {
      ...(residue !== undefined ? { residuePosition: residue } : {}),
      includeExtraFeatures: input.includeExtraFeatures,
      ...(input.includeResidueAnnotations ? { includeResidueAnnotations: true as const } : {}),
    };
    const scope = { accession, ...selection };
    const start = decodePositionCursor(input.cursor, OPERATION, scope, PositionSchema);
    const stale = () =>
      ctx.fail(
        'invalid_cursor',
        'Cursor no longer matches the InterPro records it resumes inside.',
      );
    if (start && 'features' in start && !input.includeExtraFeatures) throw stale();
    if (start && 'residues' in start && !input.includeResidueAnnotations) throw stale();
    // An isoform's rows form one list, so its positions never name an upstream page.
    if (isoform && start && 'page' in start) throw stale();
    const resumed = start !== undefined;
    const covers = (locations: readonly Location[]) =>
      residue === undefined || contains(locations, residue);
    const service = getInterproService();
    const call = service.begin(ctx);
    /** The isoform's features as canonical match rows; absent for a canonical protein. */
    let isoformRows: Match[] | undefined;
    let protein: z.infer<typeof ProteinMetadataSchema> | z.infer<typeof IsoformMetadataSchema>;
    let sourceUrl: string;
    if (isoform) {
      const response = await service.request(
        call,
        ['protein', 'uniprot', canonical],
        { isoforms: accession },
        IsoformSchema,
        { missing: { reason: 'isoform_not_found', accession, sourceDatabase: 'uniprot' } },
      );
      if (!response.data)
        throw ctx.fail('upstream_shape_invalid', 'Isoform metadata response is missing.');
      const { features, ...record } = normalizeImages(response.data);
      isoformRows = Object.values(features).map(({ locations, ...metadata }) => ({
        metadata,
        proteins: [{ accession: record.accession, entry_protein_locations: locations }],
      }));
      protein = record;
      sourceUrl = response.sourceUrl;
    } else {
      const detail = await service.request(
        call,
        ['protein', 'uniprot', accession],
        {},
        detailSchema(ProteinMetadataSchema),
        { missing: { reason: 'protein_not_found', accession, sourceDatabase: 'uniprot' } },
      );
      if (!detail.data)
        throw ctx.fail('upstream_shape_invalid', 'Protein metadata response is missing.');
      protein = normalizeImages(detail.data.metadata);
      sourceUrl = detail.sourceUrl;
    }
    const { sequence, ...withoutSequence } = protein;
    /** The first segment's protein; it differs from `protein` exactly when a sequence was omitted. */
    const header = input.includeSequence || sequence === undefined ? protein : withoutSequence;
    if (residue !== undefined && residue > protein.length)
      throw ctx.fail(
        'residue_out_of_range',
        `Residue ${residue} exceeds the ${protein.length}-residue length of ${accession}.`,
        { accession, proteinLength: protein.length, residuePosition: residue },
      );

    /** Whole candidate items: matches, selected extra features, then selected residue rules. */
    const items: Item[] = [];
    let scanned = 0;
    let totalMatches = start && !('skip' in start) ? start.totalMatches : 0;
    let totalFeatures: number | undefined;
    let totalResidueAnnotations: number | undefined;
    /** Where the walk resumes after the last gathered item; undefined once the walk ends. */
    let end: Position | undefined;
    /** The canonical protein's isoform accessions, once listed for the first segment. */
    let isoforms: string[] | undefined;
    const segment = (count: number) => {
      const stop = items[count];
      const resume = stop ? stop.at : end;
      const matches: Match[] = [];
      const features: [string, ExtraFeatures[string]][] = [];
      const residues: [string, ResidueAnnotations[string]][] = [];
      for (const item of items.slice(0, count))
        if (item.kind === 'match') matches.push(item.match);
        else if (item.kind === 'feature') features.push([item.key, item.feature]);
        else residues.push([item.key, item.rule]);
      const featureTotal = totalFeatures;
      const reachedFeatures =
        featureTotal !== undefined &&
        (features.length > 0 || resume === undefined || 'residues' in resume);
      const reachedResidues =
        totalResidueAnnotations !== undefined && (residues.length > 0 || resume === undefined);
      return {
        accession,
        ...(resumed ? {} : { protein: header }),
        ...(isoforms ? { isoforms } : {}),
        matches: matches.toSorted(byCoordinate),
        ...(reachedFeatures ? { extraFeatures: Object.fromEntries(features) } : {}),
        ...(reachedResidues ? { residueAnnotations: Object.fromEntries(residues) } : {}),
        selection,
        coverage: {
          totalMatches,
          scannedMatches: stop ? stop.scannedBefore : scanned,
          returnedMatches: matches.length,
          ...(reachedFeatures
            ? { totalFeatures: featureTotal, returnedFeatures: features.length }
            : {}),
          ...(reachedResidues
            ? { totalResidueAnnotations, returnedResidueAnnotations: residues.length }
            : {}),
          complete: !resumed && resume === undefined,
          hasMore: resume !== undefined,
          ...(resume ? { nextCursor: encodePositionCursor(OPERATION, scope, resume) } : {}),
        },
        url: `https://www.ebi.ac.uk/interpro/protein/UniProt/${canonical}/`,
        sourceUrl,
      };
    };
    /** Whether the gathered items already fill the segment, so no later stage needs reading. */
    const full = () => items.length >= limit;

    if (!start || 'skip' in start) {
      let page = start?.page;
      let skip = start?.skip ?? 0;
      const seen = new Set<string>(page ? [page] : []);
      /** One page of match rows: an upstream list page, or an isoform's whole row list. */
      const matchPage = async (cursor: string | undefined) => {
        if (isoformRows) return { rows: isoformRows, count: isoformRows.length, next: null };
        const response = await service.request(
          call,
          ['entry', 'all', 'protein', 'uniprot', accession],
          { page_size: PAGE_SIZE, cursor },
          listSchema(MatchSchema),
          { continuation: cursor !== undefined },
        );
        return {
          rows: normalizeImages(response.data?.results ?? []),
          count: response.data?.count ?? 0,
          next: response.data?.next ?? null,
        };
      };
      for (let read = 1; ; read++) {
        const response = await matchPage(page);
        if (read === 1) totalMatches = response.count;
        const records = response.rows.toSorted(byCoordinate);
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
        const next = continuation(response.next, seen);
        end = next ? { page: next, skip: 0 } : undefined;
        if (!next) break;
        seen.add(next);
        page = next;
        skip = 0;
        if (read === MAX_PAGES || full()) break;
      }
    }
    if (input.includeExtraFeatures && !(start && 'residues' in start) && end === undefined) {
      // Read extras only when the segment has room after the last match.
      end = { features: 0, totalMatches };
      if (!full()) {
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
    if (input.includeResidueAnnotations && end === undefined) {
      end = { residues: 0, totalMatches };
      if (!full()) {
        end = undefined;
        const response = await service.request(
          call,
          ['protein', 'uniprot', accession],
          { residues: '' },
          ResidueAnnotationsSchema,
        );
        if (!response.data)
          throw ctx.fail('upstream_shape_invalid', 'Residue annotation response is missing.');
        const selected = Object.entries(normalizeImages(response.data))
          .filter(([, rule]) => covers(rule.locations))
          .toSorted(([a], [b]) => compareText(a, b));
        const resumeAt = start && 'residues' in start ? start : undefined;
        const skip = resumeAt?.residues ?? 0;
        if (skip > 0 && (skip >= selected.length || selected[skip - 1]?.[0] !== resumeAt?.after))
          throw stale();
        totalResidueAnnotations = selected.length;
        for (let index = skip; index < selected.length; index++) {
          const [key, rule] = selected[index] as [string, ResidueAnnotations[string]];
          items.push({
            kind: 'residue',
            key,
            rule,
            scannedBefore: scanned,
            at: {
              residues: index,
              ...(index ? { after: (selected[index - 1] as [string, unknown])[0] } : {}),
              totalMatches,
            },
          });
        }
      }
    }
    /**
     * The isoform list is a secondary read after the map: any failure but the caller's
     * cancellation or the call deadline leaves the map whole and the count in a notice.
     */
    const isoformCount = IsoformCountSchema.safeParse(protein).data?.counters.isoforms;
    const listsIsoforms = !resumed && !isoform && isoformCount !== undefined && isoformCount > 0;
    if (listsIsoforms)
      try {
        isoforms = (
          await service.request(
            call,
            ['protein', 'uniprot', accession],
            { isoforms: '' },
            IsoformListSchema,
          )
        ).data?.results;
      } catch (error) {
        if (
          ctx.signal.aborted ||
          (error instanceof McpError && error.data?.reason === 'retry_deadline_exceeded')
        )
          throw error;
      }

    const count = Math.min(limit, items.length);
    const output = segment(count);
    const { coverage } = output;
    const notices =
      input.limit > limit ? [`Requested limit ${input.limit} was clamped to ${limit}.`] : [];
    if (coverage.nextCursor) {
      // Short of the limit, only the page read bound can have ended the segment.
      const reason =
        count === limit
          ? ` and holds the limit of ${limit} record${limit === 1 ? '' : 's'}`
          : ` and reached the ${MAX_PAGES}-page read limit after ${coverage.scannedMatches} match records`;
      const nextCall = {
        accession,
        ...(residue !== undefined ? { residuePosition: residue } : {}),
        ...(input.includeExtraFeatures ? { includeExtraFeatures: true } : {}),
        ...(input.includeResidueAnnotations ? { includeResidueAnnotations: true } : {}),
        ...(limit !== DEFAULT_LIMIT ? { limit } : {}),
        cursor: coverage.nextCursor,
      };
      notices.push(
        `This segment covers part of the protein map${reason}. Continue with interpro_get_protein_domains ${JSON.stringify(nextCall)} before concluding that a residue has no annotation${limit < MAX_LIMIT ? `; limit may rise to ${MAX_LIMIT} for larger segments` : ''}.`,
      );
    } else if (resumed)
      notices.push(
        'This is the final resumed segment. Only the combined segments cover the traversal; upstream pagination is not a snapshot.' +
          (coverage.returnedMatches || !('skip' in start)
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
    else if (header !== protein)
      notices.push(
        `Omitted protein.sequence (${protein.length.toLocaleString('en-US')} residues); repeat interpro_get_protein_domains with includeSequence: true to include it.`,
      );
    if (listsIsoforms && !isoforms)
      notices.push(
        isoformCount === 1
          ? `InterPro counts 1 isoform of ${accession}, but reading its accession failed; repeat interpro_get_protein_domains without cursor to list it.`
          : `InterPro counts ${isoformCount} isoforms of ${accession}, but reading their accessions failed; repeat interpro_get_protein_domains without cursor to list them.`,
      );
    ctx.enrich.total(totalMatches);
    ctx.enrich.echo(JSON.stringify(scope));
    if (coverage.nextCursor) ctx.enrich.truncated({ shown: count, cap: limit });
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    return output;
  },
  format: formatInterpro,
});
