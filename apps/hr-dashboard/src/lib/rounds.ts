import {
  QUESTION_KINDS,
  ROUND_TYPES,
  TRUE_FALSE_OPTIONS,
  passMarkLimit,
  saveRoundsRequestSchema,
  type Difficulty,
  type GeneratedQuestion,
  type PassMode,
  type QuestionKind,
  type RoundType,
  type SaveRoundsRequest,
  type SavedRound,
} from '@hireflow/contracts';

/**
 * The rounds editor's own state (form-friendly: numbers are strings while HR types) and its conversion to the shared
 * contract. Validation is the contract's schema itself, so the editor shows exactly the API's rules.
 */
export interface QuestionDraft {
  key: string;
  id?: string;
  kind: QuestionKind;
  text: string;
  options: string[];
  correct: number[];
  modelAnswer: string;
  language: string;
  marks: string;
  difficulty: Difficulty | null;
  topics: string[];
  source: 'HR' | 'AI';
}

export interface RoundDraft {
  key: string;
  id?: string;
  type: RoundType;
  name: string;
  description: string;
  timeLimitMinutes: string;
  passMode: PassMode | '';
  passValue: string;
  passMaxScore: string;
  questions: QuestionDraft[];
}

let seq = 0;
const key = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

export const PASS_MODES: { mode: PassMode; label: string }[] = [
  { mode: 'CORRECT_COUNT', label: 'Number of correct answers' },
  { mode: 'PERCENTAGE', label: 'Percentage of marks' },
  { mode: 'MARKS', label: 'Marks' },
  { mode: 'INTERVIEWER_SCORE', label: 'Interviewer score' },
];

export function newQuestion(kind: QuestionKind): QuestionDraft {
  return {
    key: key(),
    kind,
    text: '',
    options: kind === 'MCQ' ? ['', '', '', ''] : kind === 'TRUE_FALSE' ? [...TRUE_FALSE_OPTIONS] : [],
    correct: [],
    modelAnswer: '',
    language: kind === 'CODING' ? 'Python' : '',
    marks: QUESTION_KINDS[kind].autoGraded ? '1' : '5',
    difficulty: null,
    topics: [],
    source: 'HR',
  };
}

/** A new round with sensible defaults: interviews are scored by the interviewer out of 10. */
export function newRound(type: RoundType, name?: string): RoundDraft {
  const interview = ROUND_TYPES[type].interview;
  return {
    key: key(),
    type,
    // a custom round has no name until HR gives it one
    name: name ?? (type === 'CUSTOM' ? '' : ROUND_TYPES[type].label),
    description: '',
    timeLimitMinutes: '',
    passMode: interview ? 'INTERVIEWER_SCORE' : '',
    passValue: '',
    passMaxScore: interview ? '10' : '',
    questions: [],
  };
}

export function fromSaved(rounds: SavedRound[]): RoundDraft[] {
  return rounds.map((r) => ({
    key: r.id,
    id: r.id,
    type: r.type,
    name: r.name,
    description: r.description,
    timeLimitMinutes: r.timeLimitMinutes?.toString() ?? '',
    passMode: r.passRule?.mode ?? '',
    passValue: r.passRule?.value.toString() ?? '',
    passMaxScore: r.passRule?.maxScore?.toString() ?? '',
    questions: r.questions.map((q) => ({
      key: q.id,
      id: q.id,
      kind: q.kind,
      text: q.text,
      options: q.options,
      correct: q.correct,
      modelAnswer: q.modelAnswer ?? '',
      language: q.language ?? '',
      marks: q.marks.toString(),
      difficulty: q.difficulty,
      topics: q.topics,
      source: q.source,
    })),
  }));
}

export function fromGenerated(q: GeneratedQuestion): QuestionDraft {
  return {
    key: key(),
    kind: q.kind,
    text: q.text,
    options: q.options,
    correct: q.correct,
    modelAnswer: q.modelAnswer ?? '',
    language: q.language ?? '',
    marks: q.marks.toString(),
    difficulty: q.difficulty,
    topics: q.topics,
    source: 'AI',
  };
}

const GUESSES: [RegExp, RoundType][] = [
  [/ap+ti/i, 'APTITUDE'], // also "Apptitude"
  [/\bsql\b/i, 'SQL'],
  [/group\s*discussion|\bgd\b/i, 'GROUP_DISCUSSION'],
  [/technical\s*interview|tech\s*interview/i, 'TECHNICAL_INTERVIEW'],
  [/\bhr\b|personal\s*interview|\bpi\b/i, 'HR_INTERVIEW'],
  [/interview/i, 'TECHNICAL_INTERVIEW'],
  [/coding|programming|\bdsa\b/i, 'CODING'],
  [/mcq/i, 'TECHNICAL_MCQ'],
  [/communication|english|verbal/i, 'COMMUNICATION'],
];

/** Jobs published before rounds existed: the typed steps become a first draft (HR still adds questions). */
export function fromTypedSteps(steps: string[]): RoundDraft[] {
  return steps
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((name) => newRound(GUESSES.find(([re]) => re.test(name))?.[1] ?? 'CUSTOM', name.slice(0, 80)));
}

const int = (s: string) => (s.trim() === '' ? null : Number(s));

/** The API request for these drafts. Empty number fields become null, so the schema reports them clearly. */
export function toRequest(drafts: RoundDraft[], complete: boolean): SaveRoundsRequest {
  return {
    complete,
    rounds: drafts.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      type: r.type,
      name: r.name,
      description: r.description,
      timeLimitMinutes: int(r.timeLimitMinutes),
      passRule: r.passMode
        ? { mode: r.passMode, value: int(r.passValue) as number, maxScore: r.passMode === 'INTERVIEWER_SCORE' ? int(r.passMaxScore) : null }
        : null,
      questions: r.questions.map((q) => ({
        ...(q.id ? { id: q.id } : {}),
        kind: q.kind,
        text: q.text,
        options: q.kind === 'MCQ' ? q.options : [],
        correct: q.kind === 'MCQ' || q.kind === 'TRUE_FALSE' ? q.correct : [],
        modelAnswer: q.modelAnswer.trim() || null,
        language: q.kind === 'CODING' ? q.language.trim() || null : null,
        marks: int(q.marks) as number,
        difficulty: q.difficulty,
        topics: q.topics,
        source: q.source,
      })),
    })),
  };
}

export interface Validation {
  ok: boolean;
  /** Checked as complete rounds (publishing) or as a draft. */
  complete: boolean;
  /** Messages per field path, e.g. "rounds.0.passRule.value" or "rounds.1.questions.2". */
  fields: Record<string, string[]>;
  /** Messages for the whole list (what is still missing). */
  general: string[];
}

/** Checks the drafts with the API's own schema. complete = true also lists what is missing for publishing. */
export function validate(drafts: RoundDraft[], complete: boolean): Validation {
  const parsed = saveRoundsRequestSchema.safeParse(toRequest(drafts, complete));
  if (parsed.success) return { ok: true, complete, fields: {}, general: [] };
  const fields: Record<string, string[]> = {};
  const general: string[] = [];
  for (const issue of parsed.error.issues) {
    // the number fields arrive as null when empty: say so plainly
    const message = issue.code === 'invalid_type' && issue.received === 'null' ? 'Required' : issue.code === 'invalid_type' && issue.received === 'nan' ? 'Enter a number' : issue.message;
    if (issue.path.length <= 1) {
      general.push(message);
      continue;
    }
    // questions.N.<field> issues are shown on the question; deeper paths (options.2) on their field
    const path = issue.path.slice(0, issue.path[2] === 'questions' ? 5 : 4).join('.');
    (fields[path] ??= []).push(message);
  }
  return { ok: false, complete, fields: dedupe(fields), general: [...new Set(general)] };
}

const dedupe = (f: Record<string, string[]>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, [...new Set(v)]]));

/** All messages of a round or question (path prefix), for the summary next to it. */
export const messagesUnder = (v: Validation, prefix: string) =>
  Object.entries(v.fields)
    .filter(([path]) => path === prefix || path.startsWith(`${prefix}.`))
    .flatMap(([, m]) => m);

export function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** "out of 10 questions", "out of 40 marks"... next to the pass mark field. */
export function passMarkHint(r: RoundDraft): string {
  if (!r.passMode) return '';
  const marks = r.questions.map((q) => ({ marks: Number(q.marks) || 0 }));
  const limit = passMarkLimit({ mode: r.passMode, maxScore: int(r.passMaxScore) }, marks);
  switch (r.passMode) {
    case 'CORRECT_COUNT':
      return limit ? `out of ${limit} question${limit === 1 ? '' : 's'}` : 'add questions first';
    case 'MARKS':
      return limit ? `out of ${limit} marks` : 'add questions first';
    case 'PERCENTAGE':
      return '% of the total marks';
    case 'INTERVIEWER_SCORE':
      return limit ? `out of ${limit}` : 'set the maximum score';
  }
}

/** After a save the server gives ids; keep the editor's keys (same order) so open rounds stay open. */
export function keepKeys(saved: RoundDraft[], previous: RoundDraft[]): RoundDraft[] {
  return saved.map((r, i) => {
    const before = previous[i];
    if (!before) return r;
    return { ...r, key: before.key, questions: r.questions.map((q, j) => ({ ...q, key: before.questions[j]?.key ?? q.key })) };
  });
}
