/**
 * @fileoverview Clan metadata, relationship projection, and paged members.
 * @module mcp-server/tools/definitions/interpro-get-clan.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { continuation, decodeCursor, encodeCursor } from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveClan } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  detailSchema,
  EntrySummarySchema,
  JsonValueSchema,
  listSchema,
  optionalString,
  PageSchema,
} from '@/services/interpro/schemas.js';

const ClanSourceSchema = z.enum(['pfam', 'cdd', 'pirsf']).describe('Set database.');
const ClanMetadataSchema = z
  .object({
    accession: z.string().describe('Upstream set accession.'),
    source_database: z.string().describe('Upstream set database.'),
  })
  .catchall(JsonValueSchema);
const MemberSchema = z
  .object({
    metadata: EntrySummarySchema.describe('Complete member entry metadata.'),
    sets: z.array(JsonValueSchema).describe('Complete upstream set associations.'),
  })
  .catchall(JsonValueSchema);

/** Retrieve one clan and a page of members under one shared deadline. */
export const interproGetClan = tool('interpro_get_clan', {
  title: 'InterPro clan metadata and members',
  description:
    'Retrieve a Pfam, CDD, or PIRSF clan/set and a cursor page of member entries; optionally include the complete relationship graph.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_clan:read'],
  input: z.object({
    accession: AccessionSchema,
    sourceDatabase: optionalString(ClanSourceSchema).describe(
      'Inferred from uppercase CL (Pfam), lowercase cl (CDD), or PIRSF; supply explicitly for mixed-case CL prefixes.',
    ),
    includeRelationships: z
      .boolean()
      .default(false)
      .describe('Include the complete relationship graph; defaults to false.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Member page size from 1 to 100; defaults to 20.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged accession, sourceDatabase, and includeRelationships; limit may change.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical requested clan accession.'),
    sourceDatabase: ClanSourceSchema,
    clan: ClanMetadataSchema.describe(
      'Complete metadata, with relationships omitted unless requested.',
    ),
    relationshipsIncluded: z.boolean().describe('Whether relationship projection was requested.'),
    members: z
      .array(MemberSchema.describe('Complete upstream member record.'))
      .describe('Complete upstream member records.'),
    page: PageSchema.describe('Member continuation and total.'),
    url: z.string().describe('Canonical InterPro clan website URL.'),
    sourceUrl: z.string().describe('Official clan metadata API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Relationship projection or empty-page guidance.'),
    totalCount: z.number().optional().describe('Total matching members.'),
    truncated: z.boolean().optional().describe('More members remain.'),
    shown: z.number().int().optional().describe('Members returned in this page.'),
    cap: z.number().int().optional().describe('Requested member page size.'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Applied canonical target and relationship selection.'),
  },
  errors: [
    {
      reason: 'database_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Explicit database conflicts with accession routing.',
      retryable: false,
      recovery:
        'Retry interpro_get_clan with sourceDatabase pfam for uppercase CL, cdd for lowercase cl, or pirsf for PIRSF; supply pfam or cdd explicitly for mixed-case CL prefixes.',
      thrownBy: 'service',
    },
    {
      reason: 'accession_source_unknown',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Accession has no inferred or explicit database.',
      retryable: false,
      recovery:
        'Retry interpro_get_clan with sourceDatabase pfam for uppercase CL, cdd for lowercase cl, or pirsf for PIRSF; supply pfam or cdd explicitly for mixed-case CL prefixes.',
      thrownBy: 'service',
    },
    {
      reason: 'clan_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Set metadata returns 204 or 404.',
      retryable: false,
      recovery:
        'Read set_info with interpro_get_entry, then retry interpro_get_clan with that accession and database.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_withdrawn',
      code: JsonRpcErrorCode.NotFound,
      when: 'Entry or set returns 410.',
      retryable: false,
      recovery:
        'Call interpro_search_entries for a current replacement; consult interpro_list_reference with topic databases for source names.',
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
    const target = resolveClan(input.accession, input.sourceDatabase);
    const scope = { ...target, includeRelationships: input.includeRelationships };
    const cursor = decodeCursor(input.cursor, 'interpro_get_clan', scope);
    const service = getInterproService();
    const call = service.begin(ctx);
    const detail = await service.request(
      call,
      ['set', target.sourceDatabase, target.accession],
      {},
      detailSchema(ClanMetadataSchema),
      { missing: 'clan_not_found' },
    );
    if (!detail.data)
      throw ctx.fail('upstream_shape_invalid', 'Clan metadata response is missing.');
    const response = await service.request(
      call,
      ['entry', target.sourceDatabase, 'set', target.sourceDatabase, target.accession],
      { page_size: input.limit, cursor },
      listSchema(MemberSchema),
      { continuation: cursor !== undefined },
    );
    const clan = normalizeImages(detail.data.metadata);
    if (!input.includeRelationships) delete clan.relationships;
    const members = normalizeImages(response.data?.results ?? []);
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: members.length,
      limit: input.limit,
      hasMore: next !== undefined,
      ...(next ? { nextCursor: encodeCursor('interpro_get_clan', scope, next) } : {}),
    };
    ctx.enrich.total(page.total);
    ctx.enrich.echo(JSON.stringify(scope));
    if (next) ctx.enrich.truncated({ shown: members.length, cap: input.limit });
    const notices = [];
    if (!input.includeRelationships)
      notices.push(
        'Relationships are omitted; set includeRelationships=true to include the complete graph.',
      );
    if (!members.length)
      notices.push('This member page is empty; the clan metadata remains available.');
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    return {
      ...target,
      clan,
      relationshipsIncluded: input.includeRelationships,
      members,
      page,
      url: `https://www.ebi.ac.uk/interpro/set/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: detail.sourceUrl,
    };
  },
  format: formatInterpro,
});
