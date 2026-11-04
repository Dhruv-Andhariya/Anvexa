import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { MAILER, MailError, type Mailer } from '../applications';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import { buildRoundClearedEmail, buildRoundInviteEmail, buildRoundRejectionEmail } from './emails';
import { codingKindOf, codingMinutes, codingRoundsEnabled } from './coding-round';
import { DEFAULT_LINK_DAYS, assessmentBaseUrlFromEnv, assessmentLink, dsaBaseUrlFromEnv, isPublicLink, newAssessmentToken } from './link';
import { DEADLINE_GRACE_MS, roundKind } from './online-test';
import { ROUND_ENGINE_CLOCK, ROUND_ENGINE_CONFIG, RoundEngineService, type RoundEngineConfig } from './round-engine.service';
import { RoundEngineStore, type InviteRow, type OutcomeEmailRow, type SendFailure } from './round-engine.store';

export const ROUND_ENGINE_WORKER_CONFIG = Symbol('ROUND_ENGINE_WORKER_CONFIG');

export interface RoundEngineWorkerConfig {
  /** The background loop runs (ROUND_ENGINE_PROCESSING, default on; always off in tests). */
  enabled: boolean;
  pollMs: number;
  /** Invite students to the first online round as soon as their AI screening is complete (AUTO_ROUND_INVITES). */
  autoInvite: boolean;
  /** Base of the assessment link (ASSESSMENT_URL or CAREERS_SITE_URL/assessment/{token}); null = not set up. */
  baseUrl: string | null;
  /** Base of the DSA coding page link (DSA_ASSESSMENT_URL or CANDIDATE_APP_URL/dsa/{token}); null = not set up. */
  dsaBaseUrl: string | null;
  linkDays: number;
  /** Local testing only (e.g. Mailpit): also email links whose host is localhost (ROUND_ALLOW_LOCAL_LINKS). */
  allowLocalLinks: boolean;
}

const on = (v: string | undefined, dflt: boolean) => {
  const s = (v ?? '').trim().toLowerCase();
  return s ? !['off', 'false', '0', 'no'].includes(s) : dflt;
};
const int = (v: string | undefined, dflt: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

export const roundEngineWorkerConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): RoundEngineWorkerConfig => ({
  enabled: on(env.ROUND_ENGINE_PROCESSING, true) && env.NODE_ENV !== 'test' && !env.VITEST,
  pollMs: int(env.ROUND_ENGINE_POLL_MS, 5000, 1000, 600_000),
  autoInvite: on(env.AUTO_ROUND_INVITES, true),
  baseUrl: assessmentBaseUrlFromEnv(env),
  dsaBaseUrl: dsaBaseUrlFromEnv(env),
  linkDays: int(env.ASSESSMENT_LINK_DAYS, DEFAULT_LINK_DAYS, 1, 60),
  allowLocalLinks: on(env.ROUND_ALLOW_LOCAL_LINKS, false),
});

const DAY_MS = 24 * 60 * 60_000;
/** Wait after the 1st, 2nd, 3rd temporary failure; the 4th marks the email FAILED (HR can send an invite again). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_ATTEMPTS = 4;
const STALE_MS = 15 * 60_000;
const WAIT_FOR_LINK_MS = 5 * 60_000;
const NOT_READY_PAUSE_MS = 5 * 60_000;
const TEMPORARY = /^(ECONNECTION|ESOCKET|ETIMEDOUT|EDNS)\b/;

class PermanentEmailError extends Error {}
/** The invitation cannot carry a working link yet: kept QUEUED (no attempt used) and sent once it can. */
class WaitingForLinkError extends Error {}

/** "Table does not exist": P2021 from Prisma queries, P2010 + Postgres 42P01 from raw SQL. */
const isMissingTable = (err: unknown) => {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  // P2022: a column the code needs is missing (migration 20261102120000_dsa_round not applied)
  return e?.code === 'P2021' || e?.code === 'P2022' || (e?.code === 'P2010' && e.meta?.code === '42P01');
};

/**
 * The round engine's background loop (one tick at a time per process; several API processes are safe thanks to the
 * claim pattern + unique keys): invites students whose AI screening is complete, sends invitations and outcome
 * emails, submits tests whose time ran out, and finishes next steps that were interrupted.
 */
@Injectable()
export class RoundEngineWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('RoundEngineWorker');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pausedUntil = 0;

  constructor(
    @Inject(RoundEngineStore) private readonly store: RoundEngineStore,
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ROUND_ENGINE_WORKER_CONFIG) private readonly config: RoundEngineWorkerConfig,
    @Inject(ROUND_ENGINE_CONFIG) private readonly engineConfig: RoundEngineConfig,
    @Optional() @Inject(ROUND_ENGINE_CLOCK) private readonly now: () => Date = () => new Date(),
  ) {}

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    if (!this.config.baseUrl) this.logger.warn('assessment link not set up (ASSESSMENT_URL / CAREERS_SITE_URL): invitations wait in the queue');
    if (!this.config.dsaBaseUrl) this.logger.warn('DSA link not set up (DSA_ASSESSMENT_URL / CANDIDATE_APP_URL): coding round invitations wait in the queue');
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One round of everything that is due. Never throws. */
  async tick(): Promise<void> {
    if (this.running || Date.now() < this.pausedUntil) return;
    this.running = true;
    try {
      if (this.config.autoInvite) await this.discover();
      await this.sweepOverdue();
      await this.recover();
      await this.sendInvites();
      await this.sendOutcomeEmails();
    } catch (err) {
      if (isMissingTable(err)) {
        this.pausedUntil = Date.now() + NOT_READY_PAUSE_MS;
        this.logger.warn('round engine tables or columns are missing (migrations 20261030120000_round_engine / 20261102120000_dsa_round not applied) - paused 5 minutes');
      } else {
        this.logger.error(`round engine tick failed (${err instanceof Error ? err.name : 'unknown'})`);
      }
    } finally {
      this.running = false;
    }
  }

  /** AI screening COMPLETED -> invitation to the job's first round (when that round is an online test). */
  async discover(): Promise<number> {
    let queued = 0;
    for (const row of await this.store.screeningsToInvite(50, codingRoundsEnabled())) {
      if (await this.engine.inviteToFirstRound(row)) queued++;
    }
    return queued;
  }

  /** Attempts whose time ran out while nobody had the page open: submitted with the saved answers. */
  async sweepOverdue(): Promise<void> {
    const before = new Date(this.now().getTime() - DEADLINE_GRACE_MS);
    for (const a of await this.store.overdueAttempts(before, 20)) await this.engine.finish(a, 'TIMED_OUT');
  }

  /** Finished attempts whose next step did not happen (process stopped in between): try again. */
  async recover(): Promise<void> {
    for (const a of await this.store.unprogressedAttempts(new Date(this.now().getTime() - 60_000), 10)) await this.engine.progress(a.id);
  }

  async sendInvites(): Promise<number> {
    const now = this.now();
    const batch = await this.store.claimDueInvites(now, new Date(now.getTime() - STALE_MS), 10);
    for (const row of batch) await this.sendInvite(row); // one by one: mail servers dislike bursts
    return batch.length;
  }

  async sendOutcomeEmails(): Promise<number> {
    const now = this.now();
    const batch = await this.store.claimDueOutcomeEmails(now, new Date(now.getTime() - STALE_MS), 10);
    for (const row of batch) await this.sendOutcome(row);
    return batch.length;
  }

  private async sendInvite(row: InviteRow) {
    let delivered = false;
    try {
      if (row.revokedAt) throw new PermanentEmailError('The invitation was withdrawn by HR.');
      if (!this.mailer.enabled) throw new PermanentEmailError('Email sending is not set up on the server (SMTP / Gmail settings).');
      const ctx = await this.store.context(row.tenantId, row.applicationId);
      if (!ctx) return; // application erased meanwhile (the invite went with it)
      const config = await this.rounds.forRoundEngine(row.tenantId, row.jobId);
      const ordered = [...(config?.rounds ?? [])].sort((a, b) => a.position - b.position);
      const round = ordered.find((r) => r.id === row.roundId);
      const kind = round ? roundKind(round) : null;
      if (!round || !kind) throw new PermanentEmailError('This round is no longer an online test.');
      const coding = kind === 'CODING';
      const base = coding ? this.config.dsaBaseUrl : this.config.baseUrl;
      // never a broken link in a candidate's inbox: hold the invitation until a public link exists
      if (!base) {
        throw new WaitingForLinkError(coding ? 'Waiting for the DSA link to be set up (DSA_ASSESSMENT_URL or CANDIDATE_APP_URL).' : 'Waiting for the assessment link to be set up (ASSESSMENT_URL or CAREERS_SITE_URL).');
      }
      if (!this.config.allowLocalLinks && !isPublicLink(base)) {
        throw new WaitingForLinkError('Waiting for a public assessment link (start the public link or deploy the site); it is sent automatically then.');
      }
      const previous = ordered.filter((r) => r.position < round.position).at(-1);

      const token = newAssessmentToken();
      const expiresAt = new Date(this.now().getTime() + this.config.linkDays * DAY_MS);
      // a fresh link for every send attempt: an earlier attempt's link (never delivered) stops working
      await this.store.setInviteToken(row.id, token.tokenHash, expiresAt);
      const message = buildRoundInviteEmail({
        candidateName: ctx.candidateName,
        jobTitle: ctx.jobTitle,
        companyName: ctx.companyName,
        companyWebsite: ctx.companyWebsite,
        roundName: round.name,
        clearedStep: previous ? previous.name : 'AI screening round',
        timeLimitMinutes: coding ? codingMinutes(round) : round.timeLimitMinutes,
        questionCount: round.questions.length,
        instructions: round.description,
        link: assessmentLink(base, token.token),
        linkExpiresAt: expiresAt,
        cameraRequired: coding ? this.engineConfig.codingCameraRequired === true : this.engineConfig.cameraRequired,
        maxWarnings: coding ? null : (this.engineConfig.protection?.maxWarnings ?? null),
        coding,
        ...(coding ? { codingKind: codingKindOf(round) } : {}),
      });
      await this.mailer.send(ctx.email, message);
      delivered = true;
      const sentAt = this.now();
      // "valid for N days" counts from the moment the email was sent
      await this.store.inviteSent(row.id, sentAt, new Date(sentAt.getTime() + this.config.linkDays * DAY_MS));
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: null,
        action: 'assessment.invite_sent',
        subjectType: 'application',
        subjectId: row.applicationId,
        metadata: { roundId: row.roundId },
      });
    } catch (err) {
      if (delivered) {
        // the candidate HAS the email: never send it again, never break its (working) link
        this.logger.error(`assessment invite sent but not recorded application=${row.applicationId}`);
        return;
      }
      await this.store.inviteFailed(row.id, this.failure(row.attempts, err)).catch(() => undefined);
      if (!(err instanceof WaitingForLinkError)) this.logger.warn(`assessment invite not sent application=${row.applicationId} (${reasonOf(err)})`);
    }
  }

  private async sendOutcome(row: OutcomeEmailRow) {
    let delivered = false;
    try {
      if (!this.mailer.enabled) throw new PermanentEmailError('Email sending is not set up on the server (SMTP / Gmail settings).');
      const ctx = await this.store.context(row.tenantId, row.applicationId);
      if (!ctx) return;
      const config = await this.rounds.forRoundEngine(row.tenantId, ctx.jobId);
      const roundName = config?.rounds.find((r) => r.id === row.roundId)?.name ?? 'assessment';
      const base = { candidateName: ctx.candidateName, jobTitle: ctx.jobTitle, companyName: ctx.companyName, companyWebsite: ctx.companyWebsite, roundName };
      const message =
        row.kind === 'REJECTED'
          ? buildRoundRejectionEmail(base)
          : buildRoundClearedEmail({ ...base, nextRoundName: row.kind === 'CLEARED_NEXT_BY_HR' ? row.nextRoundName : null });
      await this.mailer.send(ctx.email, message);
      delivered = true;
      await this.store.outcomeEmailSent(row.id, this.now());
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: null,
        action: 'assessment.outcome_email_sent',
        subjectType: 'application',
        subjectId: row.applicationId,
        metadata: { roundId: row.roundId, kind: row.kind },
      });
    } catch (err) {
      if (delivered) {
        this.logger.error(`assessment outcome email sent but not recorded application=${row.applicationId}`);
        return;
      }
      await this.store.outcomeEmailFailed(row.id, this.failure(row.attempts, err)).catch(() => undefined);
      this.logger.warn(`assessment outcome email not sent application=${row.applicationId} (${reasonOf(err)})`);
    }
  }

  private failure(attempts: number, err: unknown): SendFailure {
    const now = this.now().getTime();
    if (err instanceof WaitingForLinkError) return { retryAt: new Date(now + WAIT_FOR_LINK_MS), error: err.message, countAttempt: false };
    const error = reasonOf(err);
    const temporary =
      err instanceof MailError
        ? TEMPORARY.test(err.reason) || (err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500)
        : !(err instanceof PermanentEmailError);
    if (!temporary || attempts >= MAX_ATTEMPTS) return { giveUp: true, error };
    return { retryAt: new Date(now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!), error, countAttempt: true };
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof PermanentEmailError || err instanceof WaitingForLinkError) return err.message;
  if (err instanceof MailError) return `The mail server did not accept the email: ${err.reason}`;
  return 'Unexpected error while sending the email.';
}
