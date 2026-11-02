import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { RoundEngineService, type CodingScore } from '../../round-engine';
import { DSA_QUESTION_REPOSITORY, type QuestionRepository } from '../questions/question.repository';
import type { AssessmentLifecycle } from '../session/assessment-lifecycle';
import type { DsaInvitation, InvitationResolver } from '../session/invitation.resolver';
import type { DsaSession, SessionStore } from '../session/session.store';

/** A coding round without a time limit still needs a clock on the DSA page. */
const DEFAULT_MINUTES = 60;

type StoredState = Omit<DsaSession, 'token'>;
interface InviteRef {
  inviteId: string;
  tenantId: string;
}

/**
 * Runs the DSA page as the round engine's coding rounds: the emailed round-engine link is the token (checked on
 * every call: expired, withdrawn or unknown links do not work), the attempt is recorded in the round engine when the
 * clock starts and graded there when it ends (next invite / outcome email), and the page's state is kept in
 * dsa_sessions so an API restart loses nothing. Only the invitation id is stored with it, never the token.
 */
@Injectable()
export class RoundEngineBridge implements InvitationResolver, SessionStore, AssessmentLifecycle, OnModuleInit {
  /** token -> invitation (never changes for a token; resolve() still checks the link on every request). */
  private readonly refs = new Map<string, InviteRef>();

  constructor(
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(DSA_QUESTION_REPOSITORY) private readonly questions: QuestionRepository,
  ) {}

  onModuleInit() {
    this.engine.setCodingScorer((inviteId) => this.score(inviteId));
  }

  // ---------------------------------------------------------------- InvitationResolver

  async resolve(token: string): Promise<DsaInvitation | null> {
    const invite = await this.engine.codingInvite(token);
    if (!invite) return null;
    if (this.refs.size > 10_000) this.refs.clear();
    this.refs.set(token, { inviteId: invite.inviteId, tenantId: invite.tenantId });
    return {
      token,
      assessmentId: invite.roundId,
      candidateName: invite.candidateName,
      durationMinutes: invite.timeLimitMinutes ?? DEFAULT_MINUTES,
    };
  }

  // ---------------------------------------------------------------- SessionStore

  async get(token: string): Promise<DsaSession | undefined> {
    const ref = await this.ref(token);
    if (!ref) return undefined;
    const row = await this.db.dsaSession.findUnique({ where: { inviteId: ref.inviteId } });
    return row ? { ...(row.state as unknown as StoredState), token } : undefined;
  }

  async save(session: DsaSession): Promise<void> {
    const ref = await this.ref(session.token);
    if (!ref) throw new Error('assessment link no longer valid');
    const { token: _token, ...state } = session;
    const json = state as unknown as Prisma.InputJsonObject;
    await this.db.dsaSession.upsert({
      where: { inviteId: ref.inviteId },
      create: { inviteId: ref.inviteId, tenantId: ref.tenantId, state: json },
      update: { state: json },
    });
  }

  // ---------------------------------------------------------------- AssessmentLifecycle

  started(token: string, startedAt: number, deadlineAt: number): Promise<void> {
    return this.engine.codingStarted(token, new Date(startedAt), new Date(deadlineAt));
  }

  finished(token: string, reason: 'submitted' | 'time_expired' | 'disqualified'): Promise<void> {
    return this.engine.codingFinished(token, reason);
  }

  // ---------------------------------------------------------------- grading (called by the round engine)

  /** Best score per problem, as the DSA result screen shows it. No session (never opened) = 0 marks. */
  async score(inviteId: string): Promise<CodingScore> {
    const row = await this.db.dsaSession.findUnique({ where: { inviteId } });
    const state = row ? (row.state as unknown as StoredState) : null;
    const questions = await this.questions.findForAssessment(state?.assessmentId ?? '');
    let score = 0;
    let solved = 0;
    const lines = questions.map((q) => {
      const p = state?.progress[q.id];
      const best = Math.min(p?.bestScore ?? 0, q.marks);
      score += best;
      if (p && p.total > 0 && p.passed === p.total) solved++;
      const tests = p && p.total > 0 ? `${p.passed}/${p.total} tests` : 'not submitted';
      return `${q.title} (${q.difficulty}): ${best} of ${q.marks} marks, ${tests}${p?.language ? `, ${p.language}` : ''}`;
    });
    const maxScore = questions.reduce((sum, q) => sum + q.marks, 0);
    score = Math.round(score * 100) / 100;
    const ended = state?.finishReason === 'disqualified' ? ' Ended early by the integrity monitoring.' : state?.finishReason === 'time_expired' ? ' Time ran out.' : '';
    const summary = [`DSA coding test: ${score} of ${maxScore} marks, ${solved} of ${questions.length} problems solved.${ended}`, ...lines].join('\n');
    return { score, maxScore, solved, total: questions.length, summary };
  }

  private async ref(token: string): Promise<InviteRef | null> {
    const known = this.refs.get(token);
    if (known) return known;
    return (await this.resolve(token)) ? (this.refs.get(token) ?? null) : null;
  }
}
