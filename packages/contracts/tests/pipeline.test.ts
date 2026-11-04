import { describe, expect, it } from 'vitest';
import {
  pipelineSettingsSchema,
  pipelineStatusOf,
  rubricScoreProblems,
  saveRubricRequestSchema,
  stage2GateAllows,
  stage2Verdict,
  type PipelineResult,
  type PipelineRound,
  type PipelineSettings,
} from '../src';

// Stage 1 aptitude, Stage 2 GD -> SQL -> DSA (HR's order), tech interview, personal interview
const rounds: PipelineRound[] = [
  { id: 'apt', position: 0, type: 'APTITUDE' },
  { id: 'gd', position: 1, type: 'GROUP_DISCUSSION' },
  { id: 'sql', position: 2, type: 'SQL' },
  { id: 'dsa', position: 3, type: 'CODING' },
  { id: 'tech', position: 4, type: 'AI_INTERVIEW' },
  { id: 'pi', position: 5, type: 'HR_INTERVIEW' },
];
const pass = (score: number, maxScore: number): PipelineResult => ({ outcome: 'PASSED', score, maxScore });
const fail = (score: number, maxScore: number): PipelineResult => ({ outcome: 'FAILED', score, maxScore });
const of = (m: Record<string, PipelineResult>) => (id: string) => m[id];
const ALL: PipelineSettings = { stage2Rule: 'ALL_ROUNDS_PASSED', stage2MinPercent: null, rejectionEmails: true };
const PCT70: PipelineSettings = { stage2Rule: 'TOTAL_PERCENT', stage2MinPercent: 70, rejectionEmails: true };
const BOTH70: PipelineSettings = { stage2Rule: 'BOTH', stage2MinPercent: 70, rejectionEmails: true };

// GD 12 of 30, SQL 18 of 20, DSA 25 of 30 = 55 of 80 = 68.75 %
const stage2Done = { apt: pass(8, 10), gd: pass(12, 30), sql: pass(18, 20), dsa: pass(25, 30) };

describe('Stage 2 overall criterion', () => {
  it('total percent = marks scored / total marks across DSA, SQL and GD, rounded down to 2 decimals', () => {
    expect(stage2Verdict(rounds, of(stage2Done), PCT70)).toEqual({ decided: true, passed: false, allRoundsPassed: true, scored: 55, total: 80, percent: 68.75 });
    expect(stage2Verdict(rounds, of({ ...stage2Done, gd: pass(13, 30) }), PCT70)).toMatchObject({ passed: true, percent: 70 });
    expect(stage2Verdict(rounds, of({ gd: pass(1, 3), sql: pass(1, 3), dsa: pass(0, 3) }), ALL)!.percent).toBe(22.22);
  });

  it('ALL_ROUNDS_PASSED ignores the percentage; TOTAL_PERCENT ignores failed rounds; BOTH needs both (AND)', () => {
    const low = { ...stage2Done, gd: pass(3, 30) }; // 46 of 80
    expect(stage2Verdict(rounds, of(low), ALL)!.passed).toBe(true);
    expect(stage2Verdict(rounds, of(low), BOTH70)!.passed).toBe(false);
    const oneFailedButHigh = { ...stage2Done, gd: fail(28, 30) }; // 71 of 80, GD failed its own rule
    expect(stage2Verdict(rounds, of(oneFailedButHigh), PCT70)!.passed).toBe(true);
    expect(stage2Verdict(rounds, of(oneFailedButHigh), BOTH70)!.passed).toBe(false);
    expect(stage2Verdict(rounds, of(oneFailedButHigh), ALL)!.passed).toBe(false);
  });

  it('is undecided until every technical round has a result; no technical round = no criterion', () => {
    expect(stage2Verdict(rounds, of({ apt: pass(8, 10), gd: pass(30, 30), sql: pass(20, 20) }), PCT70)).toMatchObject({ decided: false, passed: false });
    expect(stage2Verdict(rounds.filter((r) => r.id === 'apt'), of(stage2Done), PCT70)).toBeNull();
  });

  it('rounds after the last technical round need the criterion passed; earlier rounds never wait for it', () => {
    expect(stage2GateAllows(rounds, { position: 4 }, of(stage2Done), PCT70)).toBe(false);
    expect(stage2GateAllows(rounds, { position: 4 }, of(stage2Done), ALL)).toBe(true);
    expect(stage2GateAllows(rounds, { position: 3 }, of({ apt: pass(8, 10) }), PCT70)).toBe(true);
    expect(stage2GateAllows(rounds, { position: 4 }, of({ ...stage2Done, dsa: undefined as never }), ALL)).toBe(false);
  });
});

describe('pipeline status', () => {
  it('names the stage a student is in, and the specific reason a student was rejected', () => {
    expect(pipelineStatusOf(rounds, of({}), ALL)).toBe('NOT_STARTED');
    expect(pipelineStatusOf(rounds, of({ apt: fail(2, 10) }), ALL)).toBe('REJECTED_APTITUDE');
    expect(pipelineStatusOf(rounds, of({ apt: pass(8, 10) }), ALL)).toBe('IN_TECHNICAL_ROUNDS');
    expect(pipelineStatusOf(rounds, of({ apt: pass(8, 10), gd: pass(20, 30), sql: fail(5, 20) }), ALL)).toBe('REJECTED_MODULE2_ROUND');
    expect(pipelineStatusOf(rounds, of(stage2Done), PCT70)).toBe('REJECTED_MODULE2_OVERALL');
    expect(pipelineStatusOf(rounds, of(stage2Done), ALL)).toBe('IN_TECH_INTERVIEW');
    expect(pipelineStatusOf(rounds, of({ ...stage2Done, tech: fail(3, 10) }), ALL)).toBe('REJECTED_TECH_INTERVIEW');
    expect(pipelineStatusOf(rounds, of({ ...stage2Done, tech: pass(8, 10) }), ALL)).toBe('IN_PERSONAL_INTERVIEW');
  });

  it("HR's personal-interview call decides the end: selected, or rejected at the personal interview", () => {
    const cleared = of({ ...stage2Done, tech: pass(8, 10) });
    expect(pipelineStatusOf(rounds, cleared, ALL, 'SELECTED')).toBe('SELECTED');
    expect(pipelineStatusOf(rounds, cleared, ALL, 'REJECTED')).toBe('REJECTED_PERSONAL_INTERVIEW');
    // a call decision never revives a student who was rejected earlier
    expect(pipelineStatusOf(rounds, of({ apt: fail(1, 10) }), ALL, 'SELECTED')).toBe('REJECTED_APTITUDE');
  });

  it("follows HR's round order (position), not the order of the list", () => {
    const shuffled = [rounds[3]!, rounds[0]!, rounds[5]!, rounds[1]!, rounds[4]!, rounds[2]!];
    expect(pipelineStatusOf(shuffled, of({ apt: pass(8, 10), gd: pass(20, 30) }), ALL)).toBe('IN_TECHNICAL_ROUNDS');
    expect(pipelineStatusOf(shuffled, of({ apt: pass(8, 10), gd: fail(2, 30), sql: pass(20, 20) }), ALL)).toBe('REJECTED_MODULE2_ROUND');
  });
});

describe('settings and rubric validation', () => {
  it('a percentage rule needs its minimum; the percentage is a whole 1-100', () => {
    expect(pipelineSettingsSchema.safeParse({ stage2Rule: 'TOTAL_PERCENT' }).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse({ stage2Rule: 'BOTH', stage2MinPercent: 101 }).success).toBe(false);
    expect(pipelineSettingsSchema.safeParse({ stage2Rule: 'BOTH', stage2MinPercent: 60.5 }).success).toBe(false);
    expect(pipelineSettingsSchema.parse({ stage2Rule: 'ALL_ROUNDS_PASSED' })).toEqual({ stage2Rule: 'ALL_ROUNDS_PASSED', stage2MinPercent: null, rejectionEmails: true });
    expect(pipelineSettingsSchema.safeParse({ stage2Rule: 'ALL_ROUNDS_PASSED', extra: 1 }).success).toBe(false);
  });

  it('rubric parameters have distinct names and positive whole marks', () => {
    expect(saveRubricRequestSchema.safeParse({ parameters: [{ name: 'Communication', maxMarks: 10 }, { name: 'communication', maxMarks: 5 }] }).success).toBe(false);
    expect(saveRubricRequestSchema.safeParse({ parameters: [{ name: 'Content', maxMarks: 0 }] }).success).toBe(false);
    expect(saveRubricRequestSchema.safeParse({ parameters: [] }).success).toBe(true);
  });

  it('evaluator marks above a parameter’s max, unknown, missing or doubled parameters are refused (never clamped)', () => {
    const rubric = [
      { name: 'Communication', maxMarks: 10 },
      { name: 'Content', maxMarks: 10 },
      { name: 'Leadership', maxMarks: 5 },
      { name: 'Listening', maxMarks: 5 },
    ];
    const ok = [
      { parameter: 'Communication', marks: 8 },
      { parameter: 'content', marks: 7.5 },
      { parameter: 'Leadership', marks: 5 },
      { parameter: 'Listening', marks: 0 },
    ];
    expect(rubricScoreProblems(rubric, ok)).toEqual([]);
    expect(rubricScoreProblems(rubric, ok.map((s) => (s.parameter === 'Leadership' ? { ...s, marks: 6 } : s)))).toEqual(['Leadership: marks must be between 0 and 5.']);
    expect(rubricScoreProblems(rubric, ok.slice(0, 3))).toEqual(['Score "Listening".']);
    expect(rubricScoreProblems(rubric, [...ok, { parameter: 'Humour', marks: 1 }])).toEqual(['"Humour" is not a parameter of this rubric.']);
    expect(rubricScoreProblems(rubric, [...ok, { parameter: 'Content', marks: 1 }])).toEqual(['"Content" is scored twice.']);
  });
});
