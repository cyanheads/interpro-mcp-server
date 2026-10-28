/**
 * @fileoverview InterPro vocabulary and live release reference tool.
 * @module mcp-server/tools/definitions/interpro-list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatInterpro } from '@/services/interpro/format.js';
import { getInterproService } from '@/services/interpro/interpro-service.js';
import {
  ReferenceItemSchema,
  ReferenceTopicSchema,
  staticReference,
} from '@/services/interpro/reference.js';
import { JsonObjectSchema } from '@/services/interpro/schemas.js';

/** Decode supported vocabulary or retrieve coherent current release counts. */
export const interproListReference = tool('interpro_list_reference', {
  title: 'InterPro reference vocabulary',
  description:
    'List supported InterPro database slugs, entry types, accession and PDB identifier patterns, common taxon IDs, or current release information.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_list_reference:read'],
  input: z.object({ topic: ReferenceTopicSchema }),
  output: z.object({
    topic: ReferenceTopicSchema,
    items: z
      .array(ReferenceItemSchema)
      .describe('Applicable reference vocabulary; empty for release.'),
    sourceUrls: z.array(z.string()).describe('Official reference sources.'),
    release: z
      .object({
        version: z.string().describe('Greatest numeric release version.'),
        date: z.string().describe('Release date supplied by InterPro.'),
        databaseCounts: JsonObjectSchema.describe('Complete entry aggregate response.'),
      })
      .optional()
      .describe('Current live release metadata when requested.'),
  }),
  errors: [
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream JSON or response structure is incompatible.',
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
      reason: 'release_changed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Release metadata and count responses advertise different versions.',
      retryable: true,
      recovery:
        'Retry interpro_list_reference with topic release after the upstream release update finishes.',
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
    if (input.topic !== 'release') return { topic: input.topic, ...staticReference(input.topic) };
    const { sourceUrls, ...release } = await getInterproService().release(ctx);
    return { topic: input.topic, items: [], sourceUrls, release };
  },
  format: formatInterpro,
});
