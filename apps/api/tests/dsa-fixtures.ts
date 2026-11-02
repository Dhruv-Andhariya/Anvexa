import type { Language } from '../src/modules/dsa/questions/question.types';

/** Known-correct reference solutions, one per question and language. */
export const CORRECT: Record<string, Record<Language, string>> = {
  'dsa-001': {
    python: `def two_sum(nums, target):
    seen = {}
    for i, x in enumerate(nums):
        if target - x in seen:
            return [seen[target - x], i]
        seen[x] = i
    return []
`,
    java: `import java.util.*;
class Solution {
    public int[] twoSum(int[] nums, int target) {
        Map<Long, Integer> seen = new HashMap<>();
        for (int i = 0; i < nums.length; i++) {
            Integer j = seen.get((long) target - nums[i]);
            if (j != null) return new int[]{j, i};
            seen.put((long) nums[i], i);
        }
        return new int[]{};
    }
}
`,
    cpp: `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<long long, int> seen;
        for (int i = 0; i < (int)nums.size(); i++) {
            auto it = seen.find((long long)target - nums[i]);
            if (it != seen.end()) return {it->second, i};
            seen[nums[i]] = i;
        }
        return {};
    }
};
`,
  },
  'dsa-002': {
    python: `def length_of_longest_substring(s):
    last = {}
    start = best = 0
    for i, ch in enumerate(s):
        if ch in last and last[ch] >= start:
            start = last[ch] + 1
        last[ch] = i
        best = max(best, i - start + 1)
    return best
`,
    java: `import java.util.*;
class Solution {
    public int lengthOfLongestSubstring(String s) {
        Map<Character, Integer> last = new HashMap<>();
        int start = 0, best = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (last.containsKey(c) && last.get(c) >= start) start = last.get(c) + 1;
            last.put(c, i);
            best = Math.max(best, i - start + 1);
        }
        return best;
    }
}
`,
    cpp: `class Solution {
public:
    int lengthOfLongestSubstring(string s) {
        vector<int> last(256, -1);
        int start = 0, best = 0;
        for (int i = 0; i < (int)s.size(); i++) {
            unsigned char c = s[i];
            if (last[c] >= start) start = last[c] + 1;
            last[c] = i;
            best = max(best, i - start + 1);
        }
        return best;
    }
};
`,
  },
  'dsa-003': {
    python: `def find_median_sorted_arrays(nums1, nums2):
    a, b = nums1, nums2
    if len(a) > len(b):
        a, b = b, a
    m, n = len(a), len(b)
    lo, hi = 0, m
    half = (m + n + 1) // 2
    while lo <= hi:
        i = (lo + hi) // 2
        j = half - i
        a_left = a[i - 1] if i > 0 else float('-inf')
        a_right = a[i] if i < m else float('inf')
        b_left = b[j - 1] if j > 0 else float('-inf')
        b_right = b[j] if j < n else float('inf')
        if a_left <= b_right and b_left <= a_right:
            if (m + n) % 2:
                return float(max(a_left, b_left))
            return (max(a_left, b_left) + min(a_right, b_right)) / 2.0
        if a_left > b_right:
            hi = i - 1
        else:
            lo = i + 1
`,
    java: `class Solution {
    public double findMedianSortedArrays(int[] a, int[] b) {
        if (a.length > b.length) return findMedianSortedArrays(b, a);
        int m = a.length, n = b.length, lo = 0, hi = m, half = (m + n + 1) / 2;
        while (lo <= hi) {
            int i = (lo + hi) / 2, j = half - i;
            long aL = i > 0 ? a[i - 1] : Long.MIN_VALUE, aR = i < m ? a[i] : Long.MAX_VALUE;
            long bL = j > 0 ? b[j - 1] : Long.MIN_VALUE, bR = j < n ? b[j] : Long.MAX_VALUE;
            if (aL <= bR && bL <= aR) {
                if ((m + n) % 2 == 1) return (double) Math.max(aL, bL);
                return ((double) Math.max(aL, bL) + (double) Math.min(aR, bR)) / 2.0;
            }
            if (aL > bR) hi = i - 1; else lo = i + 1;
        }
        return 0.0;
    }
}
`,
    cpp: `class Solution {
public:
    double findMedianSortedArrays(vector<int>& a, vector<int>& b) {
        if (a.size() > b.size()) return findMedianSortedArrays(b, a);
        int m = a.size(), n = b.size(), lo = 0, hi = m, half = (m + n + 1) / 2;
        while (lo <= hi) {
            int i = (lo + hi) / 2, j = half - i;
            long long aL = i > 0 ? a[i - 1] : LLONG_MIN, aR = i < m ? a[i] : LLONG_MAX;
            long long bL = j > 0 ? b[j - 1] : LLONG_MIN, bR = j < n ? b[j] : LLONG_MAX;
            if (aL <= bR && bL <= aR) {
                if ((m + n) % 2 == 1) return (double)max(aL, bL);
                return ((double)max(aL, bL) + (double)min(aR, bR)) / 2.0;
            }
            if (aL > bR) hi = i - 1; else lo = i + 1;
        }
        return 0.0;
    }
};
`,
  },
};

/** Compiles / runs but returns a wrong answer on most inputs. */
export const WRONG: Record<string, Record<Language, string>> = {
  'dsa-001': {
    python: 'def two_sum(nums, target):\n    return [0, 1]\n',
    java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) { return {0, 1}; }\n};\n',
  },
  'dsa-002': {
    python: 'def length_of_longest_substring(s):\n    return len(s)\n',
    java: 'class Solution {\n    public int lengthOfLongestSubstring(String s) { return s.length(); }\n}\n',
    cpp: 'class Solution {\npublic:\n    int lengthOfLongestSubstring(string s) { return s.size(); }\n};\n',
  },
  'dsa-003': {
    python: 'def find_median_sorted_arrays(nums1, nums2):\n    return 0.0\n',
    java: 'class Solution {\n    public double findMedianSortedArrays(int[] a, int[] b) { return 0.0; }\n}\n',
    cpp: 'class Solution {\npublic:\n    double findMedianSortedArrays(vector<int>& a, vector<int>& b) { return 0.0; }\n};\n',
  },
};

/** Two Sum only: syntax / type errors, a crash, and a non-terminating loop. */
export const BROKEN: Record<'compile' | 'runtime' | 'infinite', Record<Language, string>> = {
  compile: {
    python: 'def two_sum(nums, target)\n    return [0, 1]\n',
    java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1} }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) { return {0, 1} }\n};\n',
  },
  runtime: {
    python: 'def two_sum(nums, target):\n    return [nums[10**6], 0]\n',
    java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) { return new int[]{nums[1000000], 0}; }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) { int* p = nullptr; return {*p, 0}; }\n};\n',
  },
  infinite: {
    python: 'def two_sum(nums, target):\n    while True:\n        pass\n',
    java: 'class Solution {\n    public int[] twoSum(int[] nums, int target) { while (true) {} }\n}\n',
    cpp: 'class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) { while (true) {} return {}; }\n};\n',
  },
};
