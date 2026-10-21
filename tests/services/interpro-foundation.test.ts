/**
 * @fileoverview Network-boundary and lossless representation tests for InterPro.
 * @module tests/services/interpro-foundation
 */
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { continuation, decodeCursor, encodeCursor } from '@/services/interpro/cursors.js';
import { formatInterpro, normalizeImages } from '@/services/interpro/format.js';
import { apiUrl, ENTRY_ROUTES, resolveClan, resolveEntry } from '@/services/interpro/routing.js';

describe('routing and continuation boundaries', () => {
  it('routes every reference example and normalizes case', () => {
    for (const route of ENTRY_ROUTES) {
      expect(resolveEntry(route.example.toLowerCase()).sourceDatabase).toBe(route.source);
    }
    expect(resolveClan('CL0016').sourceDatabase).toBe('pfam');
    expect(resolveClan('cl0016').sourceDatabase).toBe('cdd');
    expect(resolveClan('CL0016', 'cdd').accession).toBe('cl0016');
    expect(() => resolveEntry('PF00870', 'interpro')).toThrow();
    expect(() => resolveEntry('unknown')).toThrow();
    expect(() => resolveClan('CL0016', 'pirsf')).toThrow();
  });

  it('rejects path escapes and only uses a foreign next URL as a cursor carrier', () => {
    for (const segment of ['..', '.', 'https://evil.test', 'a/b', '%2e%2e']) {
      expect(() => apiUrl(['entry', segment])).toThrow();
    }
    const cursor = continuation('https://evil.test/private?cursor=opaque%2Btoken');
    const url = new URL(apiUrl(['entry', 'pfam'], { cursor }));
    expect(url.origin).toBe('https://www.ebi.ac.uk');
    expect(url.searchParams.get('cursor')).toBe('opaque+token');
    expect(() => continuation('?cursor=again', new Set(['again']))).toThrow();
    expect(() => continuation('?page=2')).toThrow();
  });

  it('binds versioned cursors to nested filters and operation', () => {
    const token = encodeCursor('search', { filters: { b: false, a: 1 } }, 'next');
    expect(decodeCursor(token, 'search', { filters: { a: 1, b: false } })).toBe('next');
    expect(() => decodeCursor(token, 'search', { filters: { a: 2, b: false } })).toThrow();
    expect(() => decodeCursor(token, 'clan', {})).toThrow();
    for (const invalid of ['!', 'e30', 'x'.repeat(4097)]) {
      expect(() => decodeCursor(invalid, 'search', {})).toThrow();
    }
    expect(decodeCursor(undefined, 'search', {})).toBeUndefined();
  });
});

describe('lossless formatting', () => {
  it('indexes whole quoted URLs once and images embedded in prose', () => {
    const value = {
      url: "https://example.test/a'b",
      html: '<img src="https://example.test/a.png">',
    };
    const text = formatInterpro(value)[0]?.text ?? '';
    expect(JSON.parse(text.match(/`+json\n([\s\S]*?)\n`+/)?.[1] ?? '')).toEqual(value);
    expect(text.match(/\[Link \d+\]\(<([^>]+)>\)/g)).toEqual([
      "[Link 1](<https://example.test/a'b>)",
      '[Link 2](<https://example.test/a.png>)',
    ]);
    expect(text).toContain('![Image 1](<https://example.test/a.png>)');
  });
  it('round-trips nested punctuation, HTML, fences, Unicode and image values', () => {
    const value = normalizeImages({
      text: '<b>literal</b>\n```\n[title](target)\u2028\u2029',
      nested: [{ thumbnail: 'iVBORw0KGgoAAA', url: 'https://example.test/a_(b)?a=1&b=2' }],
      omitted: null,
    });
    const text = formatInterpro(value)[0]?.text ?? '';
    const json = text.match(/`+json\n([\s\S]*?)\n`+/)?.[1];
    expect(JSON.parse(json ?? '')).toEqual(value);
    expect(text).toContain('[Link 1](<https://example.test/a_(b)?a=1&amp;b=2>)');
    expect(text).toContain('![Image 1](<data:image/png;base64,iVBORw0KGgoAAA>)');
  });
});

describe('InterproService at the HTTP seam', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  async function serviceFor(responses: Response[]) {
    const { InterproService } = await import('@/services/interpro/interpro-service.js');
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error('Unexpected additional upstream request');
      return response;
    });
    const service = new InterproService(fetch);
    const ctx = createMockContext();
    return { service, fetch, call: service.begin(ctx), ctx };
  }

  async function settle<T>(promise: Promise<T>): Promise<T> {
    const outcome = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
  }

  it('distinguishes list 204 from detail absence without reading a body', async () => {
    const { service, call, fetch } = await serviceFor([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);
    expect((await settle(service.request(call, ['entry'], {}, z.object({})))).data).toBeNull();
    await expect(
      settle(
        service.request(call, ['entry', 'pfam', 'PF00870'], {}, z.object({}), {
          missing: 'entry_not_found',
        }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'entry_not_found', retryable: false } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, 'upstream_rejected', false],
    [401, 'upstream_rejected', false],
    [403, 'upstream_rejected', false],
    [425, 'upstream_rejected', false],
    [501, 'upstream_unavailable', false],
    [408, 'upstream_timeout', true],
    [504, 'upstream_timeout', true],
    [503, 'upstream_unavailable', true],
    [429, 'upstream_rate_limited', true],
  ] as const)('maps HTTP %i and bounds retries', async (status, reason, retryable) => {
    const { service, call, fetch } = await serviceFor([
      new Response('private upstream diagnostics', { status }),
      new Response(null, { status }),
    ]);
    await expect(settle(service.request(call, ['entry'], {}, z.object({})))).rejects.toMatchObject({
      data: { reason, retryable },
    });
    expect(fetch).toHaveBeenCalledTimes(retryable ? 2 : 1);
  });

  it.each(['{bad', '{"wrong":true}'])(
    'does not retry malformed or incompatible JSON: %s',
    async (body) => {
      const { service, call, fetch } = await serviceFor([new Response(body)]);
      await expect(
        settle(service.request(call, ['entry'], {}, z.object({ count: z.number() }))),
      ).rejects.toMatchObject({ data: { reason: 'upstream_shape_invalid', retryable: false } });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('extracts only bounded withdrawal metadata and rejects invalid continuation', async () => {
    const { service, call } = await serviceFor([
      Response.json({ accession: 'PF00000', secret: 'omit', history: ['old'] }, { status: 410 }),
      new Response(null, { status: 404 }),
    ]);
    await expect(
      settle(
        service.request(call, ['entry', 'PF00000'], {}, z.object({}), {
          missing: 'entry_not_found',
        }),
      ),
    ).rejects.toMatchObject({
      data: { reason: 'entry_withdrawn', accession: 'PF00000', history: ['old'] },
    });
    await expect(
      settle(service.request(call, ['entry'], {}, z.object({}), { continuation: true })),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
  });

  it('maps a withdrawn entry list target without treating empty lists as missing details', async () => {
    const { service, call } = await serviceFor([
      Response.json({ accession: 'PF00000' }, { status: 410 }),
    ]);
    await expect(
      settle(
        service.request(call, ['protein', 'uniprot', 'entry', 'pfam', 'PF00000'], {}, z.object({})),
      ),
    ).rejects.toMatchObject({ data: { reason: 'entry_withdrawn', retryable: false } });
  });

  it('chooses numeric release order and preserves complete nested counts', async () => {
    const counts = { entries: { pfam: { entries: 42, nested: { unintegrated: 3 } } } };
    const { service, ctx, fetch } = await serviceFor([
      Response.json({ '9.0': 'old', '110.0': 'current', '99.2': 'older' }),
      Response.json(counts),
    ]);
    expect(await settle(service.release(ctx))).toMatchObject({
      version: '110.0',
      date: 'current',
      databaseCounts: counts,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails a release that changes between the two operations', async () => {
    const { service, ctx } = await serviceFor([
      Response.json({ '110.0': 'date' }, { headers: { 'interpro-version': '110.0' } }),
      Response.json({ entries: {} }, { headers: { 'interpro-version': '111.0' } }),
    ]);
    await expect(settle(service.release(ctx))).rejects.toMatchObject({
      data: { reason: 'release_changed', retryable: true },
    });
  });

  it('paces independent requests at least one second apart', async () => {
    const { service, call, fetch } = await serviceFor([Response.json({}), Response.json({})]);
    const starts: number[] = [];
    fetch.mockImplementation(async () => {
      starts.push(performance.now());
      return Response.json({});
    });
    await settle(
      Promise.all([
        service.request(call, ['entry'], {}, z.object({})),
        service.request(call, ['entry'], {}, z.object({})),
      ]),
    );
    expect(starts).toHaveLength(2);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1000);
  });

  it('does not retry a Retry-After beyond its bounded retry delay', async () => {
    const { service, call, fetch } = await serviceFor([
      new Response(null, { status: 429, headers: { 'Retry-After': '60' } }),
    ]);
    await expect(settle(service.request(call, ['entry'], {}, z.object({})))).rejects.toMatchObject({
      data: { reason: 'upstream_rate_limited' },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending body and performs no retry', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const { service, fetch } = await serviceFor([new Response(new ReadableStream({ cancel }))]);
    const ctx = createMockContext({ signal: controller.signal });
    const reason = new Error('caller cancelled');
    const outcome = service
      .request(service.begin(ctx), ['entry'], {}, z.object({}))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued request before it reaches the network', async () => {
    const controller = new AbortController();
    const { service, call, fetch } = await serviceFor([Response.json({})]);
    await service.request(call, ['entry'], {}, z.object({}));
    const ctx = createMockContext({ signal: controller.signal });
    const reason = new Error('queued caller cancelled');
    const pending = service
      .request(service.begin(ctx), ['entry'], {}, z.object({}))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels retry backoff before starting another attempt', async () => {
    const controller = new AbortController();
    const { service, fetch } = await serviceFor([new Response(null, { status: 503 })]);
    const ctx = createMockContext({ signal: controller.signal });
    const reason = new Error('backoff caller cancelled');
    const pending = service
      .request(service.begin(ctx), ['entry'], {}, z.object({}))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an already exhausted shared call budget before I/O', async () => {
    const { service, call, fetch } = await serviceFor([]);
    await vi.advanceTimersByTimeAsync(50_001);
    await expect(service.request(call, ['entry'], {}, z.object({}))).rejects.toMatchObject({
      data: { reason: 'retry_deadline_exceeded' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts each network attempt at fifteen seconds and retries only once', async () => {
    const { service, call, fetch } = await serviceFor([]);
    const attempts: number[] = [];
    fetch.mockImplementation(
      (_url?: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          attempts.push(performance.now());
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    await expect(settle(service.request(call, ['entry'], {}, z.object({})))).rejects.toMatchObject({
      data: { reason: 'upstream_timeout', retryable: true },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(performance.now()).toBeGreaterThanOrEqual((attempts[1] ?? 0) + 15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sheds saturated queued demand at its five-second wait budget before network I/O', async () => {
    const { service, fetch } = await serviceFor([]);
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    fetch.mockImplementation(
      (_url?: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const active = service
      .request(service.begin(ctx), ['entry'], {}, z.object({}))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const queued = Array.from({ length: 20 }, () =>
      service
        .request(service.begin(ctx), ['entry'], {}, z.object({}))
        .catch((error: unknown) => error),
    );
    await vi.advanceTimersByTimeAsync(0);
    const shed = service
      .request(service.begin(ctx), ['entry'], {}, z.object({}))
      .catch((error: unknown) => error);
    expect(await shed).toMatchObject({
      data: { reason: 'pacer_shed', shedKind: 'wait_projected', queueDepth: 5 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort(new Error('fixture cleanup'));
    await Promise.all([active, ...queued]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps streamed bytes before parsing and never retries an oversized response', async () => {
    const { service, call, fetch } = await serviceFor([
      new Response('x'.repeat(4 * 1024 * 1024 + 1)),
    ]);
    await expect(settle(service.request(call, ['entry'], {}, z.object({})))).rejects.toMatchObject({
      data: { reason: 'upstream_response_too_large', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an HTML error page as upstream unavailability', async () => {
    const { service, call, fetch } = await serviceFor([
      new Response('<!doctype html><html>maintenance</html>'),
      Response.json({ count: 0 }),
    ]);
    expect(
      (await settle(service.request(call, ['entry'], {}, z.object({ count: z.number() })))).data,
    ).toEqual({ count: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects unexpected content encoding without parsing or retry', async () => {
    const { service, call, fetch } = await serviceFor([
      new Response('{}', { headers: { 'content-encoding': 'gzip' } }),
    ]);
    await expect(settle(service.request(call, ['entry'], {}, z.object({})))).rejects.toMatchObject({
      data: { reason: 'upstream_shape_invalid', retryable: false },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
