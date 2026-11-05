import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_INTERVIEW_RECOMMENDATION_LABEL,
  aiInterviewDecisionRequestSchema,
  aiInterviewReportSchema,
  type AiInterviewEndReason,
  type AiInterviewHrRound,
  type AiInterviewHrView,
  type AiInterviewReport,
  type RoundAnswerInput,
} from '@hireflow/contracts';
import { AuditService } from '../audit';
import { RoundEngineService } from '../round-engine';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { AI_INTERVIEW_CLOCK, AiInterviewService, interviewError } from './ai-interview.service';
import { AiInterviewStore, type SessionRow, type TurnRow } from './ai-interview.store';
import { clockOf, configFromRound, interviewerScore, parseConfig, parsePlan } from './flow';
import { parseProtection } from './protection';

const ENDED = ['COMPLETED', 'INCOMPLETE', 'TERMINATED'];

/**
 * HR side of the AI technical interview: the transcript, integrity events and the AI's report, and HR's decision.
 * HR's decision is the only thing that moves a student on: the result goes to the round engine (round_results + next
 * invitation or outcome email, once). Company from the session; another company's ids are a 404.
 */
@Injectable()
export class AiInterviewHrService {
  private readonly logger = new Logger('AiInterviewHr');

  constructor(
    @Inject(AiInterviewStore) private readonly store: AiInterviewStore,
    @Inject(AiInterviewService) private readonly interviews: AiInterviewService,
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AI_INTERVIEW_CLOCK) private readonly now: () => Date,
  ) {}

  /** GET /api/v1/ai-interview/applications/:applicationId - every AI interview round of the student's job. */
  async view(tenantId: string, applicationId: string): Promise<AiInterviewHrView> {
    const ctx = await this.store.context(tenantId, applicationId);
    if (!ctx) throw interviewError(HttpStatus.NOT_FOUND, 'APPLICATION_NOT_FOUND', 'Student not found.');
    const [config, invites, sessions] = await Promise.all([
      this.rounds.forRoundEngine(tenantId, ctx.jobId),
      this.store.invitesForApplication(tenantId, applicationId),
      this.store.sessionsForApplication(tenantId, applicationId),
    ]);
    const rounds = (config?.rounds ?? []).filter((r) => r.type === 'AI_INTERVIEW').sort((a, b) => a.position - b.position);
    const out: AiInterviewHrRound[] = [];
    for (const r of rounds) {
      const invite = invites.find((i) => i.roundId === r.id) ?? null;
      const session = sessions.find((s) => s.roundId === r.id) ?? null;
      out.push(await this.round(r.id, r.name, configFromRound(r, true).durationMinutes, invite, session));
    }
    return { applicationId, rounds: out };
  }

  /** POST .../rounds/:roundId/decision - HR advances or rejects the student (once). */
  async decide(tenantId: string, applicationId: string, roundId: string, body: unknown, actor: Actor | null): Promise<AiInterviewHrView> {
    const parsed = aiInterviewDecisionRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_DECISION', parsed.error.issues[0]?.message ?? 'Invalid decision.');
    const session = (await this.store.sessionsForApplication(tenantId, applicationId)).find((s) => s.roundId === roundId);
    if (!session) throw interviewError(HttpStatus.NOT_FOUND, 'INTERVIEW_NOT_FOUND', 'This student has no AI interview in that round.');
    if (!ENDED.includes(session.status)) throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_NOT_FINISHED', 'The interview has not ended yet.');
    if (session.decision) throw interviewError(HttpStatus.CONFLICT, 'ALREADY_DECIDED', 'A decision was already made for this interview.');

    const config = parseConfig(session.config);
    const report = parseReport((await this.store.report(session.id))?.report);
    const proposed = interviewerScore(report?.overallScore ?? null, config.passRule);
    if (!proposed) throw interviewError(HttpStatus.CONFLICT, 'NO_PASS_RULE', 'This round has no interviewer-score pass rule. Set it on the Publish page first.');
    const passed = parsed.data.decision === 'ADVANCE';
    const systemPassed = proposed.score >= proposed.passMark;
    const reason = parsed.data.reason.trim();
    // a termination by the warning limit is reviewed by a person: HR writes what they concluded from the events
    if (session.status === 'TERMINATED' && reason.length < 5) {
      throw interviewError(
        HttpStatus.BAD_REQUEST,
        'REASON_REQUIRED',
        'This interview was ended by the warning limit. Review the recorded events and write what you concluded (at least 5 characters).',
      );
    }
    if (passed !== systemPassed && reason.length < 5) {
      throw interviewError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', `The AI score (${proposed.score} of ${proposed.maxScore}) is ${systemPassed ? 'above' : 'below'} the pass mark: write why you decide otherwise (at least 5 characters).`);
    }
    const decided = await this.store.decide(tenantId, session.id, { decision: parsed.data.decision, reason: reason || null, byId: actor?.id ?? null, byName: actor?.name ?? null }, this.now());
    if (!decided) throw interviewError(HttpStatus.CONFLICT, 'ALREADY_DECIDED', 'A decision was already made for this interview.');
    await this.audit.record({
      tenantId,
      actorUserId: actor?.id ?? null,
      action: 'ai_interview.decided',
      subjectType: 'application',
      subjectId: applicationId,
      metadata: { roundId, decision: parsed.data.decision, aiScore: proposed.score, maxScore: proposed.maxScore, aiRecommendation: report?.recommendation ?? null },
    });
    try {
      await this.record((await this.store.session(session.id))!, actor);
    } catch (err) {
      // the decision is saved; the worker loop hands it to the round engine again
      this.logger.warn(`interview decision saved, result not recorded yet application=${applicationId} (${err instanceof Error ? err.name : 'unknown'})`);
    }
    return this.view(tenantId, applicationId);
  }

  /**
   * Automatic decision (AUTO_AI_INTERVIEW_DECISIONS, worker): an interview that ended normally and has its AI report is
   * advanced or rejected by the round's pass rule (AI score vs HR's pass mark), with no HR click. Interviews ended by
   * the warning limit (TERMINATED) are never decided here - HR reviews them. Returns true when it decided.
   */
  async autoDecide(session: SessionRow): Promise<boolean> {
    if (session.decision || session.status === 'TERMINATED' || !ENDED.includes(session.status)) return false;
    const reportRow = await this.store.report(session.id);
    if (reportRow?.status !== 'DONE') return false;
    const report = parseReport(reportRow.report);
    const proposed = interviewerScore(report?.overallScore ?? null, parseConfig(session.config).passRule);
    if (!proposed) return false; // no interviewer-score pass rule: HR decides
    const decision = proposed.score >= proposed.passMark ? 'ADVANCE' : 'REJECT';
    const reason = `Automatic: AI score ${proposed.score} of ${proposed.maxScore}, pass mark ${proposed.passMark}.`;
    const decided = await this.store.decide(session.tenantId, session.id, { decision, reason, byId: null, byName: 'Automatic (pass mark)' }, this.now());
    if (!decided) return false;
    await this.audit.record({
      tenantId: session.tenantId,
      actorUserId: null,
      action: 'ai_interview.auto_decided',
      subjectType: 'application',
      subjectId: session.applicationId,
      metadata: { roundId: session.roundId, decision, aiScore: proposed.score, maxScore: proposed.maxScore, passMark: proposed.passMark },
    });
    // hands it to the round engine (next round / personal-interview email); recover() retries if interrupted
    await this.record((await this.store.session(session.id))!);
    return true;
  }

  /** POST .../rounds/:roundId/report - make the report again (after a failure). */
  async retryReport(tenantId: string, applicationId: string, roundId: string): Promise<AiInterviewHrView> {
    const session = (await this.store.sessionsForApplication(tenantId, applicationId)).find((s) => s.roundId === roundId);
    if (!session) throw interviewError(HttpStatus.NOT_FOUND, 'INTERVIEW_NOT_FOUND', 'This student has no AI interview in that round.');
    if (!ENDED.includes(session.status)) throw interviewError(HttpStatus.CONFLICT, 'INTERVIEW_NOT_FINISHED', 'The interview has not ended yet.');
    await this.interviews.generateReport(session.id);
    return this.view(tenantId, applicationId);
  }

  /**
   * Hands HR's decision to the round engine: the AI score as the round's interviewer score, HR's decision as pass /
   * fail (an audited override when it differs), and HR's questions with the student's answers. Safe to repeat.
   */
  async record(session: SessionRow, actor: Actor | null = null): Promise<void> {
    if (!session.decision || session.recordedAt) return;
    const config = parseConfig(session.config);
    const report = parseReport((await this.store.report(session.id))?.report);
    const proposed = interviewerScore(report?.overallScore ?? null, config.passRule);
    if (!proposed) return;
    const turns = await this.store.turns(session.id);
    const passed = session.decision === 'ADVANCE';
    const label = report ? AI_INTERVIEW_RECOMMENDATION_LABEL[report.recommendation] : 'no AI report';
    const notes = [
      `AI technical interview: AI score ${report?.overallScore ?? '-'} / 100 (${label}). HR decision: ${passed ? 'advance' : 'reject'}${session.decidedByName ? ` (${session.decidedByName})` : ''}.`,
      session.decisionReason ? `Reason: ${session.decisionReason}` : '',
      report?.summary ?? '',
      'Full transcript and report: AI technical interview panel.',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
    await this.engine.recordModuleResult(
      session.tenantId,
      'AI_INTERVIEW',
      {
        applicationId: session.applicationId,
        roundId: session.roundId,
        interviewerScore: proposed.score,
        answers: hrAnswers(parsePlan(session.plan)?.topics ?? [], turns, report),
        notes,
        startedAt: session.startedAt?.toISOString() ?? null,
        submittedAt: (session.completedAt ?? this.now()).toISOString(),
      },
      {
        passed,
        reason: session.decisionReason ?? `${passed ? 'Advanced' : 'Rejected'} by HR after the AI interview review.`,
        actor: actor ?? (session.decidedById ? { id: session.decidedById, name: session.decidedByName ?? '' } : null),
      },
    );
    await this.store.markRecorded(session.id, this.now());
  }

  private async round(roundId: string, roundName: string, durationMinutes: number, invite: Awaited<ReturnType<AiInterviewStore['invitesForApplication']>>[number] | null, session: SessionRow | null): Promise<AiInterviewHrRound> {
    const [turns, events, reportRow, violations] = session
      ? await Promise.all([this.store.turns(session.id), this.store.events(session.id), this.store.report(session.id), this.store.violations(session.id)])
      : [[], [], null, []];
    const config = session ? parseConfig(session.config) : null;
    const report = parseReport(reportRow?.report);
    const proposed = config ? interviewerScore(report?.overallScore ?? null, config.passRule) : null;
    const clock = session && config ? clockOf(session, config, session.completedAt ?? this.now()) : null;
    return {
      roundId,
      roundName,
      durationMinutes: config?.durationMinutes ?? durationMinutes,
      invite: invite ? { status: invite.emailStatus, sentAt: iso(invite.sentAt), expiresAt: iso(invite.expiresAt), lastError: invite.lastError } : null,
      session:
        session && clock
          ? {
              status: session.status,
              startedAt: iso(session.startedAt),
              completedAt: iso(session.completedAt),
              endedReason: (session.endedReason as AiInterviewEndReason | null) ?? null,
              // a session ended late by the time-out sweep still used at most its length (answers are refused after it)
              durationSeconds: Math.min(clock.elapsedSeconds, config!.durationMinutes * 60),
              pausedSeconds: session.pausedSeconds,
              questionsAnswered: turns.filter((t) => t.kind !== 'INTRO').length,
            }
          : null,
      turns: turns.map((t) => ({
        seq: t.seq,
        kind: t.kind,
        source: t.source,
        topic: t.topic,
        resumeRef: t.resumeRef,
        question: t.question,
        rawTranscript: t.rawTranscript,
        normalizedTranscript: t.normalizedTranscript,
        transcriptQuality: t.transcriptQuality,
        unclearTerms: t.unclearTerms,
        reading: (t.reading as AiInterviewHrRound['turns'][number]['reading']) ?? null,
        askedAt: t.askedAt.toISOString(),
        answeredAt: t.answeredAt.toISOString(),
        answerSeconds: t.answerSeconds,
      })),
      events: events.map((e) => ({ type: e.type, at: e.occurredAt.toISOString(), detail: e.detail })),
      integrity: session
        ? {
            status: session.integrityStatus,
            settings: parseProtection(session.protection),
            warningCount: session.warningCount,
            terminatedAt: iso(session.terminatedAt),
            terminationReason: session.terminationReason,
            violations: violations.map((v) => ({
              type: v.type,
              outcome: v.outcome,
              warningNumber: v.warningNumber,
              at: v.occurredAt.toISOString(),
              detail: v.detail,
              acknowledgedAt: iso(v.acknowledgedAt),
              resolvedAt: iso(v.resolvedAt),
            })),
          }
        : null,
      report: reportRow ? { status: reportRow.status, data: report, lastError: reportRow.lastError, generatedAt: iso(reportRow.generatedAt) } : null,
      proposedScore: proposed,
      decision: session?.decision
        ? { decision: session.decision, reason: session.decisionReason, by: session.decidedByName, at: (session.decidedAt ?? this.now()).toISOString() }
        : null,
      canDecide: !!session && ENDED.includes(session.status) && !session.decision && !!proposed,
    };
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function parseReport(raw: unknown): AiInterviewReport | null {
  const parsed = aiInterviewReportSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * HR's own questions of the round with what the student said (main answer + follow-ups on that topic), so they show on
 * the HR Assessments page next to the question. AI-made questions stay in the interview panel only.
 */
export function hrAnswers(topics: { id: string; hrQuestionId?: string | null }[], turns: TurnRow[], report: AiInterviewReport | null): RoundAnswerInput[] {
  const out: RoundAnswerInput[] = [];
  for (const t of topics) {
    if (!t.hrQuestionId || out.some((a) => a.questionId === t.hrQuestionId)) continue;
    const onTopic = turns.filter((x) => x.topicId === t.id);
    if (!onTopic.length) continue;
    const evaluation = report?.answers.find((a) => a.seq === onTopic[0]!.seq);
    out.push({
      questionId: t.hrQuestionId,
      answer: onTopic.map((x) => (x.kind === 'MAIN' ? x.rawTranscript : `Follow-up - ${x.question}\n${x.rawTranscript}`)).join('\n\n').slice(0, 50_000),
      feedback: evaluation?.summary || null,
    });
  }
  return out;
}
