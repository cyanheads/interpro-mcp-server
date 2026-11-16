/**
 * @fileoverview Complete InterPro and member entry metadata.
 * @module mcp-server/tools/definitions/interpro-get-entry.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { descriptionText } from '@/services/interpro/description-text.js';
import {
  formatInterpro,
  normalizeImages,
  projectWikipediaThumbnails,
} from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveEntry } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  detailSchema,
  EntryDetailMetadataSchema,
  EntryMetadataSchema,
  optionalString,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

const SECTIONS = [
  'description',
  'hierarchy',
  'member_databases',
  'go_terms',
  'literature',
  'cross_references',
  'wikipedia',
  'counters',
  'overlaps_with',
] as const;
const SectionSchema = z.enum(SECTIONS);
/** Overlap records per page when the call names no overlapLimit. */
const DEFAULT_OVERLAP_LIMIT = 20;
const MAX_OVERLAP_LIMIT = 10_000;
const OverlapsPageSchema = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(true).describe('Overlap array was supplied.'),
      total: z.number().int().nonnegative().describe('Complete upstream overlap count.'),
      offset: z.number().int().nonnegative().describe('Requested record offset.'),
      returned: z.number().int().nonnegative().describe('Complete records returned.'),
      hasMore: z.boolean().describe('More overlap records remain.'),
      nextOffset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Next offset when more records remain.'),
    })
    .describe('Page of complete upstream overlap records.'),
  z
    .object({
      available: z.literal(false).describe('Overlap array was not supplied.'),
      offset: z.number().int().nonnegative().describe('Requested record offset.'),
    })
    .describe('Overlap paging unavailable for a missing or null source section.'),
]);

/** Retrieve one complete entry with deterministic accession routing. */
export const interproGetEntry = tool('interpro_get_entry', {
  title: 'InterPro entry metadata',
  description:
    'Retrieve one InterPro or member-database entry with full metadata by default, except that an overlaps_with array of more than 20 records returns its first 20 with overlapsPage and the continuation call. Select optional sections while retaining core and unknown metadata; overlapLimit and overlapOffset page whole overlap records in upstream order, and offsets are not a snapshot across calls.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_entry:read'],
  input: z.object({
    accession: AccessionSchema.describe(
      'InterPro or member-database entry accession, such as IPR011615 or PF00870; no URL syntax.',
    ),
    sourceDatabase: optionalString(SourceDatabaseSchema).describe(
      'Database slug; inferred from standard accession prefixes when omitted.',
    ),
    includeThumbnail: z
      .boolean()
      .default(false)
      .describe(
        'Include each Wikipedia thumbnail image, base64 data often hundreds of KB; defaults to false.',
      ),
    sections: z
      .array(SectionSchema.describe('Optional metadata section to retain.'))
      .optional()
      .describe(
        'Retain these named sections and all core or unknown metadata; omitted means full detail, and an empty array retains core metadata only.',
      ),
    overlapLimit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Positive integer number of whole overlap records per page; values above 10,000 are clamped to 10,000 with a notice. Without it, pages hold 20 records, and when overlapOffset is also omitted an overlaps_with array of at most 20 records returns whole.',
      ),
    overlapOffset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Nonnegative safe integer offset of the first overlap record to return; defaults to zero. Pass overlapsPage.nextOffset to continue.',
      ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical requested accession.'),
    sourceDatabase: SourceDatabaseSchema,
    entry: EntryDetailMetadataSchema.describe(
      'Upstream metadata after explicit section selection and overlap paging, with readable descriptionText when description is retained; raw description shapes and sparse annotations survive. Wikipedia thumbnails are omitted unless includeThumbnail is true.',
    ),
    url: z.string().describe('Canonical InterPro website URL.'),
    sourceUrl: z.string().describe('Official API source URL.'),
    sections: z
      .array(SectionSchema.describe('Retained optional section.'))
      .optional()
      .describe('Canonical selected sections, when explicitly selected.'),
    omittedSections: z
      .array(SectionSchema.describe('Omitted source section.'))
      .optional()
      .describe('Named sections actually removed from upstream metadata.'),
    overlapsPage: OverlapsPageSchema.optional().describe(
      'Overlap paging state, present when overlapLimit or overlapOffset is supplied or a default call pages an array of more than 20 records; unavailable arrays have no fabricated total.',
    ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total upstream overlap records when the reply pages an available array.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Section selection, overlap page continuation or availability, and omitted Wikipedia thumbnail guidance.',
      ),
  },
  errors: [
    {
      reason: 'overlaps_not_selected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'overlapLimit or overlapOffset is supplied but sections excludes overlaps_with.',
      retryable: false,
      recovery:
        'Include overlaps_with in sections or omit sections, then retry with the same overlapLimit or overlapOffset.',
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
      when: 'Accession has no inferred or explicit database.',
      retryable: false,
      recovery:
        'Call interpro_list_reference with topic accession_patterns, or supply the sourceDatabase reported by interpro_search_entries.',
      thrownBy: 'service',
    },
    {
      reason: 'entry_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Entry detail returns 204 or 404, or the accession is a set accession.',
      retryable: false,
      recovery:
        'Call interpro_search_entries in the correct database, or interpro_list_reference with topic accession_patterns.',
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
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'The shared fifty-second budget expires while the entry request is retried.',
      retryable: true,
      recovery:
        'Repeat interpro_get_entry after waiting; sections and overlap paging do not shorten the upstream read.',
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
    const explicitPaging = input.overlapLimit !== undefined || input.overlapOffset !== undefined;
    if (explicitPaging && input.sections && !input.sections.includes('overlaps_with'))
      throw ctx.fail('overlaps_not_selected');
    const target = resolveEntry(input.accession, input.sourceDatabase);
    const service = getInterproService();
    const response = await service.request(
      service.begin(ctx),
      ['entry', target.sourceDatabase, target.accession],
      {},
      detailSchema(EntryMetadataSchema),
      { missing: { reason: 'entry_not_found', ...target } },
    );
    if (!response.data)
      throw ctx.fail('upstream_shape_invalid', 'Entry metadata response is missing.');
    const sourceMetadata = response.data.metadata;
    const selected =
      input.sections === undefined
        ? undefined
        : SECTIONS.filter((section) => input.sections?.includes(section));
    const omittedSections =
      selected === undefined
        ? undefined
        : SECTIONS.filter(
            (section) => !selected.includes(section) && Object.hasOwn(sourceMetadata, section),
          );
    const projected = { ...sourceMetadata };
    for (const section of omittedSections ?? []) delete projected[section];
    const notices: string[] = [];
    if (selected)
      notices.push(
        `Selected sections: ${JSON.stringify(selected)}; omitted source sections: ${JSON.stringify(omittedSections)}. Core and unknown metadata are retained.`,
      );
    let overlapsPage: z.infer<typeof OverlapsPageSchema> | undefined;
    const overlaps = projected.overlaps_with;
    // A call without paging input pages only an array longer than one page; any other section stays whole.
    if (explicitPaging || (Array.isArray(overlaps) && overlaps.length > DEFAULT_OVERLAP_LIMIT)) {
      const offset = input.overlapOffset ?? 0;
      const limit = Math.min(input.overlapLimit ?? DEFAULT_OVERLAP_LIMIT, MAX_OVERLAP_LIMIT);
      if (input.overlapLimit !== undefined && input.overlapLimit > limit)
        notices.push(`Requested overlapLimit ${input.overlapLimit} was clamped to ${limit}.`);
      if (overlaps === undefined || overlaps === null) {
        overlapsPage = { available: false, offset };
        notices.push(
          'Overlap paging is unavailable because upstream overlaps_with is missing or null; no total is known.',
        );
      } else {
        if (!Array.isArray(overlaps))
          throw ctx.fail('upstream_shape_invalid', 'Entry overlaps_with is not an array.');
        const slice = overlaps.slice(offset, offset + limit);
        projected.overlaps_with = slice;
        const nextOffset = offset + slice.length;
        const hasMore = nextOffset < overlaps.length;
        ctx.enrich.total(overlaps.length);
        overlapsPage = {
          available: true,
          total: overlaps.length,
          offset,
          returned: slice.length,
          hasMore,
          ...(hasMore ? { nextOffset } : {}),
        };
        notices.push(
          `Overlap page returned ${slice.length} of ${overlaps.length} records at offset ${offset}.`,
        );
        if (hasMore && input.overlapLimit === undefined)
          notices.push(
            `Pages hold ${DEFAULT_OVERLAP_LIMIT} records unless overlapLimit is set; overlapLimit may rise to ${MAX_OVERLAP_LIMIT.toLocaleString('en-US')} for larger pages.`,
          );
        if (hasMore)
          notices.push(
            `Continue with interpro_get_entry ${JSON.stringify({ ...target, includeThumbnail: input.includeThumbnail, ...(selected ? { sections: selected } : {}), ...(input.overlapLimit === undefined ? {} : { overlapLimit: limit }), overlapOffset: nextOffset })}.`,
          );
      }
    }
    const { metadata, notice } = projectWikipediaThumbnails(
      projected,
      input.includeThumbnail,
      'interpro_get_entry',
    );
    if (notice) notices.push(notice);
    if (notices.length) ctx.enrich.notice(notices.join(' '));
    const readable = descriptionText(metadata.description);
    const entry = normalizeImages(metadata);
    if (readable) entry.descriptionText = readable;
    return {
      ...target,
      entry,
      url: `https://www.ebi.ac.uk/interpro/entry/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: response.sourceUrl,
      ...(selected ? { sections: selected, omittedSections } : {}),
      ...(overlapsPage ? { overlapsPage } : {}),
    };
  },
  format: formatInterpro,
});
