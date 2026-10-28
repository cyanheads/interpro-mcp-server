/**
 * @fileoverview One paced, cancellable InterPro request boundary for every tool workflow.
 * @module services/interpro/interpro-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, defaultIsTransient, withRetry } from '@cyanheads/mcp-ts-core/utils';
import {
  type InterproFetch,
  interproHttpFetch,
  MAX_RESPONSE_BYTES,
  upstreamStatusError,
} from './http-adapter.js';
import { apiUrl } from './routing.js';
import { isAccession, JsonObjectSchema, JsonValueSchema } from './schemas.js';

const pacer = createPacer({
  name: 'interpro',
  minStartGapMs: 1000,
  maxConcurrent: 1,
  maxQueueDepth: 20,
});
/** One deadline shared by every distinct operation of a tool invocation. */
export interface InterproCall {
  readonly ctx: Context;
  readonly deadline: number;
}
/** The record a request addresses, reported under `reason` when InterPro has no such record. */
export interface MissingRecord {
  readonly accession: string;
  /** A list scoped to the record: 204 is a valid empty page, so only 404 reports it missing. */
  readonly list?: boolean;
  readonly reason:
    | 'entry_not_found'
    | 'protein_not_found'
    | 'clan_not_found'
    | 'structure_not_found';
  readonly sourceDatabase: string;
}
/** Upstream fields of a 410 body that are echoed in the withdrawal error. */
const WITHDRAWAL_FIELDS: ReadonlySet<string> = new Set([
  'accession',
  'source_database',
  'deletion_date',
  'short_name',
  'history',
]);
/**
 * Single-line forms a withdrawal date or short name must match whole before the message names it;
 * any other upstream value stays in error data only.
 */
const WITHDRAWAL_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const SHORT_NAME = /^[A-Za-z0-9_.:+-]{1,100}$/;
const RECORD_NOUNS = {
  entry_not_found: 'entry',
  clan_not_found: 'set',
  protein_not_found: 'protein',
  structure_not_found: 'structure',
} as const;
/** Name a record in a caller-facing message, e.g. `entry PF00870 in pfam`. */
const describeRecord = ({ reason, accession, sourceDatabase }: MissingRecord) =>
  `${RECORD_NOUNS[reason]} ${accession} in ${sourceDatabase}`;
/** Domain status handling selected by the tool workflow. */
export interface RequestOptions {
  readonly continuation?: boolean;
  readonly missing?: MissingRecord;
}
/** Validated response plus headers needed for release consistency. */
export interface InterproResponse<T> {
  readonly data: T | null;
  readonly headers: Headers;
  readonly sourceUrl: string;
}

/** InterPro service; inject only the network seam, retaining the real domain behavior. */
export class InterproService {
  constructor(private readonly fetch: InterproFetch = interproHttpFetch) {}

  /** Start a 50-second call budget, once per handler invocation. */
  begin(ctx: Context): InterproCall {
    return { ctx, deadline: performance.now() + 50_000 };
  }

  /** Fetch, classify, parse and validate one fixed-origin operation within a shared call. */
  async request<T extends z.ZodType>(
    call: InterproCall,
    segments: readonly string[],
    query: Readonly<Record<string, string | number | boolean | undefined>>,
    schema: T,
    options: RequestOptions = {},
  ): Promise<InterproResponse<z.output<T>>> {
    call.ctx.signal.throwIfAborted();
    const remaining = call.deadline - performance.now();
    if (remaining <= 0)
      throw timeout('InterPro call exhausted its 50-second budget.', {
        reason: 'retry_deadline_exceeded',
        retryable: true,
        deadlineMs: 50_000,
      });
    const sourceUrl = apiUrl(segments, query);
    return await withRetry(
      async ({ signal }) =>
        pacer.run(
          async () => {
            const attemptMs = Math.min(15_000, call.deadline - performance.now());
            const controller = new AbortController();
            const timer = setTimeout(
              () =>
                controller.abort(
                  timeout('InterPro attempt deadline elapsed.', {
                    reason: 'upstream_timeout',
                    retryable: true,
                  }),
                ),
              Math.max(0, attemptMs),
            );
            const attemptSignal = AbortSignal.any([signal, controller.signal, call.ctx.signal]);
            try {
              const response = await this.fetch(sourceUrl, {
                signal: attemptSignal,
                headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
                redirect: 'manual',
              });
              attemptSignal.throwIfAborted();
              if ((response.status === 400 || response.status === 404) && options.continuation)
                throw validationError('InterPro rejected the continuation cursor.', {
                  reason: 'invalid_cursor',
                  retryable: false,
                  status: response.status,
                });
              const { missing } = options;
              if (
                missing &&
                (response.status === 404 || (response.status === 204 && !missing.list))
              )
                throw notFound(`InterPro could not find ${describeRecord(missing)}.`, {
                  reason: missing.reason,
                  retryable: false,
                  status: response.status,
                  accession: missing.accession,
                  sourceDatabase: missing.sourceDatabase,
                });
              if (response.status === 204)
                return { data: null, sourceUrl, headers: response.headers };
              if (response.status === 410) {
                const body = await readBody(response, attemptSignal);
                let withdrawal: Record<string, unknown> = {};
                try {
                  const parsed = JsonObjectSchema.parse(JSON.parse(body));
                  withdrawal = Object.fromEntries(
                    Object.entries(parsed).filter(
                      ([key, value]) =>
                        WITHDRAWAL_FIELDS.has(key) && JSON.stringify(value).length <= 4096,
                    ),
                  );
                } catch {
                  /* A withdrawn record need not include valid metadata. */
                }
                const { accession, deletion_date: deleted, short_name: shortName } = withdrawal;
                const subject = missing
                  ? describeRecord(missing)
                  : isAccession(accession)
                    ? `record ${accession}`
                    : 'the requested record';
                const on =
                  typeof deleted === 'string' && WITHDRAWAL_DATE.test(deleted)
                    ? ` on ${deleted}`
                    : '';
                const named =
                  typeof shortName === 'string' && SHORT_NAME.test(shortName)
                    ? ` (short name ${shortName})`
                    : '';
                throw notFound(`InterPro reports that ${subject} was withdrawn${on}${named}.`, {
                  reason: 'entry_withdrawn',
                  retryable: false,
                  status: 410,
                  ...withdrawal,
                  // The canonical accession the message names wins over upstream's spelling.
                  ...(missing ? { accession: missing.accession } : {}),
                });
              }
              if (!response.ok) throw await upstreamStatusError(response, 'InterPro');
              const encoding = response.headers.get('content-encoding');
              if (encoding && encoding.toLowerCase() !== 'identity')
                throw serviceUnavailable('InterPro returned an unexpected content encoding.', {
                  reason: 'upstream_shape_invalid',
                  retryable: false,
                });
              const body = await readBody(response, attemptSignal);
              if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(body))
                throw serviceUnavailable('InterPro returned HTML instead of JSON.', {
                  reason: 'upstream_unavailable',
                  retryable: true,
                });
              let json: unknown;
              try {
                json = JSON.parse(body);
              } catch (cause) {
                throw serviceUnavailable(
                  'InterPro returned malformed JSON.',
                  { reason: 'upstream_shape_invalid', retryable: false },
                  { cause },
                );
              }
              const parsed = schema.safeParse(json);
              if (!parsed.success)
                throw serviceUnavailable(
                  'InterPro JSON does not match the required response structure.',
                  { reason: 'upstream_shape_invalid', retryable: false },
                );
              attemptSignal.throwIfAborted();
              if (performance.now() > call.deadline)
                throw timeout('InterPro call exhausted its total budget.', {
                  reason: 'retry_deadline_exceeded',
                  retryable: true,
                });
              return { data: parsed.data, sourceUrl, headers: response.headers };
            } catch (cause) {
              if (call.ctx.signal.aborted) throw call.ctx.signal.reason;
              if (signal.aborted) throw signal.reason;
              if (controller.signal.aborted) throw controller.signal.reason;
              if (cause instanceof McpError) throw cause;
              throw serviceUnavailable(
                'InterPro network request failed.',
                { reason: 'upstream_unavailable', retryable: true },
                { cause },
              );
            } finally {
              clearTimeout(timer);
            }
          },
          { signal, maxWaitMs: Math.max(0, Math.min(5000, call.deadline - performance.now())) },
        ),
      {
        signal: call.ctx.signal,
        context: call.ctx,
        operation: 'interpro.request',
        deadlineMs: remaining,
        maxRetries: 1,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
        isTransient: defaultIsTransient,
      },
    );
  }

  /** Retrieve a coherent current release and its complete database-count object. */
  async release(ctx: Context) {
    const call = this.begin(ctx);
    const releases = await this.request(
      call,
      ['utils', 'release'],
      {},
      z.record(z.string().regex(/^\d+(?:\.\d+)*$/), z.string()),
    );
    const counts = await this.request(
      call,
      ['entry'],
      {},
      z.object({ entries: JsonObjectSchema }).catchall(JsonValueSchema),
    );
    if (!releases.data || !counts.data || !Object.keys(releases.data).length)
      throw serviceUnavailable('InterPro release metadata is missing.', {
        reason: 'upstream_shape_invalid',
        retryable: false,
      });
    const firstVersion = releases.headers.get('interpro-version');
    const secondVersion = counts.headers.get('interpro-version');
    if (firstVersion && secondVersion && firstVersion !== secondVersion)
      throw serviceUnavailable('InterPro release changed between metadata responses.', {
        reason: 'release_changed',
        retryable: true,
      });
    const version = Object.keys(releases.data).sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (right[index] ?? 0) - (left[index] ?? 0);
        if (difference) return difference;
      }
      return 0;
    })[0];
    if (!version)
      throw serviceUnavailable('InterPro release map has no version.', {
        reason: 'upstream_shape_invalid',
        retryable: false,
      });
    return {
      version,
      date: releases.data[version] as string,
      databaseCounts: counts.data,
      sourceUrls: [releases.sourceUrl, counts.sourceUrl],
    };
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw serviceUnavailable('InterPro response exceeds 4 MiB.', {
          reason: 'upstream_response_too_large',
          retryable: false,
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

let service: InterproService | undefined;
/** Initialize the process service in createApp.setup. */
export function initInterproService(fetch: InterproFetch = interproHttpFetch): void {
  service = new InterproService(fetch);
}
/** Obtain the initialized process service. */
export function getInterproService(): InterproService {
  if (!service) throw new Error('InterPro service is not initialized.');
  return service;
}
/** Dispose queued pacing work during application teardown. */
export function disposeInterproService(): void {
  pacer.dispose();
}
