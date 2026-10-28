/**
 * @fileoverview HTTP adapter lifecycle tests at the native request boundary.
 * @module tests/services/interpro-http-adapter
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: native.request }));

describe('InterPro HTTP adapter', () => {
  const req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const response = (statusCode: number, headers: Record<string, string> = {}) =>
    Object.assign(new EventEmitter(), { statusCode, headers, complete: false, destroy: vi.fn() });

  beforeEach(() => {
    vi.useFakeTimers();
    req.removeAllListeners();
    req.destroy.mockClear();
    req.end.mockClear();
    native.request.mockReset().mockReturnValue(req);
  });
  afterEach(() => vi.useRealTimers());

  it('settles malformed 204 at headers and safely observes teardown errors', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {});
    const incoming = response(204, { 'content-length': '99', 'interpro-version': '110.0' });
    req.emit('response', incoming);
    incoming.emit('error', new Error('surplus bytes'));
    req.emit('error', new Error('teardown'));
    const result = await pending;
    expect(result.status).toBe(204);
    expect(await result.text()).toBe('');
    expect(result.headers.get('interpro-version')).toBe('110.0');
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(native.request.mock.calls[0]?.[1]).toMatchObject({
      agent: false,
      ALPNProtocols: ['http/1.1'],
      headers: { 'Accept-Encoding': 'identity' },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('issues a bodiless GET with fixed JSON headers for an InterPro API read', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/?page_size=1', {
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
      redirect: 'manual',
    });
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.complete = true;
    incoming.emit('end');
    await pending;
    const [target, options] = native.request.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://www.ebi.ac.uk/interpro/api/entry/?page_size=1');
    expect(options).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
    expect(Object.keys(options.headers).sort()).toEqual(['Accept', 'Accept-Encoding']);
    expect(req.end).toHaveBeenCalledOnce();
    expect(req.end.mock.calls[0]).toEqual([]);
  });

  it('collects a complete normal response and preserves headers', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {});
    const incoming = response(200, { 'retry-after': '3' });
    req.emit('response', incoming);
    incoming.emit('data', Buffer.from('{"a":'));
    incoming.emit('data', Buffer.from('1}'));
    incoming.complete = true;
    incoming.emit('end');
    const result = await pending;
    expect(await result.json()).toEqual({ a: 1 });
    expect(result.headers.get('retry-after')).toBe('3');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the attempt deadline while a response body stalls', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {}).catch(
      (error: unknown) => error,
    );
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.emit('data', Buffer.from('{'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ data: { reason: 'upstream_timeout', retryable: true } });
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(req.destroy).toHaveBeenCalledOnce();
  });

  it('applies a longer whole-response backstop from the factory to a slow body', async () => {
    const { createInterproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const slow = createInterproHttpFetch(50_000);
    const pending = slow('https://www.ebi.ac.uk/interpro/matches/api/matches', {
      body: '{"md5":["EBD0AA0BC77B635530A6938487B7099B"]}',
    }).catch((error: unknown) => error);
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.emit('data', Buffer.from('{"results":'));
    await vi.advanceTimersByTimeAsync(30_000);
    incoming.emit('data', Buffer.from('[]}'));
    incoming.complete = true;
    incoming.emit('end');
    expect(await ((await pending) as Response).json()).toEqual({ results: [] });

    const stalled = slow('https://www.ebi.ac.uk/interpro/matches/api/matches', {
      body: '{}',
    }).catch((error: unknown) => error);
    req.emit('response', response(200));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await stalled).toMatchObject({ data: { reason: 'upstream_timeout' } });
  });

  it('gives the scan service a native transport that outlasts a slow precalculated lookup', async () => {
    const { createMockContext } = await import('@cyanheads/mcp-ts-core/testing');
    const { SequenceScanService } = await import(
      '@/services/sequence-scan/sequence-scan-service.js'
    );
    const md5 = 'EBD0AA0BC77B635530A6938487B7099B';
    const service = new SequenceScanService(undefined);
    const pending = service
      .scan(service.begin(createMockContext()), { md5, residues: 'M' }, 0)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.emit('data', Buffer.from(`{"results":[{"md5":"${md5}",`));
    // A 0.7 MB lookup has taken 20-34 seconds; the 15-second API backstop would abort it.
    await vi.advanceTimersByTimeAsync(25_000);
    incoming.emit('data', Buffer.from('"found":false,"matches":[]}]}'));
    incoming.complete = true;
    incoming.emit('end');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ data: { reason: 'scan_not_configured' } });
    expect(native.request).toHaveBeenCalledOnce();
  });

  it.each(['aborted', 'close', 'error'] as const)(
    'rejects premature non-204 response %s',
    async (event) => {
      const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
      const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {}).catch(
        (error: unknown) => error,
      );
      const incoming = response(200);
      req.emit('response', incoming);
      incoming.emit(event, new Error('truncated'));
      expect(await pending).toMatchObject({ data: { reason: 'upstream_unavailable' } });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('cancels exactly its own request and preserves caller reason', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unexpected encoding at headers and tears down the request', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {}).catch(
      (error: unknown) => error,
    );
    const incoming = response(200, { 'content-encoding': 'br' });
    req.emit('response', incoming);
    expect(await pending).toMatchObject({
      data: { reason: 'upstream_shape_invalid', retryable: false },
    });
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a body crossing four MiB and observes late teardown errors safely', async () => {
    const { interproHttpFetch, MAX_RESPONSE_BYTES } = await import(
      '@/services/interpro/http-adapter.js'
    );
    const pending = interproHttpFetch('https://www.ebi.ac.uk/interpro/api/entry/', {}).catch(
      (error: unknown) => error,
    );
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES));
    expect(incoming.destroy).not.toHaveBeenCalled();
    incoming.emit('data', Buffer.from('x'));
    incoming.emit('error', new Error('teardown'));
    expect(await pending).toMatchObject({
      data: { reason: 'upstream_response_too_large', retryable: false },
    });
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      'https://www.ebi.ac.uk/interpro/matches/api/matches',
      '{"md5":["EBD0AA0BC77B635530A6938487B7099B"]}',
      'application/json',
      'application/json',
    ],
    [
      'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/run',
      'email=a%40b.test&sequence=MKV',
      'application/x-www-form-urlencoded',
      'text/plain',
    ],
  ])('POSTs a string body with its length to %s', async (url, body, contentType, accept) => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch(url, {
      method: 'POST',
      body,
      headers: { Accept: accept, 'Content-Type': contentType },
    });
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.complete = true;
    incoming.emit('end');
    await pending;
    expect(native.request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        Accept: accept,
        'Accept-Encoding': 'identity',
        'Content-Type': contentType,
        'Content-Length': String(Buffer.byteLength(body)),
      },
    });
    expect(req.end).toHaveBeenCalledWith(body);
  });

  it('GETs a Job Dispatcher status path inside the iprscan6 prefix', async () => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    const pending = interproHttpFetch(
      'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/status/iprscan6-R20261028-131532-0930-13189043-p1m',
      { headers: { Accept: 'text/plain' } },
    );
    const incoming = response(200);
    req.emit('response', incoming);
    incoming.complete = true;
    incoming.emit('end');
    await pending;
    expect(native.request.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'text/plain' },
    });
    expect(req.end.mock.calls[0]).toEqual([]);
  });

  it.each([
    'https://evil.test/interpro/api/entry/',
    'https://www.ebi.ac.uk/private/',
    'https://www.ebi.ac.uk/Tools/services/rest/iprscan5/run',
    'https://www.ebi.ac.uk/Tools/services/rest/ncbiblast/run',
    'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/../ncbiblast/run',
    'https://www.ebi.ac.uk/Tools/services/rest/iprscan6/%2e%2e/ncbiblast/run',
    'http://www.ebi.ac.uk/interpro/matches/api/matches',
    'https://www.ebi.ac.uk:8443/interpro/matches/api/matches',
  ])('rejects out-of-scope URL %s before I/O', async (url) => {
    const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
    await expect(interproHttpFetch(url, {})).rejects.toMatchObject({
      data: { reason: 'upstream_rejected' },
    });
    expect(native.request).not.toHaveBeenCalled();
  });
});
