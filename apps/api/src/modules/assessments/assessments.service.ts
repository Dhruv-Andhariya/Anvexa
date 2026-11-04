import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  describePassRule,
  overrideRoundResultRequestSchema,
  roundResultInputSchema,
  roundRunnerOf,
  type AssessmentJob,
  type AssessmentRoundSummary,
  type JobAssessments,
  type RoundOutcome,
  type SavedRound,
  type StudentAssessment,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { uuidv7 } from '../../common/uuidv7';
import { AuditService } from '../audit';
import { RoundModules, RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { AssessmentsStore, type ResultRow } from './assessments.store';
import { InvalidResultError, gradeResult, outcomeOf, stageOf } from './grading';

const isMissingTable = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2021';
const notReady = () =>
  apiError(HttpStatus.SERVICE_UNAVAILABLE, 'ROUNDS_NOT_READY', 'Assessment rounds are not set up on the server yet (its database migration has not been applied).');
const jobNotFound = () => apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
const studentNotFound = () => apiError(HttpStatus.NOT_FOUND, 'APPLICATION_NOT_FOUND', 'Student not found.');

/** What RoundResultsService.record() answers the round engine. */
export interface RecordedResult {
  resultId: string;
  outcome: RoundOutcome;
  systemPassed: boolean;
  score: number;
  maxScore: number;
  passMark: number;
}

/**
 * Assessment results. The round engine records one result per student per round (record); HR sees every student of a
 * job with their round results, opens one student's full review, and may override pass / fail with a reason.
 * Every read and write is scoped by the tenant id from the session (HR) or from the round engine's own lookup.
 */
@Injectable()
export class AssessmentsService {
  constructor(
    @Inject(AssessmentsStore) private readonly store: AssessmentsStore,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    /** Which round modules are connected ("run by" on the HR Assessments page). */
    @Optional() @Inject(RoundModules) private readonly modules: RoundModules = new RoundModules(),
  ) {}

  // ---------- round engine (teammate): in-process only, through index.ts ----------

  /**
   * Saves one student's result of one round. The round must belong to the student's job (same company) and the
   * job's rounds must be complete; the first result locks the rounds. Pass / fail is decided here (gradeResult).
   */
  async record(tenantId: string, input: unknown): Promise<RecordedResult> {
    const req = parseBody(roundResultInputSchema, input, 'INVALID_ROUND_RESULT', 'The round result is invalid.');
    return this.guard(async () => {
      const student = await this.store.getStudent(tenantId, req.applicationId);
      if (!student) throw studentNotFound();
      const config = await this.rounds.forRoundEngine(tenantId, student.jobId);
      const round = config?.rounds.find((r) => r.id === req.roundId);
      if (!config || !round) throw apiError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', "This round is not one of the student's job rounds.");
      if (config.status !== 'COMPLETE') throw apiError(HttpStatus.CONFLICT, 'ROUNDS_NOT_COMPLETE', 'The rounds of this job are not complete yet.');

      let graded;
      try {
        graded = gradeResult(round, req);
      } catch (err) {
        if (err instanceof InvalidResultError) {
          const e = apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'INVALID_ROUND_RESULT', err.message);
          (e.getResponse() as Record<string, unknown>).issues = err.problems.map((message) => ({ path: '', message }));
          throw e;
        }
        throw err;
      }
      if (!config.locked) await this.rounds.lockForAttempts(tenantId, student.jobId);

      const saved = await this.store.upsertResult(tenantId, uuidv7(), {
        applicationId: student.applicationId,
        jobId: student.jobId,
        roundId: round.id,
        passMode: round.passRule!.mode,
        ...graded,
        notes: req.notes,
        startedAt: req.startedAt ? new Date(req.startedAt) : null,
        submittedAt: req.submittedAt ? new Date(req.submittedAt) : new Date(),
      });
      await this.audit.record({
        tenantId,
        actorUserId: null,
        action: 'assessment.result_recorded',
        subjectType: 'application',
        subjectId: student.applicationId,
        metadata: { roundId: round.id, score: saved.score, maxScore: saved.maxScore, passMark: saved.passMark, systemPassed: saved.systemPassed },
      });
      return {
        resultId: saved.id,
        outcome: outcomeOf(saved),
        systemPassed: saved.systemPassed,
        score: saved.score,
        maxScore: saved.maxScore,
        passMark: saved.passMark,
      };
    });
  }

  // ---------- pipeline module (in-process, through index.ts) ----------

  /** Round results of a job or of one student, as stored (HR override included in `override`). */
  resultsFor(tenantId: string, where: { jobId: string } | { applicationId: string }) {
    return this.guard(() => this.store.listResults(tenantId, where));
  }

  /** The students of a job who reached the rounds (contact details included: HR views only). */
  studentsOf(tenantId: string, jobId: string) {
    return this.guard(() => this.store.listStudents(tenantId, jobId));
  }

  jobTitle(tenantId: string, jobId: string) {
    return this.guard(async () => (await this.store.getJob(tenantId, jobId))?.title ?? null);
  }

  // ---------- HR ----------

  async jobs(tenantId: string): Promise<AssessmentJob[]> {
    return this.guard(async () => {
      const jobs = await this.store.listJobs(tenantId);
      const ids = jobs.map((j) => j.id);
      const [configs, counts] = await Promise.all([this.rounds.listConfigs(tenantId, ids), this.store.countByJob(tenantId, ids)]);
      const configOf = new Map(configs.map((c) => [c.jobId, c]));
      // only the jobs HR set up assessment rounds for (draft or complete); other approved jobs have nothing to show
      return jobs.filter((j) => (configOf.get(j.id)?.rounds.length ?? 0) > 0).map((j) => ({
        jobId: j.id,
        title: j.title,
        roundsStatus: configOf.get(j.id)?.status ?? 'NOT_STARTED',
        roundCount: configOf.get(j.id)?.rounds.length ?? 0,
        students: counts.get(j.id)?.students ?? 0,
        resultsReceived: counts.get(j.id)?.results ?? 0,
      }));
    });
  }

  /** Every student who reached the rounds, with status and score per round, and pass / fail counts per round. */
  async job(tenantId: string, jobId: string): Promise<JobAssessments> {
    return this.guard(async () => {
      const job = await this.store.getJob(tenantId, jobId);
      if (!job) throw jobNotFound();
      const [config, students, results] = await Promise.all([
        this.rounds.forRoundEngine(tenantId, jobId),
        this.store.listStudents(tenantId, jobId),
        this.store.listResults(tenantId, { jobId }),
      ]);
      const rounds = config?.rounds ?? [];
      const resultOf = indexResults(results);
      const rows = students.map((s) => {
        const cells = rounds.map((r) => {
          const res = resultOf.get(`${s.applicationId}:${r.id}`);
          return {
            roundId: r.id,
            outcome: outcomeOf(res),
            score: res?.score ?? null,
            maxScore: res?.maxScore ?? null,
            passMark: res?.passMark ?? r.passRule?.value ?? null,
            overridden: !!res?.override,
            progress: res ? null : (s.roundProgress[r.id] ?? null),
          };
        });
        return {
          applicationId: s.applicationId,
          name: s.name,
          email: s.email,
          college: s.college,
          atsScore: s.ats?.score ?? null,
          aiScreening: s.aiScreening,
          stage: stageOf(cells.map((c) => c.outcome)),
          rounds: cells,
        };
      });
      return {
        jobId,
        jobTitle: job.title,
        roundsStatus: config?.status ?? 'NOT_STARTED',
        locked: config?.locked ?? false,
        rounds: rounds.map((r, i) => {
          const outcomes = rows.map((row) => row.rounds[i]!.outcome);
          return {
            ...summary(r, this.modules),
            counts: {
              passed: outcomes.filter((o) => o === 'PASSED').length,
              failed: outcomes.filter((o) => o === 'FAILED').length,
              notAttempted: outcomes.filter((o) => o === 'NOT_ATTEMPTED').length,
            },
          };
        }),
        students: rows,
      };
    });
  }

  /** One student's full review: resume score, voice screening flag, and every round with answers. */
  async student(tenantId: string, applicationId: string): Promise<StudentAssessment> {
    return this.guard(async () => {
      const s = await this.store.getStudent(tenantId, applicationId);
      if (!s) throw studentNotFound();
      const [job, config, results] = await Promise.all([
        this.store.getJob(tenantId, s.jobId),
        this.rounds.forRoundEngine(tenantId, s.jobId),
        this.store.listResults(tenantId, { applicationId }),
      ]);
      const resultOf = new Map(results.map((r) => [r.roundId, r]));
      const rounds = (config?.rounds ?? []).map((r) => roundReview(r, resultOf.get(r.id), this.modules));
      return {
        applicationId,
        jobId: s.jobId,
        jobTitle: job?.title ?? '',
        candidate: { name: s.name, email: s.email, phone: s.phone, college: s.college, degree: s.degree, branch: s.branch, graduationYear: s.graduationYear },
        stage: stageOf(rounds.map((r) => r.outcome)),
        resume: s.ats,
        hasVoiceScreening: s.hasVoiceScreening,
        rounds,
      };
    });
  }

  /** HR changes a student's pass / fail in one round (passed null = back to the system result). Audited. */
  async override(tenantId: string, applicationId: string, roundId: string, input: unknown, actor: Actor | null): Promise<StudentAssessment> {
    const req = parseBody(overrideRoundResultRequestSchema, input, 'INVALID_OVERRIDE', 'Write why you are changing the result.');
    await this.guard(async () => {
      const s = await this.store.getStudent(tenantId, applicationId);
      if (!s) throw studentNotFound();
      const saved = await this.store.setOverride(
        tenantId,
        applicationId,
        roundId,
        req.passed === null ? null : { passed: req.passed, reason: req.reason, byId: actor?.id ?? null, byName: actor?.name ?? null, at: new Date() },
      );
      if (!saved) throw apiError(HttpStatus.NOT_FOUND, 'RESULT_NOT_FOUND', 'This student has no result in that round yet.');
      await this.audit.record({
        tenantId,
        actorUserId: actor?.id ?? null,
        action: req.passed === null ? 'assessment.override_removed' : 'assessment.result_overridden',
        subjectType: 'application',
        subjectId: applicationId,
        metadata: { roundId, systemPassed: saved.systemPassed, passed: req.passed, reason: req.passed === null ? null : req.reason },
      });
    });
    return this.student(tenantId, applicationId);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (isMissingTable(err)) throw notReady();
      throw err;
    }
  }
}

const indexResults = (results: ResultRow[]) => new Map(results.map((r) => [`${r.applicationId}:${r.roundId}`, r]));

function summary(r: SavedRound, modules: RoundModules): Omit<AssessmentRoundSummary, 'counts'> {
  const runner = roundRunnerOf(r);
  return {
    id: r.id,
    position: r.position,
    type: r.type,
    name: r.name,
    description: r.description,
    timeLimitMinutes: r.timeLimitMinutes,
    passRule: r.passRule,
    passRuleText: r.passRule ? describePassRule(r.passRule, r.questions) : null,
    questionCount: r.totals.questions,
    totalMarks: r.totals.marks,
    runBy: runner.by,
    module: runner.by === 'MODULE' ? runner.module : null,
    moduleConnected: runner.by === 'MODULE' && modules.isConnected(runner.module),
  };
}

function roundReview(r: SavedRound, res: ResultRow | undefined, modules: RoundModules): StudentAssessment['rounds'][number] {
  const answerOf = new Map((res?.answers ?? []).map((a) => [a.questionId, a]));
  return {
    round: summary(r, modules),
    outcome: outcomeOf(res),
    systemPassed: res?.systemPassed ?? null,
    score: res?.score ?? null,
    maxScore: res?.maxScore ?? null,
    passMark: res?.passMark ?? r.passRule?.value ?? null,
    passMode: res?.passMode ?? r.passRule?.mode ?? null,
    notes: res?.notes ?? null,
    startedAt: res?.startedAt?.toISOString() ?? null,
    submittedAt: res?.submittedAt?.toISOString() ?? null,
    override: res?.override ? { passed: res.override.passed, reason: res.override.reason, by: res.override.byName, at: res.override.at.toISOString() } : null,
    answers: r.questions.map((q) => {
      const a = answerOf.get(q.id);
      return {
        questionId: q.id,
        position: q.position,
        kind: q.kind,
        text: q.text,
        options: q.options,
        correct: q.correct,
        modelAnswer: q.modelAnswer,
        marks: q.marks,
        difficulty: q.difficulty,
        answer: a?.answer ?? null,
        selected: a?.selected ?? [],
        answered: !!a && (a.answer !== null || a.selected.length > 0),
        isCorrect: a?.isCorrect ?? null,
        marksAwarded: a?.marksAwarded ?? null,
        feedback: a?.feedback ?? null,
      };
    }),
  };
}

