import type { RoundOutcomeEmailKind } from '@hireflow/contracts';
import type { EmailMessage } from '../../src/modules/applications/email/confirmation-email';
import type { Mailer } from '../../src/modules/applications';
import type { CodingState } from '../../src/modules/round-engine/coding-round';
import type { StoredAnswers } from '../../src/modules/round-engine/online-test';
import {
  RoundEngineStore,
  type AttemptRow,
  type CandidateContext,
  type EventRow,
  type EventWrite,
  type InviteRow,
  type OutcomeEmailRow,
  type SendFailure,
} from '../../src/modules/round-engine/round-engine.store';

let seq = 0;
const id = () => `0192f3a1-eeee-7000-8000-${String(++seq).padStart(12, '0')}`;

/** The round engine's tables in memory. Rows of every tenant live together, like in the database. */
export class MemoryRoundEngineStore extends RoundEngineStore {
  contexts = new Map<string, CandidateContext>();
  invites: InviteRow[] = [];
  attempts: AttemptRow[] = [];
  events: EventRow[] = [];
  outcomeEmails: OutcomeEmailRow[] = [];
  /** What screeningsToInvite() returns (the SQL lives in the Prisma store). */
  completedScreenings: { tenantId: string; applicationId: string; jobId: string; roundId: string }[] = [];

  async findInviteByHash(tokenHash: string) {
    return this.invites.find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async context(tenantId: string, applicationId: string) {
    const c = this.contexts.get(applicationId);
    return c && c.tenantId === tenantId ? c : null;
  }
  async attemptByInvite(inviteId: string) {
    return this.attempts.find((a) => a.inviteId === inviteId) ?? null;
  }
  async getAttempt(attemptId: string) {
    const a = this.attempts.find((x) => x.id === attemptId);
    return a ? structuredClone(a) : null;
  }
  async createAttempt(data: Parameters<RoundEngineStore['createAttempt']>[0]) {
    const existing = this.attempts.find((a) => a.inviteId === data.inviteId || (a.applicationId === data.applicationId && a.roundId === data.roundId));
    if (existing) return structuredClone(existing);
    const row: AttemptRow = {
      id: id(),
      tenantId: data.tenantId,
      applicationId: data.applicationId,
      jobId: data.jobId,
      roundId: data.roundId,
      inviteId: data.inviteId,
      status: 'IN_PROGRESS',
      startedAt: data.startedAt,
      deadlineAt: data.deadlineAt,
      submittedAt: null,
      answers: {},
      codingState: data.codingState ? structuredClone(data.codingState) : null,
      revision: 0,
      systemPassed: null,
      progressedAt: null,
    };
    this.attempts.push(row);
    return structuredClone(row);
  }
  async saveCodingState(attemptId: string, state: CodingState) {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a || a.status !== 'IN_PROGRESS') return false;
    a.codingState = structuredClone(state);
    return true;
  }
  async saveAnswers(attemptId: string, revision: number, answers: StoredAnswers) {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a) return null;
    if (a.status === 'IN_PROGRESS' && a.revision < revision) Object.assign(a, { revision, answers: structuredClone(answers) });
    return a.revision;
  }
  async finishAttempt(attemptId: string, status: 'SUBMITTED' | 'TIMED_OUT', at: Date, final?: { revision: number; answers: StoredAnswers }) {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a || a.status !== 'IN_PROGRESS') return false;
    if (final && a.revision <= final.revision) Object.assign(a, { revision: final.revision, answers: structuredClone(final.answers) });
    Object.assign(a, { status, submittedAt: at });
    return true;
  }
  async setSystemPassed(attemptId: string, passed: boolean) {
    this.attempts.find((x) => x.id === attemptId)!.systemPassed = passed;
  }
  async claimProgress(attemptId: string, at: Date) {
    const a = this.attempts.find((x) => x.id === attemptId);
    if (!a || a.progressedAt || a.status === 'IN_PROGRESS') return false;
    a.progressedAt = at;
    return true;
  }
  async releaseProgress(attemptId: string) {
    this.attempts.find((x) => x.id === attemptId)!.progressedAt = null;
  }
  async countEvents(attemptId: string) {
    return this.events.filter((e) => e.attemptId === attemptId).length;
  }
  async addEvents(_tenantId: string, attemptId: string, events: EventWrite[]) {
    this.events.push(...events.map((e) => ({ ...e, attemptId })));
  }
  async queueInvite(tenantId: string, applicationId: string, jobId: string, roundId: string) {
    if (this.invites.some((i) => i.applicationId === applicationId && i.roundId === roundId)) return false;
    this.invites.push({
      id: id(),
      tenantId,
      applicationId,
      jobId,
      roundId,
      tokenHash: null,
      expiresAt: null,
      revokedAt: null,
      emailStatus: 'QUEUED',
      attempts: 0,
      sentAt: null,
      lastError: null,
    });
    return true;
  }
  async queueOutcomeEmail(tenantId: string, applicationId: string, roundId: string, kind: RoundOutcomeEmailKind, nextRoundName: string | null) {
    if (this.outcomeEmails.some((e) => e.applicationId === applicationId && e.roundId === roundId)) return false;
    this.outcomeEmails.push({ id: id(), tenantId, applicationId, roundId, kind, nextRoundName, status: 'QUEUED', attempts: 0, sentAt: null });
    return true;
  }
  async screeningsToInvite() {
    return this.completedScreenings.filter((s) => !this.invites.some((i) => i.applicationId === s.applicationId && i.roundId === s.roundId));
  }
  async claimDueInvites() {
    const due = this.invites.filter((i) => i.emailStatus === 'QUEUED');
    due.forEach((i) => Object.assign(i, { emailStatus: 'SENDING', attempts: i.attempts + 1 }));
    return due.map((i) => ({ ...i }));
  }
  async setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date) {
    Object.assign(this.invites.find((i) => i.id === inviteId)!, { tokenHash, expiresAt });
  }
  async inviteSent(inviteId: string, sentAt: Date, expiresAt: Date) {
    Object.assign(this.invites.find((i) => i.id === inviteId)!, { emailStatus: 'SENT', sentAt, expiresAt, lastError: null });
  }
  async inviteFailed(inviteId: string, f: SendFailure) {
    const i = this.invites.find((x) => x.id === inviteId)!;
    if ('giveUp' in f) Object.assign(i, { emailStatus: 'FAILED', lastError: f.error, tokenHash: null, expiresAt: null });
    else Object.assign(i, { emailStatus: 'QUEUED', lastError: f.error, attempts: f.countAttempt ? i.attempts : i.attempts - 1 });
  }
  async claimDueOutcomeEmails() {
    const due = this.outcomeEmails.filter((e) => e.status === 'QUEUED');
    due.forEach((e) => Object.assign(e, { status: 'SENDING', attempts: e.attempts + 1 }));
    return due.map((e) => ({ ...e }));
  }
  async outcomeEmailSent(emailId: string, sentAt: Date) {
    Object.assign(this.outcomeEmails.find((e) => e.id === emailId)!, { status: 'SENT', sentAt });
  }
  async outcomeEmailFailed(emailId: string, f: SendFailure) {
    Object.assign(this.outcomeEmails.find((e) => e.id === emailId)!, 'giveUp' in f ? { status: 'FAILED' } : { status: 'QUEUED' });
  }
  async overdueAttempts(before: Date) {
    return this.attempts.filter((a) => a.status === 'IN_PROGRESS' && a.deadlineAt && a.deadlineAt < before).map((a) => structuredClone(a));
  }
  async unprogressedAttempts(finishedBefore: Date) {
    return this.attempts.filter((a) => a.status !== 'IN_PROGRESS' && !a.progressedAt && a.submittedAt && a.submittedAt < finishedBefore).map((a) => structuredClone(a));
  }
  async forApplication(tenantId: string, applicationId: string) {
    const ctx = this.contexts.get(applicationId);
    if (!ctx || ctx.tenantId !== tenantId) return null;
    const attempts = this.attempts.filter((a) => a.tenantId === tenantId && a.applicationId === applicationId);
    return {
      invites: this.invites.filter((i) => i.tenantId === tenantId && i.applicationId === applicationId),
      attempts,
      events: this.events.filter((e) => attempts.some((a) => a.id === e.attemptId)),
      outcomeEmails: this.outcomeEmails.filter((e) => e.tenantId === tenantId && e.applicationId === applicationId),
    };
  }
  async revokeInvite(tenantId: string, applicationId: string, roundId: string, _byId: string | null, at: Date) {
    const i = this.invites.find((x) => x.tenantId === tenantId && x.applicationId === applicationId && x.roundId === roundId && !x.revokedAt);
    if (!i) return false;
    i.revokedAt = at;
    return true;
  }
  async requeueFailedInvite(tenantId: string, applicationId: string, roundId: string) {
    const i = this.invites.find((x) => x.tenantId === tenantId && x.applicationId === applicationId && x.roundId === roundId && x.emailStatus === 'FAILED');
    if (!i) return false;
    Object.assign(i, { emailStatus: 'QUEUED', attempts: 0, tokenHash: null, expiresAt: null });
    return true;
  }
}

export class FakeMailer implements Mailer {
  readonly enabled = true;
  sent: { to: string; message: EmailMessage }[] = [];
  failWith: Error | null = null;
  async send(to: string, message: EmailMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to, message });
  }
}
