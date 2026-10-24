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
});
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
const ArchitectureResultSchema = ProteinResultSchema.extend({
  entries: ProteinResultSchema.shape.entries.optional(),
  taxa: ProteinResultSchema.shape.taxa.optional(),
});
const ArchitectureOutputSchema = ArchitectureResultSchema.extend({
  detailAvailability: z
    .object({
      entries: z
        .enum(['available', 'unavailable'])
        .describe('Whether upstream supplied entry records.'),
      taxa: z
        .enum(['available', 'unavailable'])
        .describe('Whether upstream supplied taxon records.'),
    })
    .describe('Absent details are unavailable, rather than biologically empty.'),
}).describe('Complete architecture-filtered protein record with explicit detail availability.');

/** Discover proteins without fetching per-protein metadata. */
export const interproFindProteinsByDomain = tool('interpro_find_proteins_by_domain', {
  title: 'Find proteins by domain',
  description:
    'Find UniProt proteins carrying an InterPro or member signature. Defaults to reviewed human proteins; reviewedOnly=false includes all review statuses in the chosen taxon. Optional isFragment filters fragment annotations; false does not prove sequence completeness. architectureId intersects the provider Pfam grouping with these selections, without implying functional equivalence; metadata-only hits disclose unavailable entry and taxon details without per-protein requests.',
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
        .regex(/^[1-9][0-9]*$/)
        .default('9606'),
    ).describe('Positive NCBI taxonomy identifier of at most 10 digits; defaults to human 9606.'),
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
      'Optional 40-character hexadecimal Pfam architecture grouping ID from protein.ida_accession; grouping does not establish functional equivalence.',
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
      'Opaque nextCursor with unchanged target, taxonId, reviewedOnly, isFragment, and architectureId selection; limit may change.',
    ),
  }),
  output: z.object({
    query: QuerySchema.describe('Applied canonical target and selection, including defaults.'),
    proteins: z
      .array(
        z
          .union([ProteinResultSchema, ArchitectureOutputSchema])
          .describe(
            'Ordinary protein details or an architecture-filtered record with detail availability.',
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
      when: 'The accession is a set accession, or InterPro rejects it for its database with HTTP 404.',
      retryable: false,
      recovery:
        'Call interpro_search_entries in the correct database, or interpro_list_reference with topic accession_patterns.',
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
    };
    const cursor = decodeCursor(input.cursor, 'interpro_find_proteins_by_domain', query);
    const service = getInterproService();
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
                entries:
                  row.entries === undefined ? ('unavailable' as const) : ('available' as const),
                taxa: row.taxa === undefined ? ('unavailable' as const) : ('available' as const),
              },
            }),
        )
      : ProteinResultSchema;
    const response = await service.request(
      service.begin(ctx),
      [
        'protein',
        query.reviewedOnly ? 'reviewed' : 'uniprot',
        'entry',
        query.sourceDatabase,
        query.accession,
        'taxonomy',
        'uniprot',
        query.taxonId,
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
    if (!proteins.length)
      notices.push(
        `No proteins matched the applied entry and selection. Retry interpro_find_proteins_by_domain with reviewedOnly=false or another taxonId${input.isFragment !== undefined ? ', or omit isFragment to include both fragment annotation groups' : ''}; use interpro_get_entry to verify the accession.`,
      );
    if (next) {
      notices.push(pageGuidance('interpro_find_proteins_by_domain', 'proteins', limit, MAX_LIMIT));
      ctx.enrich.truncated({ shown: proteins.length, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return { query, proteins, page, sourceUrl: response.sourceUrl };
  },
  format: formatInterpro,
});
