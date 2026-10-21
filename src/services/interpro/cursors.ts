/**
 * @fileoverview Query-bound, versioned pagination tokens.
 * @module services/interpro/cursors
 */
import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { API_BASE } from './routing.js';

const CursorSchema = z
  .object({
    v: z.literal(1),
    operation: z.string().min(1),
    scope: z.string(),
    upstreamCursor: z.string().min(1),
  })
  .strict();
/** Deterministic canonical scope, independent of object key insertion order. */
export function cursorScope(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
/** Encode only the continuation value, never an upstream request URL. */
export function encodeCursor(operation: string, scope: unknown, upstreamCursor: string): string {
  const token = Buffer.from(
    JSON.stringify({ v: 1, operation, scope: cursorScope(scope), upstreamCursor }),
  ).toString('base64url');
  if (token.length > 4096)
    throw serviceUnavailable('InterPro continuation exceeds the supported token size.', {
      reason: 'upstream_shape_invalid',
      retryable: false,
    });
  return token;
}
/** Reject malformed tokens and tokens reused with a changed target or filter. */
export function decodeCursor(
  token: string | undefined,
  operation: string,
  scope: unknown,
): string | undefined {
  if (token === undefined) return undefined;
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error('Invalid cursor encoding.');
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    if (parsed.operation !== operation || parsed.scope !== cursorScope(scope))
      throw new Error('Cursor scope differs.');
    return parsed.upstreamCursor;
  } catch (cause) {
    throw validationError(
      'Cursor is invalid or belongs to a different query.',
      { reason: 'invalid_cursor', retryable: false },
      { cause },
    );
  }
}
/** Extract the sole usable continuation field without trusting URL origin/path. */
export function continuation(
  next: string | null,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  if (next === null) return undefined;
  let cursor: string | null;
  try {
    cursor = new URL(next, API_BASE).searchParams.get('cursor');
  } catch (cause) {
    throw serviceUnavailable(
      'InterPro returned an invalid continuation URL.',
      { reason: 'upstream_shape_invalid', retryable: false },
      { cause },
    );
  }
  if (!cursor?.trim() || seen.has(cursor))
    throw serviceUnavailable('InterPro returned a missing or repeated continuation cursor.', {
      reason: 'upstream_shape_invalid',
      retryable: false,
    });
  return cursor;
}
