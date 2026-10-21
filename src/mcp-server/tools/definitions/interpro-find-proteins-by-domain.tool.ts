/**
 * @fileoverview Entry-scoped protein discovery with explicit taxonomy and review defaults.
 * @module mcp-server/tools/definitions/interpro-find-proteins-by-domain.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { continuation, decodeCursor, encodeCursor } from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveEntry } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  JsonValueSchema,
  LocationSchema,
  listSchema,
  optionalString,
  PageSchema,
  ProteinMetadataSchema,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';

const QuerySchema = z.object({
  accession: z.string().describe('Canonical entry accession.'),
  sourceDatabase: SourceDatabaseSchema,
  taxonId: z.string().describe('Applied NCBI taxonomy identifier.'),
  reviewedOnly: z
    .boolean()
    .describe('True restricts to reviewed proteins; false includes all review statuses.'),
});
const ProteinResultSchema = z
  .object({
    metadata: ProteinMetadataSchema.describe('Complete sparse protein summary.'),
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

/** Discover proteins without fetching per-protein metadata. */
export const interproFindProteinsByDomain = tool('interpro_find_proteins_by_domain', {
  title: 'Find proteins by domain',
  description:
    'Find UniProt proteins carrying an InterPro or member signature. Defaults to reviewed human proteins; reviewedOnly=false includes reviewed and unreviewed proteins in the chosen taxon.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_find_proteins_by_domain:read'],
  input: z.object({
    accession: AccessionSchema,
    sourceDatabase: optionalString(SourceDatabaseSchema).describe(
      'Entry database slug, inferred from standard accession prefixes when omitted.',
    ),
    taxonId: z
      .string()
      .trim()
      .regex(/^[1-9][0-9]*$/)
      .default('9606')
      .describe('Positive NCBI taxonomy identifier; defaults to human 9606.'),
    reviewedOnly: z
      .boolean()
      .default(true)
      .describe('Defaults to reviewed proteins; false includes reviewed and unreviewed proteins.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Page size from 1 to 50; defaults to 20.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged target, taxonId, and reviewedOnly; limit may change.',
    ),
  }),
  output: z.object({
    query: QuerySchema.describe('Applied canonical target and selection, including defaults.'),
    proteins: z.array(ProteinResultSchema).describe('Complete upstream protein result records.'),
    page: PageSchema.describe('Page coverage and continuation.'),
    sourceUrl: z.string().describe('Official API source URL.'),
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
    const query = {
      ...resolveEntry(input.accession, input.sourceDatabase),
      taxonId: input.taxonId,
      reviewedOnly: input.reviewedOnly,
    };
    const cursor = decodeCursor(input.cursor, 'interpro_find_proteins_by_domain', query);
    const service = getInterproService();
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
      { page_size: input.limit, cursor },
      listSchema(ProteinResultSchema),
      { continuation: cursor !== undefined },
    );
    const proteins = normalizeImages(response.data?.results ?? []);
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: proteins.length,
      limit: input.limit,
      hasMore: next !== undefined,
      ...(next
        ? { nextCursor: encodeCursor('interpro_find_proteins_by_domain', query, next) }
        : {}),
    };
    ctx.enrich.total(page.total);
    ctx.enrich.echo(JSON.stringify(query));
    if (next) ctx.enrich.truncated({ shown: proteins.length, cap: input.limit });
    if (!proteins.length)
      ctx.enrich.notice(
        'No proteins matched the applied entry and taxon. Retry interpro_find_proteins_by_domain with reviewedOnly=false or another taxonId; use interpro_get_entry to verify the accession.',
      );
    return { query, proteins, page, sourceUrl: response.sourceUrl };
  },
  format: formatInterpro,
});
