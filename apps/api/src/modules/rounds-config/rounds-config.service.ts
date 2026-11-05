import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  FIXED_SCREENING_STEPS,
  ROUND_TYPES,
  TRUE_FALSE_OPTIONS,
  generateQuestionsRequestSchema,
  roundQuestionInputSchema,
  roundsCompletionProblems,
  saveRoundsRequestSchema,
  type GenerateQuestionsResult,
  type GeneratedQuestion,
  type JobRounds,
  type PassRule,
  type RoundConfig,
  type SavedRound,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { uuidv7 } from '../../common/uuidv7';
import { AuditService } from '../audit';
import type { Actor } from '../tenants';
import { QuestionGeneratorClient, QuestionGeneratorError, type QuestionJobFacts } from './question-generator.client';
import { RoundsConfigStore, RoundsLockedError, type StoredConfig, type StoredRound } from './rounds-config.store';

/** "Table does not exist": the rounds migration is not applied to this database yet (Prisma P2021). */
export const isMissingTable = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2021';

export const roundsNotReady = () =>
  apiError(HttpStatus.SERVICE_UNAVAILABLE, 'ROUNDS_NOT_READY', 'Assessment rounds are not set up on the server yet (its database migration has not been applied).');

const jobNotFound = () => apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
const roundsLocked = () =>
  apiError(HttpStatus.CONFLICT, 'ROUNDS_LOCKED', 'Students have started the assessment rounds of this job, so its rounds, questions and passing criteria can no longer change.');

/** A job's rounds as the round engine needs them: everything, including answers and pass rules. API-internal only. */
export interface RoundsForEngine {
  jobId: string;
  status: JobRounds['status'];
  locked: boolean;
  rounds: SavedRound[];
}

/**
 * M05 round configurator. HR picks a job's assessment rounds (after the fixed resume + AI voice screening), their
 * questions and passing criteria. Everything is stored per job and per company and stays private: only the round
 * names are handed to the publisher for the public "Selection process".
 */
@Injectable()
export class RoundsConfigService {
  private readonly logger = new Logger('RoundsConfig');

  constructor(
    @Inject(RoundsConfigStore) private readonly store: RoundsConfigStore,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(QuestionGeneratorClient) private readonly generator: QuestionGeneratorClient,
  ) {}

  async get(tenantId: string, jobId: string): Promise<JobRounds> {
    return this.guard(async () => {
      const job = await this.store.getJob(tenantId, jobId);
      if (!job) throw jobNotFound();
      return toView(jobId, job.title, await this.store.getConfig(tenantId, jobId));
    });
  }

  /** Saves every round of the job at once (draft or complete). Refused once students started (locked). */
  async save(tenantId: string, jobId: string, input: unknown, actor: Actor | null): Promise<JobRounds> {
    const req = parseBody(saveRoundsRequestSchema, input, 'INVALID_ROUNDS', 'Some rounds are not filled in correctly.');
    return this.guard(async () => {
      const job = await this.store.getJob(tenantId, jobId);
      if (!job) throw jobNotFound();
      const current = await this.store.getConfig(tenantId, jobId);
      if (current?.lockedAt) throw roundsLocked();

      const rounds = toStored(req.rounds, current);
      const status = req.complete ? 'COMPLETE' : 'DRAFT';
      let saved: StoredConfig;
      try {
        saved = await this.store.replace(tenantId, jobId, status, rounds, actor?.id ?? null);
      } catch (err) {
        if (err instanceof RoundsLockedError) throw roundsLocked();
        throw err;
      }
      await this.audit.record({
        tenantId,
        actorUserId: actor?.id ?? null,
        action: req.complete ? 'rounds.completed' : 'rounds.draft_saved',
        subjectType: 'job',
        subjectId: jobId,
        // Names and counts only: questions and pass marks stay out of the audit log too.
        metadata: { rounds: rounds.map((r) => r.name), questions: rounds.reduce((n, r) => n + r.questions.length, 0) },
      });
      return toView(jobId, job.title, saved);
    });
  }

  /** AI suggestions for one round. Nothing is saved: HR keeps the ones they pick and saves the rounds. */
  async generate(tenantId: string, jobId: string, input: unknown, actor: Actor | null): Promise<GenerateQuestionsResult> {
    const req = parseBody(generateQuestionsRequestSchema, input, 'INVALID_GENERATE_REQUEST', 'Check the number of questions, difficulty and topics.');
    const job = await this.guard(async () => {
      const found = await this.store.getJob(tenantId, jobId);
      if (!found) throw jobNotFound();
      if ((await this.store.getConfig(tenantId, jobId))?.lockedAt) throw roundsLocked();
      return found;
    });
    const kinds = req.kinds.length ? req.kinds : ROUND_TYPES[req.roundType].kinds;
    let raw;
    try {
      raw = await this.generator.generate({
        job: jobFacts(job.title, job.form, job.jd),
        round: { type: req.roundType, name: req.roundName, description: req.roundDescription },
        count: req.count,
        difficulty: req.difficulty,
        topics: req.topics,
        kinds,
        avoid: req.avoid,
      });
    } catch (err) {
      if (err instanceof QuestionGeneratorError) throw apiError(err.status, err.code, err.message);
      throw err;
    }

    const seen = new Set(req.avoid.map(normal));
    const questions: GeneratedQuestion[] = [];
    for (const q of raw.questions) {
      if (!kinds.includes(q.kind) || seen.has(normal(q.text))) continue;
      const checked = roundQuestionInputSchema.safeParse({
        ...q,
        options: q.kind === 'TRUE_FALSE' ? [...TRUE_FALSE_OPTIONS] : q.kind === 'MCQ' ? q.options : [],
        correct: q.kind === 'MCQ' || q.kind === 'TRUE_FALSE' ? q.correct : [],
        marks: Math.min(Math.max(q.marks, 1), 100),
        difficulty: q.difficulty ?? req.difficulty,
        topics: q.topics.slice(0, 10).map((t) => t.slice(0, 60)),
        source: 'AI',
      });
      if (!checked.success) continue;
      seen.add(normal(q.text));
      const { id: _id, coding: _coding, sql: _sql, ...question } = checked.data;
      questions.push({ ...question, source: 'AI' });
      if (questions.length === req.count) break;
    }
    await this.audit.record({
      tenantId,
      actorUserId: actor?.id ?? null,
      action: 'rounds.questions_generated',
      subjectType: 'job',
      subjectId: jobId,
      metadata: { roundType: req.roundType, asked: req.count, suggested: questions.length, model: raw.model, promptVersion: raw.promptVersion },
    });
    return { questions, dropped: raw.questions.length + raw.invalid - questions.length, model: raw.model, promptVersion: raw.promptVersion };
  }

  /** What the job is about (approved JD + HR's requirements), for AI authoring of a round's problems. 409 once locked. */
  async jobFactsFor(tenantId: string, jobId: string): Promise<QuestionJobFacts> {
    return this.guard(async () => {
      const found = await this.store.getJob(tenantId, jobId);
      if (!found) throw jobNotFound();
      if ((await this.store.getConfig(tenantId, jobId))?.lockedAt) throw roundsLocked();
      return jobFacts(found.title, found.form, found.jd);
    });
  }

  /**
   * For the publisher: the public "Selection process" of the job = its round NAMES in order, and whether the rounds
   * are complete. null when the rounds migration is not applied (publishing then works as before it existed).
   */
  async publicSteps(tenantId: string, jobId: string): Promise<{ complete: boolean; steps: string[] } | null> {
    try {
      const config = await this.store.getConfig(tenantId, jobId);
      // a round HR skipped is not part of the selection process students see
      return { complete: config?.status === 'COMPLETE', steps: config?.rounds.filter((r) => !r.skip).map((r) => r.name) ?? [] };
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      this.logger.warn('job_round_configs is missing (rounds migration not applied) - publish check skipped');
      return null;
    }
  }

  // ---------- round engine (teammate) API: in-process only, through index.ts ----------

  /** Every round of the job with questions, answers and pass rules, for running and grading the rounds. */
  async forRoundEngine(tenantId: string, jobId: string): Promise<RoundsForEngine | null> {
    const config = await this.store.getConfig(tenantId, jobId);
    if (!config) return null;
    const view = toView(jobId, '', config);
    return { jobId, status: view.status, locked: view.locked, rounds: view.rounds };
  }

  /**
   * Students started: from now on the rounds, questions and criteria are frozen. Safe to call many times (the first
   * time wins). Only COMPLETE rounds can be started.
   */
  async lockForAttempts(tenantId: string, jobId: string, at = new Date()): Promise<Date> {
    const config = await this.store.getConfig(tenantId, jobId);
    if (!config) throw jobNotFound();
    if (config.status !== 'COMPLETE') {
      throw apiError(HttpStatus.CONFLICT, 'ROUNDS_NOT_COMPLETE', 'The rounds of this job are not complete yet.');
    }
    const lockedAt = config.lockedAt ?? (await this.store.lock(tenantId, jobId, at));
    if (!lockedAt) throw jobNotFound();
    if (!config.lockedAt) {
      await this.audit.record({ tenantId, actorUserId: null, action: 'rounds.locked', subjectType: 'job', subjectId: jobId, metadata: {} });
    }
    return lockedAt;
  }

  /**
   * HR skips one round for the whole job (skip = { reason }) or brings it back (null). Works after the lock too: the
   * questions and pass rules stay exactly as they were. Moving the students who were waiting for the round is the
   * round engine's part (RoundSkipService); this only records the decision. Returns the round as it was before.
   */
  async setSkip(tenantId: string, jobId: string, roundId: string, skip: { reason: string } | null, actor: Actor | null): Promise<{ before: SavedRound; rounds: JobRounds }> {
    return this.guard(async () => {
      const job = await this.store.getJob(tenantId, jobId);
      if (!job) throw jobNotFound();
      const config = await this.store.getConfig(tenantId, jobId);
      const round = config?.rounds.find((r) => r.id === roundId);
      if (!config || !round) throw apiError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', 'Round not found. Save the rounds first.');
      if (skip && round.skip) throw apiError(HttpStatus.CONFLICT, 'ROUND_ALREADY_SKIPPED', 'This round is already skipped.');
      if (!skip && !round.skip) throw apiError(HttpStatus.CONFLICT, 'ROUND_NOT_SKIPPED', 'This round is not skipped.');
      await this.store.setSkip(tenantId, jobId, roundId, skip ? { at: new Date(), reason: skip.reason, byId: actor?.id ?? null } : null);
      await this.audit.record({
        tenantId,
        actorUserId: actor?.id ?? null,
        action: skip ? 'rounds.round_skipped' : 'rounds.round_unskipped',
        subjectType: 'job',
        subjectId: jobId,
        metadata: { roundId, roundName: round.name, ...(skip ? { reason: skip.reason } : {}) },
      });
      return { before: toSavedRound(round), rounds: toView(jobId, job.title, await this.store.getConfig(tenantId, jobId)) };
    });
  }

  /**
   * HR changes one round's passing criterion, also after students started (assessments module: it re-grades the
   * results first). Only the rule changes; questions and everything else stay frozen. Audited.
   */
  async setPassRule(tenantId: string, jobId: string, roundId: string, rule: PassRule, actor: Actor | null): Promise<void> {
    const ok = await this.guard(() => this.store.setPassRule(tenantId, jobId, roundId, { mode: rule.mode, value: rule.value, maxScore: (rule.mode === 'INTERVIEWER_SCORE' || rule.mode === 'MARKS') ? rule.maxScore : null }));
    if (!ok) throw apiError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', 'Round not found.');
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'rounds.pass_rule_changed', subjectType: 'job', subjectId: jobId, metadata: { roundId, ...rule } });
  }

  /** Configs of several jobs (assessments job list). */
  async listConfigs(tenantId: string, jobIds: string[]): Promise<StoredConfig[]> {
    return this.guard(() => this.store.listConfigs(tenantId, jobIds));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isMissingTable(err)) throw roundsNotReady();
      throw err;
    }
  }
}

/** Keeps the ids of rounds / questions that already belong to this job; everything else gets a new id. */
function toStored(rounds: RoundConfig[], current: StoredConfig | null): StoredRound[] {
  const roundIds = new Set(current?.rounds.map((r) => r.id));
  const skips = new Map(current?.rounds.map((r) => [r.id, r.skip ?? null]));
  const questionIds = new Set(current?.rounds.flatMap((r) => r.questions.map((q) => q.id)));
  const usedRounds = new Set<string>();
  const usedQuestions = new Set<string>();
  const keep = (id: string | undefined, known: Set<string>, used: Set<string>) => {
    const value = id && known.has(id) && !used.has(id) ? id : uuidv7();
    used.add(value);
    return value;
  };
  return rounds.map((r, i) => {
    const id = keep(r.id, roundIds, usedRounds);
    return {
    id,
    // HR's skip stays with the round when the rounds are saved again
    skip: skips.get(id) ?? null,
    position: i + 1,
    type: r.type,
    name: r.name,
    description: r.description,
    timeLimitMinutes: r.timeLimitMinutes,
    passMode: r.passRule?.mode ?? null,
    passValue: r.passRule?.value ?? null,
    passMaxScore: r.passRule?.mode === 'INTERVIEWER_SCORE' || r.passRule?.mode === 'MARKS' ? r.passRule.maxScore : null,
    questions: r.questions.map((q, j) => ({
      id: keep(q.id, questionIds, usedQuestions),
      position: j + 1,
      kind: q.kind,
      text: q.text,
      options: q.kind === 'TRUE_FALSE' ? [...TRUE_FALSE_OPTIONS] : q.kind === 'MCQ' ? q.options : [],
      correct: q.correct,
      modelAnswer: q.modelAnswer || null,
      language: q.kind === 'CODING' ? q.language || null : null,
      marks: q.marks,
      difficulty: q.difficulty,
      topics: q.topics,
      source: q.source,
      coding: q.kind === 'CODING' ? q.coding : null,
      sql: q.kind === 'CODING' ? q.sql : null,
    })),
    };
  });
}

export function passRuleOf(r: Pick<StoredRound, 'passMode' | 'passValue' | 'passMaxScore'>): PassRule | null {
  return r.passMode && r.passValue !== null ? { mode: r.passMode, value: r.passValue, maxScore: r.passMaxScore } : null;
}

export function toSavedRound(r: StoredRound): SavedRound {
  return {
    id: r.id,
    position: r.position,
    type: r.type,
    name: r.name,
    description: r.description,
    timeLimitMinutes: r.timeLimitMinutes,
    passRule: passRuleOf(r),
    questions: r.questions.map((q) => ({ ...q })),
    totals: { questions: r.questions.length, marks: r.questions.reduce((sum, q) => sum + q.marks, 0) },
    skipped: r.skip ? { at: r.skip.at.toISOString(), reason: r.skip.reason, byName: r.skip.byName } : null,
  };
}

function toView(jobId: string, jobTitle: string, config: StoredConfig | null): JobRounds {
  const rounds = config?.rounds.map(toSavedRound) ?? [];
  const status = config?.status ?? 'NOT_STARTED';
  return {
    jobId,
    jobTitle,
    status,
    locked: !!config?.lockedAt,
    lockedAt: config?.lockedAt?.toISOString() ?? null,
    updatedAt: config?.updatedAt.toISOString() ?? null,
    fixedSteps: [...FIXED_SCREENING_STEPS],
    rounds,
    problems: status === 'COMPLETE' ? [] : roundsCompletionProblems(rounds),
  };
}

function jobFacts(title: string, form: Record<string, unknown>, jd: Record<string, unknown> | null): QuestionJobFacts {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 40) : []);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    title: str(jd?.title) || str(form.title) || title,
    summary: str(jd?.summary).slice(0, 4000),
    responsibilities: list(jd?.responsibilities),
    requirements: list(jd?.requirements),
    niceToHave: list(jd?.niceToHave),
    mustHaveSkills: list(form.mustHaveSkills),
    niceToHaveSkills: list(form.niceToHaveSkills),
    experienceMin: num(form.experienceMin),
    experienceMax: num(form.experienceMax),
  };
}

const normal = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
