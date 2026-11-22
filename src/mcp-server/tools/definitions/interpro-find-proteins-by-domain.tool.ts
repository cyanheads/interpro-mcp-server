/**
 * @fileoverview Entry-scoped protein discovery with explicit taxonomy and review defaults.
 * @module mcp-server/tools/definitions/interpro-find-proteins-by-domain.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  continuation,
  decodeCursor,
  encodeCursor,
  pageGuidance,
} from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveEntry } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  defaultedString,
  detailSchema,
  JsonObjectSchema,
  JsonValueSchema,
  LocationSchema,
  listSchema,
  optionalString,
  PageSchema,
  ProteinMetadataSchema,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const MAX_LIMIT = 50;
/** NCBI taxonomy root, the ancestor of every organism: as taxonId it selects all organisms. */
const ROOT_TAXON = '1';
const SelectorDetailSchema = detailSchema(JsonObjectSchema);
const QuerySchema = z.object({
  accession: z.string().describe('Canonical entry accession.'),
  sourceDatabase: SourceDatabaseSchema,
  taxonId: z.string().describe('Applied NCBI taxonomy identifier.'),
  reviewedOnly: z
    .boolean()
    .describe('True restricts to reviewed proteins; false includes all review statuses.'),
  isFragment: z
    .boolean()
    .optional()
    .describe('Applied fragment annotation filter; omitted includes both groups.'),
  architectureId: z
    .string()
    .optional()
    .describe('Applied lowercase Pfam architecture grouping identifier.'),
  proteomeId: z.string().optional().describe('Applied uppercase UniProt proteome accession.'),
});
const ProteomesSchema = z
  .array(
    z
      .object({
        accession: z.string().describe('Proteome accession as upstream writes it, lowercase.'),
      })
      .catchall(JsonValueSchema)
      .describe('Complete proteome record.'),
  )
  .describe('Complete records of the selected proteome, preserved verbatim.');
const ProteinResultSchema = z
  .object({
    metadata: ProteinMetadataSchema.describe('Complete sparse protein summary.'),
    extra_fields: JsonValueSchema.refine((value) => {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.hasOwn(value, 'is_fragment')
      )
        return true;
      return value.is_fragment === null || typeof value.is_fragment === 'boolean';
    }, 'A supplied is_fragment annotation must be boolean or null.')
      .optional()
      .describe(
        'Native extra fields preserved verbatim. is_fragment is boolean when supplied, null or absent means unknown, and false means not annotated as a fragment rather than proof of a complete canonical sequence.',
      ),
    entries: z
      .array(
        z
          .object({
            accession: z.string().describe('Matched entry accession.'),
            entry_protein_locations: z
              .array(LocationSchema)
              .min(1)
              .describe('Complete nested match locations.'),
          })
          .catchall(JsonValueSchema)
          .describe('Complete entry match record.'),
      )
      .describe('Matched entry records and all upstream fields.'),
    taxa: z
      .array(
        z
          .object({
            accession: z.string().describe('Taxon accession.'),
          })
          .catchall(JsonValueSchema)
          .describe('Complete taxon record.'),
      )
      .describe('Complete taxon records including lineage when supplied.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete protein discovery record.');
const ProteomeResultSchema = ProteinResultSchema.extend({ proteomes: ProteomesSchema }).describe(
  'Complete proteome-filtered protein discovery record.',
);
const ArchitectureResultSchema = ProteinResultSchema.extend({
  entries: ProteinResultSchema.shape.entries.optional(),
  taxa: ProteinResultSchema.shape.taxa.optional(),
  proteomes: ProteomesSchema.optional(),
});
const Availability = z.enum(['available', 'unavailable']);
const availability = (details: unknown[] | undefined): z.infer<typeof Availability> =>
  details === undefined ? 'unavailable' : 'available';
const ArchitectureOutputSchema = ArchitectureResultSchema.extend({
  detailAvailability: z
    .object({
      entries: Availability.describe('Whether upstream supplied entry records.'),
      taxa: Availability.describe('Whether upstream supplied taxon records.'),
      proteomes: Availability.optional().describe(
        'Whether upstream supplied proteome records; present only when proteomeId is set.',
      ),
    })
    .describe('Absent details are unavailable, rather than biologically empty.'),
}).describe('Complete architecture-filtered protein record with explicit detail availability.');

/** Discover proteins without fetching per-protein metadata. */
export const interproFindProteinsByDomain = tool('interpro_find_proteins_by_domain', {
  title: 'Find proteins by domain',
  description:
    'Find UniProt proteins carrying an InterPro or member signature. Defaults to reviewed human proteins; taxonId 1 selects all organisms, and reviewedOnly=false includes all review statuses in the chosen taxon. Optional isFragment filters fragment annotations; false does not prove sequence completeness. architectureId intersects the provider Pfam grouping with these selections, without implying functional equivalence; metadata-only hits disclose unavailable entry and taxon details without per-protein requests. proteomeId intersects one UniProt proteome, such as protein.proteome from interpro_get_protein_domains, with every selection including taxonId.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_find_proteins_by_domain:read'],
  input: z.object({
    accession: AccessionSchema.describe(
      'InterPro or member-database entry accession, such as IPR011615 or PF00870; no URL syntax.',
    ),
    sourceDatabase: optionalString(SourceDatabaseSchema).describe(
      'Entry database slug, inferred from standard accession prefixes when omitted.',
    ),
    taxonId: defaultedString(
      z
        .string()
        .trim()
        .max(10)
        .regex(/^[1-9][0-9]*$/, {
          error:
            'Expected a positive NCBI taxonomy identifier such as 9606, or 1 for all organisms.',
        })
        .default('9606'),
    ).describe(
      'Positive NCBI taxonomy identifier of at most 10 digits; defaults to human 9606, and 1, the taxonomy root, selects all organisms.',
    ),
    reviewedOnly: z
      .boolean()
      .default(true)
      .describe('Defaults to reviewed proteins; false includes reviewed and unreviewed proteins.'),
    isFragment: z
      .boolean()
      .optional()
      .describe(
        'Select fragment annotations: true for fragments, false for proteins not annotated as fragments; omit to include both. False does not establish sequence completeness.',
      ),
    architectureId: optionalString(
      z
        .string()
        .trim()
        .regex(/^[a-fA-F0-9]{40}$/)
        .toLowerCase(),
    ).describe(
      'Optional 40-character hexadecimal Pfam architecture grouping ID from interpro_find_architectures ida_id or interpro_get_protein_domains protein.ida_accession. Grouping does not establish functional equivalence.',
    ),
    proteomeId: optionalString(
      z
        .string()
        .trim()
        .max(11)
        .regex(/^[Uu][Pp][0-9]{9}$/)
        .toUpperCase(),
    ).describe(
      'Optional UniProt proteome accession, UP followed by 9 digits, such as protein.proteome from interpro_get_protein_domains. taxonId still applies, including its 9606 default: set taxonId to the mapped protein.source_organism.taxId or an ancestor, such as 1 for all organisms, or no proteins match.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe(
        'Positive integer page size; values above 50 are clamped to 50 with a notice; defaults to 20.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged target, taxonId, reviewedOnly, isFragment, architectureId, and proteomeId selection; limit may change.',
    ),
  }),
  output: z.object({
    query: QuerySchema.describe('Applied canonical target and selection, including defaults.'),
    proteins: z
      .array(
        z
          .union([ProteinResultSchema, ProteomeResultSchema, ArchitectureOutputSchema])
          .describe(
            'Ordinary protein details, with proteome records when proteomeId is set, or an architecture-filtered record with detail availability.',
          ),
      )
      .describe(
        'Complete upstream protein records; architecture mode discloses unavailable details.',
      ),
    page: PageSchema.describe('Page coverage and continuation.'),
    sourceUrl: z.string().describe('Official API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More records remain.'),
    shown: z.number().int().optional().describe('Selected records returned.'),
    cap: z.number().int().optional().describe('Effective page size after clamping.'),
    effectiveQuery: z.string().optional().describe('Applied selection as JSON.'),
  },
  errors: [
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
      reason: 'entry_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The accession is a set accession, InterPro rejects it for its database with HTTP 404, or an empty first page leads to entry detail returning HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Call interpro_search_entries in the correct database, or interpro_list_reference with topic accession_patterns.',
      thrownBy: 'service',
    },
    {
      reason: 'taxon_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An empty first page leads to taxonomy detail returning HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Use a valid NCBI taxonomy identifier, such as 9606 for humans or 1 for all organisms.',
      thrownBy: 'service',
    },
    {
      reason: 'proteome_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'An empty first page leads to proteome detail returning HTTP 204 or 404.',
      retryable: false,
      recovery:
        'Use a UniProt proteome identifier from protein.proteome in interpro_get_protein_domains.',
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
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires during the protein page or selector detail requests.',
      retryable: true,
      recovery:
        'Retry interpro_find_proteins_by_domain after waiting, with a smaller limit for a lighter page.',
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
      reason: 'database_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Explicit database conflicts with accession routing.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, then retry with the matching sourceDatabase.',
      thrownBy: 'service',
    },
    {
      reason: 'accession_source_unknown',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No safe inferred entry source and no explicit source.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, or supply the sourceDatabase reported by interpro_search_entries.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit = Math.min(input.limit, MAX_LIMIT);
    const notices =
      input.limit > limit ? [`Requested limit ${input.limit} was clamped to ${limit}.`] : [];
    const query = {
      ...resolveEntry(input.accession, input.sourceDatabase),
      taxonId: input.taxonId,
      reviewedOnly: input.reviewedOnly,
      ...(input.isFragment !== undefined ? { isFragment: input.isFragment } : {}),
      ...(input.architectureId !== undefined ? { architectureId: input.architectureId } : {}),
      ...(input.proteomeId !== undefined ? { proteomeId: input.proteomeId } : {}),
    };
    const cursor = decodeCursor(input.cursor, 'interpro_find_proteins_by_domain', query);
    const service = getInterproService();
    const call = service.begin(ctx);
    const rowSchema = input.architectureId
      ? ArchitectureResultSchema.refine((row) => {
          const fields = row.extra_fields;
          return (
            !fields ||
            typeof fields !== 'object' ||
            Array.isArray(fields) ||
            fields.ida_id === undefined ||
            fields.ida_id === null ||
            fields.ida_id === input.architectureId
          );
        }, 'A supplied architecture identifier must match the requested grouping.').transform(
          (row) =>
            Object.assign({}, row, {
              detailAvailability: {
                entries: availability(row.entries),
                taxa: availability(row.taxa),
                ...(input.proteomeId !== undefined
                  ? { proteomes: availability(row.proteomes) }
                  : {}),
              },
            }),
        )
      : input.proteomeId
        ? ProteomeResultSchema
        : ProteinResultSchema;
    const response = await service.request(
      call,
      [
        'protein',
        query.reviewedOnly ? 'reviewed' : 'uniprot',
        'entry',
        query.sourceDatabase,
        query.accession,
        'taxonomy',
        'uniprot',
        query.taxonId,
        ...(query.proteomeId ? ['proteome', 'uniprot', query.proteomeId] : []),
      ],
      {
        page_size: limit,
        cursor,
        extra_fields: input.architectureId ? 'is_fragment,ida_id' : 'is_fragment',
        is_fragment: query.isFragment,
        ida: input.architectureId,
      },
      listSchema(rowSchema),
      {
        continuation: cursor !== undefined,
        missing: {
          reason: 'entry_not_found',
          accession: query.accession,
          sourceDatabase: query.sourceDatabase,
          list: true,
        },
      },
    );
    const proteins = normalizeImages(response.data?.results ?? []);
    if (cursor === undefined && proteins.length === 0) {
      await service.request(
        call,
        ['entry', query.sourceDatabase, query.accession],
        {},
        SelectorDetailSchema,
        {
          missing: {
            reason: 'entry_not_found',
            accession: query.accession,
            sourceDatabase: query.sourceDatabase,
          },
        },
      );
      if (query.taxonId !== ROOT_TAXON)
        await service.request(
          call,
          ['taxonomy', 'uniprot', query.taxonId],
          {},
          SelectorDetailSchema,
          {
            missing: {
              reason: 'taxon_not_found',
              accession: query.taxonId,
              sourceDatabase: 'uniprot',
            },
          },
        );
      if (query.proteomeId)
        await service.request(
          call,
          ['proteome', 'uniprot', query.proteomeId],
          {},
          SelectorDetailSchema,
          {
            missing: {
              reason: 'proteome_not_found',
              accession: query.proteomeId,
              sourceDatabase: 'uniprot',
            },
          },
        );
    }
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: proteins.length,
      limit,
      hasMore: next !== undefined,
      ...(next
        ? { nextCursor: encodeCursor('interpro_find_proteins_by_domain', query, next) }
        : {}),
    };
    ctx.enrich.total(page.total);
    ctx.enrich.echo(JSON.stringify(query));
    if (!proteins.length) {
      // Offer only the selections that can still widen this call.
      const levers = [
        ...(query.reviewedOnly ? ['with reviewedOnly=false'] : []),
        ...(query.taxonId !== ROOT_TAXON
          ? ['with taxonId 1 for all organisms or another taxonId']
          : []),
        ...(query.isFragment !== undefined
          ? ['without isFragment to include both fragment annotation groups']
          : []),
      ];
      notices.push(
        levers.length
          ? `No proteins matched the applied entry and selection. Retry interpro_find_proteins_by_domain ${levers.join(', or ')}; use interpro_get_entry to verify the accession.`
          : 'No proteins matched the applied entry and selection. Use interpro_get_entry to verify the accession.',
      );
      if (query.architectureId)
        notices.push(
          'The architectureId grouping may not include this entry: omit architectureId, or take protein.ida_accession from interpro_get_protein_domains for a protein that carries the entry.',
        );
      if (query.proteomeId)
        notices.push(
          query.taxonId === ROOT_TAXON
            ? `taxonId 1 covers every proteome's organism, so confirm proteomeId ${query.proteomeId} against protein.proteome from interpro_get_protein_domains for a protein in that proteome.`
            : `taxonId ${query.taxonId} still applies with proteomeId ${query.proteomeId}: set taxonId to protein.source_organism.taxId from interpro_get_protein_domains for a protein in that proteome, or an ancestor taxon such as 1, and confirm proteomeId against its protein.proteome.`,
        );
    }
    if (next) {
      notices.push(pageGuidance('interpro_find_proteins_by_domain', 'proteins', limit, MAX_LIMIT));
      ctx.enrich.truncated({ shown: proteins.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return { query, proteins, page, sourceUrl: response.sourceUrl };
  },
  format: formatInterpro,
});
