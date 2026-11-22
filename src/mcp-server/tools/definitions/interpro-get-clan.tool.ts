/**
 * @fileoverview Clan metadata, counted relationship slices, and paged members.
 * @module mcp-server/tools/definitions/interpro-get-clan.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
import { ClanMetadataSchema, getInterproService } from '@/services/interpro/interpro-service.js';
import {
  orderRelationships,
  RelationshipGraphSchema,
  sliceRelationships,
} from '@/services/interpro/relationships.js';
import { resolveClan } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  EntrySummarySchema,
  JsonValueSchema,
  listSchema,
  optionalString,
  PageSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const MAX_LIMIT = 100;
const DEFAULT_RELATIONSHIP_LIMIT = 20;
/** Below the ~1 MB-per-surface point, since the member page and any thumbnail share the reply. */
const MAX_RELATIONSHIP_LIMIT = 5_000;
const ClanSourceSchema = z.enum(['pfam', 'cdd', 'pirsf']).describe('Set database.');
const CLAN_ROUTE_RECOVERY =
  'Retry interpro_get_clan with CL plus four digits for Pfam, CL plus five digits for CDD, or PIRSF plus digits for PIRSF. For an accession outside those patterns, supply its sourceDatabase.';
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
  limit: z
    .number()
    .int()
    .positive()
    .describe('Effective relationshipLimit after clamping: the most items one slice holds.'),
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
    'Retrieve a Pfam, CDD, or PIRSF clan/set and a cursor page of member entries; optionally include its relationship graph, returned in slices of relationshipLimit nodes and links and paged with relationshipOffset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_clan:read'],
  input: z.object({
    accession: AccessionSchema.describe(
      'Set accession: CL plus four digits for Pfam, CL plus five digits for CDD, or PIRSF plus digits. Letter case does not affect routing; no URL syntax.',
    ),
    sourceDatabase: optionalString(ClanSourceSchema).describe(
      'Inferred from CL plus four digits (Pfam), CL plus five digits (CDD), or PIRSF plus digits. Supply explicitly for nonstandard accessions.',
    ),
    includeRelationships: z
      .boolean()
      .default(false)
      .describe(
        'Include the relationship graph, one slice of relationshipLimit items per call; defaults to false.',
      ),
    relationshipOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Position of the first relationship item to return, counting nodes, then links; defaults to 0. A value above 0 requires includeRelationships: true; pass relationshipsPage.nextOffset to continue.',
      ),
    relationshipLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Positive integer number of relationship items per slice, counting nodes, then links; values above 5,000 are clamped to 5,000 with a notice; defaults to 20. Requires includeRelationships: true.',
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
      .default(20)
      .describe(
        'Positive integer member page size; values above 100 are clamped to 100 with a notice; defaults to 20.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque nextCursor with unchanged accession, sourceDatabase, and includeRelationships; limit, relationshipOffset, relationshipLimit, and includeThumbnail may change.',
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
    cap: z.number().int().optional().describe('Effective member page size after clamping.'),
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
      recovery: CLAN_ROUTE_RECOVERY,
      thrownBy: 'service',
    },
    {
      reason: 'accession_source_unknown',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Accession has no inferred or explicit database.',
      retryable: false,
      recovery: CLAN_ROUTE_RECOVERY,
      thrownBy: 'service',
    },
    {
      reason: 'relationships_not_requested',
      code: JsonRpcErrorCode.ValidationError,
      when: 'relationshipOffset above 0 or any relationshipLimit is supplied without includeRelationships: true; relationshipOffset 0 is accepted as a no-op.',
      retryable: false,
      recovery:
        'Repeat interpro_get_clan with includeRelationships: true to page the relationship graph, or omit relationshipOffset and relationshipLimit.',
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
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second deadline expires across the set metadata and member page.',
      retryable: true,
      recovery:
        'Retry interpro_get_clan after waiting, with a smaller limit for a lighter member page.',
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
    const limit = Math.min(input.limit, MAX_LIMIT);
    if (!input.includeRelationships) {
      const paging = [
        ...(input.relationshipOffset > 0 ? [`relationshipOffset ${input.relationshipOffset}`] : []),
        ...(input.relationshipLimit !== undefined
          ? [`relationshipLimit ${input.relationshipLimit}`]
          : []),
      ];
      if (paging.length)
        throw ctx.fail(
          'relationships_not_requested',
          `${paging.join(' and ')} ${paging.length > 1 ? 'page' : 'pages'} the relationship graph, which this call did not request.`,
        );
    }
    const relationshipLimit = Math.min(
      input.relationshipLimit ?? DEFAULT_RELATIONSHIP_LIMIT,
      MAX_RELATIONSHIP_LIMIT,
    );
    const target = resolveClan(input.accession, input.sourceDatabase);
    // includeThumbnail shapes only the clan metadata, so it stays out of the member cursor scope.
    const scope = { ...target, includeRelationships: input.includeRelationships };
    const cursor = decodeCursor(input.cursor, 'interpro_get_clan', scope);
    const service = getInterproService();
    const call = service.begin(ctx);
    const detail = await service.clanDetail(call, target);
    const response = await service.request(
      call,
      ['entry', target.sourceDatabase, 'set', target.sourceDatabase, target.accession],
      { page_size: limit, cursor },
      listSchema(MemberSchema),
      { continuation: cursor !== undefined },
    );
    const thumbnails = projectWikipediaThumbnails(
      detail.metadata,
      input.includeThumbnail,
      'interpro_get_clan',
    );
    const { relationships: graph, ...clan } = normalizeImages(thumbnails.metadata);
    const members = normalizeImages(response.data?.results ?? []);
    const next = continuation(response.data?.next ?? null, new Set(cursor ? [cursor] : []));
    const page = {
      total: response.data?.count ?? 0,
      returned: members.length,
      limit,
      hasMore: next !== undefined,
      ...(next ? { nextCursor: encodeCursor('interpro_get_clan', scope, next) } : {}),
    };
    ctx.enrich.total(page.total);
    ctx.enrich.echo(JSON.stringify({ ...scope, includeThumbnail: input.includeThumbnail }));
    const notices =
      input.limit > limit ? [`Requested limit ${input.limit} was clamped to ${limit}.`] : [];
    let clanValue: typeof clan = clan;
    let relationshipsPage: z.infer<typeof RelationshipsPageSchema> | undefined;
    if (!input.includeRelationships)
      notices.push(
        'Relationships are omitted; set includeRelationships=true to page the relationship graph.',
      );
    else {
      const parsed = RelationshipGraphSchema.safeParse(graph);
      if (!parsed.success)
        throw ctx.fail('upstream_shape_invalid', 'Clan relationships lack node and link arrays.');
      if (input.relationshipLimit !== undefined && input.relationshipLimit > relationshipLimit)
        notices.push(
          `Requested relationshipLimit ${input.relationshipLimit} was clamped to ${relationshipLimit}.`,
        );
      const offset = input.relationshipOffset;
      const slice = sliceRelationships(orderRelationships(parsed.data), offset, relationshipLimit);
      if (slice.relationships !== undefined)
        clanValue = { ...clan, relationships: slice.relationships };
      relationshipsPage = slice.page;
      const { totalNodes, totalLinks, returnedNodes, returnedLinks, nextOffset } = slice.page;
      const total = totalNodes + totalLinks;
      if (!total) notices.push('InterPro returned no relationship nodes or links for this clan.');
      else if (offset >= total)
        notices.push(
          `relationshipOffset ${offset} is past the end of the relationship graph (${totalNodes} nodes and ${totalLinks} links, ${total} items); repeat interpro_get_clan with a relationshipOffset below ${total}, or 0 to start over.`,
        );
      if (nextOffset !== undefined) {
        const nextCall = {
          accession: target.accession,
          sourceDatabase: target.sourceDatabase,
          includeRelationships: true,
          relationshipOffset: nextOffset,
          relationshipLimit,
          limit,
          ...(input.includeThumbnail ? { includeThumbnail: true } : {}),
          ...(input.cursor ? { cursor: input.cursor } : {}),
        };
        notices.push(
          `This relationship slice holds items ${offset} to ${nextOffset - 1} of ${total}, nodes first, then links (${returnedNodes} of ${totalNodes} nodes, ${returnedLinks} of ${totalLinks} links). Continue with interpro_get_clan ${JSON.stringify(nextCall)}${relationshipLimit < MAX_RELATIONSHIP_LIMIT ? `; relationshipLimit may rise to ${MAX_RELATIONSHIP_LIMIT.toLocaleString('en-US')} for larger slices` : ''}.`,
        );
      }
    }
    if (thumbnails.notice) notices.push(thumbnails.notice);
    if (!members.length)
      notices.push('This member page is empty; the clan metadata remains available.');
    if (next) {
      notices.push(pageGuidance('interpro_get_clan', 'members', limit, MAX_LIMIT));
      ctx.enrich.truncated({
        shown: members.length,
        cap: limit,
        guidance: notices.join(' '),
      });
    } else if (notices.length) ctx.enrich.notice(notices.join(' '));
    return {
      ...target,
      clan: clanValue,
      relationshipsIncluded: input.includeRelationships,
      ...(relationshipsPage ? { relationshipsPage } : {}),
      members,
      page,
      url: `https://www.ebi.ac.uk/interpro/set/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: detail.sourceUrl,
    };
  },
  format: formatInterpro,
});
