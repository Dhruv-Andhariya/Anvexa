import { z } from 'zod';
import { dsaBankEntry, dsaBankIdOf, dsaProblemSpecSchema, dsaSpecProblems, type DsaProblemSpec } from './dsa-bank';
import { SELECTION_PROCESS_LIMITS } from './publisher';
import { sqlProblemSpecSchema, sqlSpecProblems } from './sql-bank';

/**
 * M05 Round configurator contracts. Owner: rounds-config module (apps/api/src/modules/rounds-config).
 * Everything here is HR-only (and the round engine's, inside the API). Only the round NAMES ever leave the company:
 * they become the job's public "Selection process". Questions, answers, pass marks and time limits never do.
 */

export const ROUNDS_LIMITS = {
  roundsMax: SELECTION_PROCESS_LIMITS.stepsMax,
  nameMax: 80,
  descriptionMax: 1000,
  timeLimitMaxMinutes: 600,
  questionsMax: 100,
  questionTextMax: 4000,
  optionsMin: 2,
  optionsMax: 8,
  optionMax: 500,
  modelAnswerMax: 8000,
  marksMax: 100,
  topicsMax: 10,
  topicMax: 60,
  interviewerScoreMax: 100,
  /** "Marks" rounds: the total HR sets the round out of (student marks are scaled to it). */
  totalMarksMax: 100000,
  generateMax: 20,
} as const;

/** The steps every job has before its own rounds. Shown in the editor, never configurable, never in the post. */
export const FIXED_SCREENING_STEPS = ['Resume screening', 'AI voice screening'] as const;

export const roundTypeSchema = z.enum([
  'APTITUDE',
  'TECHNICAL_MCQ',
  'CODING',
  'SQL',
  'COMMUNICATION',
  'GROUP_DISCUSSION',
  'TECHNICAL_INTERVIEW',
  'HR_INTERVIEW',
  'CUSTOM',
  /** A voice interview run and scored by AI (like the AI voice screening, but a round of the job). */
  'AI_INTERVIEW',
]);
export type RoundType = z.infer<typeof roundTypeSchema>;

export const questionKindSchema = z.enum(['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'DESCRIPTIVE', 'CODING', 'INTERVIEW']);
export type QuestionKind = z.infer<typeof questionKindSchema>;

export const difficultySchema = z.enum(['EASY', 'MEDIUM', 'HARD']);
export type Difficulty = z.infer<typeof difficultySchema>;

/**
 * How a round is passed:
 *  - CORRECT_COUNT: at least `value` correct answers (value <= number of questions)
 *  - PERCENTAGE: at least `value` % of the round's total marks (1-100)
 *  - MARKS: at least `value` marks (value <= total marks of the questions)
 *  - INTERVIEWER_SCORE: the interviewer scores the student out of `maxScore`; at least `value` passes
 */
export const passModeSchema = z.enum(['CORRECT_COUNT', 'PERCENTAGE', 'MARKS', 'INTERVIEWER_SCORE']);
export type PassMode = z.infer<typeof passModeSchema>;

/** Labels and defaults per round type. `interview` rounds are scored by a person by default. */
export const ROUND_TYPES: Record<RoundType, { label: string; interview: boolean; kinds: QuestionKind[] }> = {
  APTITUDE: { label: 'Aptitude', interview: false, kinds: ['MCQ', 'TRUE_FALSE'] },
  TECHNICAL_MCQ: { label: 'Technical MCQ', interview: false, kinds: ['MCQ', 'TRUE_FALSE'] },
  CODING: { label: 'Coding', interview: false, kinds: ['CODING'] },
  SQL: { label: 'SQL', interview: false, kinds: ['CODING', 'MCQ', 'SHORT_ANSWER'] },
  COMMUNICATION: { label: 'Communication', interview: false, kinds: ['DESCRIPTIVE', 'SHORT_ANSWER'] },
  GROUP_DISCUSSION: { label: 'Group Discussion', interview: true, kinds: ['INTERVIEW'] },
  TECHNICAL_INTERVIEW: { label: 'Technical Interview', interview: true, kinds: ['INTERVIEW'] },
  HR_INTERVIEW: { label: 'HR Interview', interview: true, kinds: ['INTERVIEW'] },
  CUSTOM: { label: 'Custom round', interview: false, kinds: ['MCQ', 'SHORT_ANSWER', 'DESCRIPTIVE'] },
  AI_INTERVIEW: { label: 'AI Technical Interview', interview: true, kinds: ['INTERVIEW'] },
};

/**
 * Round modules: separate parts of ANVEXA that run a round themselves (their own candidate page) and send the result
 * and answers to the assessments module. A round whose questions are not a plain online test (round engine) goes to
 * the module of its type when that module is connected, else HR runs it.
 */
export const roundModuleSchema = z.enum(['GROUP_DISCUSSION', 'DSA', 'SQL', 'AI_INTERVIEW']);
export type RoundModule = z.infer<typeof roundModuleSchema>;

export const ROUND_MODULE_OF: Partial<Record<RoundType, RoundModule>> = {
  GROUP_DISCUSSION: 'GROUP_DISCUSSION',
  CODING: 'DSA',
  SQL: 'SQL',
  AI_INTERVIEW: 'AI_INTERVIEW',
};

export const ROUND_MODULE_LABEL: Record<RoundModule, string> = {
  GROUP_DISCUSSION: 'AI group discussion',
  DSA: 'DSA coding round',
  SQL: 'SQL round',
  AI_INTERVIEW: 'AI technical interview',
};

export const QUESTION_KINDS: Record<QuestionKind, { label: string; autoGraded: boolean }> = {
  MCQ: { label: 'Multiple choice', autoGraded: true },
  TRUE_FALSE: { label: 'True / false', autoGraded: true },
  SHORT_ANSWER: { label: 'Short answer', autoGraded: false },
  DESCRIPTIVE: { label: 'Descriptive', autoGraded: false },
  CODING: { label: 'Coding', autoGraded: false },
  INTERVIEW: { label: 'Interview question', autoGraded: false },
};

export const TRUE_FALSE_OPTIONS = ['True', 'False'] as const;

const text = (max: number, message = 'Required') => z.string().trim().min(1, message).max(max, `Use at most ${max} characters`);

/**
 * One question. `correct` holds the indexes of the right options (MCQ: one or more; TRUE_FALSE: 0 = True, 1 = False).
 * `modelAnswer` is the expected answer / rubric / reference solution for the other kinds (optional).
 */
export const roundQuestionInputSchema = z
  .object({
    /** Kept when the question already exists in this job's rounds; a new id is made otherwise. */
    id: z.string().uuid().optional(),
    kind: questionKindSchema,
    text: text(ROUNDS_LIMITS.questionTextMax, 'Write the question'),
    options: z.array(z.string().trim().max(ROUNDS_LIMITS.optionMax)).max(ROUNDS_LIMITS.optionsMax).default([]),
    correct: z.array(z.number().int().min(0)).max(ROUNDS_LIMITS.optionsMax).default([]),
    modelAnswer: z.string().trim().max(ROUNDS_LIMITS.modelAnswerMax).nullable().default(null),
    /** Coding questions: the language the student writes in (e.g. "Python", "SQL"). */
    language: z.string().trim().max(40).nullable().default(null),
    marks: z.number().int('Use a whole number').min(1, 'At least 1 mark').max(ROUNDS_LIMITS.marksMax).default(1),
    difficulty: difficultySchema.nullable().default(null),
    topics: z.array(z.string().trim().min(1).max(ROUNDS_LIMITS.topicMax)).max(ROUNDS_LIMITS.topicsMax).default([]),
    source: z.enum(['HR', 'AI']).default('HR'),
    /** Coding questions only: HR's own DSA problem (format, constraints, test cases), graded on the DSA page. */
    coding: dsaProblemSpecSchema.nullable().default(null),
    /** Coding questions only: a SQL problem copied from the SQL question bank, graded on the same coding page. */
    sql: sqlProblemSpecSchema.nullable().default(null),
  })
  .superRefine((q, ctx) => {
    for (const msg of questionProblems(q)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: msg });
  });
export type RoundQuestionInput = z.input<typeof roundQuestionInputSchema>;
export type RoundQuestion = z.output<typeof roundQuestionInputSchema>;

/** What is wrong with one question (empty = fine). Same text in the editor and in the API. */
export function questionProblems(
  q: Pick<RoundQuestion, 'kind' | 'options' | 'correct'> & {
    topics?: readonly string[];
    coding?: Pick<DsaProblemSpec, 'tests'> | null;
    sql?: { tests: readonly { hidden: boolean }[] } | null;
  },
): string[] {
  const problems: string[] = [];
  // a DSA problem marker (dsa:<id>) only makes sense on a coding question and must name a problem of the bank
  const bankId = dsaBankIdOf(q.topics ?? []);
  if (bankId !== null) {
    if (q.kind !== 'CODING') problems.push('A DSA problem can only be attached to a coding question.');
    else if (!dsaBankEntry(bankId)) problems.push('This DSA problem is not in the problem bank.');
  }
  if (q.coding) {
    if (q.kind !== 'CODING') problems.push('A DSA problem can only be attached to a coding question.');
    else if (bankId !== null) problems.push('Choose a bank problem or write your own, not both.');
    else problems.push(...dsaSpecProblems(q.coding));
  }
  if (q.sql) {
    if (q.kind !== 'CODING') problems.push('A SQL problem can only be attached to a coding question.');
    else if (bankId !== null || q.coding) problems.push('A question can have one problem only: a SQL problem, a DSA bank problem or your own.');
    else problems.push(...sqlSpecProblems(q.sql));
  }
  if (q.kind === 'MCQ') {
    const filled = q.options.filter((o) => o.trim()).length;
    if (filled !== q.options.length) problems.push('Fill in every option or remove the empty ones.');
    if (q.options.length < ROUNDS_LIMITS.optionsMin) problems.push(`Give at least ${ROUNDS_LIMITS.optionsMin} options.`);
    if (!q.correct.length) problems.push('Mark the correct option.');
    if (q.correct.some((i) => i >= q.options.length)) problems.push('A correct answer points to an option that does not exist.');
    if (new Set(q.correct).size !== q.correct.length) problems.push('An option is marked correct twice.');
  } else if (q.kind === 'TRUE_FALSE') {
    if (q.correct.length !== 1 || q.correct[0]! > 1) problems.push('Choose whether the answer is True or False.');
  } else if (q.correct.length) {
    problems.push('Only multiple choice and true / false questions have correct options.');
  }
  return problems;
}

export const passRuleSchema = z.object({
  mode: passModeSchema,
  value: z.number({ invalid_type_error: 'Enter the pass mark' }).int('Use a whole number').min(1, 'The pass mark must be at least 1'),
  /**
   * INTERVIEWER_SCORE: what the interviewer scores out of (e.g. 10, at most 100).
   * MARKS: the round's total as HR wants it (e.g. 50, 60, 1000); the student's marks are scaled to it. null = the
   * questions' own total.
   */
  maxScore: z.number({ invalid_type_error: 'Enter the total' }).int('Use a whole number').min(1, 'The total must be at least 1').max(ROUNDS_LIMITS.totalMarksMax).nullable().default(null),
});
export type PassRuleInput = z.input<typeof passRuleSchema>;

/** HR changes one round's passing criterion (also after the rounds were locked: only the rule changes). */
export const changePassRuleRequestSchema = z.object({ passRule: passRuleSchema }).strict();
export type PassRule = z.output<typeof passRuleSchema>;

export const roundInputSchema = z.object({
  /** Kept when the round already exists in this job; a new id is made otherwise. */
  id: z.string().uuid().optional(),
  type: roundTypeSchema,
  /** Shown to students (careers page, posts) as a selection process step. */
  name: text(ROUNDS_LIMITS.nameMax, 'Give the round a name'),
  description: z.string().trim().max(ROUNDS_LIMITS.descriptionMax).default(''),
  timeLimitMinutes: z.number().int('Use whole minutes').min(1, 'At least 1 minute').max(ROUNDS_LIMITS.timeLimitMaxMinutes).nullable().default(null),
  /** null = not chosen yet (allowed in a draft). */
  passRule: passRuleSchema.nullable().default(null),
  questions: z.array(roundQuestionInputSchema).max(ROUNDS_LIMITS.questionsMax).default([]),
});
export type RoundInput = z.input<typeof roundInputSchema>;
export type RoundConfig = z.output<typeof roundInputSchema>;

/** The highest pass mark a rule may have for these questions (null = the rule cannot be used yet). */
export function passMarkLimit(rule: Pick<PassRule, 'mode' | 'maxScore'>, questions: Pick<RoundQuestion, 'marks'>[]): number | null {
  switch (rule.mode) {
    case 'CORRECT_COUNT':
      return questions.length || null;
    case 'MARKS':
      return rule.maxScore ?? (questions.reduce((sum, q) => sum + q.marks, 0) || null);
    case 'PERCENTAGE':
      return 100;
    case 'INTERVIEWER_SCORE':
      return rule.maxScore;
  }
}

/** "8 of 10 correct", "60% of 40 marks"... for HR. */
export function describePassRule(rule: PassRule, questions: Pick<RoundQuestion, 'marks'>[]): string {
  const totalMarks = questions.reduce((sum, q) => sum + q.marks, 0);
  switch (rule.mode) {
    case 'CORRECT_COUNT':
      return `${rule.value} of ${questions.length} correct`;
    case 'MARKS':
      return `${rule.value} of ${rule.maxScore ?? totalMarks} marks`;
    case 'PERCENTAGE':
      return `${rule.value}% of ${totalMarks} marks`;
    case 'INTERVIEWER_SCORE':
      return `Interviewer score ${rule.value} of ${rule.maxScore ?? '?'}`;
  }
}

/** Problems with one round's pass rule (always enforced, even in a draft: the pass mark can never exceed the total). */
export function passRuleProblems(round: Pick<RoundConfig, 'passRule' | 'questions'>): string[] {
  const rule = round.passRule;
  if (!rule) return [];
  if (rule.mode === 'INTERVIEWER_SCORE') {
    if (!rule.maxScore) return ['Enter what the interviewer scores out of.'];
    if (rule.maxScore > ROUNDS_LIMITS.interviewerScoreMax) return [`An interviewer scores out of ${ROUNDS_LIMITS.interviewerScoreMax} at most.`];
    return rule.value > rule.maxScore ? [`The pass score cannot be more than ${rule.maxScore}.`] : [];
  }
  const limit = passMarkLimit(rule, round.questions);
  if (limit === null) return ['Add questions before using this pass rule.'];
  if (rule.value > limit) {
    if (rule.mode === 'MARKS') return [`The pass mark (${rule.value}) is more than the total (${limit}). Set the total in "out of" to ${rule.value} or more, or lower the pass mark.`];
    const unit = rule.mode === 'CORRECT_COUNT' ? `the ${limit} questions` : '100%';
    return [`The pass mark cannot be more than ${unit}.`];
  }
  return [];
}

/**
 * Everything that stops the rounds from being COMPLETE (empty = ready to publish). Pass rule limits are checked by
 * the schema at every save; this adds what a draft may still miss.
 */
export function roundsCompletionProblems(rounds: Pick<RoundConfig, 'name' | 'passRule' | 'questions'>[]): string[] {
  const problems: string[] = [];
  if (!rounds.length) problems.push('Add at least one assessment round.');
  rounds.forEach((r, i) => {
    const label = `Round ${i + 1} (${r.name || 'no name'})`;
    if (!r.passRule) problems.push(`${label}: choose the passing criterion.`);
    else if (r.passRule.mode !== 'INTERVIEWER_SCORE' && !r.questions.length) problems.push(`${label}: add at least one question.`);
    for (const p of passRuleProblems(r)) problems.push(`${label}: ${p}`);
  });
  return problems;
}

/** Interview length of an AI technical interview round (minutes): HR's time limit, or the default. */
export const AI_INTERVIEW_MINUTES = { min: 10, default: 20, max: 30 } as const;

/**
 * Extra rules of an AI technical interview round (the ai-interview module runs it): the time limit, when set, is the
 * interview length (10-30 minutes), and the AI's overall score is given as an interviewer score, so that is the only
 * pass rule it can use. Checked at every save, like the pass mark limits.
 */
export function aiInterviewRoundProblems(round: Pick<RoundConfig, 'type' | 'timeLimitMinutes' | 'passRule'>): { field: 'timeLimitMinutes' | 'passRule'; message: string }[] {
  if (round.type !== 'AI_INTERVIEW') return [];
  const problems: { field: 'timeLimitMinutes' | 'passRule'; message: string }[] = [];
  const t = round.timeLimitMinutes;
  if (t !== null && (t < AI_INTERVIEW_MINUTES.min || t > AI_INTERVIEW_MINUTES.max)) {
    problems.push({ field: 'timeLimitMinutes', message: `An AI technical interview lasts ${AI_INTERVIEW_MINUTES.min} to ${AI_INTERVIEW_MINUTES.max} minutes.` });
  }
  if (round.passRule && round.passRule.mode !== 'INTERVIEWER_SCORE') {
    problems.push({ field: 'passRule', message: 'An AI technical interview is passed by its interviewer score (the AI scores out of your maximum).' });
  }
  return problems;
}

/** PUT /api/v1/rounds/jobs/:jobId. complete = false saves a draft; true also requires roundsCompletionProblems() = []. */
export const saveRoundsRequestSchema = z
  .object({
    rounds: z.array(roundInputSchema).max(ROUNDS_LIMITS.roundsMax, `A job can have at most ${ROUNDS_LIMITS.roundsMax} rounds`),
    complete: z.boolean().default(false),
  })
  .superRefine((req, ctx) => {
    const names = new Set<string>();
    req.rounds.forEach((r, i) => {
      const key = r.name.trim().toLowerCase();
      if (names.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rounds', i, 'name'], message: `Two rounds are called "${r.name}".` });
      names.add(key);
      for (const msg of passRuleProblems(r)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rounds', i, 'passRule', 'value'], message: msg });
      for (const p of aiInterviewRoundProblems(r)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rounds', i, p.field], message: p.message });
    });
    if (req.complete) {
      for (const msg of roundsCompletionProblems(req.rounds)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rounds'], message: msg });
    }
  });
export type SaveRoundsRequest = z.input<typeof saveRoundsRequestSchema>;

export const roundsStatusSchema = z.enum(['NOT_STARTED', 'DRAFT', 'COMPLETE']);
export type RoundsStatus = z.infer<typeof roundsStatusSchema>;

/** A saved round as HR sees it: ids are always set, plus totals for the editor. */
export const savedRoundSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  type: roundTypeSchema,
  name: z.string(),
  description: z.string(),
  timeLimitMinutes: z.number().int().nullable(),
  passRule: passRuleSchema.nullable(),
  questions: z.array(
    z.object({
      id: z.string(),
      position: z.number().int(),
      kind: questionKindSchema,
      text: z.string(),
      options: z.array(z.string()),
      correct: z.array(z.number().int()),
      modelAnswer: z.string().nullable(),
      language: z.string().nullable(),
      marks: z.number().int(),
      difficulty: difficultySchema.nullable(),
      topics: z.array(z.string()),
      source: z.enum(['HR', 'AI']),
      /** HR's own DSA problem (coding questions only), hidden tests included: HR and the API only. */
      coding: dsaProblemSpecSchema.nullable(),
      /** SQL problem copied from the SQL bank (coding questions only), hidden datasets included: HR and the API only. */
      sql: sqlProblemSpecSchema.nullable(),
    }),
  ),
  totals: z.object({ questions: z.number().int(), marks: z.number().int() }),
  /**
   * HR skipped this round for the whole job (null / missing = it runs). Students who pass the round before it get
   * the next round that is not skipped; its questions and pass rule are kept, so "Undo skip" brings it back as it was.
   */
  skipped: z.object({ at: z.string(), reason: z.string(), byName: z.string().nullable() }).nullable().optional(),
});
export type SavedRound = z.infer<typeof savedRoundSchema>;

/** A round HR skipped for the job (see savedRoundSchema.skipped). */
export const isRoundSkipped = (r: { skipped?: unknown }): boolean => !!r.skipped;

/** The rounds that run, in HR's order (skipped ones left out). */
export const activeRounds = <R extends { position: number; skipped?: unknown }>(rounds: readonly R[]): R[] =>
  [...rounds].filter((r) => !isRoundSkipped(r)).sort((a, b) => a.position - b.position);

/** POST /api/v1/rounds/jobs/:jobId/rounds/:roundId/skip - HR's reason is required (audit log, Assessments page). */
export const skipRoundRequestSchema = z.object({
  reason: z.string().trim().min(3, 'Write why this round is skipped (at least 3 characters).').max(500),
});
export type SkipRoundRequest = z.infer<typeof skipRoundRequestSchema>;

/** What a skip / undo changed, for HR's confirmation message. */
export interface SkipRoundResult {
  rounds: JobRounds;
  /** Students moved on because they were waiting for the skipped round (unused link withdrawn / left the GD pool). */
  movedOn: number;
  /** Students in the middle of the skipped round: they finish it, then continue as usual. */
  inProgress: number;
}
export type SavedQuestion = SavedRound['questions'][number];

/** GET / PUT /api/v1/rounds/jobs/:jobId. HR only, same company. */
export const jobRoundsSchema = z.object({
  jobId: z.string(),
  jobTitle: z.string(),
  status: roundsStatusSchema,
  /** Students started the rounds: questions and criteria can no longer change. */
  locked: z.boolean(),
  lockedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  fixedSteps: z.array(z.string()),
  rounds: z.array(savedRoundSchema),
  /** What is still missing before the job can be published (empty when COMPLETE). */
  problems: z.array(z.string()),
});
export type JobRounds = z.infer<typeof jobRoundsSchema>;

/** POST /api/v1/rounds/jobs/:jobId/generate - AI suggestions for one round. Nothing is saved. */
export const generateQuestionsRequestSchema = z.object({
  roundType: roundTypeSchema,
  roundName: text(ROUNDS_LIMITS.nameMax),
  roundDescription: z.string().trim().max(ROUNDS_LIMITS.descriptionMax).default(''),
  count: z.number().int().min(1, 'Ask for at least 1 question').max(ROUNDS_LIMITS.generateMax, `At most ${ROUNDS_LIMITS.generateMax} at a time`),
  difficulty: difficultySchema,
  topics: z.array(z.string().trim().min(1).max(ROUNDS_LIMITS.topicMax)).max(ROUNDS_LIMITS.topicsMax).default([]),
  /** Which question types to write; empty = the round type's usual ones. */
  kinds: z.array(questionKindSchema).max(6).default([]),
  /** Questions already in the round, so the AI does not repeat them. */
  avoid: z.array(z.string().max(ROUNDS_LIMITS.questionTextMax)).max(ROUNDS_LIMITS.questionsMax).default([]),
});
export type GenerateQuestionsRequest = z.input<typeof generateQuestionsRequestSchema>;

/** A suggested question: same shape as one HR writes, source "AI". HR keeps only the ones they pick. */
export const generatedQuestionSchema = z.object({
  kind: questionKindSchema,
  text: z.string(),
  options: z.array(z.string()),
  correct: z.array(z.number().int()),
  modelAnswer: z.string().nullable(),
  language: z.string().nullable(),
  marks: z.number().int(),
  difficulty: difficultySchema.nullable(),
  topics: z.array(z.string()),
  source: z.literal('AI'),
});
export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export const generateQuestionsResultSchema = z.object({
  questions: z.array(generatedQuestionSchema),
  /** Suggestions the AI wrote that were dropped (broken options, duplicates...). */
  dropped: z.number().int(),
  model: z.string(),
  promptVersion: z.string(),
});
export type GenerateQuestionsResult = z.infer<typeof generateQuestionsResultSchema>;
