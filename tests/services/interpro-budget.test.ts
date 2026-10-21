/**
 * @fileoverview Shared response byte budget and whole-item fitting.
 * @module tests/services/interpro-budget
 */
import { describe, expect, it } from 'vitest';
import {
  BUDGET_LABEL,
  fitWithinBudget,
  jsonByteLength,
  largestFittingCount,
  RESPONSE_BYTE_BUDGET,
} from '@/services/interpro/budget.js';

/** A JSON array of `count` items, each serializing to `itemBytes` bytes plus its separator. */
const items = (count: number, itemBytes: number) =>
  Array.from({ length: count }, () => 'x'.repeat(itemBytes - 2));

describe('response byte budget', () => {
  it('is 100,000 UTF-8 bytes of compact JSON', () => {
    expect(RESPONSE_BYTE_BUDGET).toBe(100_000);
    expect(jsonByteLength({ a: [1, 2] })).toBe('{"a":[1,2]}'.length);
    expect(jsonByteLength('é')).toBe(4);
    expect(jsonByteLength('α😀')).toBe(8);
  });

  it('returns the largest count that fits, including an exact fit', () => {
    // `[` + n items of 1,000 bytes + (n - 1) commas + `]` = 1,001n + 1 bytes.
    const build = (count: number) => items(count, 1000);
    expect(jsonByteLength(build(99))).toBe(99_100);
    expect(largestFittingCount(500, build)).toBe(99);
    // `[` + a 59,998-byte string + n × (`,` + 999-byte item) + `]` = 60,000 + 1,000n bytes.
    const exact = (count: number) => ['x'.repeat(59_996), ...items(count, 999)];
    expect(jsonByteLength(exact(40))).toBe(100_000);
    expect(largestFittingCount(80, exact)).toBe(40);
    expect(jsonByteLength(exact(41))).toBeGreaterThan(100_000);
  });

  it('returns every remaining item when they all fit, and zero when none remain', () => {
    expect(largestFittingCount(7, (count) => items(count, 100))).toBe(7);
    expect(largestFittingCount(1, (count) => items(count, 100))).toBe(1);
    expect(largestFittingCount(0, () => 'x'.repeat(200_000))).toBe(0);
  });

  it('still advances by one item when the first item alone overflows', () => {
    expect(largestFittingCount(5, (count) => items(count, 150_000))).toBe(1);
  });

  it('flags a fitted output as oversized only when its single item exceeds the budget', () => {
    const fits = fitWithinBudget(500, (count) => items(count, 1_000));
    expect(fits).toMatchObject({ count: 99, oversized: false });
    expect(fits.output).toHaveLength(99);
    expect(fitWithinBudget(3, (count) => items(count, 150_000))).toMatchObject({
      count: 1,
      oversized: true,
    });
    expect(fitWithinBudget(0, () => 'x'.repeat(200_000))).toMatchObject({
      count: 0,
      oversized: false,
    });
    expect(BUDGET_LABEL).toBe('100,000-byte response budget');
  });
});
