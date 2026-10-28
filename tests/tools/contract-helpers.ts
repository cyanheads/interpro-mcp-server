/**
 * @fileoverview Shared assertions for tool contract tests run against an injected HTTP boundary.
 * @module tests/tools/contract-helpers
 */
import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, vi } from 'vitest';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Resolve a promise whose retries wait on fake timers. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

/** The text blocks of a result, joined. */
export function text(result: ToolResult): string {
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Every line the server writes after the JSON fence: the link and image index, each line one
 * angle-bracket destination, then the enrichment trailer's total, query echo (a code span),
 * truncation fields, and notice quote.
 */
const SERVER_LINE =
  /^(?:Sources and links:|Images:|\[Link \d+\]\(<[^<>]*>\)|!\[Image \d+\]\(<[^<>]*>\)|\*\*\d+ total\*\*|\*\*\w+:\*\* \S+|Query: `\{.*\}`|> \S.*)$/;

/**
 * The non-blank Markdown lines after a result's JSON fence. Asserts that the fence holds one JSON
 * line and that every later line is one the server writes, so upstream text that broke out of a
 * destination or a notice surfaces as a line of its own and fails here.
 */
export function serverLines(markdown: string): string[] {
  const fence = /^(`{3,})json\n[^\n\r]*\n\1(?:\n|$)/.exec(markdown);
  expect(fence, 'content opens with a one-line JSON fence').not.toBeNull();
  const lines = markdown
    .slice(fence?.[0].length)
    .split(/\r\n|\r|\n/)
    .filter(Boolean);
  for (const line of lines) expect(line).toMatch(SERVER_LINE);
  return lines;
}

/** Assert both surfaces carry the same domain output, and return it. */
export function twin(result: ToolResult) {
  expect(result.isError, text(result)).not.toBe(true);
  const output = JSON.parse(text(result).match(/`+json\n([\s\S]*?)\n`+/)?.[1] ?? '');
  expect(
    Object.fromEntries(
      Object.entries(result.structuredContent ?? {}).filter(
        ([key]) =>
          !['notice', 'totalCount', 'truncated', 'shown', 'cap', 'effectiveQuery', 'echo'].includes(
            key,
          ),
      ),
    ),
  ).toEqual(output);
  return output;
}

/** Assert a failed result carries the definition's declared code and recovery for `reason`. */
export function failure(
  result: ToolResult,
  reason: string,
  definition: { errors?: readonly { reason: string; code: number; recovery: string }[] },
) {
  expect(result.isError).toBe(true);
  const contract = definition.errors?.find((entry) => entry.reason === reason);
  expect(contract).toBeDefined();
  expect(result.structuredContent).toMatchObject({
    error: { code: contract?.code, data: { reason, recovery: { hint: contract?.recovery } } },
  });
  expect(text(result)).toContain(contract?.recovery);
}
