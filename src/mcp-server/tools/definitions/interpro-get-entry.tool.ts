/**
 * @fileoverview Complete InterPro and member entry metadata.
 * @module mcp-server/tools/definitions/interpro-get-entry.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import { resolveEntry } from '@/services/interpro/routing.js';
import {
  AccessionSchema,
  detailSchema,
  EntryMetadataSchema,
  optionalString,
  SourceDatabaseSchema,
} from '@/services/interpro/schemas.js';

/** Retrieve one complete entry with deterministic accession routing. */
export const interproGetEntry = tool('interpro_get_entry', {
  title: 'InterPro entry metadata',
  description:
    'Retrieve one InterPro or member-database entry, including description, hierarchy, member signatures, GO terms, literature, cross-references, clan membership, and coverage counters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_entry:read'],
  input: z.object({
    accession: AccessionSchema,
    sourceDatabase: optionalString(SourceDatabaseSchema).describe(
      'Database slug; inferred from standard accession prefixes when omitted.',
    ),
  }),
  output: z.object({
    accession: z.string().describe('Canonical requested accession.'),
    sourceDatabase: SourceDatabaseSchema,
    entry: EntryMetadataSchema.describe(
      'Complete upstream metadata, preserving sparse annotations.',
    ),
    url: z.string().describe('Canonical InterPro website URL.'),
    sourceUrl: z.string().describe('Official API source URL.'),
  }),
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
      when: 'Entry detail returns 204 or 404.',
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
    const target = resolveEntry(input.accession, input.sourceDatabase);
    const service = getInterproService();
    const response = await service.request(
      service.begin(ctx),
      ['entry', target.sourceDatabase, target.accession],
      {},
      detailSchema(EntryMetadataSchema),
      { missing: 'entry_not_found' },
    );
    if (!response.data)
      throw ctx.fail('upstream_shape_invalid', 'Entry metadata response is missing.');
    return {
      ...target,
      entry: normalizeImages(response.data.metadata),
      url: `https://www.ebi.ac.uk/interpro/entry/${target.sourceDatabase}/${encodeURIComponent(target.accession)}/`,
      sourceUrl: response.sourceUrl,
    };
  },
  format: formatInterpro,
});
