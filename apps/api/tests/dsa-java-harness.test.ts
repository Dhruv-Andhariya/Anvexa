import { describe, expect, it } from 'vitest';
import { buildProgram, cleanDiagnostics } from '../src/modules/dsa/evaluation/harness';

/**
 * Java bank problems: the harness `public class Main` must be the FIRST class (single-file launcher), so the
 * candidate's package line and imports are moved above it. Source transformation only - no code runner involved.
 */
const build = (code: string) => {
  const p = buildProgram('java', 'two-sum', code);
  return { ...p, lines: p.source.split('\n') };
};
const harnessStart = (lines: string[]) => lines.findIndex((l) => l.includes('public class Main'));
const lineOf = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle)) + 1; // 1-based

const SOLUTION = 'class Solution {\n    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }\n}\n';

describe('Java harness: package and imports', () => {
  it('a package declaration goes first, then the imports, then the harness Main, then the candidate code', () => {
    const p = build(`package com.example.app;\nimport java.util.*;\n\n${SOLUTION}`);
    expect(p.lines[0]).toBe('package com.example.app;');
    expect(p.lines[1]).toBe('import java.util.*;');
    const main = harnessStart(p.lines);
    expect(main).toBeGreaterThan(1);
    expect(lineOf(p.lines, 'class Solution')).toBeGreaterThan(main + 1);
    expect(p.lines.filter((l) => l.startsWith('package ')).length).toBe(1); // moved, not copied
  });

  it('the package line is moved even when it comes after the imports or after a leading comment', () => {
    const p = build(`// my solution\nimport java.util.*;\npackage app;\n${SOLUTION}`);
    expect(p.lines.slice(0, 2)).toEqual(['package app;', 'import java.util.*;']);
    expect(p.lines.slice(harnessStart(p.lines)).join('\n')).toContain('// my solution'); // comments stay with the code
  });

  it('an import with a trailing comment is moved with its comment', () => {
    const p = build(`import java.util.HashMap; // for the lookup\n${SOLUTION}`);
    expect(p.lines[0]).toBe('import java.util.HashMap; // for the lookup');
    expect(harnessStart(p.lines)).toBeGreaterThan(0);
  });

  it('several imports on one line (and a static import) are moved, in their order', () => {
    const p = build(`import java.util.Map; import java.util.HashMap;\nimport static java.lang.Math.max; /* helper */\n${SOLUTION}`);
    expect(p.lines.slice(0, 2)).toEqual(['import java.util.Map; import java.util.HashMap;', 'import static java.lang.Math.max; /* helper */']);
  });

  it('imports at arbitrary positions (after a class, between classes) are moved above the harness', () => {
    const p = build(`import java.util.*;\n\n${SOLUTION}import java.io.*;\nclass Helper {}\n`);
    expect(p.lines.slice(0, 2)).toEqual(['import java.util.*;', 'import java.io.*;']);
    expect(lineOf(p.lines, 'class Helper')).toBeGreaterThan(harnessStart(p.lines));
  });

  it('package / import text inside comments, strings and text blocks is NOT treated as a declaration', () => {
    const code = [
      '// package fake.one;',
      '/* import fake.Two; */',
      '/*',
      'import fake.Three;',
      '*/',
      'class Solution {',
      '    String s = "import fake.Four;";',
      '    String t = """',
      'import fake.Five;',
      '""";',
      '    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }',
      '}',
      '',
    ].join('\n');
    const p = build(code);
    const main = harnessStart(p.lines);
    expect(main).toBe(1); // nothing moved above the harness (it starts with an empty line)
    expect(p.lines.slice(0, main).join('')).toBe('');
    for (const fake of ['fake.one', 'fake.Two', 'fake.Three', 'fake.Four', 'fake.Five']) {
      expect(lineOf(p.lines, fake)).toBeGreaterThan(main); // still where the candidate wrote it
    }
  });

  it('a line that only closes or opens a block comment stays where it is', () => {
    const p = build(`/* note\n*/ import java.util.*;\nimport java.io.*; /* starts here\nstill a comment */\n${SOLUTION}`);
    expect(harnessStart(p.lines)).toBe(1); // neither half-comment line was moved
    expect(lineOf(p.lines, '*/ import java.util.*;')).toBeGreaterThan(1);
  });

  it('existing starters keep working: class Solution and public class Solution', () => {
    for (const decl of ['class Solution', 'public class Solution']) {
      const p = build(`import java.util.*;\n${decl} {\n    public int[] twoSum(int[] nums, int target) { return new int[]{0, 1}; }\n}\n`);
      expect(p.lines[0]).toBe('import java.util.*;');
      expect(lineOf(p.lines, decl)).toBeGreaterThan(harnessStart(p.lines));
      expect(p.source).toContain('new Solution().twoSum(nums, target)'); // the harness still calls the candidate
    }
  });

  it('error line mapping points at the candidate\'s own lines after the move', () => {
    const code = 'package app;\n// comment\nimport java.util.*; // maps\nclass Solution {\n    int x = ;\n}\n';
    const p = build(code);
    // moved header lines map to where the candidate wrote them
    expect(p.mapLine(1)).toBe(1); // package app;
    expect(p.mapLine(2)).toBe(3); // import java.util.*;
    // a harness line maps to nothing
    expect(p.mapLine(harnessStart(p.lines) + 1)).toBeNull();
    // the broken line `int x = ;` is candidate line 5
    const combined = lineOf(p.lines, 'int x = ;');
    expect(p.mapLine(combined)).toBe(5);
    expect(cleanDiagnostics(`Main.java.java:${combined}: error: illegal start of expression`, p.mapLine)).toBe('solution:5: error: illegal start of expression');
  });

  it('code without any package or import is unchanged: the harness comes first', () => {
    const p = build(SOLUTION);
    expect(harnessStart(p.lines)).toBe(1);
    expect(p.mapLine(lineOf(p.lines, 'class Solution'))).toBe(1);
  });
});
