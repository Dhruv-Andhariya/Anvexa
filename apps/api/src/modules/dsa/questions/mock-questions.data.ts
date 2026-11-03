import type { DsaQuestion, TestCase } from './question.types';

/**
 * TEMPORARY dataset. Replace by binding an HR-backed QuestionRepository (see docs/dsa-integration-notes.md).
 *
 * stdin format used by the harnesses (no JSON parsing needed in any language):
 *   int array : one line "<length> <v1> <v2> ..." ("0" for an empty array)
 *   integer   : one line
 *   string    : one line holding the raw string (empty line for "")
 */

const arrLine = (a: number[]) => [a.length, ...a].join(' ');
const num = (n: number) => n.toFixed(5);

const tc = (id: string, display: string, stdin: string, expectedOutput: string, hidden: boolean): TestCase => ({
  id,
  display,
  stdin: `${stdin}\n`,
  expectedOutput,
  hidden,
});

// ---------- Two Sum ----------
const twoSumCase = (id: string, nums: number[], target: number, answer: [number, number], hidden: boolean) =>
  tc(id, `nums = [${nums.join(', ')}], target = ${target}`, `${arrLine(nums)}\n${target}`, `[${answer[0]},${answer[1]}]`, hidden);

// 10007 is prime and coprime with 7919, so this is a permutation of 1..N.
// Only N-1 and N sum to 2N-1, so the answer is unique.
const BIG_N = 10007;
const bigNums = Array.from({ length: BIG_N }, (_, i) => ((i * 7919) % BIG_N) + 1);
const bigAnswer = [bigNums.indexOf(BIG_N - 1), bigNums.indexOf(BIG_N)].sort((a, b) => a - b) as [number, number];

const twoSumTests: TestCase[] = [
  twoSumCase('ts-1', [2, 7, 11, 15], 9, [0, 1], false),
  twoSumCase('ts-2', [3, 2, 4], 6, [1, 2], false),
  twoSumCase('ts-h1', [3, 3], 6, [0, 1], true),
  twoSumCase('ts-h2', [-1, -2, -3, -4, -5], -8, [2, 4], true),
  twoSumCase('ts-h3', [0, 4, 3, 0], 0, [0, 3], true),
  twoSumCase('ts-h4', [1000000000, 1000000000, -5], 2000000000, [0, 1], true),
  twoSumCase('ts-h5', [5, 75, 25], 100, [1, 2], true),
  twoSumCase('ts-h6', bigNums, 2 * BIG_N - 1, bigAnswer, true),
];

// ---------- Longest Substring Without Repeating Characters ----------
const lsCase = (id: string, s: string, answer: number, hidden: boolean) =>
  tc(id, `s = "${s.length > 60 ? `${s.slice(0, 57)}...` : s}"`, s, String(answer), hidden);

const lsTests: TestCase[] = [
  lsCase('ls-1', 'abcabcbb', 3, false),
  lsCase('ls-2', 'bbbbb', 1, false),
  lsCase('ls-h1', 'pwwkew', 3, true),
  lsCase('ls-h2', '', 0, true),
  lsCase('ls-h3', ' ', 1, true),
  lsCase('ls-h4', 'dvdf', 3, true),
  lsCase('ls-h5', 'abba', 2, true),
  lsCase('ls-h6', 'tmmzuxt', 5, true),
  lsCase('ls-h7', 'abc abc', 4, true),
  lsCase('ls-h8', 'abcdefghijklmnopqrstuvwxyz'.repeat(1924).slice(0, 50000), 26, true),
];

// ---------- Median of Two Sorted Arrays ----------
const medCase = (id: string, a: number[], b: number[], answer: number, hidden: boolean) =>
  tc(id, `nums1 = [${a.join(', ')}], nums2 = [${b.join(', ')}]`, `${arrLine(a)}\n${arrLine(b)}`, num(answer), hidden);

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

const medianTests: TestCase[] = [
  medCase('md-1', [1, 3], [2], 2, false),
  medCase('md-2', [1, 2], [3, 4], 2.5, false),
  medCase('md-h1', [], [1], 1, true),
  medCase('md-h2', [0, 0], [0, 0], 0, true),
  medCase('md-h3', [2], [], 2, true),
  medCase('md-h4', [1, 3, 5, 7], [2, 4, 6, 8, 10], 5, true),
  medCase('md-h5', [-5, -3, -1], [-2], -2.5, true),
  medCase('md-h6', [1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 5.5, true),
  // (a + b) / 2 overflows a 32-bit int
  medCase('md-h7', [2147483647], [2147483647], 2147483647, true),
  medCase('md-h8', range(0, 1000), range(1000, 2000), 999.5, true),
];

/** The problem bank (full questions, hidden tests included). Also the demo set. contracts' DSA_BANK lists the same ids. */
export const MOCK_QUESTIONS: DsaQuestion[] = [
  {
    id: 'dsa-001',
    title: 'Two Sum',
    difficulty: 'Easy',
    marks: 10,
    description:
      'Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target.\n\nYou may assume that each input has exactly one solution, and you may not use the same element twice. Return the two indices in ascending order.',
    inputFormat: 'nums: an array of integers. target: an integer.',
    outputFormat: 'An array of two indices [i, j] with i < j such that nums[i] + nums[j] == target.',
    constraints: [
      '2 <= nums.length <= 10^4',
      '-10^9 <= nums[i] <= 10^9',
      '-2 * 10^9 <= target <= 2 * 10^9',
      'Exactly one valid answer exists.',
    ],
    samples: [
      {
        input: 'nums = [2, 7, 11, 15], target = 9',
        output: '[0,1]',
        explanation: 'nums[0] + nums[1] = 2 + 7 = 9, so the answer is [0, 1].',
      },
    ],
    starterCode: {
      python:
        'def two_sum(nums, target):\n    # Return the two indices as a list, e.g. [0, 1]\n    pass\n',
      java:
        'class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        // Return the two indices, e.g. new int[]{0, 1}\n        return new int[]{};\n    }\n}\n',
      cpp:
        'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        // Return the two indices, e.g. {0, 1}\n        return {};\n    }\n};\n',
    },
    harness: 'two-sum',
    comparator: 'exact',
    testCases: twoSumTests,
  },
  {
    id: 'dsa-002',
    title: 'Longest Substring Without Repeating Characters',
    difficulty: 'Medium',
    marks: 20,
    description:
      'Given a string s, find the length of the longest substring that contains no repeating characters.',
    inputFormat: 's: a string.',
    outputFormat: 'An integer, the length of the longest substring without repeating characters.',
    constraints: [
      '0 <= s.length <= 5 * 10^4',
      's consists of English letters, digits, symbols and spaces.',
    ],
    samples: [
      {
        input: 's = "abcabcbb"',
        output: '3',
        explanation: 'The answer is "abc", with a length of 3.',
      },
    ],
    starterCode: {
      python: 'def length_of_longest_substring(s):\n    # Return the length as an int\n    pass\n',
      java:
        'class Solution {\n    public int lengthOfLongestSubstring(String s) {\n        // Return the length\n        return 0;\n    }\n}\n',
      cpp:
        'class Solution {\npublic:\n    int lengthOfLongestSubstring(string s) {\n        // Return the length\n        return 0;\n    }\n};\n',
    },
    harness: 'longest-substring',
    comparator: 'exact',
    testCases: lsTests,
  },
  {
    id: 'dsa-003',
    title: 'Median of Two Sorted Arrays',
    difficulty: 'Hard',
    marks: 30,
    description:
      'Given two sorted arrays nums1 and nums2 of sizes m and n, return the median of the two sorted arrays.\n\nThe overall run time complexity should be O(log(m + n)).',
    inputFormat: 'nums1, nums2: two integer arrays, each sorted in non-decreasing order.',
    outputFormat: 'A floating point number, the median of the merged arrays.',
    constraints: [
      '0 <= m <= 1000',
      '0 <= n <= 1000',
      '1 <= m + n <= 2000',
      '-2^31 <= nums1[i], nums2[i] <= 2^31 - 1',
    ],
    samples: [
      {
        input: 'nums1 = [1, 3], nums2 = [2]',
        output: '2.00000',
        explanation: 'The merged array is [1, 2, 3] and the median is 2.',
      },
    ],
    starterCode: {
      python: 'def find_median_sorted_arrays(nums1, nums2):\n    # Return the median as a float\n    pass\n',
      java:
        'class Solution {\n    public double findMedianSortedArrays(int[] nums1, int[] nums2) {\n        // Return the median\n        return 0.0;\n    }\n}\n',
      cpp:
        'class Solution {\npublic:\n    double findMedianSortedArrays(vector<int>& nums1, vector<int>& nums2) {\n        // Return the median\n        return 0.0;\n    }\n};\n',
    },
    harness: 'median-sorted-arrays',
    comparator: 'float',
    testCases: medianTests,
  },
];
