/**
 * @fileoverview List InterPro domain architectures matching Pfam or integrated InterPro domains.
 * @module mcp-server/tools/definitions/interpro-find-architectures.tool
 */
import { createHash } from 'node:crypto';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  continuation,
  cursorScope,
  decodeCursor,
  encodeCursor,
  pageGuidance,
} from '@/services/interpro/cursors.js';
import { formatInterpro } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  JsonObjectSchema,
  JsonValueSchema,
  listSchema,
  optionalString,
  PageSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const OPERATION = 'interpro_find_architectures';
const MAX_LIMIT = 200;
const DomainAccession = z
  .string()
  .trim()
  .regex(/^(?:[Pp][Ff]\d{5}|[Ii][Pp][Rr]\d{6})$/, 'Use a Pfam or InterPro domain accession.')
  .toUpperCase()
  .describe(
    'Pfam or InterPro accession. An InterPro entry must integrate a Pfam signature to participate.',
  );
const Domains = z
  .array(DomainAccession)
  .min(1)
  .describe('One or more domain accessions, retaining order and repeats.');
const Ignore = z
  .array(DomainAccession)
  .optional()
  .describe('Domains excluded from matching architectures.');
const Query = z.object({
  domains: Domains,
  ignore: Ignore,
  ordered: z.boolean().describe('Whether the requested domain order applies.'),
  exact: z.boolean().describe('Whether matches consist exactly of the requested ordered domains.'),
});
const Architecture = z
  .object({
    ida: z.string().describe('InterPro architecture composition string.'),
    ida_id: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .describe('Pfam grouping ID accepted as architectureId by interpro_find_proteins_by_domain.'),
    unique_proteins: z
      .number()
      .int()
      .nonnegative()
      .describe('Unique proteins counted across all taxonomic and review groups.'),
    representative: z
      .object({
        accession: z.string().describe('Representative UniProt protein accession.'),
        length: z.number().int().positive().describe('Representative sequence length in residues.'),
        domains: z
          .array(
            z
              .object({
                accession: z.string().describe('Domain accession on the representative.'),
                name: z.string().describe('Domain name on the representative.'),
                coordinates: z
                  .array(JsonObjectSchema)
                  .describe('Complete native coordinates, including each range of fragments.'),
              })
              .catchall(JsonValueSchema)
              .describe('Complete native representative domain record.'),
          )
          .describe('Representative domain records in upstream order.'),
      })
      .catchall(JsonValueSchema)
      .describe('Complete representative protein record.'),
  })
  .catchall(JsonValueSchema)
  .describe('Complete native architecture record.');
const ArchitecturePageSchema = listSchema(Architecture);

/** List one page of architecture rows without reading individual proteins. */
export const interproFindArchitectures = tool(OPERATION, {
  title: 'Find domain architectures',
  description:
    'List InterPro domain architectures containing the supplied Pfam or InterPro domains. Order and repeated domains are preserved; exact matching requires the given order and excludes extra domains. Pass an ida_id to interpro_find_proteins_by_domain as architectureId with one of the architecture’s domains as accession to list matching proteins.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_find_architectures:read'],
  input: z.object({
    domains: Domains,
    ignore: Ignore,
    ordered: z.boolean().default(false).describe('Require the supplied domain order.'),
    exact: z
      .boolean()
      .default(false)
      .describe('Require exactly the supplied domains in order. Implies ordered.'),
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe('Positive integer page size, clamped to 200 with a notice. Defaults to 20.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged effective selection. The limit may change.',
    ),
  }),
  output: z.object({
    query: Query.describe('Canonical applied architecture selection.'),
    architectures: z.array(Architecture).describe('Complete architecture rows in upstream order.'),
    page: PageSchema.describe('Page coverage and continuation.'),
    sourceUrl: z.string().describe('Official API source URL.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Interpretation or continuation guidance.'),
    totalCount: z.number().optional().describe('Upstream total matching architectures.'),
    truncated: z.boolean().optional().describe('More architectures remain.'),
    shown: z.number().int().optional().describe('Architecture rows returned.'),
    cap: z.number().int().optional().describe('Effective page size after clamping.'),
  },
  errors: [
    {
      reason: 'entry_withdrawn',
      code: JsonRpcErrorCode.NotFound,
      when: 'InterPro reports HTTP 410 for the requested record.',
      retryable: false,
      recovery: 'Call interpro_search_entries to find current Pfam and InterPro accessions.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed, belongs to another selection, or is rejected upstream.',
      retryable: false,
      recovery: 'Repeat the same tool without cursor to restart pagination.',
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires while fetching the architecture page.',
      retryable: true,
      recovery: 'Repeat the same tool after waiting, with a smaller limit for a lighter page.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream JSON, row shape, or continuation is incompatible.',
      retryable: false,
      recovery:
        'Retry the same tool later; call interpro_list_reference with topic release to check upstream availability.',
      thrownBy: 'service',
    },
    ...UPSTREAM_ERRORS,
  ],
  async handler(input, ctx) {
    const query = {
      domains: input.domains,
      ...(input.ignore?.length ? { ignore: input.ignore } : {}),
      ordered: input.ordered || input.exact,
      exact: input.exact,
    };
    const limit = Math.min(input.limit, MAX_LIMIT);
    // Keep the cursor bounded even when the selection contains long domain lists.
    const scope = createHash('sha256').update(cursorScope(query)).digest('base64url');
    const cursor = decodeCursor(input.cursor, OPERATION, scope);
    const service = getInterproService();
    const response = await service.request(
      service.begin(ctx),
      ['entry'],
      {
        ida_search: query.domains.join(','),
        ida_ignore: query.ignore?.join(','),
        ordered: query.ordered ? '' : undefined,
        exact: query.exact ? '' : undefined,
        page_size: limit,
        cursor,
      },
      ArchitecturePageSchema,
      { continuation: cursor !== undefined },
    );
    const architectures = response.data?.results ?? [];
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: architectures.length,
      limit,
      hasMore: next !== undefined,
      ...(next ? { nextCursor: encodeCursor(OPERATION, scope, next) } : {}),
    };
    const notices =
      input.limit > limit ? [`Requested limit ${input.limit} was clamped to ${limit}.`] : [];
    ctx.enrich.total(page.total);
    if (!architectures.length)
      notices.push(
        cursor
          ? 'This continuation page is empty: InterPro lists no further architectures.'
          : 'InterPro found no architectures for these domains and selections.',
      );
    if (next) {
      notices.push(pageGuidance(OPERATION, 'architectures', limit, MAX_LIMIT));
      ctx.enrich.truncated({
        shown: architectures.length,
        cap: limit,
        guidance: notices.join(' '),
      });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return { query, architectures, page, sourceUrl: response.sourceUrl };
  },
  format: formatInterpro,
});
