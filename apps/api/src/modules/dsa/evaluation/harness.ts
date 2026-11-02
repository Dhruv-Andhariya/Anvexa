import type { HarnessKind, Language } from '../questions/question.types';

/** Marks the line carrying the function's return value so candidate debug prints cannot corrupt it. */
export const RESULT_MARKER = '__HF_RESULT__:';

export interface BuiltProgram {
  source: string;
  /** Lines the backend prepended before the candidate's code; used to fix up compiler line numbers. */
  lineOffset: number;
}

const PRELUDE: Record<Language, string> = {
  python: 'from typing import *\n',
  java: '',
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n',
};

// ----------------------------- Python -----------------------------
const PY_COMMON = `
import sys as _hf_sys

def _hf_lines():
    return _hf_sys.stdin.read().split("\\n")

def _hf_arr(line):
    parts = line.split()
    n = int(parts[0])
    return [int(x) for x in parts[1:1 + n]]

def _hf_emit(value):
    _hf_sys.stdout.write("\\n${RESULT_MARKER}" + value + "\\n")
    _hf_sys.stdout.flush()
`;

const PYTHON: Record<HarnessKind, string> = {
  'two-sum': `${PY_COMMON}
def _hf_main():
    lines = _hf_lines()
    result = two_sum(_hf_arr(lines[0]), int(lines[1].strip()))
    _hf_emit("[" + ",".join(str(int(x)) for x in sorted(result)) + "]")

_hf_main()
`,
  'longest-substring': `${PY_COMMON}
def _hf_main():
    lines = _hf_lines()
    s = lines[0].rstrip("\\r") if lines else ""
    _hf_emit(str(int(length_of_longest_substring(s))))

_hf_main()
`,
  'median-sorted-arrays': `${PY_COMMON}
def _hf_main():
    lines = _hf_lines()
    result = find_median_sorted_arrays(_hf_arr(lines[0]), _hf_arr(lines[1]))
    _hf_emit("%.5f" % float(result))

_hf_main()
`,
};

// ----------------------------- Java -----------------------------
const JAVA_HEAD = `
public class Main {
    static int[] hfArr(String line) {
        java.util.StringTokenizer st = new java.util.StringTokenizer(line);
        int n = Integer.parseInt(st.nextToken());
        int[] a = new int[n];
        for (int i = 0; i < n; i++) a[i] = Integer.parseInt(st.nextToken());
        return a;
    }
    static String hfLine(java.io.BufferedReader br) throws java.io.IOException {
        String l = br.readLine();
        return l == null ? "" : l;
    }
    static void hfEmit(String v) {
        System.out.print("\\n${RESULT_MARKER}" + v + "\\n");
        System.out.flush();
    }
    public static void main(String[] args) throws Exception {
        java.io.BufferedReader br = new java.io.BufferedReader(new java.io.InputStreamReader(System.in));
`;

const JAVA: Record<HarnessKind, string> = {
  'two-sum': `${JAVA_HEAD}        int[] nums = hfArr(hfLine(br));
        int target = Integer.parseInt(hfLine(br).trim());
        int[] r = new Solution().twoSum(nums, target);
        int[] s = r.clone();
        java.util.Arrays.sort(s);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < s.length; i++) { if (i > 0) sb.append(','); sb.append(s[i]); }
        hfEmit(sb.append(']').toString());
    }
}
`,
  'longest-substring': `${JAVA_HEAD}        String s = hfLine(br);
        hfEmit(String.valueOf(new Solution().lengthOfLongestSubstring(s)));
    }
}
`,
  'median-sorted-arrays': `${JAVA_HEAD}        int[] a = hfArr(hfLine(br));
        int[] b = hfArr(hfLine(br));
        double r = new Solution().findMedianSortedArrays(a, b);
        hfEmit(String.format(java.util.Locale.US, "%.5f", r));
    }
}
`,
};

// ----------------------------- C++ -----------------------------
const CPP_HEAD = `
static vector<int> hf_arr(const string& line) {
    istringstream in(line);
    int n = 0;
    in >> n;
    vector<int> a(n);
    for (int i = 0; i < n; i++) in >> a[i];
    return a;
}
static string hf_line() {
    string l;
    getline(cin, l);
    if (!l.empty() && l.back() == '\\r') l.pop_back();
    return l;
}
static void hf_emit(const string& v) {
    cout << "\\n${RESULT_MARKER}" << v << "\\n" << flush;
}
int main() {
`;

const CPP: Record<HarnessKind, string> = {
  'two-sum': `${CPP_HEAD}    vector<int> nums = hf_arr(hf_line());
    int target = stoi(hf_line());
    Solution sol;
    vector<int> r = sol.twoSum(nums, target);
    sort(r.begin(), r.end());
    string out = "[";
    for (size_t i = 0; i < r.size(); i++) { if (i) out += ","; out += to_string(r[i]); }
    hf_emit(out + "]");
    return 0;
}
`,
  'longest-substring': `${CPP_HEAD}    string s = hf_line();
    Solution sol;
    hf_emit(to_string(sol.lengthOfLongestSubstring(s)));
    return 0;
}
`,
  'median-sorted-arrays': `${CPP_HEAD}    vector<int> a = hf_arr(hf_line());
    vector<int> b = hf_arr(hf_line());
    Solution sol;
    double r = sol.findMedianSortedArrays(a, b);
    char buf[64];
    snprintf(buf, sizeof buf, "%.5f", r);
    hf_emit(buf);
    return 0;
}
`,
};

const HARNESSES: Record<Language, Record<HarnessKind, string>> = { python: PYTHON, java: JAVA, cpp: CPP };

export function buildProgram(language: Language, kind: HarnessKind, candidateCode: string): BuiltProgram {
  const prelude = PRELUDE[language];
  const body = candidateCode.endsWith('\n') ? candidateCode : `${candidateCode}\n`;
  return {
    source: `${prelude}${body}${HARNESSES[language][kind]}`,
    lineOffset: prelude === '' ? 0 : prelude.split('\n').length - 1,
  };
}

/** Pulls the returned value out of stdout; everything else is the candidate's own output. */
export function splitStdout(stdout: string): { result: string | null; userOutput: string } {
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  if (idx === -1) return { result: null, userOutput: stdout };
  const rest = stdout.slice(idx + RESULT_MARKER.length);
  const result = rest.split('\n')[0].replace(/\r$/, '');
  let before = stdout.slice(0, idx);
  if (before.endsWith('\n')) before = before.slice(0, -1); // the harness' leading "\n"
  return { result, userOutput: before };
}

/** Compiler / interpreter messages refer to the combined file; point them at the candidate's own lines. */
export function cleanDiagnostics(text: string, lineOffset: number): string {
  if (!text) return text;
  return text
    .replace(/(?:\/box\/)?(?:main\.cpp|Main\.java|script\.py)(:|", line )(\d+)/g, (_m, sep: string, line: string) => {
      const n = Math.max(1, Number(line) - lineOffset);
      return sep === ':' ? `solution:${n}` : `solution", line ${n}`;
    })
    .replace(/\/box\//g, '');
}
