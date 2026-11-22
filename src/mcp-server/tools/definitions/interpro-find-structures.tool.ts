/**
 * @fileoverview PDB structure discovery for one UniProt protein or one InterPro or member entry.
 * @module mcp-server/tools/definitions/interpro-find-structures.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  continuation,
  decodeCursor,
  encodeCursor,
  pageGuidance,
} from '@/services/interpro/cursors.js';
import { formatInterpro } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveEntry } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  detailSchema,
  JsonObjectSchema,
  JsonValueSchema,
  listSchema,
  optionalString,
  PageSchema,
  ProteinAccessionSchema,
  type SourceDatabase,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';
import {
  EntryChainRecordSchema,
  EntryStructureRowSchema,
  NESTED_CHAIN_LIMIT,
  PDB_ID_PATTERN,
  ProteinChainRecordSchema,
  ProteinStructureRowSchema,
  StructureSummarySchema,
} from '@/services/interpro/structure-schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const OPERATION = 'interpro_find_structures';
const MAX_LIMIT = 50;
/** InterPro's range syntax accepts ordinary decimals and rejects exponential notation. */
const resolutionDecimal = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumSignificantDigits: 21,
});
const structureFilters = {
  experimentType: z
    .enum(['x-ray', 'nmr', 'em'])
    .optional()
    .describe('Experimental method: x-ray, nmr, or em. Omit to include all methods.'),
  maxResolution: z
    .number()
    .positive()
    .optional()
    .describe('Inclusive upper resolution bound in ångströms. Excludes null resolutions.'),
};
const taxonFilter = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{0,9}$/, 'Expected a positive NCBI taxonomy identifier such as 9606.')
  .optional()
  .describe('Positive NCBI taxonomy identifier of at most 10 digits, for entry targets only.');
/** Each route's rows, with the nested chain records lifted out from under their upstream key. */
const ProteinRowsSchema = ProteinStructureRowSchema.transform(({ proteins, ...row }) => ({
  row,
  records: proteins,
}));
const EntryRowsSchema = EntryStructureRowSchema.transform(({ entries, ...row }) => ({
  row,
  records: entries,
}));
const pdbId = z.string().describe('PDB ID of the structures row this chain record belongs to.');
/** The canonical protein target: cursor scope, routes, missing record, and empty-page notice. */
function proteinTarget(accession: string) {
  const proteinAccession = accession.toUpperCase();
  return {
    query: { proteinAccession },
    path: ['protein', 'uniprot', proteinAccession],
    missing: {
      reason: 'protein_not_found',
      accession: proteinAccession,
      sourceDatabase: 'uniprot',
    } as const,
    rows: ProteinRowsSchema,
    empty: `InterPro lists no PDB structure for protein ${proteinAccession}; interpro_get_protein_domains maps its signatures on the UniProt sequence.`,
  };
}
/** The canonical entry target, routed by prefix before any request. */
function entryTarget(accession: string, sourceDatabase: SourceDatabase | undefined) {
  const entry = resolveEntry(accession, sourceDatabase);
  return {
    query: { entryAccession: entry.accession, sourceDatabase: entry.sourceDatabase },
    path: ['entry', entry.sourceDatabase, entry.accession],
    missing: { reason: 'entry_not_found', ...entry } as const,
    rows: EntryRowsSchema,
    empty: `InterPro lists no PDB structure that entry ${entry.accession} in ${entry.sourceDatabase} matches; interpro_find_proteins_by_domain lists the proteins that carry it.`,
  };
}

/** List the PDB entries carrying one protein or one entry, a keyset page at a time. */
export const interproFindStructures = tool('interpro_find_structures', {
  title: 'Find PDB structures',
  description:
    "List the PDB structures that contain a UniProt protein or match an InterPro or member-database entry, a page at a time in PDB ID order. Filter either target by experimentType and maxResolution; a resolution bound excludes nulls, as for NMR and some EM structures. Optionally filter an entry target by taxonId. Set exactly one of proteinAccession or entryAccession. Each structure's chain records follow in chains, joined by pdbId: for a protein, chain positions mapped to UniProt positions; for an entry, its match locations in chain numbering beside author auth_start/auth_end and in UniProt numbering, with protein null on unmapped chains. InterPro nests at most 20 chain records per structure, flagged by chainRecordLimitReached. A row's metadata.accession and a record's chain feed interpro_get_structure_domains as pdbId and chain. Continue page.nextCursor until hasMore is false.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_find_structures:read'],
  input: z.object({
    proteinAccession: optionalString(ProteinAccessionSchema).describe(
      'Canonical UniProt accession, such as P04637, whose PDB structures to list; set this or entryAccession, never both.',
    ),
    entryAccession: optionalString(AccessionSchema).describe(
      'InterPro or member-database entry accession, such as IPR011615 or PF00870, whose matched PDB structures to list; set this or proteinAccession, never both.',
    ),
    sourceDatabase: optionalString(SourceDatabaseSchema).describe(
      'Database slug for entryAccession, inferred from standard accession prefixes when omitted; not used with proteinAccession.',
    ),
    ...structureFilters,
    taxonId: taxonFilter,
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe(
        'Positive integer page size in structures; values above 50 are clamped to 50 with a notice; defaults to 20. Entry-target rows carry each chain’s sequence, so their pages can run to hundreds of kilobytes.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque page.nextCursor with the same target and filters; limit may change.',
    ),
  }),
  output: z.object({
    query: z
      .union([
        z
          .object({
            proteinAccession: z.string().describe('Uppercase canonical UniProt accession.'),
            ...structureFilters,
          })
          .describe('Protein target.'),
        z
          .object({
            entryAccession: z.string().describe('Canonical entry accession.'),
            sourceDatabase: SourceDatabaseSchema,
            ...structureFilters,
            taxonId: taxonFilter,
          })
          .describe('Entry target.'),
      ])
      .describe('Applied canonical target and explicitly supplied filters.'),
    structures: z
      .array(
        z
          .object({
            metadata: StructureSummarySchema.describe(
              'Structure metadata; accession is the PDB ID.',
            ),
            chainRecordCount: z
              .number()
              .int()
              .nonnegative()
              .describe('Chain records InterPro nested in this row, all returned in chains.'),
            chainRecordLimitReached: z
              .boolean()
              .describe(
                'True when the row carries InterPro’s 20-record nesting limit, so the structure may hold more chains for the target; interpro_get_structure_domains lists every protein chain.',
              ),
          })
          .catchall(JsonValueSchema)
          .describe('One PDB structure; its chain records are in chains under its PDB ID.'),
      )
      .describe('PDB structures on this page, in upstream PDB ID order.'),
    chains: z
      .array(
        z
          .union([
            ProteinChainRecordSchema.extend({ pdbId }).describe(
              'Protein-target chain record, unchanged, with its pdbId.',
            ),
            EntryChainRecordSchema.extend({ pdbId }).describe(
              'Entry-target chain record, unchanged, with its pdbId.',
            ),
          ])
          .describe('One upstream chain record of a structure on this page.'),
      )
      .describe(
        'Chain records of this page’s structures, grouped in structures order; not to be confused with the chain IDs of interpro_get_structure_domains structure.chains.',
      ),
    page: PageSchema.extend({
      total: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          'Upstream total structures for the target and filters; absent on an empty continuation page.',
        ),
    }).describe('Page coverage and continuation.'),
    sourceUrls: z
      .array(z.string())
      .describe(
        'Official API URLs this call read: the list page, then the target detail when the first page is empty.',
      ),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation, continuation, or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total structures for the applied query.'),
    truncated: z.boolean().optional().describe('More structures remain.'),
    shown: z.number().int().optional().describe('Structures returned.'),
    cap: z.number().int().optional().describe('Effective page size after clamping.'),
    effectiveQuery: z.string().optional().describe('Applied target and filters as JSON.'),
  },
  errors: [
    {
      reason: 'invalid_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The call sets neither or both of proteinAccession and entryAccession, or sourceDatabase or taxonId beside proteinAccession.',
      retryable: false,
      recovery:
        'Retry interpro_find_structures with exactly one of proteinAccession or entryAccession; sourceDatabase and taxonId accompany only entryAccession.',
    },
    {
      reason: 'protein_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The first page is empty and the canonical protein detail returns HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Use a canonical UniProt accession returned by interpro_find_proteins_by_domain, then retry interpro_find_structures.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The accession is a set accession, InterPro rejects it for its database with HTTP 404, or the first page is empty and the entry detail returns HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Call interpro_search_entries in the correct database, or interpro_list_reference with topic accession_patterns.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_withdrawn',
      code: JsonRpcErrorCode.NotFound,
      when: 'InterPro reports the protein, the entry, or its structure list withdrawn with HTTP 410.',
      retryable: false,
      recovery:
        'Call interpro_search_entries for a current replacement entry, or retry interpro_find_structures with the UniProt accession that replaced the protein.',
      thrownBy: 'service',
    },
    {
      reason: 'database_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Explicit sourceDatabase conflicts with entryAccession routing.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, then retry with the matching sourceDatabase.',
      thrownBy: 'service',
    },
    {
      reason: 'accession_source_unknown',
      code: JsonRpcErrorCode.ValidationError,
      when: 'entryAccession matches no standard prefix and no sourceDatabase was supplied.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, or supply the sourceDatabase reported by interpro_search_entries.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Cursor decoding or scope fails, or upstream rejects continuation.',
      retryable: false,
      recovery:
        'Repeat the same tool without cursor to restart pagination with the intended target and filters.',
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires across the list page and the target detail.',
      retryable: true,
      recovery:
        'Retry interpro_find_structures after waiting, with a smaller limit for a lighter page.',
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
    const {
      proteinAccession,
      entryAccession,
      sourceDatabase,
      experimentType,
      maxResolution,
      taxonId,
    } = input;
    const target =
      proteinAccession !== undefined && entryAccession === undefined && sourceDatabase === undefined
        ? proteinTarget(proteinAccession)
        : entryAccession !== undefined && proteinAccession === undefined
          ? entryTarget(entryAccession, sourceDatabase)
          : undefined;
    if (!target)
      throw ctx.fail(
        'invalid_target',
        proteinAccession === undefined && entryAccession === undefined
          ? 'Set proteinAccession or entryAccession.'
          : entryAccession !== undefined
            ? 'proteinAccession and entryAccession are exclusive; set exactly one.'
            : 'sourceDatabase applies only beside entryAccession, never beside proteinAccession.',
      );
    if (taxonId !== undefined && proteinAccession !== undefined)
      throw ctx.fail('invalid_target', 'taxonId applies only beside entryAccession.');
    const filters = {
      ...(experimentType !== undefined ? { experimentType } : {}),
      ...(maxResolution !== undefined ? { maxResolution } : {}),
      ...(taxonId !== undefined ? { taxonId } : {}),
    };
    const query = { ...target.query, ...filters };
    const limit = Math.min(input.limit, MAX_LIMIT);
    const notices =
      input.limit > limit ? [`Requested limit ${input.limit} was clamped to ${limit}.`] : [];
    const cursor = decodeCursor(input.cursor, OPERATION, query);
    const service = getInterproService();
    const call = service.begin(ctx);
    const response = await service.request(
      call,
      [
        'structure',
        'pdb',
        ...target.path,
        ...(taxonId !== undefined ? ['taxonomy', 'uniprot', taxonId] : []),
      ],
      {
        page_size: limit,
        cursor,
        experiment_type: experimentType,
        resolution:
          maxResolution === undefined ? undefined : `0-${resolutionDecimal.format(maxResolution)}`,
      },
      listSchema(target.rows),
      { continuation: cursor !== undefined, missing: { ...target.missing, list: true } },
    );
    const sourceUrls = [response.sourceUrl];
    const rows = response.data?.results ?? [];
    // An unknown target and a target without structures both answer the first page with 204.
    if (!cursor && !rows.length) {
      const detail = await service.request(call, target.path, {}, detailSchema(JsonObjectSchema), {
        missing: target.missing,
      });
      sourceUrls.push(detail.sourceUrl);
    }
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const structures = rows.map(({ row, records }) => ({
      ...row,
      chainRecordCount: records.length,
      chainRecordLimitReached: records.length >= NESTED_CHAIN_LIMIT,
    }));
    const chains = rows.flatMap(({ row, records }) =>
      records.map((record) => Object.assign({}, record, { pdbId: row.metadata.accession })),
    );
    // A first-page 204 is an empty list; past the end of a continuation, upstream reports no total.
    const total = response.data?.count ?? (cursor ? undefined : 0);
    const page = {
      ...(total !== undefined ? { total } : {}),
      returned: structures.length,
      limit,
      hasMore: next !== undefined,
      ...(next ? { nextCursor: encodeCursor(OPERATION, query, next) } : {}),
    };
    const limited = structures.filter((row) => row.chainRecordLimitReached);
    if (limited.length) {
      const named = limited
        .map((row) => row.metadata.accession)
        .filter((id) => PDB_ID_PATTERN.test(id));
      notices.push(
        `InterPro nests at most ${NESTED_CHAIN_LIMIT} chain records in one structure row, and ${limited.length === 1 ? 'one row carries' : `${limited.length} rows carry`} that many${named.length ? ` (${named.join(', ')})` : ''}, so chains may omit some of ${limited.length === 1 ? 'its' : 'their'} chains for this target. interpro_get_structure_domains with a capped row's metadata.accession as pdbId lists every protein chain in structure.chains; set chain there to read one chain completely.`,
      );
    }
    if (!structures.length)
      notices.push(
        cursor
          ? 'This continuation page is empty: InterPro lists no further structure after the previous page.'
          : Object.keys(filters).length
            ? 'InterPro lists no PDB structures for this target with the applied filters. Try changing or omitting a filter.'
            : target.empty,
      );
    if (!structures.length && maxResolution !== undefined)
      notices.push('A resolution bound excludes structures with null resolution.');
    if (total !== undefined) ctx.enrich.total(total);
    ctx.enrich.echo(JSON.stringify(query));
    if (next) {
      notices.push(pageGuidance(OPERATION, 'structures', limit, MAX_LIMIT));
      ctx.enrich.truncated({ shown: structures.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return { query, structures, chains, page, sourceUrls };
  },
  format: formatInterpro,
});
