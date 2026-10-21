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

  it.each(['https://evil.test/interpro/api/entry/', 'https://www.ebi.ac.uk/private/'])(
    'rejects out-of-scope URL %s before I/O',
    async (url) => {
      const { interproHttpFetch } = await import('@/services/interpro/http-adapter.js');
      await expect(interproHttpFetch(url, {})).rejects.toMatchObject({
        data: { reason: 'upstream_rejected' },
      });
      expect(native.request).not.toHaveBeenCalled();
    },
  );
});
