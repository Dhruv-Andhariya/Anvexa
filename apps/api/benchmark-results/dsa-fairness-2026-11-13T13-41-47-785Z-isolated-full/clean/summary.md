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
  ],
  "cleanedAt": "2026-11-15T19:46:28.236Z",
  "cleanedFrom": "C:\\Users\\Grisa\\Downloads\\Anvexa\\Anvexa\\apps\\api\\benchmark-results\\dsa-fairness-2026-11-13T13-41-47-785Z-isolated-full\\raw.json",
  "cleaning": "kept: correct samples and genuine timeouts; excluded: HTTP 400, client timeouts, CPU-overlap, sleep and post-resume samples, false timeouts (see exclusions.json, evidence.json)",
  "pointsWithoutData": [
    "cpp|two-sum-hash|ts-n20000",
    "java|ls-quadratic|ls-distinct94-n100000",
    "python|ls-quadratic|ls-distinct94-n100000",
    "python|ls-window|ls-distinct94-n200000",
    "cpp|ls-quadratic|ls-distinct94-n200000",
    "java|ls-window|ls-alpha26-n200000",
    "cpp|ls-window|ls-alpha26-n200000",
    "cpp|ls-quadratic|ls-distinct94-n100000",
    "cpp|ls-quadratic|ls-alpha26-n200000",
    "cpp|ls-window|ls-distinct94-n100000",
    "java|ls-window|ls-distinct94-n200000",
    "python|ls-quadratic|ls-distinct94-n200000",
    "python|two-sum-nested|ts-n40000",
    "java|two-sum-hash|ts-n20000",
    "java|two-sum-hash|ts-n40000",
    "cpp|two-sum-nested|ts-n20000",
    "java|ls-quadratic|ls-alpha26-n200000",
    "python|ls-quadratic|ls-alpha26-n200000",
    "java|two-sum-nested|ts-n20000",
    "python|two-sum-hash|ts-n20000",
    "python|ls-window|ls-distinct94-n100000",
    "cpp|ls-window|ls-distinct94-n200000",
    "java|ls-window|ls-distinct94-n100000",
    "python|two-sum-nested|ts-n20000",
    "python|two-sum-hash|ts-n40000",
    "cpp|two-sum-nested|ts-n40000",
    "java|two-sum-nested|ts-n40000",
    "cpp|two-sum-hash|ts-n40000",
    "java|ls-quadratic|ls-distinct94-n200000",
    "python|ls-window|ls-alpha26-n200000"
  ],
  "summarizedAt": "2026-11-15T19:46:40.531Z",
  "summarizedFrom": "C:\\Users\\Grisa\\Downloads\\Anvexa\\Anvexa\\apps\\api\\benchmark-results\\dsa-fairness-2026-11-13T13-41-47-785Z-isolated-full\\clean\\raw.clean.json"
}
```

Columns: median / p95 / p99 / min-max / CV (coefficient of variation). Times in ms (Piston-reported). With 30
samples p99 is effectively the maximum. "censored": every warm-up hit the limit, so no measured runs were made.

| lang | algorithm | dataset | n | role | statuses | correct | run CPU ms | run wall ms | compile wall ms (C++) | memory MB |
|---|---|---|---|---|---|---|---|---|---|---|
| python | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":28} | 28/28 | 32 / 49 / 84 / 23-84 / 0.338 | 49 / 76 / 109 / 33-109 / 0.295 | - | 5.1 |
| java | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":28} | 28/28 | 2005 / 3076 / 4147 / 1418-4147 / 0.286 | 852 / 1341 / 1851 / 567-1851 / 0.328 | - | 65.2 |
| java | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":25} | 25/25 | 1745 / 2450 / 2533 / 1379-2533 / 0.184 | 696 / 969 / 1080 / 561-1080 / 0.198 | - | 65.2 |
| cpp | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":27} | 27/27 | 5 / 12 / 15 / 3-15 / 0.501 | 23 / 35 / 38 / 15-38 / 0.244 | 1541 / 3010 / 4593 / 1175-4593 / 0.391 | 1.1 |
| python | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":29} | 29/29 | 47 / 99 / 103 / 33-103 / 0.338 | 68 / 113 / 143 / 33-143 / 0.313 | - | 5.2 |
| cpp | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":25} | 25/25 | 6 / 9 / 14 / 4-14 / 0.315 | 23 / 39 / 40 / 14-40 / 0.297 | 1441 / 2982 / 9440 / 1093-9440 / 0.84 | 1.1 |
| java | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":29} | 29/29 | 1710 / 2750 / 5481 / 1385-5481 / 0.405 | 710 / 1094 / 3226 / 581-3226 / 0.583 | - | 62.4 |
| python | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":28} | 28/28 | 34 / 50 / 90 / 26-90 / 0.325 | 55 / 80 / 102 / 27-102 / 0.25 | - | 5.2 |
| python | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":28} | 28/28 | 33 / 45 / 46 / 24-46 / 0.188 | 52 / 70 / 81 / 28-81 / 0.24 | - | 5 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":29} | 29/29 | 7 / 14 / 15 / 4-15 / 0.356 | 25 / 36 / 39 / 15-39 / 0.25 | 1437 / 2248 / 2933 / 1156-2933 / 0.251 | 1.1 |
| python | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":30} | 30/30 | 65 / 107 / 111 / 45-111 / 0.22 | 82 / 124 / 153 / 61-153 / 0.216 | - | 5.4 |
| python | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":26} | 26/26 | 5 / 8 / 8 / 3-8 / 0.273 | 25 / 32 / 63 / 12-63 / 0.339 | 1347 / 2318 / 3246 / 1204-3246 / 0.301 | 1.1 |
| cpp | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":25} | 25/25 | 5 / 8 / 8 / 3-8 / 0.272 | 26 / 35 / 46 / 16-46 / 0.27 | 1563 / 2413 / 2540 / 1126-2540 / 0.236 | 1.1 |
| python | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":28} | 28/28 | 41 / 57 / 73 / 26-73 / 0.258 | 59 / 93 / 117 / 31-117 / 0.27 | - | 6.5 |
| python | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":25} | 25/25 | 58 / 89 / 759 / 43-759 / 1.587 | 76 / 106 / 803 / 56-803 / 1.351 | - | 5.2 |
| cpp | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 9 / 12 / 13 / 7-13 / 0.165 | 30 / 46 / 48 / 16-48 / 0.258 | 1457 / 2127 / 2275 / 1144-2275 / 0.204 | 1.4 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":27} | 27/27 | 67 / 78 / 82 / 51-82 / 0.147 | 89 / 102 / 102 / 64-102 / 0.136 | 1426 / 1981 / 2842 / 1134-2842 / 0.23 | 1.1 |
| python | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":23} | 23/23 | 35 / 48 / 61 / 23-61 / 0.224 | 56 / 77 / 80 / 29-80 / 0.234 | - | 5.9 |
| java | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":29} | 29/29 | 1995 / 2837 / 2880 / 1641-2880 / 0.158 | 742 / 1081 / 1141 / 618-1141 / 0.174 | - | 71.4 |
| java | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":25} | 25/25 | 1706 / 2700 / 2808 / 1437-2808 / 0.229 | 666 / 1165 / 1274 / 572-1274 / 0.259 | - | 64.7 |
| java | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":28} | 28/28 | 1884 / 2684 / 3612 / 1491-3612 / 0.213 | 756 / 1127 / 1701 / 604-1701 / 0.257 | - | 64.8 |
| cpp | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":26} | 26/26 | 4 / 8 / 8 / 3-8 / 0.288 | 22 / 34 / 39 / 8-39 / 0.34 | 1400 / 2363 / 2494 / 1203-2494 / 0.22 | 1.1 |
| java | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":28} | 28/28 | 1875 / 2450 / 2923 / 1581-2923 / 0.143 | 739 / 961 / 1133 / 601-1133 / 0.156 | - | 70.6 |
| cpp | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":28} | 28/28 | 4 / 10 / 12 / 3-12 / 0.415 | 22 / 33 / 42 / 11-42 / 0.327 | 1440 / 1974 / 2297 / 1168-2297 / 0.171 | 1.1 |
| python | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":27} | 27/27 | 3441 / 5999 / 6382 / 2997-6382 / 0.287 | 3470 / 6024 / 6394 / 3022-6394 / 0.286 | - | 5.2 |
| python | ls-window O(n) | ls-distinct94-n10000 | 10000 | test-size | {"OK":27} | 27/27 | 35 / 52 / 56 / 23-56 / 0.221 | 54 / 77 / 86 / 24-86 / 0.253 | - | 5.2 |
| python | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":27} | 27/27 | 31 / 87 / 103 / 20-103 / 0.5 | 49 / 101 / 117 / 26-117 / 0.374 | - | 5 |
| java | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":24} | 24/24 | 2054 / 2733 / 2918 / 1511-2918 / 0.188 | 790 / 1088 / 1114 / 584-1114 / 0.196 | - | 70.8 |
| cpp | two-sum-hash O(n) | ts-n5000 | 5000 | test-size | {"OK":27} | 27/27 | 7 / 11 / 12 / 5-12 / 0.286 | 26 / 44 / 45 / 13-45 / 0.298 | 1511 / 2236 / 3741 / 1215-3741 / 0.3 | 1.1 |
| cpp | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":27} | 27/27 | 159 / 298 / 300 / 126-300 / 0.248 | 181 / 314 / 322 / 146-322 / 0.217 | 1395 / 2119 / 3286 / 1141-3286 / 0.277 | 1.1 |
| java | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":26} | 26/26 | 1823 / 2627 / 2749 / 1374-2749 / 0.184 | 693 / 1022 / 1101 / 523-1101 / 0.204 | - | 71.7 |
| cpp | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":30} | 30/30 | 5 / 7 / 7 / 3-7 / 0.252 | 23 / 40 / 41 / 13-41 / 0.299 | 1594 / 2384 / 3617 / 1205-3617 / 0.271 | 1.1 |
| java | two-sum-nested O(n^2) | ts-n1000 | 1000 | test-size | {"OK":29} | 29/29 | 1850 / 2358 / 2361 / 1590-2361 / 0.124 | 712 / 968 / 991 / 594-991 / 0.152 | - | 71.9 |
| python | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":29} | 29/29 | 554 / 873 / 906 / 469-906 / 0.207 | 570 / 900 / 926 / 493-926 / 0.203 | - | 5.6 |
| java | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":26} | 26/26 | 1760 / 2766 / 3678 / 1550-3678 / 0.236 | 668 / 1070 / 1467 / 562-1467 / 0.258 | - | 71.7 |
| python | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":29} | 29/29 | 2045 / 6321 / 7808 / 1850-7808 / 0.512 | 2064 / 6351 / 7835 / 1882-7835 / 0.508 | - | 6.1 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":30} | 30/30 | 34 / 48 / 54 / 21-54 / 0.227 | 53 / 80 / 86 / 23-86 / 0.285 | - | 5 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":24,"TO":1} | 24/25 | 5050 / 6943 / 7770 / 4465-7770 / 0.159 | 5070 / 6956 / 8085 / 4483-8085 / 0.164 | 1441 / 2655 / 2930 / 1077-2930 / 0.292 | 1.1 |
| cpp | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":28} | 28/28 | 5 / 5 / 7 / 3-7 / 0.208 | 22 / 34 / 39 / 11-39 / 0.279 | 1400 / 1879 / 1984 / 1183-1984 / 0.16 | 0.9 |
| cpp | ls-window O(n) | ls-alpha26-n10 | 10 | test-size | {"OK":29} | 29/29 | 5 / 7 / 8 / 3-8 / 0.268 | 28 / 44 / 51 / 14-51 / 0.346 | 1518 / 3590 / 3691 / 1142-3691 / 0.349 | 1.1 |
| python | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":29} | 29/29 | 33 / 60 / 84 / 24-84 / 0.321 | 52 / 76 / 104 / 26-104 / 0.282 | - | 5.1 |
| java | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":23} | 23/23 | 1724 / 2458 / 2670 / 1412-2670 / 0.182 | 708 / 1022 / 1062 / 601-1062 / 0.184 | - | 62.5 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| cpp | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":27} | 27/27 | 49 / 75 / 80 / 34-80 / 0.23 | 66 / 95 / 95 / 43-95 / 0.183 | 1443 / 1869 / 2405 / 1113-2405 / 0.176 | 1.1 |
| python | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| java | ls-quadratic O(n^2) | ls-alpha26-n100000 | 100000 | fit-only | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":27} | 27/27 | 82 / 176 / 187 / 51-187 / 0.347 | 99 / 191 / 195 / 61-195 / 0.302 | - | 5.2 |
| java | two-sum-nested O(n^2) | ts-n10000 | 10000 | test-size | {"OK":26} | 26/26 | 2114 / 3232 / 5901 / 1663-5901 / 0.367 | 788 / 1321 / 2950 / 599-2950 / 0.496 | - | 72 |
| python | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":25} | 25/25 | 33 / 72 / 86 / 21-86 / 0.425 | 56 / 93 / 101 / 33-101 / 0.325 | - | 5.2 |
| python | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":25} | 25/25 | 37 / 52 / 55 / 22-55 / 0.251 | 54 / 79 / 80 / 22-80 / 0.264 | - | 5.2 |
| python | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":28} | 28/28 | 33 / 66 / 112 / 25-112 / 0.445 | 54 / 78 / 133 / 36-133 / 0.318 | - | 5.2 |
| java | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":28} | 28/28 | 1648 / 3437 / 3741 / 1337-3741 / 0.32 | 673 / 1561 / 1719 / 535-1719 / 0.384 | - | 64.8 |
| python | two-sum-hash O(n) | ts-n2 | 2 | baseline | {"OK":23} | 23/23 | 34 / 90 / 160 / 26-160 / 0.679 | 54 / 103 / 181 / 30-181 / 0.489 | - | 5.2 |
| java | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":26} | 26/26 | 1816 / 2364 / 3714 / 1487-3714 / 0.235 | 743 / 1008 / 1717 / 579-1717 / 0.283 | - | 64.9 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":27,"TO":2} | 27/29 | 5109 / 8025 / 8101 / 4748-8101 / 0.162 | 5126 / 8052 / 8158 / 4770-8158 / 0.162 | 1372 / 2330 / 2389 / 1106-2389 / 0.235 | 1.1 |
| cpp | two-sum-hash O(n) | ts-n1000 | 1000 | test-size | {"OK":26} | 26/26 | 5 / 8 / 8 / 3-8 / 0.235 | 24 / 42 / 84 / 14-84 / 0.482 | 1520 / 2015 / 2712 / 1195-2712 / 0.2 | 0.9 |
| python | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":27} | 27/27 | 31 / 62 / 108 / 23-108 / 0.473 | 55 / 88 / 124 / 23-124 / 0.356 | - | 5 |
| java | ls-window O(n) | ls-baseline-n2 | 2 | baseline | {"OK":25} | 25/25 | 1645 / 2491 / 2652 / 1480-2652 / 0.171 | 680 / 1032 / 1165 / 583-1165 / 0.192 | - | 64.2 |
| cpp | two-sum-hash O(n) | ts-n10 | 10 | test-size | {"OK":26} | 26/26 | 4 / 7 / 10 / 3-10 / 0.345 | 23 / 37 / 39 / 15-39 / 0.229 | 1488 / 2138 / 2561 / 1175-2561 / 0.209 | 1.1 |
| python | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":30} | 30/30 | 3523 / 5761 / 5761 / 2953-5761 / 0.212 | 3549 / 5775 / 5787 / 2954-5787 / 0.211 | - | 5.2 |
| cpp | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":26} | 26/26 | 5 / 10 / 14 / 3-14 / 0.448 | 21 / 34 / 38 / 13-38 / 0.289 | 1528 / 2406 / 4012 / 1250-4012 / 0.339 | 0.9 |
| java | ls-window O(n) | ls-alpha26-n1000 | 1000 | test-size | {"OK":26} | 26/26 | 1787 / 2680 / 2766 / 1338-2766 / 0.19 | 727 / 1118 / 1136 / 559-1136 / 0.204 | - | 64.4 |
| java | ls-quadratic O(n^2) | ls-distinct94-n10000 | 10000 | test-size | {"OK":26} | 26/26 | 2358 / 3970 / 4320 / 1814-4320 / 0.241 | 1291 / 2243 / 2582 / 915-2582 / 0.272 | - | 66.4 |
| python | ls-quadratic O(n^2) | ls-distinct94-n50000 | 50000 | test-size | skipped (warm-ups timed out) | 0/0 | - | - | - | - |
| python | ls-window O(n) | ls-distinct94-n1000 | 1000 | test-size | {"OK":26} | 26/26 | 32 / 75 / 117 / 23-117 / 0.51 | 56 / 97 / 137 / 26-137 / 0.42 | - | 5 |
| java | ls-window O(n) | ls-distinct94-n10 | 10 | test-size | {"OK":24} | 24/24 | 1659 / 2177 / 2901 / 1454-2901 / 0.182 | 675 / 885 / 1292 / 588-1292 / 0.213 | - | 64.9 |
| cpp | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":23} | 23/23 | 13 / 16 / 26 / 9-26 / 0.223 | 36 / 50 / 58 / 21-58 / 0.242 | 1551 / 2293 / 5971 / 1130-5971 / 0.55 | 1.1 |
| java | two-sum-hash O(n) | ts-n10000 | 10000 | test-size | {"OK":27} | 27/27 | 2172 / 3051 / 4140 / 1674-4140 / 0.238 | 853 / 1300 / 1642 / 622-1642 / 0.265 | - | 71.5 |
| java | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":21} | 21/21 | 1631 / 2524 / 2953 / 1411-2953 / 0.244 | 643 / 1069 / 1239 / 585-1239 / 0.257 | - | 62.5 |
| cpp | ls-window O(n) | ls-distinct94-n50000 | 50000 | test-size | {"OK":27} | 27/27 | 12 / 16 / 32 / 9-32 / 0.33 | 35 / 49 / 62 / 19-62 / 0.304 | 1448 / 2056 / 2088 / 1180-2088 / 0.176 | 1.1 |
| java | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":28} | 28/28 | 1813 / 2253 / 2294 / 1535-2294 / 0.139 | 736 / 995 / 1018 / 603-1018 / 0.175 | - | 65.7 |
| cpp | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":25} | 25/25 | 6 / 14 / 40 / 4-40 / 0.867 | 26 / 35 / 78 / 14-78 / 0.467 | 1468 / 1963 / 1968 / 1262-1968 / 0.164 | 1.1 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":25} | 25/25 | 73 / 111 / 120 / 49-120 / 0.241 | 90 / 134 / 144 / 60-144 / 0.226 | 1562 / 2428 / 2796 / 1208-2796 / 0.245 | 1.1 |
| java | ls-quadratic O(n^2) | ls-distinct94-n1000 | 1000 | test-size | {"OK":25} | 25/25 | 1660 / 2624 / 3256 / 1401-3256 / 0.232 | 698 / 1142 / 1554 / 579-1554 / 0.271 | - | 62.2 |
| python | ls-window O(n) | ls-alpha26-n50000 | 50000 | test-size | {"OK":23} | 23/23 | 48 / 70 / 85 / 37-85 / 0.216 | 72 / 88 / 112 / 50-112 / 0.188 | - | 5.4 |
| java | two-sum-nested O(n^2) | ts-n2 | 2 | baseline | {"OK":27} | 27/27 | 1866 / 2347 / 2661 / 1500-2661 / 0.156 | 698 / 1015 / 1018 / 579-1018 / 0.17 | - | 71.8 |
| cpp | two-sum-nested O(n^2) | ts-n10 | 10 | test-size | {"OK":26} | 26/26 | 5 / 7 / 7 / 3-7 / 0.248 | 26 / 36 / 39 / 16-39 / 0.256 | 1464 / 2263 / 2518 / 1111-2518 / 0.218 | 1.1 |
| java | two-sum-nested O(n^2) | ts-n5000 | 5000 | test-size | {"OK":27} | 27/27 | 2142 / 2506 / 3182 / 1678-3182 / 0.15 | 820 / 1016 / 1205 / 642-1205 / 0.168 | - | 72 |
| java | ls-quadratic O(n^2) | ls-baseline-n2 | 2 | baseline | {"OK":27} | 27/27 | 1741 / 2380 / 2645 / 1307-2645 / 0.199 | 711 / 989 / 1159 / 517-1159 / 0.217 | - | 62 |
| python | ls-window O(n) | ls-alpha26-n10000 | 10000 | test-size | {"OK":26} | 26/26 | 35 / 88 / 115 / 22-115 / 0.51 | 53 / 115 / 133 / 33-133 / 0.398 | - | 5.2 |
| python | ls-quadratic O(n^2) | ls-alpha26-n1000 | 1000 | test-size | {"OK":28} | 28/28 | 77 / 118 / 119 / 58-119 / 0.227 | 94 / 142 / 148 / 70-148 / 0.216 | - | 5.2 |
| cpp | ls-window O(n) | ls-alpha26-n100000 | 100000 | fit-only | {"OK":27} | 27/27 | 20 / 24 / 32 / 16-32 / 0.159 | 41 / 55 / 57 / 27-57 / 0.194 | 1403 / 2214 / 2302 / 1146-2302 / 0.213 | 1.1 |
| java | ls-quadratic O(n^2) | ls-alpha26-n10000 | 10000 | test-size | {"OK":27} | 27/27 | 2166 / 3900 / 4213 / 1801-4213 / 0.242 | 1199 / 2247 / 2416 / 1011-2416 / 0.263 | - | 62.4 |
| cpp | ls-quadratic O(n^2) | ls-distinct94-n10 | 10 | test-size | {"OK":28} | 28/28 | 4 / 8 / 39 / 3-39 / 1.108 | 22 / 43 / 181 / 14-181 / 1.024 | 1418 / 3257 / 3380 / 1149-3380 / 0.359 | 1.1 |
| python | ls-quadratic O(n^2) | ls-alpha26-n10 | 10 | test-size | {"OK":26} | 26/26 | 32 / 55 / 99 / 24-99 / 0.401 | 51 / 86 / 142 / 24-142 / 0.38 | - | 5.1 |

## Complexity separability at the maximum test size

Accepted = O(n) reference, rejected = O(n^2) reference, same dataset. Separable when the rejected p5 is above the
accepted p95, or the rejected class timed out at the benchmark limit ("censored"). **Primary metric: CPU time for
Python and C++, WALL time for Java** (Piston's CPU time adds up all threads; Java's includes javac, the JIT and the GC,
so it exceeds wall time even for n = 2). Net = minus the language's n = 2 baseline median. No noise margin applied.

| lang | problem | dataset | n | metric | primary | accepted p95 | rejected p5 | ratio | net accepted p95 | net rejected p5 | separable |
|---|---|---|---|---|---|---|---|---|---|---|---|
| python | two-sum | ts-n10000 | 10000 | CPU | **yes** | 57 | 1911 | 33.53 | 23 | 1877 | yes |
| python | two-sum | ts-n10000 | 10000 | wall | no | 93 | 1919 | 20.63 | 39 | 1865 | yes |
| python | longest-substring | ls-distinct94-n50000 | 50000 | CPU | **yes** | 99 | censored | - | 62 | censored | yes |
| python | longest-substring | ls-distinct94-n50000 | 50000 | wall | no | 113 | censored | - | 59 | censored | yes |
| python | longest-substring | ls-alpha26-n50000 | 50000 | CPU | **yes** | 70 | censored | - | 33 | censored | yes |
| python | longest-substring | ls-alpha26-n50000 | 50000 | wall | no | 88 | censored | - | 34 | censored | yes |
| java | two-sum | ts-n10000 | 10000 | CPU | no | 3051 | 1671 | 0.55 | 1291 | -89 | NO |
| java | two-sum | ts-n10000 | 10000 | wall | **yes** | 1300 | 632 | 0.49 | 632 | -36 | NO |
| java | longest-substring | ls-distinct94-n50000 | 50000 | CPU | no | 3076 | censored | - | 1431 | censored | yes |
| java | longest-substring | ls-distinct94-n50000 | 50000 | wall | **yes** | 1341 | censored | - | 661 | censored | yes |
| java | longest-substring | ls-alpha26-n50000 | 50000 | CPU | no | 2253 | censored | - | 608 | censored | yes |
| java | longest-substring | ls-alpha26-n50000 | 50000 | wall | **yes** | 995 | censored | - | 315 | censored | yes |
| cpp | two-sum | ts-n10000 | 10000 | CPU | **yes** | 12 | 136 | 11.33 | 7 | 131 | yes |
| cpp | two-sum | ts-n10000 | 10000 | wall | no | 46 | 149 | 3.24 | 23 | 126 | yes |
| cpp | longest-substring | ls-alpha26-n50000 | 50000 | CPU | **yes** | 16 | censored | - | 12 | censored | yes |
| cpp | longest-substring | ls-alpha26-n50000 | 50000 | wall | no | 50 | censored | - | 28 | censored | yes |
| cpp | longest-substring | ls-distinct94-n50000 | 50000 | CPU | **yes** | 16 | censored | - | 12 | censored | yes |
| cpp | longest-substring | ls-distinct94-n50000 | 50000 | wall | no | 49 | censored | - | 27 | censored | yes |
