/**
 * @fileoverview Output schema and budget-bounded segments of whole match records shared by the
 * scan and scan-result tools, with cursors scoped to the sequence MD5 or the job ID.
 * @module services/sequence-scan/scan-output
 */
import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { BUDGET_LABEL, fitWithinBudget } from '@/services/interpro/budget.js';
import {
  compareText,
  decodePositionCursor,
  encodePositionCursor,
} from '@/services/interpro/cursors.js';
import { type ScanMatch, ScanMatchSchema } from './scan-schemas.js';
import type { ScanOutcome } from './sequence-scan-service.js';

const PRECALCULATED_OPERATION = 'interpro_scan_sequence.precalculated';
const JOB_OPERATION = 'interpro_get_scan_result.job';
const PositionSchema = z
  .object({ offset: z.number().int().positive(), total: z.number().int().positive() })
  .strict();
type Position = z.infer<typeof PositionSchema>;

/** Output fields both tools return. */
export const ScanOutputSchema = z.object({
  source: z
    .enum(['precalculated', 'interproscan'])
    .describe(
      'Which path produced the result: precalculated matches from the InterPro Matches API, or an InterProScan 6 job run through the EBI Job Dispatcher.',
    ),
  status: z
    .enum(['finished', 'queued', 'running', 'submitted'])
    .describe(
      'finished: matches are present. queued or running: the job is pending; read it later with interpro_get_scan_result. submitted: accepted in this call and not yet polled.',
    ),
  jobId: z
    .string()
    .optional()
    .describe(
      'InterProScan job ID on the interproscan path; results stay retrievable for seven days.',
    ),
  md5: z
    .string()
    .optional()
    .describe('Uppercase hex MD5 of the uppercased residues, the UniParc sequence digest.'),
  length: z.number().int().optional().describe('Sequence length in residues.'),
  interproVersion: z
    .string()
    .optional()
    .describe('InterPro release of a finished InterProScan job.'),
  interproscanVersion: z.string().optional().describe('InterProScan version of a finished job.'),
  matches: z
    .array(ScanMatchSchema)
    .optional()
    .describe(
      'Whole match records in this segment when finished, sorted by earliest location start then signature accession; coordinates are 1-based and inclusive. Each record keeps its own source and signatureLibraryRelease.',
    ),
  coverage: z
    .object({
      totalMatches: z.number().int().describe('Match records in the complete result.'),
      offset: z.number().int().describe('Match records that precede this segment.'),
      returnedMatches: z.number().int().describe('Match records in this segment.'),
      hasMore: z.boolean().describe('Whether another segment remains.'),
      nextCursor: z
        .string()
        .optional()
        .describe(
          'Opaque cursor for the next segment; pass it unchanged to the tool the notice names.',
        ),
    })
    .optional()
    .describe('Where this segment sits in the complete match list; present when finished.'),
  sourceUrl: z.string().describe('Upstream endpoint that supplied this result.'),
});
export type ScanOutput = z.infer<typeof ScanOutputSchema>;

/** Enrichment fields both tools declare. */
export const ScanEnrichment = {
  notice: z.string().optional().describe('Job, continuation, or empty-result guidance.'),
  totalCount: z.number().optional().describe('Match records in the complete result.'),
  truncated: z.boolean().optional().describe('More segments remain.'),
  shown: z.number().int().optional().describe('Match records in this segment.'),
};

const cursorTarget = (state: ScanOutcome, md5: string | undefined) =>
  state.source === 'precalculated'
    ? { operation: PRECALCULATED_OPERATION, scope: { md5 } }
    : { operation: JOB_OPERATION, scope: { jobId: state.jobId } };

/** Decode a continuation for the given target before any upstream request. */
export function decodeScanCursor(
  cursor: string | undefined,
  target: { readonly md5: string } | { readonly jobId: string },
): Position | undefined {
  return 'md5' in target
    ? decodePositionCursor(cursor, PRECALCULATED_OPERATION, { md5: target.md5 }, PositionSchema)
    : decodePositionCursor(cursor, JOB_OPERATION, { jobId: target.jobId }, PositionSchema);
}

function minStart(match: ScanMatch): number {
  let start = Number.POSITIVE_INFINITY;
  for (const location of match.locations) start = Math.min(start, location.start);
  return start;
}

/** Deterministic order, so a cursor offset names the same record on every read. */
function sortMatches(matches: readonly ScanMatch[]): ScanMatch[] {
  return matches
    .map((match) => ({ match, start: minStart(match), json: JSON.stringify(match) }))
    .sort(
      (a, b) =>
        a.start - b.start ||
        compareText(a.match.signature.accession, b.match.signature.accession) ||
        compareText(a.match.source, b.match.source) ||
        compareText(a.json, b.json),
    )
    .map(({ match }) => match);
}

interface Enrich {
  notice(text: string): void;
  total(count: number): void;
  truncated(details: { shown: number }): void;
}

/**
 * Build one segment of a finished result, or the pending output, and the notices that go with
 * it. `continuation` names the call that reads the next segment, as the agent should make it.
 */
export function buildScanOutput(
  enrich: Enrich,
  state: ScanOutcome,
  options: {
    readonly md5?: string;
    readonly length?: number;
    readonly start?: Position;
    readonly continuation: (cursor: string) => string;
  },
): ScanOutput {
  const base = {
    source: state.source,
    ...(state.source === 'interproscan' ? { jobId: state.jobId } : {}),
  };
  if (state.source === 'interproscan' && state.status !== 'FINISHED') {
    const status =
      state.status === 'submitted' ? 'submitted' : state.status === 'QUEUED' ? 'queued' : 'running';
    enrich.notice(
      `InterProScan job ${state.jobId} is ${status}; de novo scans commonly take about ten minutes. Call interpro_get_scan_result ${JSON.stringify({ jobId: state.jobId })} to wait for it. Results stay retrievable for seven days.`,
    );
    return {
      ...base,
      status,
      ...(options.md5 ? { md5: options.md5 } : {}),
      ...(options.length ? { length: options.length } : {}),
      sourceUrl: state.sourceUrl,
    };
  }
  const finished =
    state.source === 'precalculated'
      ? { matches: state.matches, md5: options.md5, length: options.length }
      : {
          matches: state.result.matches,
          md5: state.result.md5,
          length: state.result.length,
          interproVersion: state.result.interproVersion,
          interproscanVersion: state.result.interproscanVersion,
        };
  const all = sortMatches(finished.matches);
  const total = all.length;
  const offset = options.start?.offset ?? 0;
  if (options.start && (options.start.total !== total || offset >= total))
    throw validationError('Cursor no longer matches this result; restart without cursor.', {
      reason: 'invalid_cursor',
      retryable: false,
    });
  const { operation, scope } = cursorTarget(state, finished.md5);
  const remaining = total - offset;
  const segment = (count: number): ScanOutput => {
    const end = offset + count;
    return {
      ...base,
      status: 'finished',
      ...(finished.md5 ? { md5: finished.md5 } : {}),
      ...(finished.length ? { length: finished.length } : {}),
      ...('interproVersion' in finished
        ? {
            interproVersion: finished.interproVersion,
            interproscanVersion: finished.interproscanVersion,
          }
        : {}),
      matches: all.slice(offset, end),
      coverage: {
        totalMatches: total,
        offset,
        returnedMatches: count,
        hasMore: end < total,
        ...(end < total
          ? { nextCursor: encodePositionCursor(operation, scope, { offset: end, total }) }
          : {}),
      },
      sourceUrl: state.sourceUrl,
    };
  };
  const { count, output, oversized } = remaining
    ? fitWithinBudget(remaining, segment)
    : { count: 0, output: segment(0), oversized: false };
  const notices: string[] = [];
  if (oversized)
    notices.push(
      `Match ${all[offset]?.signature.accession} cannot be split, so this segment holds it alone and exceeds the ${BUDGET_LABEL}.`,
    );
  const next = output.coverage?.nextCursor;
  if (next) {
    notices.push(
      `This segment holds matches ${offset + 1}–${offset + count} of ${total} and stopped at the ${BUDGET_LABEL}. Continue with ${options.continuation(next)} before concluding a region has no match.`,
    );
    enrich.truncated({ shown: count });
  } else if (!total)
    notices.push(
      state.source === 'precalculated'
        ? 'The InterPro Matches API holds a precalculated result for this sequence with no signature matches.'
        : 'InterProScan finished and reported no signature matches for this sequence.',
    );
  enrich.total(total);
  if (notices.length) enrich.notice(notices.join(' '));
  return output;
}
