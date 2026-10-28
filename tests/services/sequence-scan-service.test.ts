/**
 * @fileoverview Sequence scan service at the fetch seam: lookup, submission, dedupe, in-flight cap,
 * polling cadence, status mapping, the single call deadline, cancellation, and address redaction.
 * @module tests/services/sequence-scan-service
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSequence } from '@/services/sequence-scan/sequence.js';
import {
  IN_FLIGHT_TTL_MS,
  MAX_IN_FLIGHT,
  POLL_INTERVAL_MS,
  SequenceScanService,
} from '@/services/sequence-scan/sequence-scan-service.js';
import akt1Result from './fixtures/sequence-scan/iprscan6-akt1-variant.json' with { type: 'json' };
import calmodulinResult from './fixtures/sequence-scan/iprscan6-calmodulin-variant.json' with {
  type: 'json',
};
import matchesBatch from './fixtures/sequence-scan/matches-batch.json' with { type: 'json' };
import sequences from './fixtures/sequence-scan/sequences.json' with { type: 'json' };

const EMAIL = 'scan-operator@example.test';
type Route = (detail: {
  body: string;
  jobId: string;
  signal: AbortSignal;
}) => Response | Promise<Response>;
interface Recorded {
  at: number;
  body: string;
  kind: 'matches' | 'run' | 'status' | 'result';
  signal: AbortSignal;
  url: string;
}

const residuesOf = (text: string) => {
  const parsed = parseSequence(text);
  if (!parsed.ok) throw new Error('fixture sequence must parse');
  return { md5: parsed.md5, residues: parsed.residues };
};
const calmodulin = residuesOf(sequences.calmodulin);
const variant = residuesOf(sequences.calmodulinVariant);
const jobIdFor = (md5: string) =>
  `iprscan6-R20261028-131532-0930-${parseInt(md5.slice(0, 7), 16)}-p1m`;
/** The Matches API body for one MD5, from the captured five-MD5 batch. */
const lookup = (md5: string) =>
  Response.json({
    results: [
      matchesBatch.results.find((entry) => entry.md5 === md5) ?? { md5, found: false, matches: [] },
    ],
  });
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain' } });
/** A response that never arrives; the request settles only when its signal aborts. */
const hang = (signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
const later = (ms: number, response: () => Response, signal: AbortSignal) =>
  new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(response()), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function upstream(routes: Partial<Record<Recorded['kind'], Route>>) {
  const calls: Recorded[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const kind: Recorded['kind'] = pathname.endsWith('/matches')
      ? 'matches'
      : pathname.endsWith('/run')
        ? 'run'
        : pathname.includes('/status/')
          ? 'status'
          : 'result';
    const body = typeof init.body === 'string' ? init.body : '';
    const signal = init.signal as AbortSignal;
    calls.push({ kind, url, body, at: performance.now(), signal });
    const route =
      routes[kind] ??
      (kind === 'matches'
        ? ({ body: request }: { body: string }) => lookup(JSON.parse(request).md5[0])
        : kind === 'run'
          ? ({ body: request }: { body: string }) =>
              text(jobIdFor(residuesOf(new URLSearchParams(request).get('sequence') ?? '').md5))
          : undefined);
    if (!route) throw new Error(`Unexpected ${kind} request`);
    const jobId = pathname.split('/').find((segment) => segment.startsWith('iprscan6-')) ?? '';
    return await route({ body, jobId, signal });
  });
  const of = (kind: Recorded['kind']) => calls.filter((call) => call.kind === kind);
  return { fetch, calls, of };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown; at: number }> {
  const outcome = promise.then(
    (value) => ({ value, at: performance.now() }),
    (error: unknown) => ({ error, at: performance.now() }),
  );
  await vi.runAllTimersAsync();
  return await outcome;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(() => vi.useRealTimers());

describe('precalculated lookup', () => {
  it.each([EMAIL, undefined])(
    'returns Matches API records with no Job Dispatcher request (address %s)',
    async (email) => {
      const net = upstream({});
      const service = new SequenceScanService(email, net.fetch);
      const ctx = createMockContext();
      const { value } = await settle(service.scan(service.begin(ctx), calmodulin, 30_000));
      expect(value).toMatchObject({ source: 'precalculated' });
      expect(value?.source === 'precalculated' && value.matches).toHaveLength(23);
      expect(net.calls.map((call) => call.kind)).toEqual(['matches']);
      expect(JSON.parse(net.calls[0]?.body ?? '')).toEqual({ md5: [calmodulin.md5] });
    },
  );

  it('preserves InterPro-N rows and per-match library spellings and releases verbatim', async () => {
    const service = new SequenceScanService(undefined, upstream({}).fetch);
    const { value } = await settle(service.scan(service.begin(createMockContext()), calmodulin, 0));
    const expected = matchesBatch.results.find((entry) => entry.md5 === calmodulin.md5)?.matches;
    expect(value?.source === 'precalculated' && value.matches).toEqual(expected);
    const libraries = expected?.map((match) => match.signature.signatureLibraryRelease.library);
    expect(libraries).toContain('PROSITE patterns');
    expect(libraries).toContain('PROSITE Patterns');
    expect(expected?.some((match) => match.source === 'InterPro-N')).toBe(true);
  });

  it('rejects a lookup answering for another MD5', async () => {
    const net = upstream({ matches: () => lookup('1620296E269940B19BAFA78CA71E003A') });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { error } = await settle(service.scan(service.begin(createMockContext()), calmodulin, 0));
    expect(error).toMatchObject({ data: { reason: 'upstream_shape_invalid' } });
    expect(net.of('run')).toHaveLength(0);
  });

  it('retries a transient lookup failure once within the deadline', async () => {
    let attempts = 0;
    const net = upstream({
      matches: ({ body }) =>
        ++attempts === 1 ? text('busy', 503) : lookup(JSON.parse(body).md5[0]),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value } = await settle(service.scan(service.begin(createMockContext()), calmodulin, 0));
    expect(value?.source).toBe('precalculated');
    expect(net.of('matches')).toHaveLength(2);
  });
});

describe('submission and polling', () => {
  it('submits a miss exactly once and polls no faster than every five seconds inside the window', async () => {
    const net = upstream({ status: () => text('RUNNING') });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const ctx = createMockContext();
    const { value, at } = await settle(service.scan(service.begin(ctx), variant, 30_000));
    expect(value).toEqual({
      source: 'interproscan',
      jobId: jobIdFor(variant.md5),
      status: 'RUNNING',
      sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/${jobIdFor(variant.md5)}`,
    });
    expect(net.of('run')).toHaveLength(1);
    const form = new URLSearchParams(net.of('run')[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      email: EMAIL,
      sequence: `>query\n${variant.residues}`,
      stype: 'p',
      goterms: 'false',
      pathways: 'false',
    });
    const polls = net.of('status').map((call) => call.at);
    expect(polls).toEqual([5_000, 10_000, 15_000, 20_000, 25_000, 30_000]);
    expect(at).toBe(30_000);
    // The recorded log carries the submission, and never the address.
    expect(JSON.stringify(ctx.log)).toContain(jobIdFor(variant.md5));
    expect(JSON.stringify(ctx.log)).not.toContain(EMAIL);
  });

  it('returns submitted without polling when waitMs is zero', async () => {
    const net = upstream({});
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value } = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(value).toMatchObject({ status: 'submitted', jobId: jobIdFor(variant.md5) });
    expect(net.of('status')).toHaveLength(0);
  });

  it('reads a job that finishes inside the window, then frees its MD5 for a new submission', async () => {
    let polls = 0;
    const net = upstream({
      status: () => text(++polls < 3 ? 'RUNNING' : 'FINISHED'),
      result: () => Response.json(calmodulinResult),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value } = await settle(
      service.scan(service.begin(createMockContext()), variant, 40_000),
    );
    expect(value).toMatchObject({
      source: 'interproscan',
      status: 'FINISHED',
      sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/result/${jobIdFor(variant.md5)}/json`,
      result: {
        md5: variant.md5,
        length: 149,
        interproVersion: '110.0',
        interproscanVersion: '6.0.2.2',
        matches: calmodulinResult.results[0]?.matches,
      },
    });
    expect(net.of('status').map((call) => call.at)).toEqual([5_000, 10_000, 15_000]);
    await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(net.of('run')).toHaveLength(2);
  });

  it('rejects a finished result for a different sequence', async () => {
    const net = upstream({
      status: () => text('FINISHED'),
      result: () => Response.json(akt1Result),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { error } = await settle(
      service.scan(service.begin(createMockContext()), variant, 10_000),
    );
    expect(error).toMatchObject({ data: { reason: 'upstream_shape_invalid' } });
  });

  it('retries a transient status failure inside one poll', async () => {
    let attempts = 0;
    const net = upstream({ status: () => (++attempts === 1 ? text('down', 502) : text('QUEUED')) });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value } = await settle(
      service.scan(service.begin(createMockContext()), variant, 5_000),
    );
    expect(value).toMatchObject({ status: 'QUEUED' });
    expect(net.of('status')).toHaveLength(2);
  });

  it('never retries a run, and names the job when a later step fails', async () => {
    const failing = upstream({ run: () => text('unavailable', 503) });
    const service = new SequenceScanService(EMAIL, failing.fetch);
    const { error } = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(error).toMatchObject({ data: { reason: 'upstream_unavailable' } });
    expect(failing.of('run')).toHaveLength(1);

    const net = upstream({ status: () => text('maintenance', 501) });
    const other = new SequenceScanService(EMAIL, net.fetch);
    const failure = await settle(other.scan(other.begin(createMockContext()), variant, 10_000));
    expect(failure.error).toMatchObject({
      message: expect.stringContaining(jobIdFor(variant.md5)),
      data: { reason: 'upstream_unavailable', jobId: jobIdFor(variant.md5) },
    });
    // The job stays tracked, so repeating the scan rejoins it instead of submitting again.
    const again = upstream({ status: () => text('RUNNING') });
    Object.assign(other, { fetch: again.fetch });
    const { value } = await settle(other.scan(other.begin(createMockContext()), variant, 5_000));
    expect(value).toMatchObject({ jobId: jobIdFor(variant.md5), status: 'RUNNING' });
    expect(again.of('run')).toHaveLength(0);
  });

  it('settles at the fifty-second deadline when the finished result read stalls', async () => {
    const net = upstream({
      status: () => text(performance.now() >= 35_000 ? 'FINISHED' : 'RUNNING'),
      result: ({ signal }) => hang(signal),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { error, at } = await settle(
      service.scan(service.begin(createMockContext()), variant, 35_000),
    );
    // The read starts at 35 s; only the call deadline, not the 40-second body bound, ends it at 50 s.
    expect(net.of('result')[0]?.at).toBe(35_000);
    expect(at).toBe(50_000);
    expect(error).toMatchObject({ code: -32004, data: { jobId: jobIdFor(variant.md5) } });
    expect(net.of('result')).not.toHaveLength(0);
    for (const call of net.calls) expect(call.signal.aborted || call.kind !== 'result').toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets one slow body read finish in a single attempt instead of restarting it', async () => {
    const net = upstream({
      matches: ({ body, signal }) => later(25_000, () => lookup(JSON.parse(body).md5[0]), signal),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value, at } = await settle(
      service.scan(service.begin(createMockContext()), calmodulin, 0),
    );
    expect(value?.source).toBe('precalculated');
    expect(net.of('matches')).toHaveLength(1);
    expect(at).toBe(25_000);
  });

  it('still bounds a stalled status poll at fifteen seconds, then retries it once', async () => {
    let attempts = 0;
    const net = upstream({
      status: ({ signal }) => (++attempts === 1 ? hang(signal) : text('RUNNING')),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value } = await settle(
      service.scan(service.begin(createMockContext()), variant, 5_000),
    );
    expect(value).toMatchObject({ status: 'RUNNING' });
    const [first, second] = net.of('status');
    expect(first?.at).toBe(5_000);
    expect(first?.signal.aborted).toBe(true);
    expect((second?.at ?? 0) - 5_000).toBeGreaterThanOrEqual(15_000);
    // The retry follows the 15-second bound plus at most the 3-second backoff, not the body bound.
    expect((second?.at ?? Number.POSITIVE_INFINITY) - 5_000).toBeLessThanOrEqual(18_000);
  });

  it('keeps each attempt inside what remains of the deadline', async () => {
    const net = upstream({
      matches: ({ body, signal }) => later(14_000, () => lookup(JSON.parse(body).md5[0]), signal),
      run: ({ signal }) => later(14_000, () => text(jobIdFor(variant.md5)), signal),
      status: ({ signal }) => later(14_000, () => text('RUNNING'), signal),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const { value, at } = await settle(
      service.scan(service.begin(createMockContext()), variant, 40_000),
    );
    expect(value).toMatchObject({ status: 'RUNNING' });
    expect(net.calls.map((call) => [call.kind, call.at])).toEqual([
      ['matches', 0],
      ['run', 14_000],
      // Five seconds after submission have already passed, so the first poll starts at once.
      ['status', 28_000],
    ]);
    // The next poll would start at 47 s, past the 40-second window, so the call returns.
    expect(at).toBe(42_000);
  });
});

describe('cancellation', () => {
  it('aborts the in-flight poll and sends nothing after the caller cancels', async () => {
    const net = upstream({ status: ({ signal }) => hang(signal) });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = service.scan(
      service.begin(createMockContext({ signal: controller.signal })),
      variant,
      30_000,
    );
    const outcome = pending.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(net.of('status')[0]?.signal.aborted).toBe(true);
    const sent = net.calls.length;
    await vi.runAllTimersAsync();
    expect(net.calls).toHaveLength(sent);
  });

  it('lets a joined caller keep a shared submission when the first caller cancels', async () => {
    const net = upstream({
      run: ({ signal }) => later(3_000, () => text(jobIdFor(variant.md5)), signal),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const first = new AbortController();
    const a = service
      .scan(service.begin(createMockContext({ signal: first.signal })), variant, 0)
      .catch((error: unknown) => error);
    const b = service.scan(service.begin(createMockContext()), variant, 0);
    await vi.advanceTimersByTimeAsync(1_000);
    const reason = new Error('first caller left');
    first.abort(reason);
    expect(await a).toBe(reason);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await b).toMatchObject({ jobId: jobIdFor(variant.md5), status: 'submitted' });
    expect(net.of('run')).toHaveLength(1);
    expect(net.of('run')[0]?.signal.aborted).toBe(false);
  });

  it('aborts a shared submission once every waiting caller has left, and a later call starts afresh', async () => {
    const net = upstream({
      run: ({ signal }) => later(3_000, () => text(jobIdFor(variant.md5)), signal),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const controllers = [new AbortController(), new AbortController()];
    const waiting = controllers.map((controller) =>
      service
        .scan(service.begin(createMockContext({ signal: controller.signal })), variant, 0)
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    for (const controller of controllers) controller.abort(new Error('left'));
    await Promise.all(waiting);
    expect(net.of('run')[0]?.signal.aborted).toBe(true);
    const { value } = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(value).toMatchObject({ jobId: jobIdFor(variant.md5) });
    expect(net.of('run')).toHaveLength(2);
  });
});

describe('dedupe and in-flight cap', () => {
  const distinct = (index: number) => residuesOf(`MKV${'A'.repeat(index + 1)}W`);

  it('returns the in-flight job for a repeated sequence instead of submitting again', async () => {
    const net = upstream({ status: () => text('QUEUED') });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const first = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    const second = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(second.value).toMatchObject({
      jobId: first.value?.source === 'interproscan' && first.value.jobId,
    });
    expect(net.of('run')).toHaveLength(1);
  });

  it('caps in-flight submissions below thirty and sends no run past the cap', async () => {
    const net = upstream({
      status: ({ jobId }) => text(jobId === jobIdFor(distinct(3).md5) ? 'FINISHED' : 'RUNNING'),
      result: () => Response.json(calmodulinResult),
    });
    const service = new SequenceScanService(EMAIL, net.fetch);
    expect(MAX_IN_FLIGHT).toBeLessThan(30);
    for (let index = 0; index < MAX_IN_FLIGHT; index++)
      await settle(service.scan(service.begin(createMockContext()), distinct(index), 0));
    expect(net.of('run')).toHaveLength(MAX_IN_FLIGHT);
    const { error } = await settle(
      service.scan(service.begin(createMockContext()), distinct(MAX_IN_FLIGHT), 0),
    );
    expect(error).toMatchObject({
      code: -32003,
      data: { reason: 'rate_limited', retryable: true, retryAfter: IN_FLIGHT_TTL_MS / 1000 },
    });
    expect(net.of('run')).toHaveLength(MAX_IN_FLIGHT);
    // A repeated in-flight sequence still answers with its job while the cap is full.
    const repeat = await settle(service.scan(service.begin(createMockContext()), distinct(0), 0));
    expect(repeat.value).toMatchObject({ jobId: jobIdFor(distinct(0).md5) });

    // Observing one job finish through a result read frees its slot.
    await settle(service.result(service.begin(createMockContext()), jobIdFor(distinct(3).md5), 0));
    const freed = await settle(
      service.scan(service.begin(createMockContext()), distinct(MAX_IN_FLIGHT), 0),
    );
    expect(freed.value).toMatchObject({ status: 'submitted' });
    expect(net.of('run')).toHaveLength(MAX_IN_FLIGHT + 1);
  });

  it('expires tracked jobs nobody observed after the TTL, bounding the map', async () => {
    const net = upstream({});
    const service = new SequenceScanService(EMAIL, net.fetch);
    for (let index = 0; index < MAX_IN_FLIGHT; index++)
      await settle(service.scan(service.begin(createMockContext()), distinct(index), 0));
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_TTL_MS - 1_000);
    const early = await settle(service.scan(service.begin(createMockContext()), distinct(99), 0));
    expect(early.error).toMatchObject({ data: { reason: 'rate_limited', retryAfter: 1 } });
    await vi.advanceTimersByTimeAsync(1_001);
    const late = await settle(service.scan(service.begin(createMockContext()), distinct(99), 0));
    expect(late.value).toMatchObject({ status: 'submitted' });
    expect((service as unknown as { inFlight: Map<string, unknown> }).inFlight.size).toBe(1);
  });

  it('gives a fresh process and a primed one the same answer for the same input', async () => {
    const answer = async (prime: (service: SequenceScanService) => Promise<void>) => {
      const service = new SequenceScanService(
        EMAIL,
        upstream({ status: () => text('RUNNING') }).fetch,
      );
      await prime(service);
      const hit = await settle(
        service.scan(service.begin(createMockContext()), calmodulin, 10_000),
      );
      const miss = await settle(service.scan(service.begin(createMockContext()), variant, 10_000));
      return { hit: hit.value, miss: miss.value };
    };
    const fresh = await answer(async () => {});
    const primed = await answer(async (service) => {
      for (const sequence of [calmodulin, distinct(1), distinct(2)])
        await settle(service.scan(service.begin(createMockContext()), sequence, 10_000));
      await settle(
        service.result(service.begin(createMockContext()), jobIdFor(distinct(1).md5), 0),
      );
    });
    expect(primed).toEqual(fresh);
    expect(fresh.miss).toMatchObject({ status: 'RUNNING' });
  });

  it('fails a miss as scan_not_configured without an address and sends no run', async () => {
    const net = upstream({});
    const service = new SequenceScanService(undefined, net.fetch);
    const { error } = await settle(
      service.scan(service.begin(createMockContext()), variant, 30_000),
    );
    expect(error).toMatchObject({ code: -32008, data: { reason: 'scan_not_configured' } });
    expect(net.calls.map((call) => call.kind)).toEqual(['matches']);
  });
});

describe('job status mapping', () => {
  const jobId = 'iprscan6-R20261028-131532-0930-13189043-p1m';
  const read = async (status: Route, result?: Route) => {
    const net = upstream({ status, ...(result ? { result } : {}) });
    const service = new SequenceScanService(undefined, net.fetch);
    return { net, ...(await settle(service.result(service.begin(createMockContext()), jobId, 0))) };
  };

  it.each(['QUEUED', 'RUNNING'] as const)(
    'reports %s as pending after one poll',
    async (status) => {
      const { value, net } = await read(() => text(`${status}\n`));
      expect(value).toEqual({
        status,
        sourceUrl: `https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/${jobId}`,
      });
      expect(net.of('status')).toHaveLength(1);
    },
  );

  it('returns the matches of a FINISHED job', async () => {
    const { value } = await read(
      () => text('FINISHED'),
      () => Response.json(akt1Result),
    );
    expect(value).toMatchObject({ status: 'FINISHED', result: { length: 480 } });
    expect(value?.status === 'FINISHED' && value.result.matches).toHaveLength(96);
  });

  it.each(['ERROR', 'FAILURE'])('fails %s as scan_failed', async (status) => {
    const { error } = await read(() => text(status));
    expect(error).toMatchObject({ data: { reason: 'scan_failed', jobId, status } });
  });

  it('fails NOT_FOUND, which arrives as HTTP 200, as scan_not_found', async () => {
    const { error } = await read(() => text('NOT_FOUND', 200));
    expect(error).toMatchObject({ code: -32001, data: { reason: 'scan_not_found', jobId } });
  });

  it('fails a FINISHED job whose result has expired as scan_not_found', async () => {
    const { error } = await read(
      () => text('FINISHED'),
      () => new Response('<error><description>not found</description></error>', { status: 400 }),
    );
    expect(error).toMatchObject({ data: { reason: 'scan_not_found' } });
  });

  it('rejects a status outside the documented vocabulary', async () => {
    const { error } = await read(() => text('PENDING'));
    expect(error).toMatchObject({ data: { reason: 'upstream_shape_invalid' } });
  });
});

describe('submission address', () => {
  it('redacts the address from a rejection that echoes it, case-insensitively', async () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>\n<error>\n <description>Invalid email ${EMAIL.toUpperCase()}\n(see help)</description>\n</error>`;
    const net = upstream({ run: () => new Response(xml, { status: 400 }) });
    const service = new SequenceScanService(EMAIL, net.fetch);
    const ctx = createMockContext();
    const { error } = await settle(service.scan(service.begin(ctx), variant, 0));
    expect(error).toMatchObject({
      message:
        'Job Dispatcher rejected the InterProScan submission: Invalid email [address] (see help)',
      data: { reason: 'scan_rejected', retryable: false },
    });
    const serialized = JSON.stringify({
      error,
      data: (error as { data?: unknown }).data,
      log: ctx.log,
    });
    expect(serialized.toLowerCase()).not.toContain(EMAIL);
    expect(net.of('run')).toHaveLength(1);
  });

  it('reports the documented no-address rejection without a description gap', async () => {
    const xml =
      "<?xml version='1.0' encoding='UTF-8'?><error><description>Please enter an email address</description></error>";
    const service = new SequenceScanService(
      EMAIL,
      upstream({ run: () => new Response(xml, { status: 400 }) }).fetch,
    );
    const { error } = await settle(service.scan(service.begin(createMockContext()), variant, 0));
    expect(error).toMatchObject({
      message: 'Job Dispatcher rejected the InterProScan submission: Please enter an email address',
    });
  });
});

it('polls each job no more often than the documented interval', () => {
  expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
});
