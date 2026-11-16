/**
 * @fileoverview Bounded HTTP/1.1 adapter for InterPro's malformed bodyless 204 responses, also
 * carrying the Matches API and Job Dispatcher requests on the same fixed origin.
 * @module services/interpro/http-adapter
 */

import type { IncomingMessage } from 'node:http';
import { request } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';
import { API_BASE } from './routing.js';

/** Maximum decoded response size, shared by native and injected transports. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * One tool call's wall-clock budget, below the 60-second default MCP client request timeout. It is
 * also the transport's whole-response backstop, so each service's tighter attempt bound ends a
 * request first.
 */
export const CALL_BUDGET_MS = 50_000;
/**
 * Rethrows withRetry's deadline (a `retry_deadline_exceeded` without `retryable`, which times one
 * request) as `budgetError`, the call-budget error the caller sees; other errors pass through.
 */
export const toCallBudget = (
  error: unknown,
  budgetError: (options: ErrorOptions) => McpError,
): never => {
  if (
    error instanceof McpError &&
    error.data?.reason === 'retry_deadline_exceeded' &&
    error.data.retryable !== true
  )
    throw budgetError({ cause: error });
  throw error;
};
/** Fetch-compatible injection seam; callers supply the composed request signal. */
export type InterproFetch = (url: string, init: RequestInit) => Promise<Response>;
/**
 * The documented path prefixes on the fixed origin: the InterPro API, the InterPro Matches API,
 * and the Job Dispatcher's InterProScan 6 service. The URL parser resolves dot segments first.
 */
const ALLOWED_PATH_PREFIXES = [
  '/interpro/api/',
  '/interpro/matches/api/',
  '/Tools/services/rest/iprscan6/',
] as const;

/**
 * The native transport for every request on the fixed origin. It collects one response without
 * following redirects or retaining malformed connections, failing as `upstream_timeout` only when
 * the whole response outlasts {@link CALL_BUDGET_MS}; callers bound each attempt more tightly
 * through the request signal.
 */
export const interproHttpFetch: InterproFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    if (
      target.origin !== new URL(API_BASE).origin ||
      !ALLOWED_PATH_PREFIXES.some((prefix) => target.pathname.startsWith(prefix))
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
      CALL_BUDGET_MS,
    );
    const connectionOptions: ConnectionOptions = { ALPNProtocols: ['http/1.1'] };
    const body = typeof init.body === 'string' ? init.body : undefined;
    const requestHeaders = new Headers(init.headers);
    const accept = requestHeaders.get('accept') ?? 'application/json';
    const contentType = requestHeaders.get('content-type');
    const req = request(target, {
      ...connectionOptions,
      method: body === undefined ? 'GET' : 'POST',
      agent: false,
      headers: {
        Accept: accept,
        'Accept-Encoding': 'identity',
        ...(body === undefined
          ? {}
          : {
              'Content-Type': contentType ?? 'application/json',
              'Content-Length': String(Buffer.byteLength(body, 'utf8')),
            }),
      },
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
    else if (body === undefined) req.end();
    else req.end(body);
  });

/**
 * Classify a non-OK upstream response: 5xx (except 501), 408, and 429 are retryable; any other
 * client status is reported as a non-retryable service failure, not a caller error.
 */
export async function upstreamStatusError(response: Response, service: string): Promise<McpError> {
  const status = response.status;
  const reason =
    status === 408 || status === 504
      ? 'upstream_timeout'
      : status === 429
        ? 'upstream_rate_limited'
        : status >= 500
          ? 'upstream_unavailable'
          : 'upstream_rejected';
  return await httpErrorFromResponse(response, {
    service,
    captureBody: false,
    codeOverride: (value) =>
      value < 500 && value !== 408 && value !== 429
        ? JsonRpcErrorCode.ServiceUnavailable
        : undefined,
    data: {
      reason,
      retryable: (status >= 500 && status !== 501) || status === 408 || status === 429,
    },
  });
}
