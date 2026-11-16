# DSA fairness benchmark

```json
{
  "createdAt": "2026-11-13T13:17:24.355Z",
  "pistonUrl": "http://127.0.0.1:2000",
  "runtimes": {
    "c++": "10.2.0",
    "java": "15.0.2",
    "python": "3.12.0"
  },
  "profile": "smoke",
  "mode": "isolated",
  "workers": 1,
  "limits": "ceiling",
  "requestLimits": {
    "python": {
      "run_timeout": 8000,
      "run_cpu_time": 8000,
      "run_memory_limit": 268435456,
      "compile_timeout": 15000,
      "compile_cpu_time": 15000,
      "compile_memory_limit": 536870912
    },
    "cpp": {
      "run_timeout": 8000,
      "run_cpu_time": 8000,
      "run_memory_limit": 268435456,
      "compile_timeout": 15000,
      "compile_cpu_time": 15000,
      "compile_memory_limit": 536870912
    },
    "java": {
      "run_timeout": 8000,
      "run_cpu_time": 8000,
      "run_memory_limit": 536870912,
      "compile_timeout": 15000,
      "compile_cpu_time": 15000,
      "compile_memory_limit": 536870912
    }
  },
  "warmup": 1,
  "reps": 3,
  "seed": 42,
  "points": 48,
  "executions": 174,
  "censoredPoints": [
    "python|ls-quadratic|ls-distinct94-n50000",
    "python|ls-quadratic|ls-alpha26-n50000",
    "java|ls-quadratic|ls-distinct94-n50000",
    "java|ls-quadratic|ls-alpha26-n50000",
    "cpp|ls-quadratic|ls-distinct94-n50000",
    "cpp|ls-quadratic|ls-alpha26-n50000"
  ],
  "durationSec": 204,
  "notes": [
    "C++ is compiled by Piston as `g++ -std=c++17` (no -O2); Java runs the single-file launcher (javac inside the run stage).",
    "Times are Piston-reported per stage; clientMs is the HTTP round trip seen by this script (includes queueing)."
  ]
}
```

Columns: median / p95 / p99 / min-max / CV (coefficient of variation). Times in ms (Piston-reported). With 30
samples p99 is effectively the maximum. "censored": every warm-up hit the limit, so no measured runs were made.

| lang | algorithm | dataset | n | role | statuses | correct | run CPU ms | run wall ms | compile wall ms (C++) | memory MB |
|---|---|---|---|---|---|---|---|---|---|---|
| python | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 30 / 32 / 32 / 29-32 / 0.05 | 42 / 50 / 50 / 41-50 / 0.111 | - | 5.1 |
| python | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 32 / 46 / 46 / 26-46 / 0.296 | 48 / 69 / 69 / 44-69 / 0.25 | - | 5.1 |
| python | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 34 / 39 / 39 / 25-39 / 0.217 | 55 / 60 / 60 / 41-60 / 0.189 | - | 6.4 |
| python | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 37 / 58 / 58 / 27-58 / 0.389 | 62 / 70 / 70 / 42-70 / 0.249 | - | 5.2 |
| python | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 47 / 54 / 54 / 41-54 / 0.137 | 63 / 77 / 77 / 55-77 / 0.171 | - | 5.2 |
| python | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 1928 / 2688 / 2688 / 1836-2688 / 0.217 | 1984 / 2709 / 2709 / 1860-2709 / 0.21 | - | 6.1 |
| python | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 32 / 39 / 39 / 30-39 / 0.14 | 59 / 61 / 61 / 32-61 / 0.32 | - | 5 |
| python | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 29 / 33 / 33 / 26-33 / 0.12 | 47 / 51 / 51 / 26-51 / 0.325 | - | 4.9 |
| python | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 28 / 30 / 30 / 28-30 / 0.04 | 51 / 56 / 56 / 43-56 / 0.131 | - | 5.2 |
| python | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 47 / 60 / 60 / 47-60 / 0.146 | 77 / 86 / 86 / 56-86 / 0.211 | - | 5.3 |
| python | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 45 / 48 / 48 / 44-48 / 0.046 | 58 / 63 / 63 / 55-63 / 0.069 | - | 5.1 |
| python | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 33 / 34 / 34 / 28-34 / 0.102 | 58 / 59 / 59 / 53-59 / 0.057 | - | 4.9 |
| python | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 85 / 100 / 100 / 63-100 / 0.225 | 100 / 120 / 120 / 74-120 / 0.235 | - | 5 |
| python | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 84 / 106 / 106 / 83-106 / 0.143 | 97 / 143 / 143 / 85-143 / 0.283 | - | 4.9 |
| python | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 1862 / 2003 / 2003 / 1497-2003 / 0.146 | 752 / 837 / 837 / 577-837 / 0.184 | - | 71.3 |
| java | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 2043.0000000000002 / 2116 / 2116 / 1497-2116 / 0.179 | 803 / 853 / 853 / 577-853 / 0.198 | - | 68.7 |
| java | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 2111 / 2790 / 2790 / 2013.9999999999998-2790 / 0.183 | 850 / 1027 / 1027 / 803-1027 / 0.132 | - | 71.3 |
| java | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 1894 / 1969 / 1969 / 1679-1969 / 0.081 | 792 / 816 / 816 / 641-816 / 0.127 | - | 71.6 |
| java | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 2133 / 2146 / 2146 / 1467-2146 / 0.203 | 854 / 858 / 858 / 547-858 / 0.237 | - | 71.7 |
| java | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 2140 / 2395 / 2395 / 1789-2395 / 0.144 | 860 / 893 / 893 / 680-893 / 0.141 | - | 72.2 |
| java | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 1783 / 1983 / 1983 / 1426-1983 / 0.163 | 720 / 875 / 875 / 571-875 / 0.211 | - | 65.2 |
| java | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 1821 / 2235 / 2235 / 1309-2235 / 0.259 | 770 / 884 / 884 / 533-884 / 0.246 | - | 64.8 |
| java | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 2023.0000000000002 / 2097 / 2097 / 1941-2097 / 0.039 | 851 / 868 / 868 / 833-868 / 0.021 | - | 65.7 |
| java | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 1865 / 1928 / 1928 / 1355-1928 / 0.183 | 806 / 834 / 834 / 547-834 / 0.217 | - | 66 |
| java | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 1758 / 1803 / 1803 / 1642-1803 / 0.048 | 763 / 772 / 772 / 748-772 / 0.016 | - | 65.2 |
| java | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 1694 / 1789 / 1789 / 1219-1789 / 0.195 | 697 / 774 / 774 / 506-774 / 0.209 | - | 61.9 |
| java | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 1318 / 1794 / 1794 / 1272-1794 / 0.198 | 555 / 817 / 817 / 524-817 / 0.255 | - | 62.6 |
| java | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 1921 / 1962 / 1962 / 1846-1962 / 0.031 | 845 / 896 / 896 / 814-896 / 0.049 | - | 61.9 |
| java | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 5 / 6 / 6 / 4-6 / 0.2 | 19 / 35 / 35 / 14-35 / 0.484 | 1507 / 1685 / 1685 / 1284-1685 / 0.135 | 1.2 |
| cpp | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 5 / 6 / 6 / 3-6 / 0.327 | 19 / 20 / 20 / 15-20 / 0.147 | 1565 / 1759 / 1759 / 1320-1759 / 0.142 | 1.2 |
| cpp | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 9 / 9 / 9 / 8-9 / 0.067 | 34 / 38 / 38 / 29-38 / 0.134 | 1402 / 1503 / 1503 / 1385-1503 / 0.045 | 1.4 |
| cpp | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":3} | 3/3 | 5 / 5 / 5 / 4-5 / 0.124 | 18 / 24 / 24 / 16-24 / 0.215 | 1653 / 1848 / 1848 / 1433-1848 / 0.126 | 1.2 |
| cpp | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 8 / 8 / 8 / 6-8 / 0.157 | 28 / 35 / 35 / 18-35 / 0.316 | 1622 / 1803 / 1803 / 1547-1803 / 0.079 | 0.9 |
| cpp | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":3} | 3/3 | 186 / 239 / 239 / 151-239 / 0.231 | 213 / 252 / 252 / 162-252 / 0.216 | 1585 / 1849 / 1849 / 1134-1849 / 0.237 | 1.1 |
| cpp | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 6 / 6 / 6 / 4-6 / 0.217 | 29 / 39 / 39 / 17-39 / 0.389 | 1445 / 1954 / 1954 / 1318-1954 / 0.214 | 0.9 |
| cpp | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 5 / 6 / 6 / 4-6 / 0.2 | 34 / 42 / 42 / 15-42 / 0.457 | 1756 / 1844 / 1844 / 1706-1844 / 0.04 | 1.1 |
| cpp | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 5 / 6 / 6 / 5-6 / 0.108 | 21 / 21 / 21 / 14-21 / 0.217 | 1763 / 1801 / 1801 / 1642-1801 / 0.048 | 0.9 |
| cpp | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 12 / 13 / 13 / 11-13 / 0.083 | 25 / 26 / 26 / 24-26 / 0.04 | 1503 / 1709 / 1709 / 1247-1709 / 0.156 | 1.1 |
| cpp | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":3} | 3/3 | 11 / 21 / 21 / 9-21 / 0.47 | 26 / 39 / 39 / 23-39 / 0.29 | 1339 / 1567 / 1567 / 1319-1567 / 0.098 | 0.9 |
| cpp | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":3} | 3/3 | 5 / 6 / 6 / 5-6 / 0.108 | 19 / 28 / 28 / 14-28 / 0.349 | 1834 / 1835 / 1835 / 1813-1835 / 0.007 | 1.1 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 74 / 76 / 76 / 64-76 / 0.09 | 83 / 93 / 93 / 73-93 / 0.12 | 1703 / 1769 / 1769 / 1371-1769 / 0.132 | 1.2 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":3} | 3/3 | 69 / 73 / 73 / 64-73 / 0.066 | 94 / 106 / 106 / 85-106 / 0.111 | 1249 / 1715 / 1715 / 1204-1715 / 0.204 | 1.1 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
