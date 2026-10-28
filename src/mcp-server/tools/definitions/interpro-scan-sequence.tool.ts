/**
 * @fileoverview Domain matches for a raw protein sequence: precalculated lookup, else InterProScan.
 * @module mcp-server/tools/definitions/interpro-scan-sequence.tool
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
import {
  codePointLabel,
  MAX_SEQUENCE_CHARS,
  parseSequence,
} from '@/services/sequence-scan/sequence.js';
import {
  getSequenceScanService,
  MAX_WAIT_SECONDS,
} from '@/services/sequence-scan/sequence-scan-service.js';

export const interproScanSequence = tool('interpro_scan_sequence', {
  title: 'Scan a protein sequence',
  description:
    'Find InterPro domain, family, and site matches for one raw protein sequence that has no UniProt accession. Sequences already in UniParc return precalculated matches at once; any other sequence starts one InterProScan 6 job, which commonly runs about ten minutes, so the usual first result is a jobId to read with interpro_get_scan_result. Repeating a sequence whose job is still running returns the same jobId instead of starting another. Matches are InterProScan records verbatim, 1-based and inclusive, each naming its member database and release.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  auth: ['tool:interpro_scan_sequence:write'],
  input: z.object({
    sequence: z
      .string()
      .max(MAX_SEQUENCE_CHARS)
      .describe(
        'One protein sequence as residue letters, optionally preceded by a single FASTA header line. Case, spaces, and line breaks are ignored; digits, gaps, and stop symbols (*) are rejected.',
      ),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_SECONDS)
      .default(30)
      .describe(
        'Seconds to wait for a newly started job to finish before returning its jobId; 0 starts the job and returns at once.',
      ),
    cursor: optionalString(z.string().trim().max(4096)).describe(
      'Opaque coverage.nextCursor from an earlier call with this same sequence, to read the next segment of precalculated matches.',
    ),
  }),
  output: ScanOutputSchema,
  enrichment: ScanEnrichment,
  errors: [
    {
      reason: 'empty_sequence',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The sequence holds no residue letters.',
      recovery: 'Pass the protein residues as letters, optionally after one FASTA header line.',
    },
    {
      reason: 'invalid_residue',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The sequence holds a character other than a residue letter or whitespace.',
      recovery:
        'Remove digits, gap characters, and stop symbols, then repeat with residue letters only.',
    },
    {
      reason: 'multiple_sequences',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The input holds more than one FASTA record.',
      recovery: 'Scan one sequence per call, repeating interpro_scan_sequence for each record.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed, belongs to another sequence or result, or the result changed.',
      recovery: 'Repeat interpro_scan_sequence with the same sequence and no cursor.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_not_configured',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'The sequence has no precalculated matches and this server cannot submit InterProScan jobs.',
      recovery:
        'The server operator must configure InterProScan submission; sequences already in UniParc still return precalculated matches.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The server already holds its maximum of in-flight InterProScan jobs; nothing was submitted.',
      retryable: true,
      recovery: 'Wait retryAfter seconds, then repeat the same interpro_scan_sequence call.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Job Dispatcher rejected the submission with HTTP 400.',
      retryable: false,
      recovery:
        'Check that the input is one protein sequence; if the message names the contact address, the server operator must correct it.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_failed',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The InterProScan job ended with status ERROR or FAILURE.',
      retryable: false,
      recovery: 'Repeat interpro_scan_sequence with the same sequence to start a new job.',
      thrownBy: 'service',
    },
    {
      reason: 'scan_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The Job Dispatcher no longer holds the job this sequence was waiting on.',
      retryable: false,
      recovery: 'Repeat interpro_scan_sequence with the same sequence to start a new job.',
      thrownBy: 'service',
    },
    {
      reason: 'retry_deadline_exceeded',
      code: JsonRpcErrorCode.Timeout,
      when: 'Lookup, submission, polling, and result reading exhausted the fifty-second call budget.',
      retryable: true,
      recovery:
        'Repeat the same call; a job already started is reused, or read it with interpro_get_scan_result using the jobId in the message.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The Matches API or Job Dispatcher returned a response this server cannot read.',
      retryable: false,
      recovery: 'Retry the same call later; the upstream response format may have changed.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_response_too_large',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An upstream response exceeds 4 MiB.',
      retryable: false,
      recovery:
        'Scan a shorter sequence, or split a multi-domain protein into regions and scan each.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An upstream service returned an unhandled redirect or client rejection.',
      retryable: false,
      recovery: 'Retry the same call later; the upstream service may be under maintenance.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'An upstream service had a network or server failure.',
      retryable: true,
      recovery:
        'Retry the same call later; a job already started is reused rather than resubmitted.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'An upstream request returned HTTP 408/504 or exceeded its attempt deadline.',
      retryable: true,
      recovery: 'Retry the same call after waiting; a job already started is reused.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'An upstream service returned HTTP 429.',
      retryable: true,
      recovery: 'Wait for retryAfter when supplied, then repeat the same call.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const parsed = parseSequence(input.sequence);
    if (!parsed.ok)
      switch (parsed.reason) {
        case 'empty_sequence':
          throw ctx.fail('empty_sequence', 'The sequence holds no residue letters.');
        case 'multiple_sequences':
          throw ctx.fail(
            'multiple_sequences',
            `A second FASTA record starts at character ${parsed.position}; scan one sequence per call.`,
          );
        case 'invalid_residue':
          throw ctx.fail(
            'invalid_residue',
            `Character ${codePointLabel(parsed.codePoint)} at position ${parsed.position} is not a protein residue letter.`,
          );
      }
    const { md5, residues } = parsed;
    const start = decodeScanCursor(input.cursor, { md5 });
    const service = getSequenceScanService();
    const outcome = await service.scan(
      service.begin(ctx),
      { md5, residues },
      input.waitSeconds * 1000,
      start !== undefined,
    );
    return buildScanOutput(ctx.enrich, outcome, {
      md5,
      length: residues.length,
      ...(start ? { start } : {}),
      // The sequence is not echoed (titin is 34 kB), so the precalculated call is named, not printed.
      continuation: (cursor) =>
        outcome.source === 'precalculated'
          ? 'interpro_scan_sequence, passing the same sequence and cursor set to coverage.nextCursor,'
          : `interpro_get_scan_result ${JSON.stringify({ jobId: outcome.jobId, cursor })}`,
    });
  },

  format: formatInterpro,
});
