/**
 * @fileoverview Shared byte budget for one tool result's domain output, and whole-item fitting.
 * @module services/interpro/budget
 */

/** Most UTF-8 bytes one result's domain output may occupy when serialized as compact JSON. */
export const RESPONSE_BYTE_BUDGET = 100_000;

/** UTF-8 bytes of a value serialized as compact JSON, the form both result surfaces carry. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The largest count from 1 to `max` whose `build(count)` fits {@link RESPONSE_BYTE_BUDGET},
 * found by binary search on the assumption that the built size grows with the count. Returns 1
 * when even one item overflows, so a continuation always advances, and 0 when none remain.
 */
export function largestFittingCount(max: number, build: (count: number) => unknown): number {
  if (max <= 0) return 0;
  let fits = 1;
  let overflows = max + 1;
  while (overflows - fits > 1) {
    const middle = Math.floor((fits + overflows) / 2);
    if (jsonByteLength(build(middle)) <= RESPONSE_BYTE_BUDGET) fits = middle;
    else overflows = middle;
  }
  return fits;
}

/** The budget as it reads in notices. */
export const BUDGET_LABEL = `${RESPONSE_BYTE_BUDGET.toLocaleString('en-US')}-byte response budget`;

/**
 * Builds the largest whole-item output that fits the budget. `oversized` is set when even the
 * smallest non-empty output exceeds it, so the output carries one indivisible item alone.
 */
export function fitWithinBudget<T>(
  max: number,
  build: (count: number) => T,
): { count: number; output: T; oversized: boolean } {
  const count = largestFittingCount(max, build);
  const output = build(count);
  return { count, output, oversized: count > 0 && jsonByteLength(output) > RESPONSE_BYTE_BUDGET };
}
