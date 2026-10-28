/**
 * @fileoverview PDB structure domain maps in budget-bounded segments of whole matches.
 * @module mcp-server/tools/definitions/interpro-get-structure-domains.tool
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
  continuation,
  decodePositionCursor,
  encodePositionCursor,
} from '@/services/interpro/cursors.js';
import { formatInterpro } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  detailSchema,
  EntrySummarySchema,
  isAccession,
  JsonValueSchema,
  listSchema,
  optionalString,
} from '@/services/interpro/schemas.js';
import {
  ChainSchema,
  isChain,
  PdbIdSchema,
  StructureMatchSchema,
  StructureMetadataSchema,
  StructureRecordSchema,
} from '@/services/interpro/structure-schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const OPERATION = 'interpro_get_structure_domains';
/** Uncached 200-row structure pages can outlast an attempt, so pages stay at InterPro's default. */
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
/** InterPro nests at most this many chain records in one match, whatever the page size. */
const NESTED_CHAIN_LIMIT = 20;

/**
 * Where a continuation resumes: `skip` records into the upstream page whose cursor is `page`
 * (absent for the first page). `after` names the match before it, so a changed page is rejected.
 */
const PositionSchema = z
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
  );
type Position = z.infer<typeof PositionSchema>;
type Match = z.infer<typeof StructureMatchSchema>;

const CoverageSchema = z.object({
  totalMatches: z
    .number()
    .int()
    .nonnegative()
    .describe('Upstream total match count for the structure, or for the chain when one is set.'),
  returnedMatches: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Whole matches in this segment; totalMatches is upstream's reported count, and a complete walk can return a different number.",
    ),
  complete: z
    .boolean()
    .describe('True only when this call starts without a cursor and returns every match.'),
  hasMore: z.boolean().describe('Whether another segment remains.'),
  nextCursor: z
    .string()
    .optional()
    .describe('Opaque cursor resuming at the next whole match for the same pdbId and chain.'),
});

/** Map signatures onto one PDB entry's chains in budget-bounded segments of whole matches. */
export const interproGetStructureDomains = tool('interpro_get_structure_domains', {
  title: 'Map structure domains',
  description:
    "Retrieve InterPro and member-signature matches on one PDB entry's protein chains. Each chain record keeps match locations in chain numbering (1-based start/end beside author auth_start/auth_end, which can be null), in UniProt numbering, and the chain-to-UniProt residue map, with discontinuous fragments preserved; the UniProt protein is null for unmapped chains. InterPro nests at most 20 chain records per match; set chain to read one chain completely. Budgeted segments hold whole matches; the first carries structure metadata listing the protein chains. Continue coverage.nextCursor until hasMore is false.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_structure_domains:read'],
  input: z.object({
    pdbId: PdbIdSchema,
    chain: optionalString(ChainSchema).describe(
      'Protein chain to map, case-sensitive and one of structure.chains, such as A; omit for every chain.',
    ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque coverage.nextCursor with unchanged pdbId and chain.',
    ),
  }),
  inputAliases: { accession: 'pdbId' },
  output: z.object({
    pdbId: z.string().describe('Lowercase PDB ID.'),
    chain: z.string().optional().describe('Chain the map is restricted to, when one was set.'),
    structure: StructureMetadataSchema.optional().describe(
      'Complete upstream structure metadata on the first segment, the call without cursor; continuation segments omit it.',
    ),
    matches: z
      .array(
        z
          .object({
            metadata: EntrySummarySchema.describe('Entry metadata.'),
            chainRecordCount: z
              .number()
              .int()
              .nonnegative()
              .describe('Chain records InterPro nested in this match, all returned in structures.'),
            chainRecordLimitReached: z
              .boolean()
              .describe(
                'True when the match carries InterPro’s 20-record nesting limit, so it may match chains not returned; set chain to read one chain.',
              ),
          })
          .catchall(JsonValueSchema)
          .describe('Whole entry match; its chain records are in structures under its accession.'),
      )
      .describe('Whole matches in this segment, in upstream order; never split across segments.'),
    structures: z
      .array(
        z
          .object({
            entry: z.string().describe('Accession of the match in matches this record belongs to.'),
            record: StructureRecordSchema,
          })
          .describe('One upstream chain record of a match, unchanged.'),
      )
      .describe('Every chain record of this segment’s matches, grouped by match in matches order.'),
    coverage: CoverageSchema.describe('Where this segment sits in the structure map.'),
    url: z.string().describe('Canonical structure website URL.'),
    sourceUrls: z.array(z.string()).describe('Official API URLs this call read.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation, continuation, or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More segments remain.'),
    shown: z.number().int().optional().describe('Whole matches in this segment.'),
    cap: z
      .number()
      .int()
      .optional()
      .describe(
        'Most matches one call reads; a segment can stop sooner at the response byte budget.',
      ),
    effectiveQuery: z.string().optional().describe('Applied pdbId and chain as JSON.'),
  },
  errors: [
    {
      reason: 'structure_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'InterPro has no current structure for the PDB ID: unassigned, obsolete, or not yet loaded.',
      retryable: false,
      recovery:
        'Check the PDB ID at rcsb.org; for a superseded entry retry interpro_get_structure_domains with its replacement ID.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_withdrawn',
      code: JsonRpcErrorCode.NotFound,
      when: 'InterPro reports the structure or its match list withdrawn with HTTP 410.',
      retryable: false,
      recovery:
        'Check the PDB ID at rcsb.org, then retry interpro_get_structure_domains with the ID that replaced it.',
      thrownBy: 'service',
    },
    {
      reason: 'chain_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The chain is not one of the structure’s protein chains; IDs are case-sensitive and nucleic-acid chains are not listed.',
      retryable: false,
      recovery:
        'Retry interpro_get_structure_domains with a chain from availableChains, matching its case exactly, or omit chain.',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires across the structure metadata and match pages.',
      retryable: true,
      recovery:
        'Retry interpro_get_structure_domains after waiting; set chain to read a smaller map.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor decoding or scope fails, the page it resumes inside changed, or upstream rejects continuation.',
      retryable: false,
      recovery:
        'Repeat the same tool without cursor to restart pagination, keeping the intended pdbId and chain.',
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
  ],
  async handler(input, ctx) {
    const pdbId = input.pdbId.toLowerCase();
    const { chain } = input;
    const scope = { pdbId, ...(chain !== undefined ? { chain } : {}) };
    const start = decodePositionCursor(input.cursor, OPERATION, scope, PositionSchema);
    const stale = () =>
      ctx.fail('invalid_cursor', 'Cursor no longer matches the InterPro page it resumes inside.');
    const service = getInterproService();
    const call = service.begin(ctx);
    const missing = {
      reason: 'structure_not_found',
      accession: pdbId,
      sourceDatabase: 'pdb',
    } as const;
    const sourceUrls: string[] = [];
    let structure: z.infer<typeof StructureMetadataSchema> | undefined;
    if (!start) {
      // A list 204 means no matches, so only the detail tells an unknown ID or chain apart.
      const detail = await service.request(
        call,
        ['structure', 'pdb', pdbId],
        {},
        detailSchema(StructureMetadataSchema),
        { missing },
      );
      if (!detail.data)
        throw ctx.fail('upstream_shape_invalid', 'Structure metadata response is missing.');
      structure = detail.data.metadata;
      sourceUrls.push(detail.sourceUrl);
      if (chain !== undefined && !structure.chains.includes(chain)) {
        const named = structure.chains.filter(isChain);
        throw ctx.fail(
          'chain_not_found',
          named.length
            ? `Chain ${chain} is not a protein chain of ${pdbId}; chain IDs are case-sensitive. Available chains: ${named.join(', ')}.`
            : `${pdbId} has no protein chains, so InterPro maps no domains onto chain ${chain}.`,
          { pdbId, chain, availableChains: structure.chains },
        );
      }
    }
    const segments = ['entry', 'all', 'structure', 'pdb', pdbId, ...(chain ? [chain] : [])];

    const items: { match: Match; at: Position }[] = [];
    let totalMatches = 0;
    /** Where the walk resumes after the last gathered match; undefined once the walk ends. */
    let end: Position | undefined;
    const segment = (count: number) => {
      const resume = items[count]?.at ?? end;
      const matches = items.slice(0, count).map((item) => item.match);
      return {
        pdbId,
        ...(chain !== undefined ? { chain } : {}),
        ...(structure ? { structure } : {}),
        matches: matches.map(({ metadata, structures, ...rest }) => ({
          ...rest,
          metadata,
          chainRecordCount: structures.length,
          chainRecordLimitReached: structures.length >= NESTED_CHAIN_LIMIT,
        })),
        structures: matches.flatMap(({ metadata, structures }) =>
          structures.map((record) => ({ entry: metadata.accession, record })),
        ),
        coverage: {
          totalMatches,
          returnedMatches: matches.length,
          complete: !start && resume === undefined,
          hasMore: resume !== undefined,
          ...(resume ? { nextCursor: encodePositionCursor(OPERATION, scope, resume) } : {}),
        },
        url: `https://www.ebi.ac.uk/interpro/structure/PDB/${pdbId}/`,
        sourceUrls,
      };
    };

    let page = start?.page;
    let skip = start?.skip ?? 0;
    const seen = new Set<string>(page ? [page] : []);
    for (let read = 1; ; read++) {
      const response = await service.request(
        call,
        segments,
        { page_size: PAGE_SIZE, cursor: page },
        listSchema(StructureMatchSchema),
        page ? { continuation: true } : { missing: { ...missing, list: true } },
      );
      sourceUrls.push(response.sourceUrl);
      // A continuation page cannot be empty: the structure or its matches changed underneath it.
      if (page && !response.data) throw stale();
      if (read === 1) totalMatches = response.data?.count ?? 0;
      const records = response.data?.results ?? [];
      if (
        skip > 0 &&
        (skip >= records.length || records[skip - 1]?.metadata.accession !== start?.after)
      )
        throw stale();
      for (let index = skip; index < records.length; index++)
        items.push({
          match: records[index] as Match,
          at: {
            ...(page ? { page } : {}),
            skip: index,
            ...(index ? { after: (records[index - 1] as Match).metadata.accession } : {}),
          },
        });
      const next = continuation(response.data?.next ?? null, seen);
      end = next ? { page: next, skip: 0 } : undefined;
      if (!next) break;
      seen.add(next);
      page = next;
      skip = 0;
      if (read === MAX_PAGES || jsonByteLength(segment(items.length)) > RESPONSE_BYTE_BUDGET) break;
    }

    const { count, output, oversized } = fitWithinBudget(items.length, segment);
    const { coverage } = output;
    const notices: string[] = [];
    if (oversized) {
      const id = items[0]?.match.metadata.accession;
      notices.push(
        `${isAccession(id) ? `Match ${id}` : 'This match'} cannot be split, so this segment holds it alone and exceeds the ${BUDGET_LABEL}.`,
      );
    }
    const limited = output.matches.filter((match) => match.chainRecordLimitReached);
    if (limited.length) {
      const named = limited.map((match) => match.metadata.accession).filter(isAccession);
      notices.push(
        `InterPro nests at most ${NESTED_CHAIN_LIMIT} chain records in one match, and ${limited.length === 1 ? 'one match carries' : `${limited.length} matches carry`} that many${named.length ? ` (${named.join(', ')})` : ''}, so ${limited.length === 1 ? 'it' : 'they'} may match chains not returned. Repeat interpro_get_structure_domains with chain set to one of structure.chains to read that chain's matches completely.`,
      );
    }
    if (coverage.nextCursor) {
      const reason = items[count]
        ? ` and stopped at the ${BUDGET_LABEL} before the next whole match`
        : ` and reached the ${MAX_PAGES}-page read limit`;
      notices.push(
        `This segment covers part of the structure map${oversized ? '' : reason}. Continue with interpro_get_structure_domains ${JSON.stringify({ ...scope, cursor: coverage.nextCursor })} before concluding that a chain has no annotation.`,
      );
    } else if (start)
      notices.push(
        'This is the final resumed segment. Only the combined segments cover the traversal; upstream pagination is not a snapshot.',
      );
    else if (!coverage.returnedMatches)
      notices.push(
        structure && !structure.chains.length
          ? `${pdbId} has no protein chains, so InterPro maps no domains onto it.`
          : chain !== undefined
            ? `InterPro reports no match on chain ${chain} of ${pdbId}.`
            : `InterPro reports no match on the protein chains of ${pdbId}.`,
      );
    if (start)
      notices.push('Continuation segments omit the structure metadata the first segment returned.');
    ctx.enrich.total(totalMatches);
    ctx.enrich.echo(JSON.stringify(scope));
    if (coverage.nextCursor)
      ctx.enrich.truncated({ shown: coverage.returnedMatches, cap: MAX_PAGES * PAGE_SIZE });
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    return output;
  },
  format: formatInterpro,
});
