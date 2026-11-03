import type { DsaRoundQuestion } from '../session/invitation.resolver';
import type { CodeLanguage, Difficulty, DsaQuestion } from './question.types';

/** HR's own problems: the candidate writes the whole program, reading the input from stdin and printing the answer. */
export const STDIO_STARTER_CODE: Record<CodeLanguage, string> = {
  python: `import sys


def main():
    data = sys.stdin.read().split()
    # Read the input, solve the problem and print the answer


if __name__ == "__main__":
    main()
`,
  java: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        // Read the input, solve the problem and print the answer
    }
}
`,
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    // Read the input, solve the problem and print the answer
    return 0;
}
`,
};

const DIFFICULTY: Record<'EASY' | 'MEDIUM' | 'HARD', Difficulty> = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' };

/** What a test's input looks like on the problem page (long inputs are cut; the program still gets all of it). */
const display = (input: string) => {
  const text = input.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
};

/**
 * The problem as the DSA page runs it, from what HR wrote in the rounds editor: the question text is the statement,
 * the sample tests are the examples (and what "Run" uses), every test grades "Submit". Hidden tests stay in the API
 * (toPublicQuestion only ever sends the sample ones).
 */
export function fromHrProblem(q: DsaRoundQuestion & { custom: NonNullable<DsaRoundQuestion['custom']> }): DsaQuestion {
  const { statement, difficulty, spec } = q.custom;
  let samples = 0;
  let hidden = 0;
  return {
    id: q.id,
    title: spec.title,
    difficulty: DIFFICULTY[difficulty ?? 'MEDIUM'],
    marks: q.marks,
    description: statement,
    inputFormat: spec.inputFormat,
    outputFormat: spec.outputFormat,
    constraints: spec.constraints
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean),
    samples: spec.tests.filter((t) => !t.hidden).map((t) => ({ input: display(t.input), output: t.output, explanation: '' })),
    starterCode: { ...STDIO_STARTER_CODE },
    harness: 'stdio',
    comparator: 'lines',
    testCases: spec.tests.map((t) => ({
      id: t.hidden ? `h${++hidden}` : `s${++samples}`,
      display: t.hidden ? '' : display(t.input),
      stdin: t.input.endsWith('\n') ? t.input : `${t.input}\n`,
      expectedOutput: t.output,
      hidden: t.hidden,
    })),
  };
}
