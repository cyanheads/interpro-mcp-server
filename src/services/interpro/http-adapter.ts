/**
 * @fileoverview Bounded HTTP/1.1 adapter for InterPro's malformed bodyless 204 responses.
 * @module services/interpro/http-adapter
 */

import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import { serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { API_BASE } from './routing.js';

/** Maximum decoded response size, shared by native and injected transports. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Fetch-compatible injection seam; callers supply the composed request signal. */
export type InterproFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Collect one response without following redirects or retaining malformed connections. */
export const interproHttpFetch: InterproFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    if (
      target.origin !== new URL(API_BASE).origin ||
      !target.pathname.startsWith('/interpro/api/')
    ) {
      reject(
        serviceUnavailable('InterPro request left the fixed API origin.', {
          reason: 'upstream_rejected',
          retryable: false,
        }),
      );
      return;
    }
    const signal = init.signal;
    signal?.throwIfAborted();
    let settled = false;
    let response: IncomingMessage | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      req.destroy();
      reject(error);
    };
    const abort = () => fail(signal?.reason);
    const timer = setTimeout(
      () =>
        fail(
          timeout('InterPro response exceeded its attempt deadline.', {
            reason: 'upstream_timeout',
            retryable: true,
          }),
        ),
      15_000,
    );
    const connectionOptions: ConnectionOptions = { ALPNProtocols: ['http/1.1'] };
    const req = request(target, {
      ...connectionOptions,
      method: 'GET',
      agent: false,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    });
    req.on('error', (cause) =>
      fail(
        serviceUnavailable(
          'InterPro connection failed.',
          { reason: 'upstream_unavailable', retryable: true },
          { cause },
        ),
      ),
    );
    req.on('close', () => {
      if (!response)
        fail(
          serviceUnavailable('InterPro connection closed before response headers.', {
            reason: 'upstream_unavailable',
            retryable: true,
          }),
        );
    });
    req.on('response', (incoming) => {
      response = incoming;
      incoming.on('error', (cause) =>
        fail(
          serviceUnavailable(
            'InterPro response stream failed.',
            { reason: 'upstream_unavailable', retryable: true },
            { cause },
          ),
        ),
      );
      incoming.on('aborted', () =>
        fail(
          serviceUnavailable('InterPro response ended prematurely.', {
            reason: 'upstream_unavailable',
            retryable: true,
          }),
        ),
      );
      incoming.on('close', () => {
        if (!incoming.complete)
          fail(
            serviceUnavailable('InterPro response closed before completion.', {
              reason: 'upstream_unavailable',
              retryable: true,
            }),
          );
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const status = incoming.statusCode;
      if (!status) {
        fail(
          serviceUnavailable('InterPro response lacks an HTTP status.', {
            reason: 'upstream_shape_invalid',
            retryable: false,
          }),
        );
        return;
      }
      if (status === 204) {
        settled = true;
        cleanup();
        resolve(new Response(null, { status, headers }));
        incoming.destroy();
        req.destroy();
        return;
      }
      const encoding = headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') {
        fail(
          serviceUnavailable('InterPro returned an unexpected content encoding.', {
            reason: 'upstream_shape_invalid',
            retryable: false,
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          fail(
            serviceUnavailable('InterPro response exceeds 4 MiB.', {
              reason: 'upstream_response_too_large',
              retryable: false,
            }),
          );
          return;
        }
        chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(new Response(status === 304 ? null : Buffer.concat(chunks), { status, headers }));
        } catch (cause) {
          reject(
            serviceUnavailable(
              'InterPro returned invalid HTTP response metadata.',
              { reason: 'upstream_shape_invalid', retryable: false },
              { cause },
            ),
          );
        }
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else req.end();
  });
