import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_PIPELINE_SETTINGS,
  PIPELINE_STAGE_OF,
  isTechnicalRound,
  piCallUpdateRequestSchema,
  pipelineSettingsSchema,
  pipelineStatusOf,
  rubricScoreProblems,
  rubricTotal,
  saveRubricRequestSchema,
  stage2GateAllows,
  stage2Verdict,
  type JobPipelineStatuses,
  type PiBoard,
  type PiCandidateRow,
  type PipelineResult,
  type PipelineSettings,
  type PipelineSettingsView,
  type PipelineStatus,
  type RoundRubricView,
  type RubricParameter,
  type SavedRound,
  type Stage2Verdict,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { AssessmentsService } from '../assessments';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { PipelineStore, type PiCallRow } from './pipeline.store';

type ResultRows = Awaited<ReturnType<AssessmentsService['resultsFor']>>;

const isMissingTable = (err: unknown) => (err as { code?: unknown } | null)?.code === 'P2021';
const jobNotFound = () => apiError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'Job not found.');
const locked = () =>
  apiError(HttpStatus.CONFLICT, 'PIPELINE_LOCKED', 'Students have started this job’s rounds, so its pipeline rules can no longer change.');

const toResult = (r: ResultRows[number]): PipelineResult => ({
  outcome: (r.override?.passed ?? r.systemPassed) ? 'PASSED' : 'FAILED',
  score: r.score,
  maxScore: r.maxScore,
});
const percentOf = (rows: (ResultRows[number] | undefined)[]) => {
  const got = rows.filter((r): r is ResultRows[number] => !!r);
  const max = got.reduce((s, r) => s + r.maxScore, 0);
  return max > 0 ? Math.floor((got.reduce((s, r) => s + r.score, 0) / max) * 10000) / 100 : null;
};

/** Statuses of a student who is at (or past) the personal interview, i.e. listed in that section. */
const AT_PI: PipelineStatus[] = ['IN_PERSONAL_INTERVIEW', 'SELECTED', 'REJECTED_PERSONAL_INTERVIEW'];

/**
 * Hiring pipeline rules on top of the rounds' own pass rules (contracts `pipeline.ts` holds the pure rules):
 * the Stage 2 overall criterion, rejection emails on / off, HR's GD rubric, every student's pipeline status and the
 * personal-interview (HR call) section. The round engine and the GD module ask it before moving a student on.
 */
@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);

  constructor(
    @Inject(PipelineStore) private readonly store: PipelineStore,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AssessmentsService) private readonly assessments: AssessmentsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- settings

  /** The job's settings, or the defaults (also when the migration is not applied yet: the old behaviour). */
  async settings(tenantId: string, jobId: string): Promise<PipelineSettings> {
    try {
      return (await this.store.getSettings(tenantId, jobId)) ?? DEFAULT_PIPELINE_SETTINGS;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      this.logger.warn('job_pipeline_settings is missing (pipeline migration not applied) - defaults used');
      return DEFAULT_PIPELINE_SETTINGS;
    }
  }

  async settingsView(tenantId: string, jobId: string): Promise<PipelineSettingsView> {
    const config = await this.rounds.forRoundEngine(tenantId, jobId);
    return { jobId, ...(await this.settings(tenantId, jobId)), locked: config?.locked ?? false };
  }

  async saveSettings(tenantId: string, jobId: string, body: unknown, actor: Actor | null): Promise<PipelineSettingsView> {
    const s = parseBody(pipelineSettingsSchema, body, 'INVALID_PIPELINE_SETTINGS', 'Check the pipeline rules.');
    const config = await this.rounds.forRoundEngine(tenantId, jobId);
    if (!config) throw apiError(HttpStatus.NOT_FOUND, 'ROUNDS_NOT_FOUND', 'Save the job’s rounds first.');
    if (config.locked) throw locked();
    const settings: PipelineSettings = { ...s, stage2MinPercent: s.stage2Rule === 'ALL_ROUNDS_PASSED' ? null : s.stage2MinPercent };
    await this.store.saveSettings(tenantId, jobId, settings, actor?.id ?? null);
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'pipeline.settings_saved', subjectType: 'job', subjectId: jobId, metadata: { ...settings } });
    return { jobId, ...settings, locked: false };
  }

  // ---------------------------------------------------------------- rubric (GD)

  /** HR's rubric of a round (null = none: the GD uses the AI's overall score, as before). */
  async rubricOf(tenantId: string, roundId: string): Promise<RubricParameter[] | null> {
    try {
      const r = await this.store.getRubric(tenantId, roundId);
      return r && r.length ? r : null;
    } catch (err) {
      if (isMissingTable(err)) return null;
      throw err;
    }
  }

  async rubricView(tenantId: string, jobId: string, roundId: string): Promise<RoundRubricView> {
    const { config } = await this.gdRound(tenantId, jobId, roundId);
    const parameters = (await this.rubricOf(tenantId, roundId)) ?? [];
    return { roundId, parameters, totalMarks: rubricTotal(parameters), locked: config.locked };
  }

  async saveRubric(tenantId: string, jobId: string, roundId: string, body: unknown, actor: Actor | null): Promise<RoundRubricView> {
    const { parameters } = parseBody(saveRubricRequestSchema, body, 'INVALID_RUBRIC', 'Check the rubric.');
    const { config } = await this.gdRound(tenantId, jobId, roundId);
    if (config.locked) throw locked();
    if (parameters.length) await this.store.saveRubric(tenantId, jobId, roundId, parameters, actor?.id ?? null);
    else await this.store.deleteRubric(tenantId, roundId);
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'pipeline.rubric_saved', subjectType: 'job', subjectId: jobId, metadata: { roundId, parameters: parameters.length, totalMarks: rubricTotal(parameters) } });
    return { roundId, parameters, totalMarks: rubricTotal(parameters), locked: false };
  }

  /** Validates HR's marks against the round's rubric: 400 RUBRIC_SCORES_INVALID with every problem (never clamped). */
  checkRubricScores(rubric: RubricParameter[], scores: { parameter: string; marks: number }[]) {
    const problems = rubricScoreProblems(rubric, scores);
    if (problems.length) {
      const err = apiError(HttpStatus.BAD_REQUEST, 'RUBRIC_SCORES_INVALID', problems[0]!);
      (err.getResponse() as Record<string, unknown>).issues = problems.map((message) => ({ path: 'scores', message }));
      throw err;
    }
  }

  private async gdRound(tenantId: string, jobId: string, roundId: string) {
    const config = await this.rounds.forRoundEngine(tenantId, jobId);
    if (!config) throw jobNotFound();
    const round = config.rounds.find((r) => r.id === roundId);
    if (!round) throw apiError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', 'Round not found. Save the rounds first.');
    if (round.type !== 'GROUP_DISCUSSION') throw apiError(HttpStatus.CONFLICT, 'RUBRIC_NOT_FOR_ROUND', 'Only group discussion rounds have a rubric.');
    return { config, round };
  }

  // ---------------------------------------------------------------- rules used by the round engine / GD module

  /** The Stage 2 verdict of one student (null = the job has no technical round). */
  async stage2Of(tenantId: string, jobId: string, applicationId: string, rounds: SavedRound[]): Promise<Stage2Verdict | null> {
    const [settings, results] = await Promise.all([this.settings(tenantId, jobId), this.assessments.resultsFor(tenantId, { applicationId })]);
    const byRound = new Map(results.map((r) => [r.roundId, toResult(r)]));
    return stage2Verdict(rounds, (id) => byRound.get(id), settings);
  }

  /**
   * After `round` was PASSED: does the Stage 2 overall criterion stop the student here? Only asked at the last
   * technical round; true = reject (REJECTED_MODULE2_OVERALL).
   */
  async failsStage2Overall(tenantId: string, jobId: string, applicationId: string, rounds: SavedRound[], round: SavedRound): Promise<boolean> {
    if (!isTechnicalRound(round.type)) return false;
    if (rounds.some((r) => isTechnicalRound(r.type) && r.position > round.position)) return false;
    const verdict = await this.stage2Of(tenantId, jobId, applicationId, rounds);
    return !!verdict && verdict.decided && !verdict.passed;
  }

  /** May this student be invited to `roundId` (rounds after Stage 2 need its overall criterion passed)? */
  async gateAllows(tenantId: string, jobId: string, applicationId: string, roundId: string): Promise<boolean> {
    const config = await this.rounds.forRoundEngine(tenantId, jobId);
    const target = config?.rounds.find((r) => r.id === roundId);
    if (!config || !target) return true;
    const [settings, results] = await Promise.all([this.settings(tenantId, jobId), this.assessments.resultsFor(tenantId, { applicationId })]);
    const byRound = new Map(results.map((r) => [r.roundId, toResult(r)]));
    return stage2GateAllows(config.rounds, target, (id) => byRound.get(id), settings);
  }

  /** Whether a rejection email may be sent for this job. */
  async rejectionEmailsOn(tenantId: string, jobId: string): Promise<boolean> {
    return (await this.settings(tenantId, jobId)).rejectionEmails;
  }

  // ---------------------------------------------------------------- HR views

  async statuses(tenantId: string, jobId: string): Promise<JobPipelineStatuses> {
    const ctx = await this.jobContext(tenantId, jobId);
    const counts: JobPipelineStatuses['counts'] = {};
    const students = ctx.students.map((s) => {
      const status = ctx.statusOf(s.applicationId);
      counts[status] = (counts[status] ?? 0) + 1;
      return { applicationId: s.applicationId, status, stage2: ctx.stage2Of(s.applicationId) };
    });
    return { jobId, settings: { jobId, ...ctx.settings, locked: ctx.config.locked }, counts, students };
  }

  /** Students who cleared the technical interview (every round before the HR interview), best overall score first. */
  async piBoard(tenantId: string, jobId: string): Promise<PiBoard> {
    const ctx = await this.jobContext(tenantId, jobId);
    const ordered = [...ctx.config.rounds].sort((a, b) => a.position - b.position);
    const hasPi = ordered.some((r) => PIPELINE_STAGE_OF[r.type] === 'PERSONAL_INTERVIEW');
    const eligible = hasPi ? AT_PI : [...AT_PI, 'CLEARED' as const];
    const candidates: PiCandidateRow[] = ctx.students
      .map((s) => ({ s, status: ctx.statusOf(s.applicationId) }))
      .filter(({ status }) => eligible.includes(status))
      .map(({ s, status }) => {
        const res = (roundId: string) => ctx.resultRow.get(`${s.applicationId}:${roundId}`);
        const tech = [...ordered].reverse().find((r) => PIPELINE_STAGE_OF[r.type] === 'TECH_INTERVIEW' && res(r.id));
        const techRow = tech ? res(tech.id) : undefined;
        const call = ctx.calls.get(s.applicationId);
        return {
          applicationId: s.applicationId,
          name: s.name,
          email: s.email,
          phone: s.phone,
          college: s.college,
          status,
          rounds: ordered.map((r) => {
            const row = res(r.id);
            return { roundId: r.id, name: r.name, type: r.type, score: row?.score ?? null, maxScore: row?.maxScore ?? null, outcome: row ? toResult(row).outcome : 'NOT_ATTEMPTED' };
          }),
          aptitudePercent: percentOf(ordered.filter((r) => PIPELINE_STAGE_OF[r.type] === 'APTITUDE').map((r) => res(r.id))),
          stage2Percent: ctx.stage2Of(s.applicationId)?.percent ?? null,
          techInterview: techRow ? { score: techRow.score, maxScore: techRow.maxScore, remarks: techRow.override?.reason ?? techRow.notes ?? null } : null,
          overallPercent: percentOf(ordered.map((r) => res(r.id))),
          call: { status: call?.status ?? 'NOT_CALLED', notes: call?.notes ?? '', updatedByName: call?.updatedByName ?? null, updatedAt: call?.updatedAt.toISOString() ?? null },
        };
      })
      .sort((a, b) => (b.overallPercent ?? -1) - (a.overallPercent ?? -1) || a.name.localeCompare(b.name));
    return { jobId, jobTitle: ctx.jobTitle, hasPersonalInterviewRound: hasPi, candidates };
  }

  async updatePiCall(tenantId: string, jobId: string, applicationId: string, body: unknown, actor: Actor): Promise<PiBoard> {
    const req = parseBody(piCallUpdateRequestSchema, body, 'INVALID_PI_CALL', 'Choose a status.');
    const board = await this.piBoard(tenantId, jobId);
    if (!board.candidates.some((c) => c.applicationId === applicationId)) {
      throw apiError(HttpStatus.CONFLICT, 'NOT_AT_PERSONAL_INTERVIEW', 'This student has not cleared the technical interview.');
    }
    await this.store.savePiCall(tenantId, jobId, applicationId, req, actor);
    await this.audit.record({ tenantId, actorUserId: actor.id, action: 'pipeline.pi_call_updated', subjectType: 'application', subjectId: applicationId, metadata: { status: req.status } });
    return this.piBoard(tenantId, jobId);
  }

  private async jobContext(tenantId: string, jobId: string) {
    const [config, jobTitle] = await Promise.all([this.rounds.forRoundEngine(tenantId, jobId), this.assessments.jobTitle(tenantId, jobId)]);
    if (!config || jobTitle === null) throw jobNotFound();
    const [settings, students, results, calls] = await Promise.all([
      this.settings(tenantId, jobId),
      this.assessments.studentsOf(tenantId, jobId),
      this.assessments.resultsFor(tenantId, { jobId }),
      this.piCalls(tenantId, jobId),
    ]);
    const resultRow = new Map(results.map((r) => [`${r.applicationId}:${r.roundId}`, r]));
    const resultOf = (applicationId: string) => (roundId: string) => {
      const r = resultRow.get(`${applicationId}:${roundId}`);
      return r ? toResult(r) : undefined;
    };
    const decisionOf = (applicationId: string) => {
      const c = calls.get(applicationId)?.status;
      return c === 'SELECTED' || c === 'REJECTED' ? c : null;
    };
    return {
      config,
      jobTitle,
      settings,
      students,
      resultRow,
      calls,
      statusOf: (applicationId: string) => pipelineStatusOf(config.rounds, resultOf(applicationId), settings, decisionOf(applicationId)),
      stage2Of: (applicationId: string) => stage2Verdict(config.rounds, resultOf(applicationId), settings),
    };
  }

  private async piCalls(tenantId: string, jobId: string): Promise<Map<string, PiCallRow>> {
    try {
      return new Map((await this.store.listPiCalls(tenantId, jobId)).map((c) => [c.applicationId, c]));
    } catch (err) {
      if (isMissingTable(err)) return new Map();
      throw err;
    }
  }
}
