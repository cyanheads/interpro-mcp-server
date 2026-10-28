/**
 * @fileoverview Sequence scanning: precalculated lookup in the InterPro Matches API, then
 * submission to the EBI Job Dispatcher iprscan6 service with a bounded, cancellable wait. The
 * process-wide in-flight cap and the per-MD5 submission dedupe live on the service instance.
 * @module services/sequence-scan/sequence-scan-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  configurationError,
  McpError,
  notFound,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import {
  createInterproHttpFetch,
  type InterproFetch,
  MAX_RESPONSE_BYTES,
  upstreamStatusError,
} from '@/services/interpro/http-adapter.js';
import {
  JOB_ID_PATTERN,
  type JobStatus,
  JobStatusSchema,
  MAX_JOB_ID_CHARS,
  MatchesLookupSchema,
  type ScanMatch,
  ScanResultSchema,
} from './scan-schemas.js';

/** One budget per tool call, below the 60-second default MCP client request timeout. */
export const CALL_BUDGET_MS = 50_000;
/**
 * Most one attempt of each request may take, further bounded by what remains of the call budget.
 * Bodies get the longest bound: EBI throughput varies, and a 0.7 MB lookup or a 1.5 MB result
 * has taken 13-15 seconds, where a retry would only restart the same download.
 */
const ATTEMPT_MS = { status: 15_000, run: 20_000, body: 40_000 } as const;
/** Minimum spacing between `status` polls of one job within a call. */
export const POLL_INTERVAL_MS = 5_000;
/** Call budget kept back from polling so a FINISHED job's result can still be read. */
const RESULT_RESERVE_MS = 15_000;
/** Longest wait window a call can use: the budget less the result reserve. */
export const MAX_WAIT_SECONDS = (CALL_BUDGET_MS - RESULT_RESERVE_MS) / 1000;
/** Job Dispatcher fair use asks for at most 30 jobs in flight per user; one address is one user. */
export const MAX_IN_FLIGHT = 25;
/** A tracked job nobody observed finishing frees its slot after this long (runs take ~10 min). */
export const IN_FLIGHT_TTL_MS = 20 * 60_000;

export const MATCHES_URL = 'https://www.ebi.ac.uk/interpro/matches/api/matches';
export const JOB_DISPATCHER_BASE = 'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/';

/** A tool invocation's single deadline, measured on the `performance` clock. */
export interface ScanCall {
  readonly ctx: Context;
  readonly deadline: number;
  readonly started: number;
}
/** Everything a finished iprscan6 job returns that the tools surface. */
export interface JobResult {
  readonly interproscanVersion: string;
  readonly interproVersion: string;
  readonly length: number;
  readonly matches: ScanMatch[];
  readonly md5: string;
}
/** Where a job stands when a call's wait window closes. */
export type JobState =
  | { readonly status: 'submitted' | 'QUEUED' | 'RUNNING' }
  | { readonly status: 'FINISHED'; readonly result: JobResult };
/** What one scan call produced. */
export type ScanOutcome =
  | { readonly source: 'precalculated'; readonly matches: ScanMatch[]; readonly sourceUrl: string }
  | ({
      readonly source: 'interproscan';
      readonly jobId: string;
      readonly sourceUrl: string;
    } & JobState);

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };
interface Submitting {
  readonly controller: AbortController;
  readonly kind: 'submitting';
  readonly md5: string;
  outcome: Promise<Outcome<string>>;
  settled: boolean;
  readonly since: number;
  waiters: number;
}
interface Tracked {
  readonly jobId: string;
  readonly kind: 'job';
  readonly since: number;
}

const now = () => performance.now();
const deadlineError = () =>
  timeout('InterProScan call exhausted its 50-second budget.', {
    reason: 'retry_deadline_exceeded',
    retryable: true,
    deadlineMs: CALL_BUDGET_MS,
  });

/**
 * Resolve with `promise`, or reject with the caller's abort reason or the call's deadline error,
 * whichever comes first. Uses the global timer so fake timers drive it in tests.
 */
function bounded<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        done();
        reject(deadlineError());
      },
      Math.max(0, deadline - now()),
    );
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error);
      },
    );
  });
}

/** Wait `ms`, rejecting at once with the caller's reason when the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw serviceUnavailable('InterProScan response exceeds 4 MiB.', {
          reason: 'upstream_response_too_large',
          retryable: false,
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw serviceUnavailable(
      'InterProScan service returned malformed JSON.',
      { reason: 'upstream_shape_invalid', retryable: false },
      { cause },
    );
  }
}

const shapeInvalid = (what: string) =>
  serviceUnavailable(`${what} does not match the required response structure.`, {
    reason: 'upstream_shape_invalid',
    retryable: false,
  });

/** The native transport, its backstop no tighter than the per-operation attempt bounds. */
const scanHttpFetch = createInterproHttpFetch(CALL_BUDGET_MS);

/** Lookup, submission, polling, and result reads for one configured submission address. */
export class SequenceScanService {
  private readonly inFlight = new Map<string, Submitting | Tracked>();

  constructor(
    private readonly email: string | undefined,
    private readonly fetch: InterproFetch = scanHttpFetch,
  ) {}

  /** Start the call's single deadline. */
  begin(ctx: Context): ScanCall {
    const started = now();
    return { ctx, started, deadline: started + CALL_BUDGET_MS };
  }

  /**
   * Look the MD5 up in the Matches API; on a miss, submit (or join the submission already in
   * flight for this MD5) and wait up to `waitMs`. `lookupOnly` resumes a precalculated walk and
   * never submits.
   */
  async scan(
    call: ScanCall,
    sequence: { readonly md5: string; readonly residues: string },
    waitMs: number,
    lookupOnly = false,
  ): Promise<ScanOutcome> {
    const hit = await this.lookup(call, sequence.md5);
    if (hit) return { source: 'precalculated', matches: hit, sourceUrl: MATCHES_URL };
    if (lookupOnly)
      throw validationError(
        'The precalculated result this cursor continues is no longer available.',
        { reason: 'invalid_cursor', retryable: false },
      );
    const { jobId, submittedAt } = await this.submit(call, sequence);
    const state = await this.withJob(jobId, () =>
      this.awaitJob(
        call,
        jobId,
        submittedAt === undefined ? now() : submittedAt + POLL_INTERVAL_MS,
        waitMs,
      ),
    );
    if (state.status === 'FINISHED' && state.result.md5 !== sequence.md5)
      throw shapeInvalid('InterProScan result for a different sequence');
    return { source: 'interproscan', jobId, sourceUrl: this.jobUrl(jobId, state.status), ...state };
  }

  /** Read a job's state, waiting up to `waitMs` for it to finish; polls at least once. */
  async result(
    call: ScanCall,
    jobId: string,
    waitMs: number,
  ): Promise<JobState & { sourceUrl: string }> {
    const state = await this.awaitJob(call, jobId, call.started, waitMs);
    return { ...state, sourceUrl: this.jobUrl(jobId, state.status) };
  }

  private jobUrl(jobId: string, status: JobState['status']): string {
    return status === 'FINISHED'
      ? `${JOB_DISPATCHER_BASE}result/${jobId}/json`
      : `${JOB_DISPATCHER_BASE}status/${jobId}`;
  }

  /** Name the in-flight job in any failure after submission, so the caller keeps its handle. */
  private async withJob<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      if (!(cause instanceof McpError) || cause.data?.jobId) throw cause;
      throw new McpError(
        cause.code,
        `${cause.message} InterProScan job ${jobId} was submitted; read it with interpro_get_scan_result.`,
        { ...cause.data, jobId },
        { cause },
      );
    }
  }

  /** Precalculated matches, or undefined when UniParc holds no result for the MD5. */
  private async lookup(call: ScanCall, md5: string): Promise<ScanMatch[] | undefined> {
    const parsed = await this.send(
      call,
      call.ctx.signal,
      'interpro.matches.lookup',
      MATCHES_URL,
      {
        method: 'POST',
        body: JSON.stringify({ md5: [md5] }),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      },
      'body',
      async (response, signal) => {
        if (!response.ok) throw await upstreamStatusError(response, 'InterPro Matches API');
        const result = MatchesLookupSchema.safeParse(parseJson(await readText(response, signal)));
        if (!result.success) throw shapeInvalid('InterPro Matches API JSON');
        return result.data;
      },
    );
    const [entry] = parsed.results;
    if (entry?.md5.toUpperCase() !== md5) throw shapeInvalid('InterPro Matches API result');
    return entry.found ? entry.matches : undefined;
  }

  /** Expire tracked jobs nobody saw finish, so the map stays bounded without a timer. */
  private sweep(): void {
    const cutoff = now() - IN_FLIGHT_TTL_MS;
    for (const [md5, slot] of this.inFlight)
      if (slot.kind === 'job' && slot.since < cutoff) this.inFlight.delete(md5);
  }

  /** Free the slot of a job observed in a terminal state. */
  private release(jobId: string): void {
    for (const [md5, slot] of this.inFlight)
      if (slot.kind === 'job' && slot.jobId === jobId) this.inFlight.delete(md5);
  }

  /**
   * The job for this MD5: one already tracked, one being submitted by another call, or a new
   * submission. `submittedAt` is set only when this call's own `run` (or one it joined) made it.
   */
  private async submit(
    call: ScanCall,
    sequence: { readonly md5: string; readonly residues: string },
  ): Promise<{ jobId: string; submittedAt?: number }> {
    this.sweep();
    const existing = this.inFlight.get(sequence.md5);
    if (existing?.kind === 'job') return { jobId: existing.jobId };
    if (existing) return { jobId: await this.join(existing, call), submittedAt: existing.since };
    const { email } = this;
    if (!email)
      throw configurationError(
        'This sequence has no precalculated matches, and this server is not configured to submit InterProScan jobs.',
        { reason: 'scan_not_configured', retryable: false },
      );
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      const frees = Math.min(
        ...[...this.inFlight.values()].map((slot) =>
          slot.kind === 'job' ? slot.since + IN_FLIGHT_TTL_MS : slot.since + ATTEMPT_MS.run,
        ),
      );
      throw rateLimited(
        `This server already has ${MAX_IN_FLIGHT} InterProScan jobs in flight, the most it keeps under the Job Dispatcher fair-use limit.`,
        {
          reason: 'rate_limited',
          retryable: true,
          retryAfter: Math.max(1, Math.ceil((frees - now()) / 1000)),
        },
      );
    }
    const slot: Submitting = {
      kind: 'submitting',
      md5: sequence.md5,
      since: now(),
      controller: new AbortController(),
      outcome: Promise.resolve({ ok: false, error: undefined }),
      waiters: 0,
      settled: false,
    };
    this.inFlight.set(sequence.md5, slot);
    slot.outcome = (async (): Promise<Outcome<string>> => {
      try {
        const jobId = await this.run(call, slot.controller.signal, email, sequence);
        const current = this.inFlight.get(sequence.md5);
        if (current === slot || current === undefined)
          this.inFlight.set(sequence.md5, { kind: 'job', since: now(), jobId });
        return { ok: true, value: jobId };
      } catch (error) {
        if (this.inFlight.get(sequence.md5) === slot) this.inFlight.delete(sequence.md5);
        return { ok: false, error };
      } finally {
        slot.settled = true;
      }
    })();
    return { jobId: await this.join(slot, call), submittedAt: slot.since };
  }

  /**
   * Await a shared submission. A caller leaving early detaches only itself; the request is
   * aborted when the last waiting caller leaves before it settles.
   */
  private async join(slot: Submitting, call: ScanCall): Promise<string> {
    slot.waiters++;
    try {
      const outcome = await bounded(slot.outcome, call.ctx.signal, call.deadline);
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } finally {
      slot.waiters--;
      if (!slot.waiters && !slot.settled) {
        // Abandoned: a later call for this MD5 must start afresh, not inherit this abort.
        if (this.inFlight.get(slot.md5) === slot) this.inFlight.delete(slot.md5);
        slot.controller.abort(call.ctx.signal.aborted ? call.ctx.signal.reason : deadlineError());
      }
    }
  }

  /** One `run` request, never retried: a lost response may still have created a job. */
  private async run(
    call: ScanCall,
    signal: AbortSignal,
    email: string,
    sequence: { readonly md5: string; readonly residues: string },
  ): Promise<string> {
    const body = new URLSearchParams({
      email,
      sequence: `>query\n${sequence.residues}`,
      stype: 'p',
      goterms: 'false',
      pathways: 'false',
    }).toString();
    const jobId = await this.send(
      call,
      signal,
      'interpro.scan.run',
      `${JOB_DISPATCHER_BASE}run`,
      {
        method: 'POST',
        body,
        headers: { Accept: 'text/plain', 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      'run',
      async (response, attemptSignal) => {
        const text = await readText(response, attemptSignal);
        if (response.status === 400) {
          const description = this.describeRejection(text);
          throw serviceUnavailable(
            `Job Dispatcher rejected the InterProScan submission${description ? `: ${description}` : '.'}`,
            { reason: 'scan_rejected', retryable: false, status: 400 },
          );
        }
        if (!response.ok) throw await upstreamStatusError(response, 'Job Dispatcher');
        const id = text.trim();
        if (id.length > MAX_JOB_ID_CHARS || !JOB_ID_PATTERN.test(id))
          throw shapeInvalid('Job Dispatcher job ID');
        return id;
      },
    );
    call.ctx.log.info('InterProScan job submitted', { md5: sequence.md5, jobId });
    return jobId;
  }

  /**
   * The `<description>` of a Job Dispatcher XML error, single-line, bounded, and with the
   * configured address replaced, since rejections can echo submitted fields.
   */
  private describeRejection(xml: string): string | undefined {
    const match = /<description>([^<]{1,500})<\/description>/.exec(xml.slice(0, 4096));
    if (!match?.[1]) return undefined;
    let text = match[1].replace(/[\p{Cc}\s]+/gu, ' ').trim();
    if (this.email)
      text = text.replace(
        new RegExp(this.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
        '[address]',
      );
    return text.slice(0, 300) || undefined;
  }

  /**
   * Poll `status` from `firstPollAt`, at most every five seconds, until a terminal status or
   * the window closes, then read the result of a FINISHED job. The window is `waitMs` from the
   * call's start, capped so the result read keeps its reserve of the deadline.
   */
  private async awaitJob(
    call: ScanCall,
    jobId: string,
    firstPollAt: number,
    waitMs: number,
  ): Promise<JobState> {
    const windowEnd = Math.min(call.started + waitMs, call.deadline - RESULT_RESERVE_MS);
    let status: JobStatus | undefined;
    for (let next = firstPollAt; next <= windowEnd; next = now() + POLL_INTERVAL_MS) {
      await delay(next - now(), call.ctx.signal);
      status = await this.status(call, jobId);
      if (status !== 'QUEUED' && status !== 'RUNNING') break;
    }
    switch (status) {
      case undefined:
        return { status: 'submitted' };
      case 'QUEUED':
      case 'RUNNING':
        return { status };
      case 'FINISHED': {
        // Released only once read, so a retried scan after a failed read rejoins this job.
        const result = await this.read(call, jobId);
        this.release(jobId);
        return { status, result };
      }
      case 'NOT_FOUND':
        this.release(jobId);
        throw notFound(
          `Job Dispatcher has no InterProScan job ${jobId}; it never existed or expired after seven days.`,
          { reason: 'scan_not_found', retryable: false, jobId },
        );
      default:
        this.release(jobId);
        throw serviceUnavailable(`InterProScan job ${jobId} ended with status ${status}.`, {
          reason: 'scan_failed',
          retryable: false,
          jobId,
          status,
        });
    }
  }

  private async status(call: ScanCall, jobId: string): Promise<JobStatus> {
    return await this.send(
      call,
      call.ctx.signal,
      'interpro.scan.status',
      `${JOB_DISPATCHER_BASE}status/${jobId}`,
      { headers: { Accept: 'text/plain' } },
      'status',
      async (response, signal) => {
        if (!response.ok) throw await upstreamStatusError(response, 'Job Dispatcher');
        const parsed = JobStatusSchema.safeParse((await readText(response, signal)).trim());
        if (!parsed.success) throw shapeInvalid('Job Dispatcher status');
        return parsed.data;
      },
    );
  }

  private async read(call: ScanCall, jobId: string): Promise<JobResult> {
    return await this.send(
      call,
      call.ctx.signal,
      'interpro.scan.result',
      `${JOB_DISPATCHER_BASE}result/${jobId}/json`,
      { headers: { Accept: 'application/json' } },
      'body',
      async (response, signal) => {
        if (response.status === 400 || response.status === 404) {
          this.release(jobId);
          throw notFound(`Job Dispatcher has no result for InterProScan job ${jobId}.`, {
            reason: 'scan_not_found',
            retryable: false,
            jobId,
          });
        }
        if (!response.ok) throw await upstreamStatusError(response, 'Job Dispatcher');
        const parsed = ScanResultSchema.safeParse(parseJson(await readText(response, signal)));
        if (!parsed.success) throw shapeInvalid('InterProScan result JSON');
        const [result] = parsed.data.results as [(typeof parsed.data.results)[number]];
        return {
          md5: result.md5.toUpperCase(),
          length: result.sequence.length,
          interproVersion: parsed.data['interpro-version'],
          interproscanVersion: parsed.data['interproscan-version'],
          matches: result.matches,
        };
      },
    );
  }

  /**
   * One fixed-origin request under the call deadline. Each attempt is bounded by the smaller of
   * the operation's attempt bound and what remains. Reads get one more attempt on a transient
   * failure; a `run` never does.
   */
  private async send<T>(
    call: ScanCall,
    signal: AbortSignal,
    operation: string,
    url: string,
    init: RequestInit,
    kind: keyof typeof ATTEMPT_MS,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const remaining = call.deadline - now();
    if (remaining <= 0) throw deadlineError();
    return await withRetry(
      async ({ signal: retrySignal }) => {
        const controller = new AbortController();
        const timer = setTimeout(
          () =>
            controller.abort(
              timeout('InterProScan attempt deadline elapsed.', {
                reason: 'upstream_timeout',
                retryable: true,
              }),
            ),
          Math.max(0, Math.min(ATTEMPT_MS[kind], call.deadline - now())),
        );
        const attemptSignal = AbortSignal.any([retrySignal, controller.signal, signal]);
        try {
          const response = await this.fetch(url, {
            ...init,
            signal: attemptSignal,
            redirect: 'manual',
          });
          const value = await read(response, attemptSignal);
          attemptSignal.throwIfAborted();
          return value;
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          if (retrySignal.aborted) throw retrySignal.reason;
          if (controller.signal.aborted) throw controller.signal.reason;
          if (cause instanceof McpError) throw cause;
          throw serviceUnavailable(
            'InterProScan network request failed.',
            { reason: 'upstream_unavailable', retryable: true },
            { cause },
          );
        } finally {
          clearTimeout(timer);
        }
      },
      {
        signal,
        context: call.ctx,
        operation,
        deadlineMs: remaining,
        maxRetries: kind === 'run' ? 0 : 1,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      },
    );
  }
}

let service: SequenceScanService | undefined;
/** Initialize the process service in createApp.setup with the configured submission address. */
export function initSequenceScanService(
  email: string | undefined,
  fetch: InterproFetch = scanHttpFetch,
): void {
  service = new SequenceScanService(email, fetch);
}
/** Obtain the initialized process service. */
export function getSequenceScanService(): SequenceScanService {
  if (!service) throw new Error('Sequence scan service is not initialized.');
  return service;
}
