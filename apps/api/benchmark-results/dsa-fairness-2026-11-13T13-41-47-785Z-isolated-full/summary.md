# DSA fairness benchmark

```json
{
  "createdAt": "2026-11-15T19:28:56.192Z",
  "pistonUrl": "http://127.0.0.1:2000",
  "runtimes": {
    "c++": "10.2.0",
    "java": "15.0.2",
    "python": "3.12.0"
  },
  "profile": "full",
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
  "warmup": 3,
  "reps": 30,
  "seed": 42,
  "points": 120,
  "executions": 3690,
  "censoredPoints": [
    "python|ls-quadratic|ls-distinct94-n50000",
    "python|ls-quadratic|ls-alpha26-n50000",
    "python|ls-quadratic|ls-alpha26-n100000",
    "java|ls-quadratic|ls-distinct94-n50000",
    "java|ls-quadratic|ls-alpha26-n50000",
    "java|ls-quadratic|ls-alpha26-n100000",
    "cpp|ls-quadratic|ls-distinct94-n50000",
    "cpp|ls-quadratic|ls-alpha26-n50000",
    "cpp|ls-quadratic|ls-alpha26-n100000"
  ],
  "durationSec": 193628,
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
| python | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":30} | 30/30 | 33 / 84 / 150 / 23-150 / 0.608 | 49 / 109 / 169 / 33-169 / 0.462 | - | 5.1 |
| java | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":30} | 30/30 | 2018 / 3303 / 4147 / 1418-4147 / 0.295 | 855 / 1626 / 1851 / 567-1851 / 0.348 | - | 65.2 |
| java | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":30} | 30/30 | 1812 / 2661 / 4582 / 1379-4582 / 0.309 | 759 / 1223 / 2191 / 561-2191 / 0.374 | - | 65.1 |
| cpp | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 5 / 62 / 88 / 3-88 / 1.746 | 23 / 38 / 83 / 0-83 / 0.524 | 1548 / 4593 / 8223 / 1175-8223 / 0.674 | 1.1 |
| cpp | two-sum-hash O(n) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":30} | 30/30 | 47 / 99 / 103 / 33-103 / 0.334 | 68 / 113 / 143 / 33-143 / 0.307 | - | 5.2 |
| cpp | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 7 / 18 / 67 / 4-67 / 1.193 | 24 / 40 / 140 / 14-140 / 0.763 | 1718 / 9440 / 10060 / 1093-10060 / 0.889 | 1.1 |
| java | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 1710 / 2750 / 5481 / 1385-5481 / 0.399 | 710 / 1265 / 3226 / 581-3226 / 0.571 | - | 62.3 |
| java | ls-quadratic O(n^2) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 34 / 90 / 119 / 26-119 / 0.48 | 57 / 102 / 177 / 27-177 / 0.415 | - | 5.2 |
| python | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":30} | 30/30 | 34 / 46 / 177 / 24-177 / 0.694 | 52 / 81 / 186 / 28-186 / 0.481 | - | 5 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 7 / 15 / 213 / 4-213 / 2.631 | 25 / 39 / 1026 / 15-1026 / 3.063 | 1437 / 2933 / 3061 / 1156-3061 / 0.291 | 1.1 |
| python | ls-window O(n) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":30} | 30/30 | 65 / 107 / 111 / 45-111 / 0.22 | 82 / 124 / 153 / 61-153 / 0.216 | - | 5.4 |
| python | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":29,"INFRA_ERROR":1} | 29/30 | 6 / 18 / 40 / 3-40 / 1.002 | 25 / 63 / 84 / 12-84 / 0.484 | 1428 / 4439 / 10444 / 1204-10444 / 0.853 | 1.1 |
| java | ls-window O(n) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":29,"TO":1} | 29/30 | 5 / 637 / 14939 / 3-14939 / 5.192 | 27 / 889 / 15184 / 16-15184 / 4.927 | 1803 / 3460 / 15184 / 1126-15184 / 1.066 | 1.1 |
| cpp | ls-window O(n) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 41 / 73 / 73 / 26-73 / 0.294 | 61 / 112 / 117 / 31-117 / 0.298 | - | 6.6 |
| python | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 59 / 284 / 759 / 43-759 / 1.35 | 79 / 298 / 803 / 56-803 / 1.168 | - | 5.2 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 9 / 12 / 13 / 7-13 / 0.165 | 30 / 46 / 48 / 16-48 / 0.258 | 1457 / 2127 / 2275 / 1144-2275 / 0.204 | 1.4 |
| cpp | ls-window O(n) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 67 / 83 / 228 / 51-228 / 0.436 | 89 / 102 / 304 / 64-304 / 0.441 | 1437 / 2621 / 2842 / 1134-2842 / 0.267 | 1.1 |
| python | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":30} | 30/30 | 38 / 114 / 2302 / 23-2302 / 3.468 | 56 / 146 / 2351 / 29-2351 / 3.024 | - | 5.9 |
| java | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":30} | 30/30 | 1995 / 2880 / 5225 / 1641-5225 / 0.304 | 742 / 1141 / 2411 / 618-2411 / 0.387 | - | 71.2 |
| java | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 1750 / 2808 / 6268 / 1437-6268 / 0.435 | 731 / 1277 / 3501 / 572-3501 / 0.597 | - | 64.6 |
| java | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 1892 / 3612 / 3894 / 1491-3894 / 0.266 | 774 / 1661 / 1701 / 604-1701 / 0.304 | - | 64.8 |
| cpp | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":30} | 30/30 | 5 / 121 / 223 / 3-223 / 2.649 | 24 / 427 / 2135 / 8-2135 / 3.548 | 1461 / 5015 / 5992 / 1203-5992 / 0.59 | 1.1 |
| java | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 1927 / 2923 / 3365 / 1581-3365 / 0.191 | 748 / 1133 / 5384 / 601-5384 / 0.93 | - | 70.5 |
| cpp | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":29,"TO":1} | 29/30 | 4 / 46 / 15034 / 3-15034 / 5.408 | 24 / 106 / 15030 / 11-15030 / 5.208 | 1453 / 2846 / 15030 / 1168-15030 / 1.257 | 1.1 |
| python | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":28,"TO":2} | 28/30 | 3454 / 8058 / 8077 / 2997-8077 / 0.347 | 3471 / 8101 / 8103 / 3022-8103 / 0.346 | - | 5.2 |
| python | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 36 / 80 / 165 / 23-165 / 0.62 | 54 / 106 / 189 / 24-189 / 0.48 | - | 5.1 |
| python | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":30} | 30/30 | 33 / 103 / 232 / 20-232 / 0.884 | 53 / 117 / 242 / 26-242 / 0.628 | - | 5 |
| java | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 2161 / 2918 / 6208 / 1511-6208 / 0.363 | 860 / 1652 / 5966 / 584-5966 / 0.901 | - | 70.5 |
| cpp | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":30} | 30/30 | 7 / 12 / 18 / 5-18 / 0.375 | 26 / 44 / 45 / 13-45 / 0.284 | 1511 / 3741 / 6873 / 1215-6873 / 0.596 | 1.1 |
| java | ls-window O(n) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":29,"TO":1} | 29/30 | 163 / 756 / 15053 / 126-15053 / 3.84 | 184 / 796 / 15342 / 146-15342 / 3.744 | 1403 / 9359 / 15342 / 1141-15342 / 1.261 | 1.1 |
| python | ls-quadratic O(n^2) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-nested O(n^2) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| java | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":29,"TO":1} | 29/30 | 1846 / 6221 / 8109 / 1374-8109 / 0.606 | 698 / 3458 / 8101 / 523-8101 / 1.264 | - | 71.7 |
| cpp | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 5 / 7 / 7 / 3-7 / 0.252 | 23 / 40 / 41 / 13-41 / 0.299 | 1594 / 2384 / 3617 / 1205-3617 / 0.271 | 1.1 |
| java | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 1850 / 2361 / 4925 / 1590-4925 / 0.299 | 712 / 991 / 2452 / 594-2452 / 0.423 | - | 71.8 |
| python | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":30} | 30/30 | 554 / 906 / 1035 / 469-1035 / 0.234 | 570 / 926 / 1069 / 493-1069 / 0.231 | - | 5.6 |
| java | two-sum-hash O(n) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| java | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 1862 / 3744 / 4206 / 1550-4206 / 0.313 | 700 / 1567 / 1755 / 562-1755 / 0.359 | - | 71.7 |
| python | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 2045 / 6321 / 7808 / 1850-7808 / 0.504 | 2064 / 6351 / 7835 / 1882-7835 / 0.501 | - | 6.1 |
| java | two-sum-hash O(n) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| java | ls-quadratic O(n^2) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 34 / 48 / 54 / 21-54 / 0.227 | 53 / 80 / 86 / 23-86 / 0.285 | - | 5 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":25,"TO":5} | 25/30 | 5095 / 8065 / 8078 / 4465-8078 / 0.21 | 5131 / 8100 / 8223 / 4483-8223 / 0.213 | 1489 / 6967 / 14718 / 1077-14718 / 1.072 | 1.1 |
| cpp | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 5 / 7 / 153 / 3-153 / 2.866 | 22 / 39 / 281 / 11-281 / 1.55 | 1434 / 3210 / 9651 / 1183-9651 / 0.842 | 0.9 |
| cpp | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":30} | 30/30 | 5 / 8 / 51 / 3-51 / 1.331 | 28 / 51 / 90 / 14-90 / 0.491 | 1518 / 3691 / 8671 / 1142-8671 / 0.731 | 1.1 |
| python | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 33 / 84 / 102 / 24-102 / 0.433 | 52 / 104 / 155 / 26-155 / 0.429 | - | 5.1 |
| java | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":30} | 30/30 | 1865 / 4378 / 4992 / 1412-4992 / 0.426 | 739 / 2159 / 2855 / 601-2855 / 0.547 | - | 62.5 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | two-sum-nested O(n^2) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-hash O(n) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":30} | 30/30 | 50 / 107 / 115 / 34-115 / 0.349 | 66 / 121 / 133 / 43-133 / 0.264 | 1555 / 3493 / 7566 / 1113-7566 / 0.645 | 1.1 |
| python | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-window O(n) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 83 / 187 / 242 / 51-242 / 0.443 | 101 / 195 / 269 / 61-269 / 0.391 | - | 5.2 |
| java | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 2230 / 3767 / 5901 / 1663-5901 / 0.352 | 872 / 1623 / 2950 / 599-2950 / 0.468 | - | 72 |
| python | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":30} | 30/30 | 33 / 86 / 184 / 21-184 / 0.674 | 58 / 204 / 306 / 33-306 / 0.712 | - | 5.2 |
| python | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":30} | 30/30 | 38 / 90 / 216 / 22-216 / 0.772 | 57 / 106 / 229 / 22-229 / 0.549 | - | 5.2 |
| cpp | ls-window O(n) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 33 / 112 / 189 / 25-189 / 0.75 | 55 / 133 / 210 / 36-210 / 0.524 | - | 5.2 |
| java | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 1676 / 3741 / 7510 / 1337-7510 / 0.553 | 676 / 1839 / 4602 / 535-4602 / 0.799 | - | 64.8 |
| python | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 36 / 160 / 5968 / 26-5968 / 4.368 | 57 / 181 / 6111 / 30-6111 / 4.064 | - | 5.2 |
| java | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":30} | 30/30 | 1921 / 4550 / 5769 / 1487-5769 / 0.454 | 788 / 2227 / 3095 / 579-3095 / 0.575 | - | 65 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":28,"TO":2} | 28/30 | 5109 / 8025 / 8101 / 4748-8101 / 0.165 | 5126 / 8052 / 8158 / 4770-8158 / 0.164 | 1372 / 2389 / 2786 / 1106-2786 / 0.264 | 1.1 |
| java | ls-window O(n) | ls-distinct94-n100000 | 100000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":29,"TO":1} | 29/30 | 6 / 60 / 8830 / 3-8830 / 5.34 | 25 / 100 / 17538 / 14-17538 / 5.182 | 1566 / 8808 / 17538 / 1195-17538 / 1.279 | 1.1 |
| python | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 31 / 108 / 155 / 23-155 / 0.693 | 56 / 126 / 175 / 23-175 / 0.515 | - | 5 |
| java | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":30} | 30/30 | 1672 / 5537 / 6587 / 1480-6587 / 0.538 | 692 / 3071 / 4860 / 583-4860 / 0.866 | - | 64.2 |
| cpp | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 5 / 10 / 10 / 3-10 / 0.391 | 23 / 39 / 42 / 15-42 / 0.251 | 1590 / 3517 / 6379 / 1175-6379 / 0.531 | 1.1 |
| python | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 3523 / 5761 / 5761 / 2953-5761 / 0.212 | 3549 / 5775 / 5787 / 2954-5787 / 0.211 | - | 5.2 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":29,"TO":1} | 29/30 | 5 / 355 / 14990 / 3-14990 / 5.292 | 24 / 399 / 15148 / 13-15148 / 5.104 | 1574 / 4205 / 15148 / 1250-15148 / 1.127 | 1 |
| python | two-sum-nested O(n^2) | ts-n20000 | 20000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | two-sum-hash O(n) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| java | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 1840 / 3122 / 3454 / 1338-3454 / 0.266 | 734 / 1434 / 1560 / 559-1560 / 0.305 | - | 64.3 |
| java | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 2484 / 4798 / 4855 / 1814-4855 / 0.303 | 1316 / 2822 / 2918 / 915-2918 / 0.344 | - | 66.3 |
| python | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 36 / 117 / 234 / 23-234 / 0.851 | 58 / 201 / 476 / 26-476 / 1.049 | - | 5 |
| java | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":30} | 30/30 | 1815 / 4231 / 4902 / 1454-4902 / 0.406 | 769 / 2428 / 2483 / 588-2483 / 0.574 | - | 64.7 |
| cpp | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":29,"TO":1} | 29/30 | 14 / 117 / 14984 / 9-14984 / 5.273 | 38 / 338 / 15159 / 21-15159 / 4.995 | 1646 / 10152 / 15159 / 1130-15159 / 1.067 | 1.1 |
| java | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":29,"INFRA_ERROR":1} | 29/30 | 2187 / 4140 / 6424 / 1674-6424 / 0.39 | 872 / 1642 / 3169 / 622-3169 / 0.507 | - | 71.5 |
| java | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":29,"INFRA_ERROR":1} | 29/30 | 1998 / 4916 / 5529 / 1411-5529 / 0.488 | 847 / 2696 / 3253 / 585-3253 / 0.634 | - | 62.6 |
| cpp | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":29,"TO":1} | 29/30 | 12 / 66 / 15327 / 9-15327 / 5.321 | 35 / 123 / 15329 / 19-15329 / 5.101 | 1490 / 4648 / 15329 / 1180-15329 / 1.196 | 1.1 |
| java | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":29,"TO":1} | 29/30 | 1872 / 4263 / 8182 / 1535-8182 / 0.575 | 760 / 2056 / 6795 / 603-6795 / 1.103 | - | 65.7 |
| cpp | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 7 / 52 / 562 / 4-562 / 3.502 | 27 / 78 / 1031 / 14-1031 / 2.892 | 1508 / 5957 / 6228 / 1262-6228 / 0.612 | 1.1 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 78 / 259 / 325 / 49-325 / 0.628 | 92 / 345 / 559 / 60-559 / 0.811 | 1637 / 8654 / 9451 / 1208-9451 / 0.834 | 1.1 |
| java | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 1796 / 4747 / 5203 / 1401-5203 / 0.452 | 764 / 2249 / 2629 / 579-2629 / 0.538 | - | 62.1 |
| cpp | two-sum-nested O(n^2) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":30} | 30/30 | 50 / 108 / 1251 / 37-1251 / 2.212 | 75 / 388 / 1493 / 50-1493 / 1.933 | - | 5.4 |
| java | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":29,"TO":1} | 29/30 | 1868 / 4427 / 8136 / 1500-8136 / 0.561 | 720 / 2141 / 6759 / 579-6759 / 1.108 | - | 71.8 |
| cpp | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 5 / 7 / 7 / 3-7 / 0.239 | 25 / 36 / 39 / 16-39 / 0.265 | 1492 / 2997 / 3298 / 1111-3298 / 0.321 | 1.1 |
| java | two-sum-nested O(n^2) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| java | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":29,"TO":1} | 29/30 | 2151 / 3182 / 4381 / 1678-4381 / 0.242 | 850 / 1956 / 8391 / 642-8391 / 1.256 | - | 72 |
| java | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":30} | 30/30 | 1751 / 3472 / 4914 / 1307-4914 / 0.381 | 725 / 1599 / 2537 / 517-2537 / 0.482 | - | 62 |
| python | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 36 / 115 / 281 / 22-281 / 0.924 | 56 / 133 / 297 / 33-297 / 0.671 | - | 5.2 |
| cpp | two-sum-hash O(n) | ts-n40000 | 40000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":30} | 30/30 | 80 / 193 / 364 / 58-364 / 0.607 | 99 / 216 / 341 / 70-341 / 0.469 | - | 5.2 |
| cpp | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":30} | 30/30 | 21 / 54 / 64 / 16-64 / 0.478 | 43 / 78 / 90 / 27-90 / 0.319 | 1413 / 4414 / 10777 / 1146-10777 / 0.905 | 1.1 |
| java | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":29,"TO":1} | 29/30 | 2170 / 6530 / 8320 / 1801-8320 / 0.525 | 1215 / 4088 / 5949 / 1011-5949 / 0.65 | - | 62.4 |
| java | ls-quadratic O(n^2) | ls-distinct94-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":29,"TO":1} | 29/30 | 4 / 237 / 15183 / 3-15183 / 5.331 | 22 / 388 / 14940 / 14-14940 / 5.049 | 1440 / 3380 / 14940 / 1149-14940 / 1.168 | 1.1 |
| python | ls-window O(n) | ls-alpha26-n200000 | 200000 | fit-only | {"INFRA_ERROR":30} | 0/30 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":30} | 30/30 | 33 / 99 / 3660 / 24-3660 / 4.127 | 56 / 142 / 1424 / 24-1424 / 2.357 | - | 5.2 |

## Complexity separability at the maximum test size

Accepted = O(n) reference, rejected = O(n^2) reference, same dataset. Separable when the rejected p5 is above the
accepted p95, or the rejected class timed out at the benchmark limit ("censored"). **Primary metric: CPU time for
Python and C++, WALL time for Java** (Piston's CPU time adds up all threads; Java's includes javac, the JIT and the GC,
so it exceeds wall time even for n = 2). Net = minus the language's n = 2 baseline median. No noise margin applied.

| lang | problem | dataset | n | metric | primary | accepted p95 | rejected p5 | ratio | net accepted p95 | net rejected p5 | separable |
|---|---|---|---|---|---|---|---|---|---|---|---|
| python | two-sum | ts-n10000 | 10000 | CPU | **yes** | 73 | 1911 | 26.18 | 37 | 1875 | yes |
| python | two-sum | ts-n10000 | 10000 | wall | no | 112 | 1919 | 17.13 | 55 | 1862 | yes |
| python | longest-substring | ls-distinct94-n50000 | 50000 | CPU | **yes** | 99 | censored | - | 61 | censored | yes |
| python | longest-substring | ls-distinct94-n50000 | 50000 | wall | no | 113 | censored | - | 56 | censored | yes |
| python | longest-substring | ls-alpha26-n50000 | 50000 | CPU | **yes** | 108 | censored | - | 70 | censored | yes |
| python | longest-substring | ls-alpha26-n50000 | 50000 | wall | no | 388 | censored | - | 331 | censored | yes |
| java | two-sum | ts-n10000 | 10000 | CPU | no | 4140 | 1671 | 0.4 | 2278 | -191 | NO |
| java | two-sum | ts-n10000 | 10000 | wall | **yes** | 1642 | 632 | 0.38 | 942 | -68 | NO |
| java | longest-substring | ls-distinct94-n50000 | 50000 | CPU | no | 3303 | censored | - | 1631 | censored | yes |
| java | longest-substring | ls-distinct94-n50000 | 50000 | wall | **yes** | 1626 | censored | - | 934 | censored | yes |
| java | longest-substring | ls-alpha26-n50000 | 50000 | CPU | no | 4263 | censored | - | 2591 | censored | yes |
| java | longest-substring | ls-alpha26-n50000 | 50000 | wall | **yes** | 2056 | censored | - | 1364 | censored | yes |
| cpp | two-sum | ts-n10000 | 10000 | CPU | **yes** | 12 | 136 | 11.33 | 7 | 131 | yes |
| cpp | two-sum | ts-n10000 | 10000 | wall | no | 46 | 149 | 3.24 | 23 | 126 | yes |
| cpp | longest-substring | ls-alpha26-n50000 | 50000 | CPU | **yes** | 117 | censored | - | 112 | censored | yes |
| cpp | longest-substring | ls-alpha26-n50000 | 50000 | wall | no | 338 | censored | - | 314 | censored | yes |
| cpp | longest-substring | ls-distinct94-n50000 | 50000 | CPU | **yes** | 66 | censored | - | 61 | censored | yes |
| cpp | longest-substring | ls-distinct94-n50000 | 50000 | wall | no | 123 | censored | - | 99 | censored | yes |
