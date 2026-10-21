/**
 * @fileoverview Complete InterPro and member entry metadata.
 * @module mcp-server/tools/definitions/interpro-get-entry.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
  EntryMetadataSchema,
  optionalString,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';
import { UPSTREAM_ERRORS } from '@/services/interpro/upstream-errors.js';

/** Retrieve one complete entry with deterministic accession routing. */
export const interproGetEntry = tool('interpro_get_entry', {
  title: 'InterPro entry metadata',
  description:
    'Retrieve one InterPro or member-database entry, including description, hierarchy, member signatures, GO terms, literature, cross-references, clan membership, and coverage counters.',
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
  }),
  output: z.object({
    accession: z.string().describe('Canonical requested accession.'),
    sourceDatabase: SourceDatabaseSchema,
    entry: EntryMetadataSchema.describe(
      'Complete upstream metadata, preserving sparse annotations; Wikipedia thumbnails are omitted unless includeThumbnail is true.',
    ),
    url: z.string().describe('Canonical InterPro website URL.'),
    sourceUrl: z.string().describe('Official API source URL.'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Omitted Wikipedia thumbnail size and how to include it.'),
  },
  errors: [
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
    const { metadata, notice } = projectWikipediaThumbnails(
      response.data.metadata,
      input.includeThumbnail,
      'interpro_get_entry',
    );
    if (notice) ctx.enrich.notice(notice);
    return {
      ...target,
      entry: normalizeImages(metadata),
      url: `https://www.ebi.ac.uk/interpro/entry/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: response.sourceUrl,
    };
  },
  format: formatInterpro,
});
