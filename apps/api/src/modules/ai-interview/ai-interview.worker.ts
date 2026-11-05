import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { isFeatureOn } from '../../common/feature-flags';
import { CurrentLinkCheck, LINK_STILL_OPENS, isTemporaryTunnel, linkStillOpens } from '../../common/public-link';
import { MAILER, MailError, type Mailer } from '../applications';
import { AuditService } from '../audit';
import { RoundEngineService } from '../round-engine';
import { RoundsConfigService } from '../rounds-config';
import { AiInterviewHrService } from './ai-interview-hr.service';
import { AI_INTERVIEW_CLOCK, AiInterviewService } from './ai-interview.service';
import { AiInterviewStore, type InviteRow, type SendFailure } from './ai-interview.store';
import { buildInterviewInviteEmail } from './emails';
import { configFromRound } from './flow';
import { DEFAULT_LINK_DAYS, interviewBaseUrlFromEnv, interviewLink, isPublicLink, newInterviewToken } from './link';

export const AI_INTERVIEW_WORKER_CONFIG = Symbol('AI_INTERVIEW_WORKER_CONFIG');

export interface AiInterviewWorkerConfig {
  /** The background loop runs (AI_INTERVIEW_PROCESSING, default on; always off in tests and with FEATURE_AI_INTERVIEW=off). */
  enabled: boolean;
  pollMs: number;
  /** Invite students as soon as they passed the round before (AUTO_AI_INTERVIEW_INVITES, default on). */
  autoInvite: boolean;
  /** Base of the interview link (AI_INTERVIEW_URL or CAREERS_SITE_URL/interview/{token}); null = not set up. */
  baseUrl: string | null;
  linkDays: number;
  /** Local testing only (Mailpit): also email links whose host is localhost (ROUND_ALLOW_LOCAL_LINKS). */
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

export const aiInterviewWorkerConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): AiInterviewWorkerConfig => ({
  enabled: on(env.AI_INTERVIEW_PROCESSING, true) && isFeatureOn('ai_interview', env) && env.NODE_ENV !== 'test' && !env.VITEST,
  pollMs: int(env.AI_INTERVIEW_POLL_MS, 10_000, 1000, 600_000),
  autoInvite: on(env.AUTO_AI_INTERVIEW_INVITES, true),
  baseUrl: interviewBaseUrlFromEnv(env),
  linkDays: int(env.AI_INTERVIEW_LINK_DAYS, DEFAULT_LINK_DAYS, 1, 60),
  allowLocalLinks: on(env.ROUND_ALLOW_LOCAL_LINKS, false),
});

const DAY_MS = 24 * 60 * 60_000;
/** Wait after the 1st, 2nd, 3rd temporary failure; the 4th marks the email FAILED. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_ATTEMPTS = 4;
const STALE_MS = 15 * 60_000;
const WAIT_FOR_LINK_MS = 5 * 60_000;
const NOT_READY_PAUSE_MS = 5 * 60_000;
/** A session is only swept when its time ran out this long ago with no activity (the page may still be sending). */
const SWEEP_SLACK_SECONDS = 120;
const TEMPORARY = /^(ECONNECTION|ESOCKET|ETIMEDOUT|EDNS)\b/;

class PermanentEmailError extends Error {}
/** The invitation cannot carry a working link yet: kept QUEUED (no attempt used) and sent once it can. */
class WaitingForLinkError extends Error {}

const isMissingTable = (err: unknown) => {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  return e?.code === 'P2021' || e?.code === 'P2022' || (e?.code === 'P2010' && (e.meta?.code === '42P01' || e.meta?.code === '42703'));
};

/**
 * The ai-interview module's background loop (one tick at a time per process; several API processes are safe: unique
 * keys, conditional updates and FOR UPDATE SKIP LOCKED claims):
 *  - invite: students the round engine hands to this module (passed every earlier round, whichever HR chose)
 *  - send the invitation emails (a fresh link per attempt; held while no public link exists)
 *  - end interviews whose time ran out with the page closed (answers so far are kept)
 *  - make / retry reports, and hand HR decisions to the round engine when that was interrupted
 */
@Injectable()
export class AiInterviewWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('AiInterviewWorker');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pausedUntil = 0;

  constructor(
    @Inject(AiInterviewStore) private readonly store: AiInterviewStore,
    @Inject(AiInterviewService) private readonly interviews: AiInterviewService,
    @Inject(AiInterviewHrService) private readonly hr: AiInterviewHrService,
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AI_INTERVIEW_WORKER_CONFIG) private readonly config: AiInterviewWorkerConfig,
    @Optional() @Inject(AI_INTERVIEW_CLOCK) private readonly now: () => Date = () => new Date(),
    /** Tests only: whether the site behind a link answers. */
    @Optional() @Inject(LINK_STILL_OPENS) private readonly stillOpens: (base: string) => Promise<boolean> = linkStillOpens,
  ) {}

  private readonly linkCheck = new CurrentLinkCheck((base) => this.stillOpens(base));

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    if (!this.config.baseUrl) this.logger.warn('interview link not set up (AI_INTERVIEW_URL / CAREERS_SITE_URL): invitations wait in the queue');
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
    void this.resendDeadLinks();
  }

  /**
   * The interview link follows CAREERS_SITE_URL, and a Cloudflare quick tunnel gets a new address on every restart:
   * links already emailed then stop opening. At start, every student whose interview is not finished (not opened,
   * started or paused) and whose emailed link no longer opens gets the invitation again with a fresh link; the
   * interview itself continues where it stopped (it belongs to the invitation, not to the link). A link that still
   * opens (e.g. a teammate's API on the shared database) is left alone. Never throws. Returns the invite ids queued.
   */
  async resendDeadLinks(): Promise<string[]> {
    const base = this.config.baseUrl;
    if (!base || (!this.config.allowLocalLinks && !isPublicLink(base))) return [];
    const queued: string[] = [];
    try {
      const opens = new Map<string, Promise<boolean>>();
      for (const invite of await this.store.invitesWithOtherLink(base, this.now(), 200)) {
        if (invite.linkBase) {
          if (!opens.has(invite.linkBase)) opens.set(invite.linkBase, this.stillOpens(invite.linkBase).catch(() => false));
          if (await opens.get(invite.linkBase)) continue;
        }
        if (!(await this.store.requeueInvite(invite.id, this.now()))) continue; // another API queued it first
        queued.push(invite.id);
        await this.audit.record({ tenantId: invite.tenantId, actorUserId: null, action: 'ai_interview.link_replaced', subjectType: 'application', subjectId: invite.applicationId, metadata: { roundId: invite.roundId } });
      }
      if (queued.length) this.logger.log(`interview link address changed: invitation queued again for ${queued.length} student(s)`);
    } catch (err) {
      if (!isMissingTable(err)) this.logger.error(`interview link refresh failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
    return queued;
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
      await this.sendInvites();
      await this.sweep();
      await this.reports();
      await this.recover();
    } catch (err) {
      if (isMissingTable(err)) {
        this.pausedUntil = Date.now() + NOT_READY_PAUSE_MS;
        this.logger.warn('ai interview tables are missing (migration 20261103170000_ai_technical_interview not applied) - paused 5 minutes');
      } else {
        this.logger.error(`ai interview tick failed (${err instanceof Error ? err.name : 'unknown'})`);
      }
    } finally {
      this.running = false;
    }
  }

  /** Students waiting for an AI interview round -> one queued invitation each. */
  async discover(): Promise<number> {
    let queued = 0;
    for (const row of await this.engine.waitingForModule('AI_INTERVIEW', { limit: 100 })) {
      if (!(await this.store.queueInvite(row))) continue;
      queued++;
      await this.audit.record({ tenantId: row.tenantId, actorUserId: null, action: 'ai_interview.invite_queued', subjectType: 'application', subjectId: row.applicationId, metadata: { roundId: row.roundId } });
    }
    return queued;
  }

  async sendInvites(): Promise<number> {
    const now = this.now();
    const batch = await this.store.claimDueInvites(now, new Date(now.getTime() - STALE_MS), 10);
    for (const row of batch) await this.sendInvite(row); // one by one: mail servers dislike bursts
    return batch.length;
  }

  /** Interviews whose time ran out while nobody had the page open: they end with the answers saved so far. */
  async sweep(): Promise<void> {
    const before = new Date(this.now().getTime() - SWEEP_SLACK_SECONDS * 1000);
    for (const s of await this.store.idleSessions(before, 20)) {
      const opened = await this.interviews.openSession(s);
      if (opened) await this.interviews.sweepTime(opened, SWEEP_SLACK_SECONDS);
    }
  }

  async reports(): Promise<void> {
    for (const s of await this.store.sessionsNeedingReport(this.now(), 3)) await this.interviews.generateReport(s.id);
  }

  async recover(): Promise<void> {
    for (const s of await this.store.decidedNotRecorded(10)) {
      try {
        await this.hr.record(s);
      } catch (err) {
        this.logger.warn(`interview decision not recorded yet application=${s.applicationId} (${err instanceof Error ? err.name : 'unknown'})`);
      }
    }
  }

  private async sendInvite(row: InviteRow) {
    let delivered = false;
    try {
      if (!this.mailer.enabled) throw new PermanentEmailError('Email sending is not set up on the server (SMTP / Gmail settings).');
      const ctx = await this.store.context(row.tenantId, row.applicationId);
      if (!ctx) return; // application erased meanwhile (the invite went with it)
      const config = await this.rounds.forRoundEngine(row.tenantId, row.jobId);
      const ordered = [...(config?.rounds ?? [])].sort((a, b) => a.position - b.position);
      const round = ordered.find((r) => r.id === row.roundId);
      if (!round || round.type !== 'AI_INTERVIEW') throw new PermanentEmailError('This round is no longer an AI interview.');
      const base = this.config.baseUrl;
      // never a broken link in a candidate's inbox: hold the invitation until a public link exists
      if (!base) throw new WaitingForLinkError('Waiting for the interview link to be set up (AI_INTERVIEW_URL or CAREERS_SITE_URL).');
      if (!this.config.allowLocalLinks && !isPublicLink(base)) {
        throw new WaitingForLinkError('Waiting for a public interview link (start the public link or deploy the site); it is sent automatically then.');
      }
      // a quick tunnel that is not running (or was replaced) does not exist any more: never email a dead link
      if (!this.config.allowLocalLinks && isTemporaryTunnel(base) && !(await this.linkCheck.opens(base))) {
        throw new WaitingForLinkError('The interview link does not open right now (the public tunnel in CAREERS_SITE_URL is not running). Run "pnpm start:public"; it is sent automatically once the link opens.');
      }
      const previous = ordered.filter((r) => r.position < round.position).at(-1);
      const token = newInterviewToken();
      const expiresAt = new Date(this.now().getTime() + this.config.linkDays * DAY_MS);
      // a fresh link for every send attempt: an earlier attempt's link (never delivered) stops working
      await this.store.setInviteToken(row.id, token.tokenHash, expiresAt, base);
      const message = buildInterviewInviteEmail({
        candidateName: ctx.candidateName,
        jobTitle: ctx.jobTitle,
        companyName: ctx.companyName,
        companyWebsite: ctx.companyWebsite,
        roundName: round.name,
        clearedStep: previous ? previous.name : 'AI screening round',
        minutes: configFromRound(round, true).durationMinutes,
        instructions: round.description,
        link: interviewLink(base, token.token),
        linkExpiresAt: expiresAt,
        linkReplaced: row.sentAt !== null,
      });
      await this.mailer.send(ctx.email, message);
      delivered = true;
      const sentAt = this.now();
      // "valid for N days" counts from the moment the email was sent
      await this.store.inviteSent(row.id, sentAt, new Date(sentAt.getTime() + this.config.linkDays * DAY_MS));
      await this.audit.record({ tenantId: row.tenantId, actorUserId: null, action: 'ai_interview.invite_sent', subjectType: 'application', subjectId: row.applicationId, metadata: { roundId: row.roundId } });
    } catch (err) {
      if (delivered) {
        // the candidate HAS the email: never send it again, never break its (working) link
        this.logger.error(`interview invite sent but not recorded application=${row.applicationId}`);
        return;
      }
      await this.store.inviteFailed(row.id, this.failure(row.attempts, err)).catch(() => undefined);
      if (!(err instanceof WaitingForLinkError)) this.logger.warn(`interview invite not sent application=${row.applicationId} (${reasonOf(err)})`);
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
