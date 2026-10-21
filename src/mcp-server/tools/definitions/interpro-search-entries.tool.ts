/**
 * @fileoverview Cursor-paged entry and signature discovery.
 * @module mcp-server/tools/definitions/interpro-search-entries.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { continuation, decodeCursor, encodeCursor } from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { ENTRY_ROUTES } from '@/services/interpro/routing.js';
import {
  EntrySummarySchema,
  EntryTypeSchema,
  JsonValueSchema,
  listSchema,
  optionalString,
  PageSchema,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';

const QuerySchema = z.object({
  sourceDatabase: SourceDatabaseSchema,
  query: z.string().optional().describe('Applied text search.'),
  entryType: EntryTypeSchema.optional().describe('Applied entry type.'),
  goTerm: z.string().optional().describe('Applied GO identifier.'),
  goCategory: z.enum(['P', 'F', 'C']).optional().describe('Applied GO category.'),
  integratedInto: z.string().optional().describe('Applied integrating InterPro accession.'),
});
const RowSchema = z
  .object({ metadata: EntrySummarySchema.describe('Entry summary.') })
  .catchall(JsonValueSchema);

/** Search or browse one database without per-record detail requests. */
export const interproSearchEntries = tool('interpro_search_entries', {
  title: 'Search InterPro entries',
  description:
    'Search InterPro entries or member signatures by text, entry type, GO annotation, or integrated InterPro accession. Results are cursor-paged; use interpro_get_entry for full metadata.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_search_entries:read'],
  input: z.object({
    sourceDatabase: SourceDatabaseSchema.default('interpro').describe(
      'Database to search; defaults to interpro.',
    ),
    query: optionalString(z.string().trim().min(1).max(300)).describe(
      'Text to search; omit all filters to browse the database.',
    ),
    entryType: optionalString(EntryTypeSchema).describe('Entry annotation type.'),
    goTerm: optionalString(
      z
        .string()
        .trim()
        .regex(/^GO:\d{7}$/),
    ).describe('GO annotation identifier such as GO:0003677.'),
    goCategory: optionalString(z.enum(['P', 'F', 'C'])).describe(
      'GO category: P biological process, F molecular function, C cellular component.',
    ),
    integratedInto: optionalString(
      z
        .string()
        .trim()
        .regex(/^IPR\d{6}$/i),
    ).describe('Integrating InterPro accession; requires a member sourceDatabase.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Page size, from 1 to 100; defaults to 20.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor from this tool with unchanged filters; limit may change.',
    ),
  }),
  output: z.object({
    query: QuerySchema.describe('Applied canonical filters.'),
    entries: z
      .array(EntrySummarySchema.describe('Complete entry summary.'))
      .describe('Complete entry summaries from this page.'),
    page: PageSchema.describe('Continuation and upstream total.'),
    sourceUrl: z.string().describe('Official API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation or recovery guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching records.'),
    truncated: z.boolean().optional().describe('More records remain.'),
    shown: z.number().int().optional().describe('Records returned in this page.'),
    cap: z.number().int().optional().describe('Requested page size.'),
    effectiveQuery: z.string().optional().describe('Applied filters as JSON.'),
  },
  errors: [
    {
      reason: 'database_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Integration filtering is requested on the integrating database.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, then retry with the matching sourceDatabase.',
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
  ],
  async handler(input, ctx) {
    if (input.integratedInto && input.sourceDatabase === 'interpro')
      throw ctx.fail('database_mismatch', 'integratedInto requires a member sourceDatabase.');
    const query = {
      sourceDatabase: input.sourceDatabase,
      ...(input.query ? { query: input.query } : {}),
      ...(input.entryType ? { entryType: input.entryType } : {}),
      ...(input.goTerm ? { goTerm: input.goTerm } : {}),
      ...(input.goCategory ? { goCategory: input.goCategory } : {}),
      ...(input.integratedInto ? { integratedInto: input.integratedInto.toUpperCase() } : {}),
    };
    const cursor = decodeCursor(input.cursor, 'interpro_search_entries', query);
    const service = getInterproService();
    const response = await service.request(
      service.begin(ctx),
      ['entry', query.sourceDatabase],
      {
        search: query.query,
        type: query.entryType,
        go_term: query.goTerm,
        go_category: query.goCategory,
        integrated: query.integratedInto,
        page_size: input.limit,
        cursor,
      },
      listSchema(RowSchema),
      { continuation: cursor !== undefined },
    );
    const entries = normalizeImages(response.data?.results.map((row) => row.metadata) ?? []);
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: entries.length,
      limit: input.limit,
      hasMore: next !== undefined,
      ...(next ? { nextCursor: encodeCursor('interpro_search_entries', query, next) } : {}),
    };
    ctx.enrich.total(page.total);
    ctx.enrich.echo(JSON.stringify(query));
    if (next) ctx.enrich.truncated({ shown: entries.length, cap: input.limit });
    if (!entries.length) {
      const memberText =
        input.sourceDatabase === 'interpro' &&
        input.query &&
        ENTRY_ROUTES.some(
          (route) => route.source !== 'interpro' && route.pattern.test(input.query ?? ''),
        );
      ctx.enrich.notice(
        'No entries matched the applied filters. Remove query, entryType, goTerm, goCategory, or integratedInto filters that are present; call interpro_list_reference with topic databases to check sourceDatabase.' +
          (memberText
            ? ' Use interpro_get_entry with the accession to infer its member database.'
            : ''),
      );
    }
    return { query, entries, page, sourceUrl: response.sourceUrl };
  },
  format: formatInterpro,
});
