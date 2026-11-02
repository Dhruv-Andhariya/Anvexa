import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { MAILER, MailError, type Mailer } from '../applications';
import { AuditService } from '../audit';
import { ATS_PROCESSOR_CONFIG, type AtsProcessorConfig } from './ats-processor.service';
import { AUTO_SHORTLIST, autoShortlistFromEnv, queueAutoShortlists } from './auto-rejection';
import { SCREENING_BASE_URL } from './decision.service';
import { buildRejectionEmail, buildShortlistEmail } from './emails/decision-emails';
import { isMissingTable } from './screening-settings.service';
import { SCREENING_LINK_DAYS, newScreeningToken, screeningLink } from './screening-link';

export const ALLOW_LOCAL_SCREENING_LINKS = Symbol('ALLOW_LOCAL_SCREENING_LINKS');
export const allowLocalScreeningLinksFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean =>
  ['true', 'on', '1'].includes((env.SCREENING_ALLOW_LOCAL_LINKS ?? '').trim().toLowerCase());

const DAY_MS = 24 * 60 * 60_000;
/** Wait after the 1st, 2nd, 3rd temporary failure; the 4th failure marks the email FAILED (HR can send again). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_ATTEMPTS = 4;
/** A SENDING claim older than this is taken over (the process crashed mid-send). */
const STALE_MS = 15 * 60_000;
const NOT_READY_PAUSE_MS = 5 * 60_000;
/** Network trouble talking to the mail server (see mailer.ts reasons): worth another try. */
const TEMPORARY = /^(ECONNECTION|ESOCKET|ETIMEDOUT|EDNS)\b/;

interface Claimed {
  id: string;
  tenant_id: string;
  application_id: string;
  kind: 'SHORTLIST' | 'REJECTION';
  attempts: number;
}

class PermanentEmailError extends Error {}
/** The shortlist email cannot carry a working screening link yet: kept QUEUED and sent by itself once it can. */
class WaitingForLinkError extends Error {}

/** How often shortlisted candidates without a shortlist email are looked for (queueMissedShortlists). */
const SWEEP_MS = 60_000;

/** How often a held shortlist email checks again for a public screening link. */
const WAIT_FOR_LINK_MS = 5 * 60_000;

/** A link a student can open from their own device (not this machine's localhost). */
export const isPublicLink = (base: string): boolean => {
  try {
    return !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base.replace('{token}', 'x')).hostname);
  } catch {
    return false;
  }
};

/**
 * Sends the decision emails (queued automatically, or by HR) (candidate_emails QUEUED -> SENT / FAILED).
 * A shortlist email waits in the queue (not failed, no attempt used) until its screening link is public. Same claim pattern as the ATS
 * processor, so an email is sent by one process only. The shortlist email's screening link is created right before
 * sending and is valid for 7 days from the send time; only its SHA-256 is stored.
 */
@Injectable()
export class DecisionEmailSender implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('DecisionEmailSender');
  private timer: NodeJS.Timeout | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private running = false;
  private pausedUntil = 0;

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SCREENING_BASE_URL) private readonly screeningBaseUrl: string | null,
    @Inject(ATS_PROCESSOR_CONFIG) private readonly config: AtsProcessorConfig,
    /** Local testing only (e.g. with Mailpit): also send shortlist emails whose link is localhost. */
    @Optional() @Inject(ALLOW_LOCAL_SCREENING_LINKS) private readonly allowLocalLinks: boolean = allowLocalScreeningLinksFromEnv(),
    @Optional() @Inject(AUTO_SHORTLIST) private readonly autoShortlist: boolean = autoShortlistFromEnv(),
  ) {}

  onApplicationBootstrap() {
    if (!(this.config.emailsEnabled ?? this.config.enabled)) return;
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
    if (this.autoShortlist) {
      void this.queueMissedShortlists();
      this.sweepTimer = setInterval(() => void this.queueMissedShortlists(), SWEEP_MS);
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * Safety net for the automatic shortlist emails: every shortlisted, screened candidate without a decision email
   * (shortlisted while AUTO_SHORTLIST_EMAILS was off, by an older API on the shared database, or an email row that was
   * lost) gets one queued. Never throws. Returns the application ids queued.
   */
  async queueMissedShortlists(): Promise<string[]> {
    try {
      const tenants = await this.db.atsEvaluation.findMany({
        where: {
          ...(this.config.onlyTenantId ? { tenantId: this.config.onlyTenantId } : {}),
          status: 'SCORED',
          OR: [{ hrDecision: 'SHORTLISTED' }, { hrDecision: null, systemDecision: 'SHORTLISTED' }],
          application: { decisionEmail: { is: null } },
        },
        distinct: ['tenantId'],
        select: { tenantId: true },
      });
      const queued: string[] = [];
      for (const { tenantId } of tenants) queued.push(...(await queueAutoShortlists(this.db, tenantId, {})));
      if (queued.length) this.logger.log(`queued ${queued.length} missed shortlist email(s)`);
      return queued;
    } catch (err) {
      if (!isMissingTable(err)) this.logger.error(`shortlist sweep failed (${err instanceof Error ? err.name : 'unknown'})`);
      return [];
    }
  }

  /** Sends what is due. Never throws. `at` (tests only) pretends the round runs at that time. */
  async tick(at?: Date): Promise<number> {
    if (this.running || Date.now() < this.pausedUntil) return 0;
    this.running = true;
    let handled = 0;
    try {
      for (;;) {
        const batch = await this.claim(at ?? new Date());
        if (!batch.length) return handled;
        for (const row of batch) await this.send(row); // one by one: mail servers dislike bursts
        handled += batch.length;
      }
    } catch (err) {
      if (isMissingTable(err)) this.pausedUntil = Date.now() + NOT_READY_PAUSE_MS;
      else this.logger.error(`decision email tick failed (${err instanceof Error ? err.name : 'unknown'})`);
      return handled;
    } finally {
      this.running = false;
    }
  }

  /** This process can put a screening link a student can open into a shortlist email. */
  private canSendShortlists(): boolean {
    return !!this.screeningBaseUrl && (this.allowLocalLinks || isPublicLink(this.screeningBaseUrl));
  }

  private claim(now: Date): Promise<Claimed[]> {
    const stale = new Date(now.getTime() - STALE_MS);
    const scope = this.config.onlyTenantId ? Prisma.sql`AND tenant_id = ${this.config.onlyTenantId}::uuid` : Prisma.empty;
    // Several APIs can share one database (teammates' laptops). One without a public link leaves the shortlist
    // emails to one that has it, instead of claiming them only to hold them again.
    const kinds = this.canSendShortlists() ? Prisma.empty : Prisma.sql`AND kind <> 'SHORTLIST'::candidate_email_kind`;
    return this.db.$queryRaw<Claimed[]>(Prisma.sql`
      UPDATE candidate_emails
         SET status = 'SENDING'::email_delivery_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM candidate_emails
          WHERE ((status = 'QUEUED'::email_delivery_status AND next_attempt_at <= ${now})
             OR (status = 'SENDING'::email_delivery_status AND locked_at < ${stale})) ${scope} ${kinds}
          ORDER BY next_attempt_at
          LIMIT 10
          FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id, application_id, kind::text AS kind, attempts`);
  }

  private async send(row: Claimed) {
    let delivered = false;
    try {
      if (!this.mailer.enabled) throw new PermanentEmailError('Email sending is not set up on the server (SMTP / Gmail settings).');
      const app = await this.db.application.findFirst({
        where: { id: row.application_id, tenantId: row.tenant_id },
        select: { email: true, jobId: true, candidate: { select: { name: true, email: true } } },
      });
      if (!app) return; // erased meanwhile (the email row went with it)
      const [job, profile, tenant] = await Promise.all([
        this.db.job.findFirst({ where: { id: app.jobId, tenantId: row.tenant_id }, select: { title: true } }),
        this.db.companyProfile.findUnique({ where: { tenantId: row.tenant_id }, select: { name: true, website: true, careersUrl: true } }),
        this.db.tenant.findUnique({ where: { id: row.tenant_id }, select: { name: true } }),
      ]);
      const input = {
        candidateName: app.candidate.name,
        jobTitle: job?.title ?? 'the role',
        companyName: profile?.name ?? tenant?.name ?? 'our company',
        companyWebsite: profile?.website || profile?.careersUrl || null,
      };

      let message;
      let tokenHash: string | null = null;
      if (row.kind === 'SHORTLIST') {
        // never a broken link in a student's inbox: hold the email until a public link exists (tunnel / deployment)
        if (!this.screeningBaseUrl) throw new WaitingForLinkError('Waiting for the AI screening link to be set up (CAREERS_SITE_URL or AI_SCREENING_URL).');
        if (!this.allowLocalLinks && !isPublicLink(this.screeningBaseUrl)) {
          throw new WaitingForLinkError('Waiting for a public AI screening link (start the public link or deploy the careers site); it is sent automatically then.');
        }
        const token = newScreeningToken();
        tokenHash = token.tokenHash;
        // a fresh link for every send attempt: an earlier attempt's link (never delivered) stops working
        await this.db.screeningInvite.upsert({
          where: { applicationId: row.application_id },
          create: { id: uuidv7(), tenantId: row.tenant_id, applicationId: row.application_id, tokenHash, expiresAt: new Date(Date.now() + SCREENING_LINK_DAYS * DAY_MS) },
          update: { tokenHash, expiresAt: new Date(Date.now() + SCREENING_LINK_DAYS * DAY_MS), usedAt: null },
        });
        message = buildShortlistEmail({ ...input, screeningLink: screeningLink(this.screeningBaseUrl, token.token) });
      } else {
        message = buildRejectionEmail(input);
      }

      await this.mailer.send(app.email ?? app.candidate.email, message);
      delivered = true;
      const sentAt = new Date();
      await this.db.candidateEmail.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'SENT', sentAt, lockedAt: null, lastError: null },
      });
      if (tokenHash) {
        // "within seven days of receiving this email": counted from the moment it was sent
        await this.db.screeningInvite.updateMany({
          where: { applicationId: row.application_id, tokenHash },
          data: { expiresAt: new Date(sentAt.getTime() + SCREENING_LINK_DAYS * DAY_MS) },
        });
      }
      await this.audit.record({
        tenantId: row.tenant_id,
        actorUserId: null,
        action: 'ats.email_sent',
        subjectType: 'application',
        subjectId: row.application_id,
        metadata: { kind: row.kind },
      });
    } catch (err) {
      if (delivered) {
        // the candidate HAS the email: never send it again, never delete its (working) screening link
        this.logger.error(`decision email sent but not recorded application=${row.application_id} (${err instanceof Error ? err.name : 'unknown'})`);
        return;
      }
      await this.failed(row, err);
    }
  }

  private async failed(row: Claimed, err: unknown) {
    if (err instanceof WaitingForLinkError) {
      // not a failure: back in the queue without using up an attempt
      await this.db.candidateEmail
        .updateMany({
          where: { id: row.id, status: 'SENDING' },
          data: { status: 'QUEUED', lockedAt: null, attempts: { decrement: 1 }, lastError: err.message, nextAttemptAt: new Date(Date.now() + WAIT_FOR_LINK_MS) },
        })
        .catch((saveErr) => this.logger.error(`held email not saved application=${row.application_id} (${saveErr instanceof Error ? saveErr.name : 'unknown'})`));
      return;
    }
    const reason =
      err instanceof PermanentEmailError ? err.message : err instanceof MailError ? `The mail server did not accept the email: ${err.reason}` : 'Unexpected error while sending the email.';
    if (!(err instanceof PermanentEmailError) && !(err instanceof MailError)) {
      this.logger.error(`decision email crashed application=${row.application_id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
    const temporary =
      err instanceof MailError ? TEMPORARY.test(err.reason) || (err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500) : !(err instanceof PermanentEmailError);
    const giveUp = !temporary || row.attempts >= MAX_ATTEMPTS;
    try {
      await this.db.candidateEmail.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: giveUp
          ? { status: 'FAILED', lockedAt: null, lastError: reason.slice(0, 500) }
          : { status: 'QUEUED', lockedAt: null, lastError: reason.slice(0, 500), nextAttemptAt: new Date(Date.now() + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)]!) },
      });
      if (giveUp) {
        // a shortlist link that never reached the candidate must not keep working
        await this.db.screeningInvite.deleteMany({ where: { applicationId: row.application_id, tenantId: row.tenant_id } });
        this.logger.warn(`decision email failed application=${row.application_id} kind=${row.kind}`);
      }
    } catch (saveErr) {
      this.logger.error(`decision email failure not saved application=${row.application_id} (${saveErr instanceof Error ? saveErr.name : 'unknown'})`);
    }
  }
}
