/**
 * @fileoverview Output schema and count-bounded segments of whole match records shared by the
 * scan and scan-result tools, with cursors scoped to the sequence MD5 or the job ID.
 * @module services/sequence-scan/scan-output
 */
import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  compareText,
  decodePositionCursor,
  decodeScopedPositionCursor,
  encodePositionCursor,
} from '@/services/interpro/cursors.js';
import { type ScanMatch, ScanMatchSchema } from './scan-schemas.js';
import type { ScanOutcome } from './sequence-scan-service.js';

const PRECALCULATED_OPERATION = 'interpro_scan_sequence.precalculated';
const JOB_OPERATION = 'interpro_get_scan_result.job';
/** Match records per segment when the caller sets no limit. */
const DEFAULT_LIMIT = 20;
/** Most match records one segment holds; a larger limit is clamped with a notice. */
const MAX_LIMIT = 200;
/**
 * A record position in the sorted match list, never a segment size. Precalculated cursors also
 * carry the residue count the Matches API omits, so a call with only the cursor can report it;
 * cursors minted before it was added resume without it.
 */
const PositionSchema = z
  .object({
    offset: z.number().int().positive(),
    total: z.number().int().positive(),
    length: z.number().int().positive().optional(),
  })
  .strict();
type Position = z.infer<typeof PositionSchema>;
const PrecalculatedScopeSchema = z.object({ md5: z.string().regex(/^[0-9A-F]{32}$/) }).strict();

/** The `limit` input both tools declare. */
export const ScanLimitSchema = z
  .number()
  .int()
  .min(1)
  .default(DEFAULT_LIMIT)
  .describe(
    `Positive integer segment size in match records; values above ${MAX_LIMIT} are clamped to ${MAX_LIMIT} with a notice; defaults to ${DEFAULT_LIMIT}.`,
  );

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
  notice: z.string().optional().describe('Job, continuation, clamp, or empty-result guidance.'),
  totalCount: z.number().optional().describe('Match records in the complete result.'),
  truncated: z.boolean().optional().describe('More segments remain.'),
  shown: z.number().int().optional().describe('Match records in this segment.'),
  cap: z.number().int().optional().describe('Effective segment size after clamping.'),
};

/**
 * Decode a precalculated continuation before any upstream request. With the sequence's `md5` the
 * cursor must belong to it; without one, the cursor alone names the sequence.
 */
export function decodePrecalculatedCursor(
  cursor: string,
  md5: string | undefined,
): { md5: string; start: Position } {
  const { scope, position } = decodeScopedPositionCursor(
    cursor,
    PRECALCULATED_OPERATION,
    md5 === undefined
      ? PrecalculatedScopeSchema
      : PrecalculatedScopeSchema.refine((target) => target.md5 === md5),
    PositionSchema,
  );
  return { md5: scope.md5, start: position };
}

/** Decode a job-result continuation for `jobId` before any upstream request. */
export function decodeJobCursor(cursor: string | undefined, jobId: string): Position | undefined {
  return decodePositionCursor(cursor, JOB_OPERATION, { jobId }, PositionSchema);
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
  truncated(details: { shown: number; cap: number; guidance: string }): void;
}

/**
 * Build one segment of a finished result, or the pending output, and the notices that go with
 * it. A segment holds `min(limit, remaining)` whole records; the continuation notice prints the
 * call that reads the next one, runnable as written.
 */
export function buildScanOutput(
  enrich: Enrich,
  state: ScanOutcome,
  options: {
    readonly md5?: string;
    readonly length?: number;
    readonly start?: Position;
    /** The caller's limit, before clamping. */
    readonly limit: number;
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
  const limit = Math.min(options.limit, MAX_LIMIT);
  const notices =
    options.limit > limit ? [`Requested limit ${options.limit} was clamped to ${limit}.`] : [];
  const end = Math.min(offset + limit, total);
  const nextCursor =
    end < total
      ? state.source === 'precalculated'
        ? encodePositionCursor(
            PRECALCULATED_OPERATION,
            { md5: finished.md5 },
            { offset: end, total, ...(finished.length ? { length: finished.length } : {}) },
          )
        : encodePositionCursor(JOB_OPERATION, { jobId: state.jobId }, { offset: end, total })
      : undefined;
  const output: ScanOutput = {
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
      returnedMatches: end - offset,
      hasMore: nextCursor !== undefined,
      ...(nextCursor ? { nextCursor } : {}),
    },
    sourceUrl: state.sourceUrl,
  };
  enrich.total(total);
  if (nextCursor) {
    const next = {
      ...(state.source === 'interproscan' ? { jobId: state.jobId } : {}),
      cursor: nextCursor,
      ...(limit === DEFAULT_LIMIT ? {} : { limit }),
    };
    const tool =
      state.source === 'precalculated' ? 'interpro_scan_sequence' : 'interpro_get_scan_result';
    notices.push(
      `This segment holds matches ${offset + 1}–${end} of ${total}. Continue with ${tool} ${JSON.stringify(next)} before concluding a region has no match${limit < MAX_LIMIT ? `; limit may rise to ${MAX_LIMIT} for larger segments` : ''}.`,
    );
    enrich.truncated({ shown: end - offset, cap: limit, guidance: notices.join(' ') });
    return output;
  }
  if (!total)
    notices.push(
      state.source === 'precalculated'
        ? 'The InterPro Matches API holds a precalculated result for this sequence with no signature matches.'
        : 'InterProScan finished and reported no signature matches for this sequence.',
    );
  if (notices.length) enrich.notice(notices.join(' '));
  return output;
}
