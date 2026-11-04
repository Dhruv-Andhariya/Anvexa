import {
  AI_INTERVIEW_LIMITS,
  AI_INTERVIEW_MINUTES,
  type AiInterviewEndReason,
  type AiInterviewQuestionKind,
  type AiInterviewSource,
  type SavedRound,
} from '@hireflow/contracts';

/**
 * Pure rules of the AI technical interview (no I/O): what an interview runs with, the server clock, and which question
 * comes next. The AI proposes the next question; these rules decide whether it may be asked, and supply a question of
 * the plan whenever the AI's proposal is missing or not allowed, so an interview never stalls on bad AI output.
 */

/** Copied onto the session at the first visit: later edits by HR never change an interview already opened. */
export interface InterviewConfig {
  roundName: string;
  durationMinutes: number;
  /** Before this, the interview never ends early (the AI may only conclude after it). */
  minMinutes: number;
  cameraRequired: boolean;
  /** HR's own questions for this round (asked as written; the expected answer is used only in the report). */
  hrQuestions: { id: string; text: string; topics: string[]; expectedAnswer: string | null }[];
  /** INTERVIEWER_SCORE pass rule: the AI's 0-100 score is scaled to maxScore. null = no rule yet. */
  passRule: { value: number; maxScore: number } | null;
}

export function configFromRound(round: SavedRound, cameraRequired: boolean): InterviewConfig {
  const requested = round.timeLimitMinutes ?? AI_INTERVIEW_MINUTES.default;
  const durationMinutes = Math.min(AI_INTERVIEW_MINUTES.max, Math.max(AI_INTERVIEW_MINUTES.min, requested));
  const rule = round.passRule;
  return {
    roundName: round.name,
    durationMinutes,
    minMinutes: Math.min(durationMinutes, Math.max(AI_INTERVIEW_MINUTES.min, Math.round(durationMinutes * 0.7))),
    cameraRequired,
    hrQuestions: round.questions
      .filter((q) => q.text.trim())
      .map((q) => ({ id: q.id, text: q.text.trim(), topics: q.topics, expectedAnswer: q.modelAnswer })),
    passRule: rule?.mode === 'INTERVIEWER_SCORE' && rule.maxScore ? { value: rule.value, maxScore: rule.maxScore } : null,
  };
}

/** A stored config (JSON) read back leniently: a damaged row must never break an interview. */
export function parseConfig(raw: unknown): InterviewConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<InterviewConfig>;
  const minutes = Number(c.durationMinutes);
  const durationMinutes = Number.isInteger(minutes) ? Math.min(AI_INTERVIEW_MINUTES.max, Math.max(AI_INTERVIEW_MINUTES.min, minutes)) : AI_INTERVIEW_MINUTES.default;
  return {
    roundName: typeof c.roundName === 'string' ? c.roundName : 'AI Technical Interview',
    durationMinutes,
    minMinutes: Number.isInteger(c.minMinutes) ? Math.min(durationMinutes, Math.max(1, c.minMinutes!)) : durationMinutes,
    cameraRequired: c.cameraRequired !== false,
    hrQuestions: Array.isArray(c.hrQuestions) ? c.hrQuestions.filter((q) => q && typeof q.text === 'string') : [],
    passRule: c.passRule && Number(c.passRule.maxScore) > 0 ? { value: Number(c.passRule.value), maxScore: Number(c.passRule.maxScore) } : null,
  };
}

// ---------------------------------------------------------------- the clock

export type Phase = 'CORE' | 'MAY_CONCLUDE' | 'FINAL' | 'OVER';

export interface ClockInput {
  startedAt: Date | null;
  pausedSeconds: number;
  pausedAt: Date | null;
}

export interface Clock {
  elapsedSeconds: number;
  remainingSeconds: number;
  /** Pause allowance left (device / connection problems). */
  pauseSecondsLeft: number;
  phase: Phase;
  /** Past the end + grace: no answer is accepted any more. */
  pastGrace: boolean;
}

/** In the last 90 seconds the interviewer asks at most one short last question. */
export const FINAL_SECONDS = 90;

/**
 * Interview time used = wall time since the start minus paused time, where only AI_INTERVIEW_LIMITS.maxPauseSeconds
 * of pausing counts in total (a longer pause runs the clock again, so an interview can never be stretched for long).
 */
export function clockOf(s: ClockInput, config: Pick<InterviewConfig, 'durationMinutes' | 'minMinutes'>, now: Date): Clock {
  const total = config.durationMinutes * 60;
  if (!s.startedAt) {
    return { elapsedSeconds: 0, remainingSeconds: total, pauseSecondsLeft: AI_INTERVIEW_LIMITS.maxPauseSeconds, phase: 'CORE', pastGrace: false };
  }
  const wall = Math.max(0, (now.getTime() - s.startedAt.getTime()) / 1000);
  const currentPause = s.pausedAt ? Math.max(0, (now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
  const paused = Math.min(AI_INTERVIEW_LIMITS.maxPauseSeconds, s.pausedSeconds + currentPause);
  const elapsed = Math.max(0, wall - paused);
  const remaining = total - elapsed;
  const phase: Phase = remaining <= 0 ? 'OVER' : remaining <= FINAL_SECONDS ? 'FINAL' : elapsed >= config.minMinutes * 60 ? 'MAY_CONCLUDE' : 'CORE';
  return {
    elapsedSeconds: Math.floor(elapsed),
    remainingSeconds: Math.max(0, Math.ceil(remaining)),
    pauseSecondsLeft: Math.max(0, Math.floor(AI_INTERVIEW_LIMITS.maxPauseSeconds - paused)),
    phase,
    pastGrace: remaining < -AI_INTERVIEW_LIMITS.graceSeconds,
  };
}

// ---------------------------------------------------------------- the plan

export interface PlanTopic {
  id: string;
  title: string;
  source: 'RESUME' | 'JOB' | 'SCENARIO' | 'HR';
  resumeRef: string | null;
  skill: string | null;
  goal: string;
  question: string;
  priority: number;
  /** HR topics: the round question it asks (its answer is then shown on the HR Assessments page). */
  hrQuestionId?: string | null;
}

export interface StoredPlan {
  topics: PlanTopic[];
  /** false = the AI planner was not available: the plan was built from the resume / job / HR questions by rule. */
  ai: boolean;
  model: string | null;
  promptVersion: string | null;
}

export function parsePlan(raw: unknown): StoredPlan | null {
  const p = raw as Partial<StoredPlan> | null;
  if (!p || !Array.isArray(p.topics)) return null;
  return { topics: p.topics.filter((t) => t && typeof t.id === 'string' && typeof t.question === 'string'), ai: p.ai !== false, model: p.model ?? null, promptVersion: p.promptVersion ?? null };
}

/** What the planner (and the fallback) may use from the resume. */
export interface ResumeFacts {
  skills: string[];
  projects: { title: string; technologies: string[] }[];
  experience: { organization: string; role: string }[];
}

/**
 * The plan when the AI planner is unavailable: grounded questions built from the resume, the job's must-have skills,
 * HR's questions and two practical scenarios. Generic in wording, but every resume question names a real resume item.
 */
export function fallbackPlan(config: InterviewConfig, resume: ResumeFacts | null, jobSkills: string[]): PlanTopic[] {
  const topics: Omit<PlanTopic, 'id'>[] = [];
  for (const p of (resume?.projects ?? []).slice(0, 3)) {
    topics.push({
      title: p.title.slice(0, 80),
      source: 'RESUME',
      resumeRef: p.title,
      skill: p.technologies[0] ?? null,
      goal: 'Explains what the project does, how it is built and their own part in it.',
      question: `Could you walk me through your project "${p.title}" - what it does, how it is built, and which part you worked on yourself?`,
      priority: 1,
    });
  }
  for (const e of (resume?.experience ?? []).slice(0, 1)) {
    topics.push({
      title: `${e.role || 'Work'} at ${e.organization}`.slice(0, 80),
      source: 'RESUME',
      resumeRef: e.organization,
      skill: null,
      goal: 'Describes concrete work and responsibilities.',
      question: `What did you work on at ${e.organization}, and what was a technical problem you solved there?`,
      priority: 2,
    });
  }
  for (const q of config.hrQuestions) {
    topics.push({ title: (q.topics.join(', ') || 'Question from the hiring team').slice(0, 80), source: 'HR', resumeRef: null, skill: null, goal: '', question: asQuestion(q.text), priority: 1, hrQuestionId: q.id });
  }
  for (const s of jobSkills.slice(0, 3)) {
    topics.push({
      title: s.slice(0, 80),
      source: 'JOB',
      resumeRef: null,
      skill: s,
      goal: `Shows practical understanding of ${s}.`,
      question: `This role uses ${s}. How have you used it, and what would you be careful about when using it in a real project?`,
      priority: 2,
    });
  }
  topics.push(
    {
      title: 'Slow API in production',
      source: 'SCENARIO',
      resumeRef: null,
      skill: 'Debugging',
      goal: 'Structured debugging: measure, isolate, fix.',
      question: 'Suppose an API you built suddenly becomes slow in production. How would you find out what is causing it?',
      priority: 2,
    },
    {
      title: 'Duplicate records',
      source: 'SCENARIO',
      resumeRef: null,
      skill: 'Data integrity',
      goal: 'Constraints, idempotency, race conditions.',
      question: 'Suppose the same record shows up twice in your database after users submit a form. How would you find the cause and prevent it?',
      priority: 3,
    },
  );
  return topics.map((t, i) => ({ ...t, id: `t${i + 1}` }));
}

/** HR questions in the AI's plan point back at the round question they ask (closest wording). */
export function linkHrQuestions(topics: PlanTopic[], hrQuestions: InterviewConfig['hrQuestions']): PlanTopic[] {
  const used = new Set<string>();
  return topics.map((t) => {
    if (t.source !== 'HR') return t;
    let best: { id: string; sim: number } | null = null;
    for (const q of hrQuestions) {
      if (used.has(q.id)) continue;
      const sim = similarity(t.question, q.text);
      if (!best || sim > best.sim) best = { id: q.id, sim };
    }
    if (!best || best.sim < 0.2) return { ...t, hrQuestionId: null };
    used.add(best.id);
    return { ...t, hrQuestionId: best.id };
  });
}

// ---------------------------------------------------------------- the next question

export interface Pending {
  kind: AiInterviewQuestionKind;
  source: AiInterviewSource;
  text: string;
  topicId: string | null;
  topic: string | null;
  resumeRef: string | null;
}

export interface Decision {
  /** null = not read (the AI's decision failed): stored as no label, never a guess. */
  reading: string | null;
  action: 'FOLLOW_UP' | 'CLARIFY' | 'NEXT_TOPIC' | 'CONCLUDE';
  question: string | null;
  topicId: string | null;
  newTopicTitle: string | null;
  newTopicSource: 'RESUME' | 'JOB' | 'SCENARIO' | 'HR' | null;
  newTopicResumeRef: string | null;
  coveredTopicIds: string[];
}

export interface NextInput {
  current: Pending;
  seq: number;
  followUpsOnTopic: number;
  coveredTopics: string[];
  plan: PlanTopic[];
  /** null: no AI decision (the greeting reply, or the AI part failed after the transcript). */
  decision: Decision | null;
  clock: Clock;
  /** The question just answered was already asked in the last 90 seconds (it was the one last question). */
  answeredInFinal: boolean;
  answeredTurns: number;
  askedQuestions: string[];
  closing: string;
}

export interface Next {
  pending: Pending;
  followUpsOnTopic: number;
  coveredTopics: string[];
  done: boolean;
  endedReason: AiInterviewEndReason | null;
}

/** Asked when the plan is used up before the minimum time (never repeated). */
export const EXTRA_QUESTIONS = [
  'Could you describe the hardest technical problem you have solved so far, and how you approached it?',
  'If you could rebuild one of your projects from scratch, what would you change in its design, and why?',
  'How do you test your code before you consider a feature finished?',
  'Suppose you join a team and find a part of the code that nobody understands any more. How would you approach working on it?',
];

export function nextQuestion(n: NextInput): Next {
  const close = (reason: AiInterviewEndReason): Next => ({
    pending: { kind: 'CLOSING', source: 'CLOSING', text: n.closing, topicId: null, topic: null, resumeRef: null },
    followUpsOnTopic: 0,
    coveredTopics: n.coveredTopics,
    done: true,
    endedReason: reason,
  });
  if (n.clock.phase === 'OVER' || (n.clock.phase === 'FINAL' && n.answeredInFinal)) return close('TIME_UP');
  if (n.answeredTurns >= AI_INTERVIEW_LIMITS.maxTurns) return close('MAX_TURNS');

  const d = n.decision;
  const covered = new Set([...n.coveredTopics, ...(d?.coveredTopicIds ?? [])]);
  const onTopic = n.current.topicId;
  const asked = n.askedQuestions;
  const fresh = (q: string | null) => (q && !asked.some((a) => similarity(a, q) >= 0.7) ? q : null);

  // deeper on the same topic, within the per-topic limit
  if (d && (d.action === 'FOLLOW_UP' || d.action === 'CLARIFY') && n.current.kind !== 'INTRO' && n.followUpsOnTopic < AI_INTERVIEW_LIMITS.followUpsPerTopic) {
    const q = fresh(d.question);
    if (q) {
      return {
        pending: { kind: d.action, source: 'FOLLOW_UP', text: q, topicId: onTopic, topic: n.current.topic, resumeRef: n.current.resumeRef },
        followUpsOnTopic: n.followUpsOnTopic + 1,
        coveredTopics: [...covered],
        done: false,
        endedReason: null,
      };
    }
  }
  if (onTopic && n.current.kind !== 'INTRO') covered.add(onTopic); // moving on covers the topic
  if (d?.action === 'CONCLUDE' && n.clock.phase !== 'CORE') return { ...close('AI_CONCLUDED'), coveredTopics: [...covered] };

  const moveTo = (p: Pending): Next => ({ pending: p, followUpsOnTopic: 0, coveredTopics: [...covered], done: false, endedReason: null });

  // the AI chose a planned topic (its wording, or the plan's)
  const chosen = d?.topicId ? n.plan.find((t) => t.id === d.topicId && !covered.has(t.id)) : undefined;
  if (chosen) return moveTo(fromTopic(chosen, fresh(d!.question) ?? chosen.question));
  // the AI chose a new grounded topic (the worker checked resume references)
  if (d?.action === 'NEXT_TOPIC' && !d.topicId && d.newTopicSource && fresh(d.question)) {
    return moveTo({ kind: 'MAIN', source: d.newTopicSource, text: d.question!, topicId: `x${n.seq}`, topic: d.newTopicTitle, resumeRef: d.newTopicResumeRef });
  }
  // otherwise: the highest-priority uncovered planned topic
  const planned = [...n.plan].filter((t) => !covered.has(t.id) && fresh(t.question)).sort((a, b) => a.priority - b.priority || order(a) - order(b));
  if (planned[0]) return moveTo(fromTopic(planned[0], planned[0].question));
  if (n.clock.phase !== 'CORE') return { ...close('AI_CONCLUDED'), coveredTopics: [...covered] };
  const extra = EXTRA_QUESTIONS.find((q) => fresh(q));
  if (extra) return moveTo({ kind: 'MAIN', source: 'JOB', text: extra, topicId: `x${n.seq}`, topic: 'General problem solving', resumeRef: null });
  return { ...close('AI_CONCLUDED'), coveredTopics: [...covered] };
}

function fromTopic(t: PlanTopic, text: string): Pending {
  return { kind: 'MAIN', source: t.source, text, topicId: t.id, topic: t.title, resumeRef: t.resumeRef };
}

const order = (t: PlanTopic) => Number(t.id.replace(/\D/g, '')) || 0;

// ---------------------------------------------------------------- words spoken by the interviewer

export function greeting(firstName: string, jobTitle: string, companyName: string, minutes: number): string {
  const name = firstName ? ` ${firstName}` : '';
  return (
    `Hello${name}, and welcome to your technical interview for the ${jobTitle} role at ${companyName}. ` +
    `I'm an AI interviewer. I've gone through your resume and the requirements of this role, so we'll talk about your projects, ` +
    `your technical knowledge, and a few practical problems - about ${minutes} minutes in total. ` +
    `Take your time with each answer and speak naturally. Are you ready to begin?`
  );
}

export function closingWords(firstName: string, companyName: string): string {
  const name = firstName ? `, ${firstName}` : '';
  return (
    `Thank you${name}. That brings us to the end of the interview. Your answers have been saved, ` +
    `and the hiring team at ${companyName} will review them and contact you about the next steps. Have a good day!`
  );
}

export function asQuestion(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.endsWith('?') ? t : `${t.replace(/[.!]+$/, '')}?`;
}

/** Word overlap of two questions (0..1): 0.7+ counts as the same question asked again. */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both);
}

/** Spellings for the transcriber: technical terms of this resume and job (deduplicated, at most 80). */
export function vocabulary(resume: ResumeFacts | null, jobSkills: string[]): string[] {
  const out = new Map<string, string>();
  for (const t of [...jobSkills, ...(resume?.skills ?? []), ...(resume?.projects ?? []).flatMap((p) => p.technologies)]) {
    const v = t.replace(/\s+/g, ' ').trim();
    if (v.length >= 2 && v.length <= 60 && !out.has(v.toLowerCase())) out.set(v.toLowerCase(), v);
  }
  return [...out.values()].slice(0, 80);
}

/** The AI's 0-100 score as the round's interviewer score (rounded to whole points out of maxScore). */
export function interviewerScore(overall: number | null, rule: InterviewConfig['passRule']): { score: number; maxScore: number; passMark: number } | null {
  if (!rule) return null;
  const score = overall === null ? 0 : Math.round((Math.min(100, Math.max(0, overall)) / 100) * rule.maxScore);
  return { score, maxScore: rule.maxScore, passMark: rule.value };
}
