import { Inject, Injectable } from '@nestjs/common';
import {
  DSA_BANK,
  dsaTopicFor,
  type AssessmentIncidentType,
  type AssessmentIntegrityStatus,
  type AssessmentProtectionSettings,
  type EmailDeliveryStatus,
  type ProctorEventType,
  type ProctorSeverity,
  type ProtectionCount,
  type ProtectionOutcome,
  type RoundOutcomeEmailKind,
} from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { parseCodingState, type CodingState } from './coding-round';
import { parseStoredAnswers, type StoredAnswers } from './online-test';

export interface InviteRow {
  id: string;
  tenantId: string;
  applicationId: string;
  jobId: string;
  roundId: string;
  tokenHash: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  emailStatus: EmailDeliveryStatus;
  attempts: number;
  sentAt: Date | null;
  lastError: string | null;
}

export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'TIMED_OUT' | 'TERMINATED';

export interface AttemptRow {
  id: string;
  tenantId: string;
  applicationId: string;
  jobId: string;
  roundId: string;
  inviteId: string;
  status: AttemptStatus;
  startedAt: Date;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  answers: StoredAnswers;
  /** DSA (coding) rounds only: what the candidate achieved so far (null for MCQ rounds). */
  codingState: CodingState | null;
  revision: number;
  systemPassed: boolean | null;
  progressedAt: Date | null;
  /** Protection rules copied at the start (AssessmentProtectionSettings JSON); null = not monitored. */
  protection: unknown;
  warningCount: number;
  integrityStatus: AssessmentIntegrityStatus;
  terminatedAt: Date | null;
  terminationReason: string | null;
  integrityDecision: 'ADVANCE' | 'REJECT' | null;
  integrityReason: string | null;
  integrityDecidedBy: string | null;
  integrityDecidedAt: Date | null;
}

/** Fields the protection sets; never given when creating an attempt. */
type ProtectionFields =
  | 'protection'
  | 'warningCount'
  | 'integrityStatus'
  | 'terminatedAt'
  | 'terminationReason'
  | 'integrityDecision'
  | 'integrityReason'
  | 'integrityDecidedBy'
  | 'integrityDecidedAt';

export interface IncidentRow {
  attemptId: string;
  type: AssessmentIncidentType;
  outcome: ProtectionOutcome;
  warningNumber: number | null;
  incidentId: string;
  occurredAt: Date;
  detail: string | null;
  acknowledgedAt: Date | null;
}

/** What `decide` returns under the lock: null = not accepted now (nothing stored). */
export type IncidentVerdict = (ProtectionCount & { terminationReason: string | null }) | null;

export type RecordIncidentResult =
  | { kind: 'replay'; row: IncidentRow; attempt: AttemptRow }
  | { kind: 'ignored'; attempt: AttemptRow }
  | { kind: 'saved'; decision: ProtectionCount; stored: boolean; attempt: AttemptRow };

/** What the emails and the assessment page need about the candidate, job and company. */
export interface CandidateContext {
  tenantId: string;
  applicationId: string;
  jobId: string;
  candidateName: string;
  email: string;
  jobTitle: string;
  companyName: string;
  companyWebsite: string | null;
}

export interface EventWrite {
  type: ProctorEventType;
  severity: ProctorSeverity;
  occurredAt: Date;
  detail: Record<string, string | number | boolean>;
}

export interface EventRow extends EventWrite {
  attemptId: string;
}

export interface OutcomeEmailRow {
  id: string;
  tenantId: string;
  applicationId: string;
  roundId: string;
  kind: RoundOutcomeEmailKind;
  nextRoundName: string | null;
  status: EmailDeliveryStatus;
  attempts: number;
  sentAt: Date | null;
}

/** How a failed send is stored: back in the queue (retry / waiting for a public link) or given up. */
export type SendFailure =
  | { retryAt: Date; error: string; countAttempt: boolean }
  | { giveUp: true; error: string };

/**
 * All database access of the round engine. Every HR-facing read filters by tenant id; candidate-facing reads start
 * from the invite found by the token's hash and then use THAT invite's tenant / application ids only.
 */
export abstract class RoundEngineStore {
  // ---- candidate side
  abstract findInviteByHash(tokenHash: string): Promise<InviteRow | null>;
  abstract context(tenantId: string, applicationId: string): Promise<CandidateContext | null>;
  abstract attemptByInvite(inviteId: string): Promise<AttemptRow | null>;
  abstract getAttempt(attemptId: string): Promise<AttemptRow | null>;
  /** Creates the attempt, or returns the one that already exists for this invite (two tabs pressing Start). */
  abstract createAttempt(
    data: Omit<AttemptRow, 'id' | 'answers' | 'codingState' | 'revision' | 'systemPassed' | 'progressedAt' | 'submittedAt' | 'status' | ProtectionFields> & {
      consentVersion: string;
      codingState?: CodingState;
      /** Protection rules shown to the candidate (null = not monitored). */
      protection?: AssessmentProtectionSettings | null;
    },
  ): Promise<AttemptRow>;
  /** DSA rounds: stores the candidate's progress while the attempt is in progress (false = it is not, nothing stored). */
  abstract saveCodingState(attemptId: string, state: CodingState): Promise<boolean>;
  /** Stores the answers if the attempt is in progress and `revision` is newer. Returns the revision now stored. */
  abstract saveAnswers(attemptId: string, revision: number, answers: StoredAnswers): Promise<number | null>;
  /** IN_PROGRESS -> SUBMITTED / TIMED_OUT, once. Optional final answers (applied only when newer). true = this call finished it. */
  abstract finishAttempt(attemptId: string, status: Exclude<AttemptStatus, 'IN_PROGRESS'>, at: Date, final?: { revision: number; answers: StoredAnswers }): Promise<boolean>;
  abstract setSystemPassed(attemptId: string, passed: boolean): Promise<void>;
  /** Takes the right to run the next step (only one caller ever gets true). */
  abstract claimProgress(attemptId: string, at: Date): Promise<boolean>;
  abstract releaseProgress(attemptId: string): Promise<void>;
  abstract countEvents(attemptId: string): Promise<number>;
  abstract addEvents(tenantId: string, attemptId: string, events: EventWrite[]): Promise<void>;

  // ---- protection (one warning counter per attempt)
  /**
   * Under the attempt's row lock: a known incidentId -> its stored row; otherwise `decide` sees the locked attempt and
   * every earlier incident, and its verdict (and the termination it may carry) is stored in the same transaction.
   */
  abstract recordIncident(
    attemptId: string,
    input: { incidentId: string; type: AssessmentIncidentType; detail: string | null; now: Date; maxRows: number },
    decide: (attempt: AttemptRow, prior: IncidentRow[]) => IncidentVerdict,
  ): Promise<RecordIncidentResult>;
  abstract incidents(attemptId: string): Promise<IncidentRow[]>;
  abstract acknowledgeIncident(attemptId: string, warningNumber: number, at: Date): Promise<boolean>;
  /** HR's decision on a terminated attempt in review, once (false = not in review / already decided). */
  abstract decideIntegrity(tenantId: string, attemptId: string, d: { decision: 'ADVANCE' | 'REJECT'; reason: string; by: string | null }, at: Date): Promise<boolean>;

  // ---- progression / emails
  abstract queueInvite(tenantId: string, applicationId: string, jobId: string, roundId: string): Promise<boolean>;
  abstract queueOutcomeEmail(tenantId: string, applicationId: string, roundId: string, kind: RoundOutcomeEmailKind, nextRoundName: string | null): Promise<boolean>;
  /** Students waiting for a round module's round (see RoundEngineService.waitingForModule). */
  abstract moduleCandidates(types: string[], limit: number, tenantId?: string): Promise<{ tenantId: string; applicationId: string; jobId: string; roundId: string }[]>;
  /**
   * Completed AI screenings whose job's FIRST round is an online test (or, with `codingRounds`, a DSA round) the
   * candidate was not invited to yet.
   */
  abstract screeningsToInvite(limit: number, codingRounds?: boolean): Promise<{ tenantId: string; applicationId: string; jobId: string; roundId: string }[]>;
  abstract claimDueInvites(now: Date, staleBefore: Date, limit: number): Promise<InviteRow[]>;
  abstract setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  abstract inviteSent(inviteId: string, sentAt: Date, expiresAt: Date): Promise<void>;
  abstract inviteFailed(inviteId: string, failure: SendFailure): Promise<void>;
  abstract claimDueOutcomeEmails(now: Date, staleBefore: Date, limit: number): Promise<OutcomeEmailRow[]>;
  abstract outcomeEmailSent(id: string, sentAt: Date): Promise<void>;
  abstract outcomeEmailFailed(id: string, failure: SendFailure): Promise<void>;
  /** IN_PROGRESS attempts whose deadline passed before `before`. */
  abstract overdueAttempts(before: Date, limit: number): Promise<AttemptRow[]>;
  /** Finished attempts whose next step never ran (process stopped in between, or grading failed). */
  abstract unprogressedAttempts(finishedBefore: Date, limit: number): Promise<AttemptRow[]>;

  // ---- HR
  abstract forApplication(
    tenantId: string,
    applicationId: string,
  ): Promise<{ invites: InviteRow[]; attempts: AttemptRow[]; events: EventRow[]; outcomeEmails: OutcomeEmailRow[]; incidents: IncidentRow[] } | null>;
  abstract revokeInvite(tenantId: string, applicationId: string, roundId: string, byId: string | null, at: Date): Promise<boolean>;
  /** A FAILED invitation goes back to the queue (a new link is made when it is sent). */
  abstract requeueFailedInvite(tenantId: string, applicationId: string, roundId: string): Promise<boolean>;
}

type InviteDb = Prisma.RoundInviteGetPayload<object>;
type AttemptDb = Prisma.RoundAttemptGetPayload<object>;
type OutcomeDb = Prisma.RoundOutcomeEmailGetPayload<object>;

@Injectable()
export class PrismaRoundEngineStore extends RoundEngineStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async findInviteByHash(tokenHash: string) {
    const row = await this.db.roundInvite.findUnique({ where: { tokenHash } });
    return row ? toInvite(row) : null;
  }

  async context(tenantId: string, applicationId: string): Promise<CandidateContext | null> {
    const app = await this.db.application.findFirst({
      where: { id: applicationId, tenantId },
      select: { jobId: true, email: true, candidate: { select: { name: true, email: true } } },
    });
    if (!app) return null;
    const [job, profile, tenant] = await Promise.all([
      this.db.job.findFirst({ where: { id: app.jobId, tenantId }, select: { title: true } }),
      this.db.companyProfile.findUnique({ where: { tenantId }, select: { name: true, website: true, careersUrl: true } }),
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    if (!job) return null;
    return {
      tenantId,
      applicationId,
      jobId: app.jobId,
      candidateName: app.candidate.name,
      email: app.email ?? app.candidate.email,
      jobTitle: job.title,
      companyName: profile?.name || tenant?.name || 'our company',
      companyWebsite: profile?.website || profile?.careersUrl || null,
    };
  }

  async attemptByInvite(inviteId: string) {
    const row = await this.db.roundAttempt.findUnique({ where: { inviteId } });
    return row ? toAttempt(row) : null;
  }

  async getAttempt(attemptId: string) {
    const row = await this.db.roundAttempt.findUnique({ where: { id: attemptId } });
    return row ? toAttempt(row) : null;
  }

  async createAttempt(data: Parameters<RoundEngineStore['createAttempt']>[0]) {
    // unique invite_id (and application + round): a second Start never makes a second attempt
    await this.db.roundAttempt.createMany({
      data: {
        id: uuidv7(),
        tenantId: data.tenantId,
        applicationId: data.applicationId,
        jobId: data.jobId,
        roundId: data.roundId,
        inviteId: data.inviteId,
        consentVersion: data.consentVersion,
        consentAt: data.startedAt,
        startedAt: data.startedAt,
        deadlineAt: data.deadlineAt,
        ...(data.codingState ? { codingState: data.codingState as unknown as Prisma.InputJsonObject } : {}),
        ...(data.protection ? { protection: data.protection as unknown as Prisma.InputJsonObject } : {}),
      },
      skipDuplicates: true,
    });
    return toAttempt(await this.db.roundAttempt.findUniqueOrThrow({ where: { inviteId: data.inviteId } }));
  }

  async saveCodingState(attemptId: string, state: CodingState) {
    const r = await this.db.roundAttempt.updateMany({ where: { id: attemptId, status: 'IN_PROGRESS' }, data: { codingState: state as unknown as Prisma.InputJsonObject } });
    return r.count > 0;
  }

  async saveAnswers(attemptId: string, revision: number, answers: StoredAnswers) {
    await this.db.roundAttempt.updateMany({
      where: { id: attemptId, status: 'IN_PROGRESS', revision: { lt: revision } },
      data: { revision, answers: answers as Prisma.InputJsonObject },
    });
    const row = await this.db.roundAttempt.findUnique({ where: { id: attemptId }, select: { revision: true } });
    return row?.revision ?? null;
  }

  async finishAttempt(attemptId: string, status: Exclude<AttemptStatus, 'IN_PROGRESS'>, at: Date, final?: { revision: number; answers: StoredAnswers }) {
    return this.db.$transaction(async (tx) => {
      if (final) {
        await tx.roundAttempt.updateMany({
          where: { id: attemptId, status: 'IN_PROGRESS', revision: { lte: final.revision } },
          data: { revision: final.revision, answers: final.answers as Prisma.InputJsonObject },
        });
      }
      const done = await tx.roundAttempt.updateMany({ where: { id: attemptId, status: 'IN_PROGRESS' }, data: { status, submittedAt: at } });
      return done.count > 0;
    });
  }

  async setSystemPassed(attemptId: string, passed: boolean) {
    await this.db.roundAttempt.update({ where: { id: attemptId }, data: { systemPassed: passed } });
  }

  async claimProgress(attemptId: string, at: Date) {
    const r = await this.db.roundAttempt.updateMany({ where: { id: attemptId, progressedAt: null, status: { not: 'IN_PROGRESS' } }, data: { progressedAt: at } });
    return r.count > 0;
  }

  async releaseProgress(attemptId: string) {
    await this.db.roundAttempt.update({ where: { id: attemptId }, data: { progressedAt: null } });
  }

  countEvents(attemptId: string) {
    return this.db.proctorEvent.count({ where: { attemptId } });
  }

  async recordIncident(
    attemptId: string,
    input: { incidentId: string; type: AssessmentIncidentType; detail: string | null; now: Date; maxRows: number },
    decide: (attempt: AttemptRow, prior: IncidentRow[]) => IncidentVerdict,
  ): Promise<RecordIncidentResult> {
    return this.db.$transaction(async (tx) => {
      // the row lock: reports of one attempt are decided one after the other (the counter has one writer)
      await tx.$queryRaw`SELECT 1 AS locked FROM round_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
      const attempt = toAttempt(await tx.roundAttempt.findUniqueOrThrow({ where: { id: attemptId } }));
      const existing = await tx.roundProtectionIncident.findUnique({ where: { attemptId_incidentId: { attemptId, incidentId: input.incidentId } } });
      if (existing) return { kind: 'replay' as const, row: toIncident(existing), attempt };
      const prior = (await tx.roundProtectionIncident.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' } })).map(toIncident);
      const verdict = decide(attempt, prior);
      if (!verdict) return { kind: 'ignored' as const, attempt };
      const { terminationReason, ...decision } = verdict;
      const counted = decision.outcome === 'WARNING' || decision.outcome === 'TERMINATED';
      const stored = counted || prior.length < input.maxRows;
      if (stored) {
        await tx.roundProtectionIncident.create({
          data: {
            id: uuidv7(),
            tenantId: attempt.tenantId,
            attemptId,
            applicationId: attempt.applicationId,
            type: input.type,
            outcome: decision.outcome,
            warningNumber: decision.warningNumber,
            incidentId: input.incidentId,
            occurredAt: input.now,
            detail: input.detail,
          },
        });
      }
      if (counted) {
        await tx.roundAttempt.update({
          where: { id: attemptId },
          data: {
            warningCount: decision.warningCount,
            // the test ends with the answers saved so far; the result waits for HR (no email until HR decided)
            ...(decision.terminate
              ? { status: 'TERMINATED' as const, submittedAt: input.now, terminatedAt: input.now, terminationReason: terminationReason?.slice(0, 300) ?? null, integrityStatus: 'INTEGRITY_VIOLATION_REVIEW' as const }
              : {}),
          },
        });
      }
      const fresh = toAttempt(await tx.roundAttempt.findUniqueOrThrow({ where: { id: attemptId } }));
      return { kind: 'saved' as const, decision, stored, attempt: fresh };
    });
  }

  async incidents(attemptId: string) {
    return (await this.db.roundProtectionIncident.findMany({ where: { attemptId }, orderBy: { occurredAt: 'asc' }, take: 500 })).map(toIncident);
  }

  async acknowledgeIncident(attemptId: string, warningNumber: number, at: Date) {
    const r = await this.db.roundProtectionIncident.updateMany({ where: { attemptId, warningNumber, outcome: 'WARNING', acknowledgedAt: null }, data: { acknowledgedAt: at } });
    return r.count > 0;
  }

  async decideIntegrity(tenantId: string, attemptId: string, d: { decision: 'ADVANCE' | 'REJECT'; reason: string; by: string | null }, at: Date) {
    const r = await this.db.roundAttempt.updateMany({
      where: { id: attemptId, tenantId, status: 'TERMINATED', integrityStatus: 'INTEGRITY_VIOLATION_REVIEW', integrityDecision: null },
      data: { integrityStatus: 'REVIEWED', integrityDecision: d.decision, integrityReason: d.reason, integrityDecidedBy: d.by, integrityDecidedAt: at },
    });
    return r.count > 0;
  }

  async addEvents(tenantId: string, attemptId: string, events: EventWrite[]) {
    if (!events.length) return;
    await this.db.proctorEvent.createMany({
      data: events.map((e) => ({ id: uuidv7(), tenantId, attemptId, type: e.type, severity: e.severity, occurredAt: e.occurredAt, detail: e.detail })),
    });
  }

  async queueInvite(tenantId: string, applicationId: string, jobId: string, roundId: string) {
    const r = await this.db.roundInvite.createMany({ data: { id: uuidv7(), tenantId, applicationId, jobId, roundId }, skipDuplicates: true });
    return r.count > 0;
  }

  async queueOutcomeEmail(tenantId: string, applicationId: string, roundId: string, kind: RoundOutcomeEmailKind, nextRoundName: string | null) {
    const r = await this.db.roundOutcomeEmail.createMany({ data: { id: uuidv7(), tenantId, applicationId, roundId, kind, nextRoundName }, skipDuplicates: true });
    return r.count > 0;
  }

  moduleCandidates(types: string[], limit: number, tenantId?: string) {
    if (!types.length) return Promise.resolve([]);
    const typeList = Prisma.join(types.map((t) => Prisma.sql`${t}::round_type`));
    const scope = tenantId ? Prisma.sql`AND r.tenant_id = ${tenantId}::uuid` : Prisma.empty;
    return this.db.$queryRaw<{ tenantId: string; applicationId: string; jobId: string; roundId: string }[]>(Prisma.sql`
      SELECT a.tenant_id::text AS "tenantId", a.id::text AS "applicationId", a.job_id::text AS "jobId", r.id::text AS "roundId"
        FROM job_rounds r
        JOIN job_round_configs c ON c.job_id = r.job_id AND c.tenant_id = r.tenant_id AND c.status = 'COMPLETE'
        JOIN applications a ON a.job_id = r.job_id AND a.tenant_id = r.tenant_id
       WHERE r.type IN (${typeList}) ${scope}
         -- a plain online test is the round engine's own (isOnlineRound)
         AND NOT (r.pass_mode IS NOT NULL AND r.pass_mode <> 'INTERVIEWER_SCORE'
                  AND EXISTS (SELECT 1 FROM round_questions q WHERE q.round_id = r.id)
                  AND NOT EXISTS (SELECT 1 FROM round_questions q WHERE q.round_id = r.id AND q.kind NOT IN ('MCQ', 'TRUE_FALSE')))
         AND NOT EXISTS (SELECT 1 FROM round_results rr WHERE rr.application_id = a.id AND rr.round_id = r.id)
         AND (
           -- first round: AI screening completed (like the first online test)
           (r.position = 1 AND EXISTS (
              SELECT 1 FROM screening_sessions s
               WHERE s.application_id = a.id AND s.tenant_id = a.tenant_id AND s.status = 'COMPLETED'))
           OR
           -- later round: every earlier round has a result that counts as passed (HR override first)
           (r.position > 1 AND NOT EXISTS (
              SELECT 1 FROM job_rounds e
               WHERE e.job_id = r.job_id AND e.tenant_id = r.tenant_id AND e.position < r.position
                 AND NOT EXISTS (
                   SELECT 1 FROM round_results rr
                    WHERE rr.application_id = a.id AND rr.round_id = e.id
                      AND COALESCE(rr.override_passed, rr.system_passed))))
         )
       ORDER BY a.created_at
       LIMIT ${limit}`);
  }

  screeningsToInvite(limit: number, codingRounds = true) {
    const bankTopics = DSA_BANK.map((p) => dsaTopicFor(p.id));
    return this.db.$queryRaw<{ tenantId: string; applicationId: string; jobId: string; roundId: string }[]>(Prisma.sql`
      SELECT a.tenant_id::text AS "tenantId", a.id::text AS "applicationId", a.job_id::text AS "jobId", r.id::text AS "roundId"
        FROM screening_sessions s
        JOIN applications a ON a.id = s.application_id AND a.tenant_id = s.tenant_id
        JOIN job_round_configs c ON c.job_id = a.job_id AND c.tenant_id = a.tenant_id AND c.status = 'COMPLETE'
        JOIN job_rounds r ON r.job_id = a.job_id AND r.tenant_id = a.tenant_id AND r.position = 1
       WHERE s.status = 'COMPLETED'
         AND r.pass_mode IS NOT NULL AND r.pass_mode <> 'INTERVIEWER_SCORE'
         AND EXISTS (SELECT 1 FROM round_questions q WHERE q.round_id = r.id)
         AND (
           NOT EXISTS (SELECT 1 FROM round_questions q WHERE q.round_id = r.id AND q.kind NOT IN ('MCQ', 'TRUE_FALSE'))
           OR (${codingRounds}::boolean AND NOT EXISTS (
                 SELECT 1 FROM round_questions q WHERE q.round_id = r.id
                    AND NOT (q.kind = 'CODING' AND (q.topics && ${bankTopics}::text[] OR q.coding_spec IS NOT NULL OR q.sql_spec IS NOT NULL))))
         )
         AND NOT EXISTS (SELECT 1 FROM round_invites i WHERE i.application_id = a.id AND i.round_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM round_results rr WHERE rr.application_id = a.id AND rr.round_id = r.id)
       ORDER BY s.completed_at
       LIMIT ${limit}`);
  }

  async claimDueInvites(now: Date, staleBefore: Date, limit: number) {
    const ids = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE round_invites
         SET email_status = 'SENDING'::email_delivery_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM round_invites
          WHERE (email_status = 'QUEUED'::email_delivery_status AND next_attempt_at <= ${now})
             OR (email_status = 'SENDING'::email_delivery_status AND locked_at < ${staleBefore})
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`);
    if (!ids.length) return [];
    const rows = await this.db.roundInvite.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
    return rows.map(toInvite);
  }

  async setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date) {
    await this.db.roundInvite.update({ where: { id: inviteId }, data: { tokenHash, expiresAt } });
  }

  async inviteSent(inviteId: string, sentAt: Date, expiresAt: Date) {
    await this.db.roundInvite.updateMany({
      where: { id: inviteId, emailStatus: 'SENDING' },
      data: { emailStatus: 'SENT', sentAt, expiresAt, lockedAt: null, lastError: null },
    });
  }

  async inviteFailed(inviteId: string, f: SendFailure) {
    await this.db.roundInvite.updateMany({
      where: { id: inviteId, emailStatus: 'SENDING' },
      data:
        'giveUp' in f
          ? // a link that never reached the candidate must not keep working
            { emailStatus: 'FAILED', lockedAt: null, lastError: f.error.slice(0, 500), tokenHash: null, expiresAt: null }
          : { emailStatus: 'QUEUED', lockedAt: null, lastError: f.error.slice(0, 500), nextAttemptAt: f.retryAt, ...(f.countAttempt ? {} : { attempts: { decrement: 1 } }) },
    });
  }

  async claimDueOutcomeEmails(now: Date, staleBefore: Date, limit: number) {
    const ids = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE round_outcome_emails
         SET status = 'SENDING'::email_delivery_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM round_outcome_emails
          WHERE (status = 'QUEUED'::email_delivery_status AND next_attempt_at <= ${now})
             OR (status = 'SENDING'::email_delivery_status AND locked_at < ${staleBefore})
          ORDER BY next_attempt_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`);
    if (!ids.length) return [];
    const rows = await this.db.roundOutcomeEmail.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
    return rows.map(toOutcome);
  }

  async outcomeEmailSent(id: string, sentAt: Date) {
    await this.db.roundOutcomeEmail.updateMany({ where: { id, status: 'SENDING' }, data: { status: 'SENT', sentAt, lockedAt: null, lastError: null } });
  }

  async outcomeEmailFailed(id: string, f: SendFailure) {
    await this.db.roundOutcomeEmail.updateMany({
      where: { id, status: 'SENDING' },
      data:
        'giveUp' in f
          ? { status: 'FAILED', lockedAt: null, lastError: f.error.slice(0, 500) }
          : { status: 'QUEUED', lockedAt: null, lastError: f.error.slice(0, 500), nextAttemptAt: f.retryAt, ...(f.countAttempt ? {} : { attempts: { decrement: 1 } }) },
    });
  }

  async overdueAttempts(before: Date, limit: number) {
    const rows = await this.db.roundAttempt.findMany({ where: { status: 'IN_PROGRESS', deadlineAt: { lt: before } }, orderBy: { deadlineAt: 'asc' }, take: limit });
    return rows.map(toAttempt);
  }

  async unprogressedAttempts(finishedBefore: Date, limit: number) {
    const rows = await this.db.roundAttempt.findMany({
      where: {
        status: { not: 'IN_PROGRESS' },
        progressedAt: null,
        submittedAt: { lt: finishedBefore },
        // a terminated attempt waiting for HR is only retried until it is graded (no next step before HR decided)
        NOT: { integrityStatus: 'INTEGRITY_VIOLATION_REVIEW', systemPassed: { not: null } },
      },
      orderBy: { submittedAt: 'asc' },
      take: limit,
    });
    return rows.map(toAttempt);
  }

  async forApplication(tenantId: string, applicationId: string) {
    const app = await this.db.application.findFirst({ where: { id: applicationId, tenantId }, select: { id: true } });
    if (!app) return null;
    const [invites, attempts, outcomeEmails] = await Promise.all([
      this.db.roundInvite.findMany({ where: { tenantId, applicationId } }),
      this.db.roundAttempt.findMany({ where: { tenantId, applicationId } }),
      this.db.roundOutcomeEmail.findMany({ where: { tenantId, applicationId } }),
    ]);
    const ids = attempts.map((a) => a.id);
    const [events, incidents] = attempts.length
      ? await Promise.all([
          this.db.proctorEvent.findMany({ where: { tenantId, attemptId: { in: ids } }, orderBy: { occurredAt: 'asc' } }),
          this.db.roundProtectionIncident.findMany({ where: { tenantId, attemptId: { in: ids } }, orderBy: { occurredAt: 'asc' } }),
        ])
      : [[], []];
    return {
      incidents: incidents.map(toIncident),
      invites: invites.map(toInvite),
      attempts: attempts.map(toAttempt),
      outcomeEmails: outcomeEmails.map(toOutcome),
      events: events.map((e) => ({
        attemptId: e.attemptId,
        type: e.type,
        severity: e.severity,
        occurredAt: e.occurredAt,
        detail: (e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail) ? e.detail : {}) as Record<string, string | number | boolean>,
      })),
    };
  }

  async revokeInvite(tenantId: string, applicationId: string, roundId: string, byId: string | null, at: Date) {
    const r = await this.db.roundInvite.updateMany({ where: { tenantId, applicationId, roundId, revokedAt: null }, data: { revokedAt: at, revokedById: byId } });
    return r.count > 0;
  }

  async requeueFailedInvite(tenantId: string, applicationId: string, roundId: string) {
    const r = await this.db.roundInvite.updateMany({
      where: { tenantId, applicationId, roundId, emailStatus: 'FAILED', revokedAt: null },
      data: { emailStatus: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedAt: null, tokenHash: null, expiresAt: null },
    });
    return r.count > 0;
  }
}

function toInvite(r: InviteDb): InviteRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    applicationId: r.applicationId,
    jobId: r.jobId,
    roundId: r.roundId,
    tokenHash: r.tokenHash,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    emailStatus: r.emailStatus,
    attempts: r.attempts,
    sentAt: r.sentAt,
    lastError: r.lastError,
  };
}

function toAttempt(r: AttemptDb): AttemptRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    applicationId: r.applicationId,
    jobId: r.jobId,
    roundId: r.roundId,
    inviteId: r.inviteId,
    status: r.status,
    startedAt: r.startedAt,
    deadlineAt: r.deadlineAt,
    submittedAt: r.submittedAt,
    answers: parseStoredAnswers(r.answers),
    codingState: r.codingState === null ? null : parseCodingState(r.codingState),
    revision: r.revision,
    systemPassed: r.systemPassed,
    progressedAt: r.progressedAt,
    protection: r.protection,
    warningCount: r.warningCount,
    integrityStatus: r.integrityStatus,
    terminatedAt: r.terminatedAt,
    terminationReason: r.terminationReason,
    integrityDecision: r.integrityDecision === 'ADVANCE' || r.integrityDecision === 'REJECT' ? r.integrityDecision : null,
    integrityReason: r.integrityReason,
    integrityDecidedBy: r.integrityDecidedBy,
    integrityDecidedAt: r.integrityDecidedAt,
  };
}

function toIncident(r: Prisma.RoundProtectionIncidentGetPayload<object>): IncidentRow {
  return {
    attemptId: r.attemptId,
    type: r.type,
    outcome: r.outcome,
    warningNumber: r.warningNumber,
    incidentId: r.incidentId,
    occurredAt: r.occurredAt,
    detail: r.detail,
    acknowledgedAt: r.acknowledgedAt,
  };
}

function toOutcome(r: OutcomeDb): OutcomeEmailRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    applicationId: r.applicationId,
    roundId: r.roundId,
    kind: r.kind,
    nextRoundName: r.nextRoundName,
    status: r.status,
    attempts: r.attempts,
    sentAt: r.sentAt,
  };
}
