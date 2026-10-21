/**
 * @fileoverview Clan metadata, budget-bounded relationship slices, and paged members.
 * @module mcp-server/tools/definitions/interpro-get-clan.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { BUDGET_LABEL, fitWithinBudget } from '@/services/interpro/budget.js';
import {
  continuation,
  decodeCursor,
  encodeCursor,
  pageGuidance,
} from '@/services/interpro/cursors.js';
import {
  formatInterpro,
  normalizeImages,
  projectWikipediaThumbnails,
} from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  orderRelationships,
  RelationshipGraphSchema,
  sliceRelationships,
} from '@/services/interpro/relationships.js';
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
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const MAX_LIMIT = 100;
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
const RelationshipsPageSchema = z.object({
  totalNodes: z.number().int().nonnegative().describe('Nodes in the complete graph.'),
  totalLinks: z.number().int().nonnegative().describe('Links in the complete graph.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .describe(
      'Requested relationshipOffset: position of the first returned item among every node sorted by accession, followed by every link sorted by source, target, and method.',
    ),
  returnedNodes: z.number().int().nonnegative().describe('Nodes in this slice.'),
  returnedLinks: z.number().int().nonnegative().describe('Links in this slice.'),
  hasMore: z.boolean().describe('Whether nodes or links remain after this slice.'),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('relationshipOffset of the next slice; present only when hasMore is true.'),
});

/** Retrieve one clan and a page of members under one shared deadline. */
export const interproGetClan = tool('interpro_get_clan', {
  title: 'InterPro clan metadata and members',
  description:
    'Retrieve a Pfam, CDD, or PIRSF clan/set and a cursor page of member entries; optionally include its relationship graph, returned in slices that fit the response budget and paged with relationshipOffset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_clan:read'],
  input: z.object({
    accession: AccessionSchema.describe(
      'Set accession, such as CL0016 (Pfam), cl21453 (CDD), or PIRSF000047; no URL syntax.',
    ),
    sourceDatabase: optionalString(ClanSourceSchema).describe(
      'Inferred from uppercase CL (Pfam), lowercase cl (CDD), or PIRSF; supply explicitly for mixed-case CL prefixes.',
    ),
    includeRelationships: z
      .boolean()
      .default(false)
      .describe(
        'Include the relationship graph, one slice per call that fits the response budget; defaults to false.',
      ),
    relationshipOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Position of the first relationship item to return, counting nodes, then links; defaults to 0. A value above 0 requires includeRelationships: true; pass relationshipsPage.nextOffset to continue.',
      ),
    includeThumbnail: z
      .boolean()
      .default(false)
      .describe(
        'Include each Wikipedia thumbnail image, base64 data often tens of KB; defaults to false.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(20)
      .describe('Member page size from 1 to 100; defaults to 20.'),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged accession, sourceDatabase, and includeRelationships; limit, relationshipOffset, and includeThumbnail may change.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical requested clan accession.'),
    sourceDatabase: ClanSourceSchema,
    clan: ClanMetadataSchema.describe(
      'Complete metadata, with relationships and Wikipedia thumbnails omitted unless requested; requested relationships hold the slice relationshipsPage locates.',
    ),
    relationshipsIncluded: z.boolean().describe('Whether relationship projection was requested.'),
    relationshipsPage: RelationshipsPageSchema.optional().describe(
      'Position and totals of the relationship slice; present only when includeRelationships is true.',
    ),
    members: z
      .array(MemberSchema.describe('Complete upstream member record.'))
      .describe('Complete upstream member records.'),
    page: PageSchema.describe('Member continuation and total.'),
    url: z.string().describe('Canonical InterPro clan website URL.'),
    sourceUrl: z.string().describe('Official clan metadata API source URL.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Next relationship slice call, omitted relationships or thumbnails, or empty-page guidance.',
      ),
    totalCount: z.number().optional().describe('Total matching members.'),
    truncated: z.boolean().optional().describe('More members remain.'),
    shown: z.number().int().optional().describe('Members returned in this page.'),
    cap: z.number().int().optional().describe('Requested member page size.'),
    effectiveQuery: z
      .string()
      .optional()
      .describe('Applied canonical target, relationship, and thumbnail selection.'),
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
      reason: 'relationships_not_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'relationshipOffset above 0 is supplied without includeRelationships: true; 0 is accepted as a no-op.',
      retryable: false,
      recovery:
        'Repeat interpro_get_clan with includeRelationships: true to page the relationship graph, or omit relationshipOffset.',
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
    ...UPSTREAM_ERRORS,
  ],
  async handler(input, ctx) {
    if (input.relationshipOffset > 0 && !input.includeRelationships)
      throw ctx.fail(
        'relationships_not_requested',
        `relationshipOffset ${input.relationshipOffset} pages the relationship graph, which this call did not request.`,
      );
    const target = resolveClan(input.accession, input.sourceDatabase);
    // includeThumbnail shapes only the clan metadata reread on every page, so it stays out of scope.
    const scope = { ...target, includeRelationships: input.includeRelationships };
    const cursor = decodeCursor(input.cursor, 'interpro_get_clan', scope);
    const service = getInterproService();
    const call = service.begin(ctx);
    const detail = await service.request(
      call,
      ['set', target.sourceDatabase, target.accession],
      {},
      detailSchema(ClanMetadataSchema),
      { missing: { reason: 'clan_not_found', ...target } },
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
    const thumbnails = projectWikipediaThumbnails(
      detail.data.metadata,
      input.includeThumbnail,
      'interpro_get_clan',
    );
    const { relationships: graph, ...clan } = normalizeImages(thumbnails.metadata);
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
    ctx.enrich.echo(JSON.stringify({ ...scope, includeThumbnail: input.includeThumbnail }));
    const result = (
      clanValue: typeof clan,
      relationshipsPage?: z.infer<typeof RelationshipsPageSchema>,
    ) => ({
      ...target,
      clan: clanValue,
      relationshipsIncluded: input.includeRelationships,
      ...(relationshipsPage ? { relationshipsPage } : {}),
      members,
      page,
      url: `https://www.ebi.ac.uk/interpro/set/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: detail.sourceUrl,
    });
    const notices = [];
    let output = result(clan);
    if (!input.includeRelationships)
      notices.push(
        'Relationships are omitted; set includeRelationships=true to page the relationship graph.',
      );
    else {
      const parsed = RelationshipGraphSchema.safeParse(graph);
      if (!parsed.success)
        throw ctx.fail('upstream_shape_invalid', 'Clan relationships lack node and link arrays.');
      const ordered = orderRelationships(parsed.data);
      const offset = input.relationshipOffset;
      const total = (ordered?.nodes.length ?? 0) + (ordered?.links.length ?? 0);
      const sliceAt = (count: number) => sliceRelationships(ordered, offset, count);
      const withSlice = ({ relationships, page: slicePage }: ReturnType<typeof sliceAt>) =>
        result(relationships === undefined ? clan : { ...clan, relationships }, slicePage);
      const fit = fitWithinBudget(Math.max(0, total - offset), (n) => withSlice(sliceAt(n)));
      const slice = sliceAt(fit.count);
      output = fit.output;
      const { totalNodes, totalLinks, returnedNodes, returnedLinks, nextOffset } = slice.page;
      if (!total) notices.push('InterPro returned no relationship nodes or links for this clan.');
      else if (offset >= total)
        notices.push(
          `relationshipOffset ${offset} is past the end of the relationship graph (${totalNodes} nodes and ${totalLinks} links, ${total} items); repeat interpro_get_clan with a relationshipOffset below ${total}, or 0 to start over.`,
        );
      if (fit.oversized) {
        const roomier = [
          ...(input.includeThumbnail ? ['includeThumbnail: false'] : []),
          ...(input.limit > 1 ? ['a smaller limit'] : []),
        ];
        notices.push(
          `The clan metadata and member page leave no room in the ${BUDGET_LABEL}, so this slice holds one item and exceeds it${roomier.length ? `; repeat with ${roomier.join(' or ')} for larger slices` : ''}.`,
        );
      }
      if (nextOffset !== undefined) {
        const nextCall = {
          accession: target.accession,
          sourceDatabase: target.sourceDatabase,
          includeRelationships: true,
          relationshipOffset: nextOffset,
          limit: input.limit,
          ...(input.includeThumbnail ? { includeThumbnail: true } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        };
        notices.push(
          `This relationship slice holds items ${offset} to ${nextOffset - 1} of ${total}, nodes first, then links (${returnedNodes} of ${totalNodes} nodes, ${returnedLinks} of ${totalLinks} links). Continue with interpro_get_clan ${JSON.stringify(nextCall)}${input.limit > 1 ? '; a smaller limit leaves more of the response budget to each slice' : ''}.`,
        );
      }
    }
    if (thumbnails.notice) notices.push(thumbnails.notice);
    if (!members.length)
      notices.push('This member page is empty; the clan metadata remains available.');
    if (next) {
      notices.push(pageGuidance('interpro_get_clan', 'members', input.limit, MAX_LIMIT));
      ctx.enrich.truncated({
        shown: members.length,
        cap: input.limit,
        guidance: notices.join(' '),
      });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return output;
  },
  format: formatInterpro,
});
