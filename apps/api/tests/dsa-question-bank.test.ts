import { describe, expect, it } from 'vitest';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';

/**
 * Every bank test case must respect the problem's own stated constraints (a test beyond them could fail a solution
 * written exactly to the statement, e.g. a fixed-size array). The stdin formats are the harness ones
 * (mock-questions.data.ts): an int array is "<length> v1 .. vn", a string is one raw line.
 */
const q = (id: string) => MOCK_QUESTIONS.find((x) => x.id === id)!;
const lines = (stdin: string) => stdin.replace(/\n$/, '').split('\n');
const intArray = (line: string) => {
  const [n, ...vals] = line.trim().split(/\s+/).map(Number);
  expect(vals.length).toBe(n); // the declared length matches the values given
  return vals;
};

describe('question bank: test inputs respect the stated constraints', () => {
  it('Two Sum: 2 <= nums.length <= 10^4, |nums[i]| <= 10^9, |target| <= 2*10^9, exactly one answer', () => {
    const two = q('dsa-001');
    expect(two.constraints).toContain('2 <= nums.length <= 10^4');
    for (const t of two.testCases) {
      const [arr, target] = lines(t.stdin);
      const nums = intArray(arr);
      const tgt = Number(target);
      expect(nums.length).toBeGreaterThanOrEqual(2);
      expect(nums.length).toBeLessThanOrEqual(10_000);
      expect(nums.every((v) => Number.isInteger(v) && Math.abs(v) <= 1e9)).toBe(true);
      expect(Math.abs(tgt)).toBeLessThanOrEqual(2e9);
      // exactly one valid pair, and it is the expected output (indices ascending)
      const pairs: [number, number][] = [];
      const seen = new Map<number, number[]>();
      nums.forEach((v, i) => {
        for (const j of seen.get(tgt - v) ?? []) pairs.push([j, i]);
        seen.set(v, [...(seen.get(v) ?? []), i]);
      });
      expect(pairs.length).toBe(1);
      expect(t.expectedOutput).toBe(`[${pairs[0][0]},${pairs[0][1]}]`);
    }
  });

  it('Two Sum: the largest hidden test is exactly the 10^4 maximum, a permutation of 1..N, answer = values N-1 and N', () => {
    const big = q('dsa-001').testCases.find((t) => t.id === 'ts-h6')!;
    expect(big.hidden).toBe(true);
    const [arr, target] = lines(big.stdin);
    const nums = intArray(arr);
    const N = 10_000;
    expect(nums.length).toBe(N);
    expect([...nums].sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // permutation of 1..N
    expect(Number(target)).toBe(2 * N - 1);
    const answer = [nums.indexOf(N - 1), nums.indexOf(N)].sort((a, b) => a - b);
    expect(big.expectedOutput).toBe(`[${answer[0]},${answer[1]}]`);
    expect(Math.max(...q('dsa-001').testCases.map((t) => intArray(lines(t.stdin)[0]).length))).toBe(N);
  });

  it('Longest Substring: 0 <= s.length <= 5 * 10^4', () => {
    const ls = q('dsa-002');
    expect(ls.constraints).toContain('0 <= s.length <= 5 * 10^4');
    const lengths = ls.testCases.map((t) => lines(t.stdin)[0]?.length ?? 0);
    for (const n of lengths) expect(n).toBeLessThanOrEqual(50_000);
    expect(Math.max(...lengths)).toBe(50_000); // the maximum is exercised, not exceeded
  });

  it('Median of Two Sorted Arrays: m, n <= 1000, 1 <= m + n <= 2000, sorted, 32-bit values', () => {
    const md = q('dsa-003');
    for (const t of md.testCases) {
      const [a, b] = lines(t.stdin).map(intArray);
      expect(a.length).toBeLessThanOrEqual(1000);
      expect(b.length).toBeLessThanOrEqual(1000);
      expect(a.length + b.length).toBeGreaterThanOrEqual(1);
      expect(a.length + b.length).toBeLessThanOrEqual(2000);
      for (const xs of [a, b]) {
        expect(xs.every((v, i) => i === 0 || xs[i - 1] <= v)).toBe(true);
        expect(xs.every((v) => v >= -(2 ** 31) && v <= 2 ** 31 - 1)).toBe(true);
      }
    }
  });
});
