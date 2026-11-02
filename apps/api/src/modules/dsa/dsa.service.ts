import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { dsaError, parseCodeRequest, type CodeRequestDto } from './dsa.dto';
import { Evaluator, type CaseResult, type Evaluation, type Verdict } from './evaluation/evaluator';
import { JUDGE0_CLIENT, Judge0UnavailableError, type CodeRunner } from './judge0/judge0.client';
import { DSA_CLOCK } from './dsa.tokens';
import { parseProctorEvents, parseProctorStart } from './proctoring/proctoring.dto';
import { ProctoringService, inviteRefFor, type RecordResult } from './proctoring/proctoring.service';
import type { CandidateProctorState, ClientProctoringConfig } from './proctoring/proctoring.types';
import { DSA_QUESTION_REPOSITORY, type QuestionRepository } from './questions/question.repository';
import { LANGUAGES, toPublicQuestion, type DsaQuestion, type Language, type PublicQuestion } from './questions/question.types';
import { DSA_LIFECYCLE, type AssessmentLifecycle } from './session/assessment-lifecycle';
import {
  DSA_INVITATION_RESOLVER,
  type DsaInvitation,
  type InvitationResolver,
} from './session/invitation.resolver';
import {
  DSA_SESSION_STORE,
  type DsaSession,
  type QuestionProgress,
  type SessionStatus,
  type SessionStore,
} from './session/session.store';

export { DSA_CLOCK };

export interface QuestionResult {
  questionId: string;
  title: string;
  difficulty: string;
  marks: number;
  score: number;
  passed: number;
  total: number;
  attempts: number;
  language: Language | null;
  solved: boolean;
}

export interface FinalResult {
  reason: 'submitted' | 'time_expired' | 'disqualified';
  finishedAt: string;
  totalScore: number;
  maxScore: number;
  percentage: number;
  questions: QuestionResult[];
}

export interface AssessmentState {
  status: SessionStatus;
  candidateName: string;
  title: string;
  durationMinutes: number;
  totalMarks: number;
  languages: readonly Language[];
  overview: { id: string; title: string; difficulty: string; marks: number }[];
  /** Server clock, so the browser can show a countdown that cannot be skewed by a wrong local clock. */
  serverTime: string;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingSeconds: number | null;
  /** Only present while the assessment is in progress. Contains NO hidden test cases. */
  questions?: PublicQuestion[];
  progress: QuestionProgress[];
  result?: FinalResult;
  /** Monitoring rules and the candidate's own standing. Contains no thresholds and no event log. */
  proctoring: ClientProctoringConfig & { started: boolean } & CandidateProctorState;
}

export interface RunResponse {
  questionId: string;
  language: Language;
  verdict: Verdict;
  passed: number;
  total: number;
  compileOutput: string;
  cases: CaseResult[];
  remainingSeconds: number;
}

export interface SubmitResponse extends RunResponse {
  score: number;
  maxScore: number;
  progress: QuestionProgress;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class DsaService {
  private readonly logger = new Logger(DsaService.name);
  private readonly evaluator: Evaluator;
  /** Tokens with a run/submit executing, to stop a candidate flooding the code runner (one process). */
  private readonly running = new Set<string>();

  constructor(
    @Inject(DSA_INVITATION_RESOLVER) private readonly invitations: InvitationResolver,
    @Inject(DSA_QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
    @Inject(DSA_SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(JUDGE0_CLIENT) runner: CodeRunner,
    @Optional() @Inject(DSA_CLOCK) private readonly now: () => number = Date.now,
    @Optional() @Inject(ProctoringService) private readonly proctoring: ProctoringService = new ProctoringService(),
    @Optional() @Inject(DSA_LIFECYCLE) private readonly lifecycle: AssessmentLifecycle | null = null,
  ) {
    this.evaluator = new Evaluator(runner);
  }

  // ---------------------------------------------------------------- public API

  async getState(token: string): Promise<AssessmentState> {
    const { session, questions } = await this.load(token);
    return this.toState(session, questions);
  }

  async start(token: string): Promise<AssessmentState> {
    const { session, questions } = await this.load(token);
    if (session.status === 'not_started') {
      // With proctoring on, the candidate must have accepted the monitoring notice (and been in full screen) first.
      if (this.proctoring.enabled && !(await this.proctoring.isStarted(inviteRefFor(token)))) {
        throw dsaError(HttpStatus.CONFLICT, 'PROCTORING_NOT_STARTED', 'Accept the monitoring notice and enter full screen before starting.');
      }
      const at = this.now();
      const deadlineAt = at + session.durationSec * 1000;
      await this.lifecycle?.started(token, at, deadlineAt);
      session.status = 'in_progress';
      session.startedAt = at;
      session.deadlineAt = deadlineAt;
      await this.sessions.save(session);
      await this.proctoring.markAssessmentStarted(inviteRefFor(token), session.assessmentId, at);
    }
    return this.toState(session, questions);
  }

  // ---------------------------------------------------------------- proctoring (candidate side)

  /** Records consent. Happens before the assessment starts; idempotent. */
  async proctorStart(token: string, body: unknown): Promise<ClientProctoringConfig> {
    const dto = parseProctorStart(body);
    const { session } = await this.load(token);
    if (session.status === 'finished') throw this.finishedError(session);
    return this.proctoring.start(inviteRefFor(token), session.assessmentId, dto);
  }

  /** Stores browser integrity events. The candidate is whoever owns the token; nothing else is accepted. */
  async proctorEvents(token: string, body: unknown): Promise<RecordResult & { ended: boolean }> {
    const inputs = parseProctorEvents(body);
    const { session } = await this.load(token);
    if (session.status === 'not_started') throw dsaError(HttpStatus.CONFLICT, 'NOT_STARTED', 'The assessment has not started.');
    if (session.status === 'finished') throw this.finishedError(session);
    const result = await this.proctoring.record(inviteRefFor(token), this.attemptWindow(session), inputs);

    // Allowed warnings: the first N suspicious events are tolerated, the next one ends the attempt right away.
    // The answers submitted so far are kept. (Each real action counts once: merging already happened in `record`.)
    const policy = this.proctoring.policy;
    let ended = false;
    if (policy.maxStrikes > 0 && result.violationCount > policy.maxStrikes) {
      await this.closeSession(session, 'disqualified');
      ended = true;
    }
    // Optional score-based policy: ending the attempt when the disqualification threshold is reached. Off unless configured.
    if (!ended && policy.autoEnd && policy.disqualifyScore > 0) {
      const summary = await this.proctoring.summary(inviteRefFor(token));
      if (summary?.status === 'disqualified') {
        await this.closeSession(session, 'disqualified');
        ended = true;
      }
    }
    return { ...result, ended };
  }

  /** Ends proctoring after the assessment is over (it also ends by itself on finish and on time-out). */
  async proctorEnd(token: string): Promise<{ ended: true }> {
    const { session } = await this.load(token);
    if (session.status !== 'finished') {
      throw dsaError(HttpStatus.CONFLICT, 'ASSESSMENT_IN_PROGRESS', 'Monitoring continues until the assessment is finished.');
    }
    await this.proctoring.end(inviteRefFor(token), session.finishedAt ?? this.now());
    return { ended: true };
  }

  async run(token: string, body: unknown): Promise<RunResponse> {
    const dto = parseCodeRequest(body);
    const { session, questions } = await this.load(token);
    const question = this.activeQuestion(session, questions, dto);
    const samples = question.testCases.filter((t) => !t.hidden);
    const evaluation = await this.execute(session, question, dto, samples);
    return this.toResponse(session, question, dto, evaluation);
  }

  async submit(token: string, body: unknown): Promise<SubmitResponse> {
    const dto = parseCodeRequest(body);
    const { session, questions } = await this.load(token);
    const question = this.activeQuestion(session, questions, dto);
    // Samples and hidden cases both count towards the score; hidden ones are only judged here.
    const evaluation = await this.execute(session, question, dto, question.testCases);

    const score = this.scoreOf(question, evaluation);
    const previous = session.progress[question.id] ?? this.emptyProgress(question.id);
    const best = score >= previous.bestScore && evaluation.verdict !== 'internal_error';
    const progress: QuestionProgress = {
      questionId: question.id,
      attempts: previous.attempts + 1,
      bestScore: best ? score : previous.bestScore,
      passed: best ? evaluation.passed : previous.passed,
      total: evaluation.total,
      language: best ? dto.language : previous.language,
      lastVerdict: evaluation.verdict,
    };
    // Re-read: a finish may have raced with this evaluation; never resurrect a manually finished session.
    const fresh = (await this.sessions.get(token)) ?? session;
    if (fresh.finishReason !== 'submitted' && fresh.finishReason !== 'disqualified') {
      fresh.progress[question.id] = progress;
      await this.sessions.save(fresh);
    }
    const response = this.toResponse(session, question, dto, evaluation);
    return { ...response, score, maxScore: question.marks, progress };
  }

  async finish(token: string): Promise<AssessmentState> {
    const { session, questions } = await this.load(token);
    if (session.status === 'not_started') {
      throw dsaError(HttpStatus.CONFLICT, 'NOT_STARTED', 'The assessment has not been started.');
    }
    if (session.status === 'in_progress') await this.closeSession(session, 'submitted');
    return this.toState(session, questions);
  }

  // ---------------------------------------------------------------- internals

  /** One place that ends an attempt: stores the result and seals the proctoring record. */
  private async closeSession(session: DsaSession, reason: 'submitted' | 'disqualified'): Promise<void> {
    session.status = 'finished';
    session.finishedAt = this.now();
    session.finishReason = reason;
    await this.sessions.save(session);
    await this.proctoring.end(inviteRefFor(session.token), session.finishedAt);
    await this.notifyFinished(session);
  }

  /** A failure here is not the candidate's problem: the round engine grades the attempt when its time runs out. */
  private async notifyFinished(session: DsaSession): Promise<void> {
    try {
      await this.lifecycle?.finished(session.token, session.finishReason ?? 'submitted');
    } catch (err) {
      this.logger.warn(`assessment end not passed on (${err instanceof Error ? err.message : 'unknown'}); graded when its time runs out`);
    }
  }

  private finishedError(session: DsaSession) {
    if (session.finishReason === 'time_expired') return dsaError(HttpStatus.FORBIDDEN, 'TIME_EXPIRED', 'Time is up. The assessment has ended.');
    if (session.finishReason === 'disqualified') {
      return dsaError(HttpStatus.FORBIDDEN, 'ATTEMPT_ENDED', 'The assessment was ended because of integrity violations. Your answers so far were recorded.');
    }
    return dsaError(HttpStatus.FORBIDDEN, 'ALREADY_FINISHED', 'The assessment has already been submitted.');
  }

  private attemptWindow(session: DsaSession) {
    return { assessmentId: session.assessmentId, startedAt: session.startedAt, endsAt: session.deadlineAt };
  }

  private async load(token: string): Promise<{ session: DsaSession; questions: DsaQuestion[] }> {
    const invitation = await this.invitations.resolve(token);
    if (!invitation) {
      throw dsaError(HttpStatus.NOT_FOUND, 'INVALID_TOKEN', 'This assessment link is not valid.');
    }
    const questions = await this.questions.findForAssessment(invitation.assessmentId);
    let session = await this.sessions.get(token);
    if (!session) {
      session = this.newSession(invitation);
      await this.sessions.save(session);
    }
    if (this.expireIfNeeded(session)) {
      await this.sessions.save(session);
      await this.proctoring.end(inviteRefFor(session.token), session.finishedAt ?? this.now());
      await this.notifyFinished(session);
    }
    return { session, questions };
  }

  private newSession(inv: DsaInvitation): DsaSession {
    return {
      token: inv.token,
      assessmentId: inv.assessmentId,
      candidateName: inv.candidateName,
      durationSec: inv.durationMinutes * 60,
      status: 'not_started',
      startedAt: null,
      deadlineAt: null,
      finishedAt: null,
      finishReason: null,
      progress: {},
    };
  }

  /** The server decides when time is up; the browser's timer is only a display. */
  private expireIfNeeded(session: DsaSession): boolean {
    if (session.status === 'in_progress' && session.deadlineAt !== null && this.now() >= session.deadlineAt) {
      session.status = 'finished';
      session.finishedAt = session.deadlineAt;
      session.finishReason = 'time_expired';
      return true;
    }
    return false;
  }

  private activeQuestion(session: DsaSession, questions: DsaQuestion[], dto: CodeRequestDto): DsaQuestion {
    if (session.status === 'not_started') {
      throw dsaError(HttpStatus.CONFLICT, 'NOT_STARTED', 'Start the assessment before running code.');
    }
    if (session.status === 'finished') throw this.finishedError(session);
    const question = questions.find((q) => q.id === dto.questionId);
    if (!question) throw dsaError(HttpStatus.NOT_FOUND, 'UNKNOWN_QUESTION', 'This question does not exist.');
    return question;
  }

  private async execute(
    session: DsaSession,
    question: DsaQuestion,
    dto: CodeRequestDto,
    cases: DsaQuestion['testCases'],
  ): Promise<Evaluation> {
    if (!(LANGUAGES as readonly string[]).includes(dto.language)) {
      throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Unsupported language.');
    }
    if (this.running.has(session.token)) {
      throw dsaError(HttpStatus.TOO_MANY_REQUESTS, 'BUSY', 'Your previous run is still in progress. Please wait for it to finish.');
    }
    this.running.add(session.token);
    try {
      return await this.evaluator.evaluate(question, dto.language, dto.code, cases);
    } catch (err) {
      if (err instanceof Judge0UnavailableError) {
        this.logger.error(`Judge0 failure: ${err.message} (${err.detail ?? 'no detail'})`);
        throw dsaError(HttpStatus.SERVICE_UNAVAILABLE, 'JUDGE0_UNAVAILABLE', err.message);
      }
      throw err;
    } finally {
      this.running.delete(session.token);
    }
  }

  private scoreOf(question: DsaQuestion, evaluation: Evaluation): number {
    return evaluation.total === 0 ? 0 : round2((question.marks * evaluation.passed) / evaluation.total);
  }

  private emptyProgress(questionId: string): QuestionProgress {
    return { questionId, attempts: 0, bestScore: 0, passed: 0, total: 0, language: null, lastVerdict: null };
  }

  private remainingSeconds(session: DsaSession): number | null {
    if (session.deadlineAt === null) return null;
    if (session.status === 'finished') return 0;
    return Math.max(0, Math.ceil((session.deadlineAt - this.now()) / 1000));
  }

  private toResponse(session: DsaSession, question: DsaQuestion, dto: CodeRequestDto, e: Evaluation): RunResponse {
    return {
      questionId: question.id,
      language: dto.language,
      verdict: e.verdict,
      passed: e.passed,
      total: e.total,
      compileOutput: e.compileOutput,
      cases: e.cases,
      remainingSeconds: this.remainingSeconds(session) ?? 0,
    };
  }

  private async toState(session: DsaSession, questions: DsaQuestion[]): Promise<AssessmentState> {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const ref = inviteRefFor(session.token);
    const state: AssessmentState = {
      status: session.status,
      candidateName: session.candidateName,
      title: 'DSA Coding Assessment',
      durationMinutes: Math.round(session.durationSec / 60),
      totalMarks: questions.reduce((sum, q) => sum + q.marks, 0),
      languages: LANGUAGES,
      overview: questions.map((q) => ({ id: q.id, title: q.title, difficulty: q.difficulty, marks: q.marks })),
      serverTime: new Date(this.now()).toISOString(),
      startedAt: iso(session.startedAt),
      deadlineAt: iso(session.deadlineAt),
      remainingSeconds: this.remainingSeconds(session),
      progress: questions.map((q) => session.progress[q.id] ?? this.emptyProgress(q.id)),
      proctoring: {
        ...this.proctoring.config(),
        started: await this.proctoring.isStarted(ref),
        ...(await this.proctoring.candidateStateFor(ref)),
      },
    };
    if (session.status === 'in_progress') state.questions = questions.map(toPublicQuestion);
    if (session.status === 'finished') state.result = this.buildResult(session, questions);
    return state;
  }

  private buildResult(session: DsaSession, questions: DsaQuestion[]): FinalResult {
    const rows: QuestionResult[] = questions.map((q) => {
      const p = session.progress[q.id] ?? this.emptyProgress(q.id);
      return {
        questionId: q.id,
        title: q.title,
        difficulty: q.difficulty,
        marks: q.marks,
        score: p.bestScore,
        passed: p.passed,
        total: p.total,
        attempts: p.attempts,
        language: p.language,
        solved: p.total > 0 && p.passed === p.total,
      };
    });
    const maxScore = questions.reduce((sum, q) => sum + q.marks, 0);
    const totalScore = round2(rows.reduce((sum, r) => sum + r.score, 0));
    return {
      reason: session.finishReason ?? 'submitted',
      finishedAt: new Date(session.finishedAt ?? this.now()).toISOString(),
      totalScore,
      maxScore,
      percentage: maxScore === 0 ? 0 : round2((totalScore / maxScore) * 100),
      questions: rows,
    };
  }
}
