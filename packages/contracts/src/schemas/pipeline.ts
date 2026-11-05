import { z } from 'zod';
import type { RoundOutcome } from './assessments';
import type { RoundType } from './rounds';

/**
 * Hiring pipeline rules (pipeline module), on top of each round's own pass rule:
 *   Stage 1 APTITUDE (aptitude / English tests) -> Stage 2 TECHNICAL_ROUNDS (DSA, SQL, GD in HR's order)
 *   -> Stage 3 TECH_INTERVIEW -> Stage 4 PERSONAL_INTERVIEW (HR call).
 * A student moves on only after passing; HR's round order (position) is always read from the job's rounds.
 */

export const pipelineStageSchema = z.enum(['APTITUDE', 'TECHNICAL_ROUNDS', 'TECH_INTERVIEW', 'PERSONAL_INTERVIEW', 'OTHER']);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

/** Which pipeline stage each round type belongs to. */
export const PIPELINE_STAGE_OF: Record<RoundType, PipelineStage> = {
  APTITUDE: 'APTITUDE',
  TECHNICAL_MCQ: 'APTITUDE',
  COMMUNICATION: 'APTITUDE',
  CODING: 'TECHNICAL_ROUNDS',
  SQL: 'TECHNICAL_ROUNDS',
  GROUP_DISCUSSION: 'TECHNICAL_ROUNDS',
  AI_INTERVIEW: 'TECH_INTERVIEW',
  TECHNICAL_INTERVIEW: 'TECH_INTERVIEW',
  HR_INTERVIEW: 'PERSONAL_INTERVIEW',
  CUSTOM: 'OTHER',
};

export const isTechnicalRound = (type: RoundType) => PIPELINE_STAGE_OF[type] === 'TECHNICAL_ROUNDS';

// ---------------------------------------------------------------- settings

export const stage2RuleSchema = z.enum(['ALL_ROUNDS_PASSED', 'TOTAL_PERCENT', 'BOTH']);
export type Stage2Rule = z.infer<typeof stage2RuleSchema>;

export const pipelineSettingsSchema = z
  .object({
    stage2Rule: stage2RuleSchema,
    /** TOTAL_PERCENT / BOTH: the share of the technical rounds' total marks a student must score (1-100). */
    stage2MinPercent: z.number().int('Use a whole number').min(1, 'At least 1%').max(100, 'At most 100%').nullable().default(null),
    /** false = no rejection email after a failed round; HR still sees the rejection on the dashboard. */
    rejectionEmails: z.boolean().default(true),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.stage2Rule !== 'ALL_ROUNDS_PASSED' && s.stage2MinPercent === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stage2MinPercent'], message: 'Enter the minimum total percentage.' });
    }
  });
export type PipelineSettingsInput = z.input<typeof pipelineSettingsSchema>;
export type PipelineSettings = z.output<typeof pipelineSettingsSchema>;

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = { stage2Rule: 'ALL_ROUNDS_PASSED', stage2MinPercent: null, rejectionEmails: true };

export interface PipelineSettingsView extends PipelineSettings {
  jobId: string;
  /** Frozen with the rounds once the first student started. */
  locked: boolean;
}

// ---------------------------------------------------------------- rubric (GD)

export const RUBRIC_LIMITS = { parametersMax: 12, nameMax: 60, maxMarksMax: 100, remarksMax: 1000 } as const;

export const rubricParameterSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the parameter').max(RUBRIC_LIMITS.nameMax),
    maxMarks: z.number().int('Use whole marks').min(1, 'At least 1 mark').max(RUBRIC_LIMITS.maxMarksMax),
  })
  .strict();
export type RubricParameter = z.infer<typeof rubricParameterSchema>;

export const saveRubricRequestSchema = z
  .object({
    /** Empty = no rubric (the AI's overall score is used, as before). */
    parameters: z
      .array(rubricParameterSchema)
      .max(RUBRIC_LIMITS.parametersMax)
      .superRefine((ps, ctx) => {
        const seen = new Set<string>();
        ps.forEach((p, i) => {
          const key = p.name.toLowerCase();
          if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'name'], message: 'Each parameter needs a different name.' });
          seen.add(key);
        });
      }),
  })
  .strict();

export interface RoundRubricView {
  roundId: string;
  parameters: RubricParameter[];
  totalMarks: number;
  locked: boolean;
}

/** HR's evaluator form: marks per rubric parameter. Out-of-range marks are refused (never clamped). */
export const rubricScoresRequestSchema = z
  .object({
    scores: z.array(z.object({ parameter: z.string().trim().min(1).max(RUBRIC_LIMITS.nameMax), marks: z.number().finite().min(0) }).strict()).min(1),
    remarks: z.string().trim().max(RUBRIC_LIMITS.remarksMax).default(''),
  })
  .strict();
export type RubricScoresRequest = z.infer<typeof rubricScoresRequestSchema>;

/** Problems with HR's scores against the rubric (empty = valid). Every parameter exactly once, 0..maxMarks. */
export function rubricScoreProblems(rubric: RubricParameter[], scores: { parameter: string; marks: number }[]): string[] {
  const problems: string[] = [];
  const byName = new Map(rubric.map((p) => [p.name.toLowerCase(), p]));
  const seen = new Set<string>();
  for (const s of scores) {
    const p = byName.get(s.parameter.toLowerCase());
    if (!p) {
      problems.push(`"${s.parameter}" is not a parameter of this rubric.`);
      continue;
    }
    if (seen.has(p.name.toLowerCase())) problems.push(`"${p.name}" is scored twice.`);
    seen.add(p.name.toLowerCase());
    if (s.marks < 0 || s.marks > p.maxMarks) problems.push(`${p.name}: marks must be between 0 and ${p.maxMarks}.`);
  }
  for (const p of rubric) if (!seen.has(p.name.toLowerCase())) problems.push(`Score "${p.name}".`);
  return problems;
}

export const rubricTotal = (rubric: Pick<RubricParameter, 'maxMarks'>[]) => rubric.reduce((sum, p) => sum + p.maxMarks, 0);

// ---------------------------------------------------------------- status

export const pipelineStatusSchema = z.enum([
  'NOT_STARTED',
  'IN_APTITUDE',
  'IN_TECHNICAL_ROUNDS',
  'IN_TECH_INTERVIEW',
  'IN_PERSONAL_INTERVIEW',
  'IN_OTHER_ROUND',
  'CLEARED',
  'SELECTED',
  'REJECTED_APTITUDE',
  'REJECTED_MODULE2_ROUND',
  'REJECTED_MODULE2_OVERALL',
  'REJECTED_TECH_INTERVIEW',
  'REJECTED_PERSONAL_INTERVIEW',
  'REJECTED_OTHER',
]);
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;

export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, string> = {
  NOT_STARTED: 'Not started',
  IN_APTITUDE: 'Aptitude',
  IN_TECHNICAL_ROUNDS: 'Technical rounds',
  IN_TECH_INTERVIEW: 'Technical interview',
  IN_PERSONAL_INTERVIEW: 'Personal interview',
  IN_OTHER_ROUND: 'In progress',
  CLEARED: 'Cleared all rounds',
  SELECTED: 'Selected',
  REJECTED_APTITUDE: 'Rejected: aptitude',
  REJECTED_MODULE2_ROUND: 'Rejected: technical round',
  REJECTED_MODULE2_OVERALL: 'Rejected: technical overall',
  REJECTED_TECH_INTERVIEW: 'Rejected: technical interview',
  REJECTED_PERSONAL_INTERVIEW: 'Rejected: personal interview',
  REJECTED_OTHER: 'Rejected',
};

export const isRejection = (s: PipelineStatus) => s.startsWith('REJECTED_');

/** What the pipeline rules need of a round and of a student's result in it. */
export interface PipelineRound {
  id: string;
  position: number;
  type: RoundType;
  /** HR skipped the round for the job: the pipeline rules leave it out (no result is ever expected in it). */
  skipped?: unknown;
}

/** Rounds that count for the pipeline: skipped ones left out. */
const counted = <R extends PipelineRound>(rounds: R[]): R[] => rounds.filter((r) => !r.skipped);
export interface PipelineResult {
  outcome: RoundOutcome;
  score: number | null;
  maxScore: number | null;
}

export interface Stage2Verdict {
  /** False until every technical round has a result (or one failed: then the round rule already rejected). */
  decided: boolean;
  passed: boolean;
  allRoundsPassed: boolean;
  scored: number;
  total: number;
  /** Rounded to 2 decimals; null when there is nothing scored yet. */
  percent: number | null;
}

const round2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/**
 * Stage 2 overall criterion over the technical rounds (DSA, SQL, GD). Total percent = marks scored / total marks
 * across them (each round's score in its own pass rule's unit, so MARKS rounds count their marks), x 100.
 * null when the job has no technical round.
 */
export function stage2Verdict(rounds: PipelineRound[], resultOf: (roundId: string) => PipelineResult | undefined, settings: PipelineSettings): Stage2Verdict | null {
  const tech = counted(rounds).filter((r) => isTechnicalRound(r.type));
  if (!tech.length) return null;
  const results = tech.map((r) => resultOf(r.id));
  const outcomes = results.map((r) => r?.outcome ?? 'NOT_ATTEMPTED');
  const scored = results.reduce((s, r) => s + (r?.score ?? 0), 0);
  const total = results.reduce((s, r) => s + (r?.maxScore ?? 0), 0);
  const percent = total > 0 ? round2((scored / total) * 100) : null;
  const allRoundsPassed = outcomes.every((o) => o === 'PASSED');
  const decided = outcomes.every((o) => o !== 'NOT_ATTEMPTED');
  const percentOk = percent !== null && percent >= (settings.stage2MinPercent ?? 0);
  const passed =
    settings.stage2Rule === 'ALL_ROUNDS_PASSED' ? allRoundsPassed : settings.stage2Rule === 'TOTAL_PERCENT' ? percentOk : allRoundsPassed && percentOk;
  return { decided, passed: decided && passed, allRoundsPassed, scored: round2(scored), total: round2(total), percent };
}

const REJECTED_AT: Record<PipelineStage, PipelineStatus> = {
  APTITUDE: 'REJECTED_APTITUDE',
  TECHNICAL_ROUNDS: 'REJECTED_MODULE2_ROUND',
  TECH_INTERVIEW: 'REJECTED_TECH_INTERVIEW',
  PERSONAL_INTERVIEW: 'REJECTED_PERSONAL_INTERVIEW',
  OTHER: 'REJECTED_OTHER',
};
const IN_STAGE: Record<PipelineStage, PipelineStatus> = {
  APTITUDE: 'IN_APTITUDE',
  TECHNICAL_ROUNDS: 'IN_TECHNICAL_ROUNDS',
  TECH_INTERVIEW: 'IN_TECH_INTERVIEW',
  PERSONAL_INTERVIEW: 'IN_PERSONAL_INTERVIEW',
  OTHER: 'IN_OTHER_ROUND',
};

/**
 * Where a student stands, from their round results (HR overrides included) and the job's pipeline settings.
 * Rounds are walked in HR's order: the first failed round rejects at its stage; a failed Stage 2 overall criterion
 * rejects as REJECTED_MODULE2_OVERALL; otherwise the student is in the stage of their first round without a result.
 * `piCall`: HR's personal-interview call decision (SELECTED / REJECTED) once the student reached that stage.
 */
export function pipelineStatusOf(
  rounds: PipelineRound[],
  resultOf: (roundId: string) => PipelineResult | undefined,
  settings: PipelineSettings,
  piCall?: 'SELECTED' | 'REJECTED' | null,
): PipelineStatus {
  const ordered = counted(rounds).sort((a, b) => a.position - b.position);
  const verdict = stage2Verdict(ordered, resultOf, settings);
  const lastTech = [...ordered].reverse().find((r) => isTechnicalRound(r.type));
  let any = false;
  for (const r of ordered) {
    const outcome = resultOf(r.id)?.outcome ?? 'NOT_ATTEMPTED';
    if (outcome === 'FAILED') return REJECTED_AT[PIPELINE_STAGE_OF[r.type]];
    if (outcome === 'NOT_ATTEMPTED') {
      if (PIPELINE_STAGE_OF[r.type] === 'PERSONAL_INTERVIEW' && piCall) return piCall === 'SELECTED' ? 'SELECTED' : 'REJECTED_PERSONAL_INTERVIEW';
      return any ? IN_STAGE[PIPELINE_STAGE_OF[r.type]] : 'NOT_STARTED';
    }
    any = true;
    if (lastTech && r.id === lastTech.id && verdict?.decided && !verdict.passed) return 'REJECTED_MODULE2_OVERALL';
  }
  if (!ordered.length) return 'NOT_STARTED';
  if (piCall) return piCall === 'SELECTED' ? 'SELECTED' : 'REJECTED_PERSONAL_INTERVIEW';
  return 'CLEARED';
}

/**
 * May a student be invited to `target`? Rounds after the last technical round need the Stage 2 overall criterion
 * passed (every earlier round passing is checked by the caller, as before).
 */
export function stage2GateAllows(rounds: PipelineRound[], target: Pick<PipelineRound, 'position'>, resultOf: (roundId: string) => PipelineResult | undefined, settings: PipelineSettings): boolean {
  const tech = counted(rounds).filter((r) => isTechnicalRound(r.type));
  if (!tech.length) return true;
  const lastTechPosition = Math.max(...tech.map((r) => r.position));
  if (target.position <= lastTechPosition) return true;
  const verdict = stage2Verdict(rounds, resultOf, settings);
  return !!verdict?.decided && verdict.passed;
}

// ---------------------------------------------------------------- HR views

export interface JobPipelineStatusRow {
  applicationId: string;
  status: PipelineStatus;
  stage2: Stage2Verdict | null;
}
export interface JobPipelineStatuses {
  jobId: string;
  settings: PipelineSettingsView;
  counts: Partial<Record<PipelineStatus, number>>;
  students: JobPipelineStatusRow[];
}

export const piCallStatusSchema = z.enum(['NOT_CALLED', 'CALLED', 'SCHEDULED', 'SELECTED', 'REJECTED']);
export type PiCallStatus = z.infer<typeof piCallStatusSchema>;
export const PI_CALL_STATUS_LABEL: Record<PiCallStatus, string> = {
  NOT_CALLED: 'Not called',
  CALLED: 'Called',
  SCHEDULED: 'Scheduled',
  SELECTED: 'Selected',
  REJECTED: 'Rejected',
};

export const piCallUpdateRequestSchema = z
  .object({ status: piCallStatusSchema, notes: z.string().trim().max(2000).default('') })
  .strict();

export interface PiCandidateRow {
  applicationId: string;
  name: string;
  email: string;
  phone: string;
  college: string;
  status: PipelineStatus;
  /** Score per round in HR's order (null = no result). */
  rounds: { roundId: string; name: string; type: RoundType; score: number | null; maxScore: number | null; outcome: RoundOutcome }[];
  aptitudePercent: number | null;
  stage2Percent: number | null;
  techInterview: { score: number | null; maxScore: number | null; remarks: string | null } | null;
  /** Share of all marks scored across every round with a result (sort key). */
  overallPercent: number | null;
  call: { status: PiCallStatus; notes: string; updatedByName: string | null; updatedAt: string | null };
}
export interface PiBoard {
  jobId: string;
  jobTitle: string;
  /** True when the job has an HR interview round; otherwise candidates who cleared every round are listed. */
  hasPersonalInterviewRound: boolean;
  candidates: PiCandidateRow[];
}
