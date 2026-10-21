/**
 * @fileoverview Query-bound, versioned pagination tokens.
 * @module services/interpro/cursors
 */
import { z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { API_BASE } from './routing.js';

/**
 * Every token carries exactly one continuation: the upstream cursor of the next page, or a
 * tool-defined position for a walk that resumes inside a page.
 */
const CursorSchema = z
  .object({
    v: z.literal(1),
    operation: z.string().min(1),
    scope: z.string(),
    upstreamCursor: z.string().min(1).optional(),
    position: z.json().optional(),
  })
  .strict()
  .refine(
    (cursor) => (cursor.upstreamCursor === undefined) !== (cursor.position === undefined),
    'A cursor carries exactly one continuation.',
  );
type Resumption = { upstreamCursor: string } | { position: unknown };
/** Deterministic canonical scope, independent of object key insertion order. */
export function cursorScope(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
/** Code-unit string order, the tiebreak used wherever a page boundary must be deterministic. */
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function seal(operation: string, scope: unknown, resumption: Resumption): string {
  const token = Buffer.from(
    JSON.stringify({ v: 1, operation, scope: cursorScope(scope), ...resumption }),
  ).toString('base64url');
  if (token.length > 4096)
    throw serviceUnavailable('InterPro continuation exceeds the supported token size.', {
      reason: 'upstream_shape_invalid',
      retryable: false,
    });
  return token;
}
function open<T>(
  token: string | undefined,
  operation: string,
  scope: unknown,
  read: (cursor: z.infer<typeof CursorSchema>) => T,
): T | undefined {
  if (token === undefined) return undefined;
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error('Invalid cursor encoding.');
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    if (parsed.operation !== operation || parsed.scope !== cursorScope(scope))
      throw new Error('Cursor scope differs.');
    return read(parsed);
  } catch (cause) {
    throw validationError(
      'Cursor is invalid or belongs to a different query.',
      { reason: 'invalid_cursor', retryable: false },
      { cause },
    );
  }
}
/** Encode only the continuation value, never an upstream request URL. */
export function encodeCursor(operation: string, scope: unknown, upstreamCursor: string): string {
  return seal(operation, scope, { upstreamCursor });
}
/** Reject malformed tokens and tokens reused with a changed target or filter. */
export function decodeCursor(
  token: string | undefined,
  operation: string,
  scope: unknown,
): string | undefined {
  return open(token, operation, scope, ({ upstreamCursor }) => {
    if (upstreamCursor === undefined) throw new Error('Cursor carries no upstream continuation.');
    return upstreamCursor;
  });
}
/** Encode a tool-defined resumption point, for walks that can stop inside an upstream page. */
export function encodePositionCursor(operation: string, scope: unknown, position: unknown): string {
  return seal(operation, scope, { position });
}
/** Decode a resumption point and validate it against the tool's own position schema. */
export function decodePositionCursor<T extends z.ZodType>(
  token: string | undefined,
  operation: string,
  scope: unknown,
  schema: T,
): z.output<T> | undefined {
  return open(token, operation, scope, ({ position }) => schema.parse(position));
}
/**
 * Truncation guidance for a capped cursor page: the call that continues it, plus a larger
 * `limit` only while the current one is below the tool's maximum.
 */
export function pageGuidance(
  toolName: string,
  noun: string,
  limit: number,
  maxLimit: number,
): string {
  return `More ${noun} remain: repeat ${toolName} with the same arguments and cursor set to page.nextCursor${limit < maxLimit ? `; limit may rise to ${maxLimit} for larger pages` : ''}.`;
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
