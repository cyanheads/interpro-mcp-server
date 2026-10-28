/**
 * @fileoverview Read-only status and matches of an InterProScan job started by interpro_scan_sequence.
 * @module mcp-server/tools/definitions/interpro-get-scan-result.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatInterpro } from '@/services/interpro/format.js';
import { optionalString } from '@/services/interpro/schemas.js';
import {
  buildScanOutput,
  decodeScanCursor,
  ScanEnrichment,
  ScanOutputSchema,
} from '@/services/sequence-scan/scan-output.js';
import { JOB_ID_PATTERN, MAX_JOB_ID_CHARS } from '@/services/sequence-scan/scan-schemas.js';
import {
  getSequenceScanService,
  MAX_WAIT_SECONDS,
} from '@/services/sequence-scan/sequence-scan-service.js';

export const interproGetScanResult = tool('interpro_get_scan_result', {
  title: 'Read an InterProScan job',
  description:
    'Check an InterProScan job started by interpro_scan_sequence, waiting up to waitSeconds for it to finish. Returns the matches once finished, otherwise its queued or running status to check again later. Matches are InterProScan records verbatim, 1-based and inclusive, with the InterPro and InterProScan versions that produced them. Jobs and their results expire seven days after submission.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  auth: ['tool:interpro_get_scan_result:read'],
  input: z.object({
    jobId: z
      .string()
      .trim()
      .max(MAX_JOB_ID_CHARS)
      .regex(
        JOB_ID_PATTERN,
        'Expected an iprscan6 job ID such as iprscan6-R20261028-131532-0930-13189043-p1m.',
      )
      .describe(
        'jobId returned by interpro_scan_sequence, such as iprscan6-R20261028-131532-0930-13189043-p1m.',
      ),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(30)
      .describe(
        'Seconds to wait for a pending job to finish; 0 checks its status once and returns.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque coverage.nextCursor from an earlier result for this same jobId, to read the next segment.',
    ),
  }),
  output: ScanOutputSchema,
  enrichment: ScanEnrichment,
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed, belongs to another job, or no longer fits the result.',
      recovery: 'Repeat interpro_get_scan_result with the same jobId and no cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The InterProScan job ended with status ERROR or FAILURE.',
      retryable: false,
      recovery: 'Start a new job by passing the sequence to interpro_scan_sequence again.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Job Dispatcher has no such job: it never existed or expired after seven days.',
      retryable: false,
      recovery: 'Start a new job by passing the sequence to interpro_scan_sequence again.',
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'Polling and result reading exhausted the fifty-second call budget.',
      retryable: true,
      recovery: 'Repeat the same interpro_get_scan_result call; the job keeps running upstream.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Job Dispatcher returned a response this server cannot read.',
      retryable: false,
      recovery: 'Retry the same call later; the upstream response format may have changed.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The job result exceeds 4 MiB.',
      retryable: false,
      recovery:
        'Scan a shorter sequence, or split a multi-domain protein into regions and scan each.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Job Dispatcher returned an unhandled redirect or client rejection.',
      retryable: false,
      recovery: 'Retry the same call later; the upstream service may be under maintenance.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Job Dispatcher had a network or server failure.',
      retryable: true,
      recovery:
        'Retry the same interpro_get_scan_result call later; the job keeps running upstream.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'A Job Dispatcher request returned HTTP 408/504 or exceeded its attempt deadline.',
      retryable: true,
      recovery: 'Retry the same interpro_get_scan_result call after waiting a few seconds.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The Job Dispatcher returned HTTP 429.',
      retryable: true,
      recovery: 'Wait for retryAfter when supplied, then repeat the same call.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { jobId } = input;
    const start = decodeScanCursor(input.cursor, { jobId });
    const service = getSequenceScanService();
    const state = await service.result(service.begin(ctx), jobId, input.waitSeconds * 1000);
    return buildScanOutput(
      ctx.enrich,
      { source: 'interproscan', jobId, ...state },
      {
        ...(start ? { start } : {}),
        continuation: (cursor) => `interpro_get_scan_result ${JSON.stringify({ jobId, cursor })}`,
      },
    );
  },

  format: formatInterpro,
});
