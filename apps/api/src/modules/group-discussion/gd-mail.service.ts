import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { SecretBox } from '../../common/secret-box';
import { uuidv7 } from '../../common/uuidv7';
import { MAILER, MailError, type Mailer } from '../applications';
import { AuditService } from '../audit';
import { buildGdHrLinkEmail, buildGdInviteEmail, buildGdReminderEmail, buildGdResultEmail } from './emails';
import { durationMinutes, settingsOf } from './gd-live.service';
import { GD_CLOCK } from './gd.service';
import { gdBaseUrlFromEnv, gdLink, hrLiveLink, isPublicGdLink, newGdToken } from './link';

export const GD_MAIL_CONFIG = Symbol('GD_MAIL_CONFIG');

/**
 * Where a student who just qualified for a GD stands (for the coding page, which takes them there in the same tab).
 * READY carries their personal GD link - the same one their invitation email carries.
 */
export type GdStudentLink =
  | { status: 'JOINING_POOL' }
  | { status: 'WAITING'; waiting: number; needed: number }
  | { status: 'SCHEDULED'; startsAt: string }
  | { status: 'READY'; startsAt: string; link: string }
  | { status: 'NONE' };

export interface GdMailConfig {
  /** Base of the student link (GD_URL or CAREERS_SITE_URL/gd/{token}); null = not set up. */
  baseUrl: string | null;
  /** Local testing only (Mailpit): also email localhost links (GD_ALLOW_LOCAL_LINKS / ROUND_ALLOW_LOCAL_LINKS). */
  allowLocalLinks: boolean;
  /** Reminder this many minutes before the start. */
  reminderMinutes: number;
  env: NodeJS.ProcessEnv;
}

const on = (v: string | undefined) => ['on', 'true', '1', 'yes'].includes((v ?? '').trim().toLowerCase());

export const gdMailConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): GdMailConfig => ({
  baseUrl: gdBaseUrlFromEnv(env),
  allowLocalLinks: on(env.GD_ALLOW_LOCAL_LINKS) || on(env.ROUND_ALLOW_LOCAL_LINKS),
  reminderMinutes: 15,
  env,
});

type EmailRow = Prisma.GdEmailGetPayload<object>;

const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MAX_ATTEMPTS = 4;
const STALE_MS = 15 * 60_000;
const WAIT_FOR_LINK_MS = 2 * 60_000;
const TEMPORARY = /^(ECONNECTION|ESOCKET|ETIMEDOUT|EDNS)\b/;

class PermanentEmailError extends Error {}
class WaitingForLinkError extends Error {}

/**
 * The GD email log and its sender (gd_emails): every invitation, reminder, HR link and result is one row with a
 * unique dedupe key, claimed with FOR UPDATE SKIP LOCKED, retried after 1, 5, 15 minutes, then FAILED.
 * The student's link token is made when the invitation is SENT (only its hash + a sealed copy are stored); the
 * reminder carries the same link again.
 */
@Injectable()
export class GdMailService {
  private readonly logger = new Logger('GdMail');
  private readonly box = SecretBox.fromEnv();

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GD_MAIL_CONFIG) private readonly config: GdMailConfig,
    @Inject(GD_CLOCK) private readonly now: () => Date,
  ) {}

  /**
   * The student's GD state after they qualified: still being added to the pool, waiting for enough students (needed =
   * AUTO_GD_MIN_STUDENTS), scheduled (link not made yet - the invitation goes out within seconds), or READY with the
   * personal link. Only for the student's own application (the caller proved it with their round link).
   */
  async studentLink(tenantId: string, applicationId: string, roundId: string, needed: number): Promise<GdStudentLink> {
    const p = await this.db.gdParticipant.findFirst({ where: { tenantId, applicationId, roundId }, include: { batch: true } });
    if (!p) return { status: 'JOINING_POOL' };
    if (p.attendance === 'WAITING' || !p.batch) {
      const waiting = await this.db.gdParticipant.count({ where: { tenantId, roundId, attendance: 'WAITING' } });
      return { status: 'WAITING', waiting, needed };
    }
    if (!['SCHEDULED', 'LOBBY_OPEN', 'LIVE'].includes(p.batch.status)) return { status: 'NONE' };
    const startsAt = p.batch.startsAt.toISOString();
    const base = this.config.baseUrl;
    if (!p.tokenSealed || !this.box || !base) return { status: 'SCHEDULED', startsAt };
    return { status: 'READY', startsAt, link: gdLink(base, this.box.decrypt(p.tokenSealed)) };
  }

  /** Queues what is due: invitations for scheduled students, HR links, reminders shortly before the start. */
  async queueDue(): Promise<number> {
    const now = this.now();
    let queued = 0;
    const toInvite = await this.db.gdParticipant.findMany({
      where: { attendance: 'SCHEDULED', batch: { status: 'SCHEDULED', startsAt: { gt: now }, event: { status: 'SCHEDULED' } } },
      include: { application: { select: { email: true, candidate: { select: { email: true } } } } },
      take: 200,
    });
    for (const p of toInvite) {
      queued += await this.queue(p.tenantId, p.batchId!, p.id, 'INVITE', p.application.email ?? p.application.candidate.email, `INVITE:${p.id}:${p.batchId}`);
    }

    const batches = await this.db.gdBatch.findMany({
      where: { status: 'SCHEDULED', startsAt: { gt: now }, event: { status: 'SCHEDULED', createdById: { not: null } } },
      include: { event: { select: { createdById: true } } },
      take: 200,
    });
    for (const b of batches) {
      const user = await this.db.user.findUnique({ where: { id: b.event.createdById! }, select: { email: true, isActive: true } });
      if (user?.isActive) queued += await this.queue(b.tenantId, b.id, null, 'HR_LINK', user.email, `HR_LINK:${b.id}:${b.event.createdById}`);
    }

    const soon = new Date(now.getTime() + this.config.reminderMinutes * 60_000);
    const toRemind = await this.db.gdParticipant.findMany({
      where: { attendance: 'INVITED', tokenSealed: { not: null }, batch: { status: { in: ['SCHEDULED', 'LOBBY_OPEN'] }, startsAt: { lte: soon, gt: new Date(now.getTime() - 60_000) } } },
      include: { application: { select: { email: true, candidate: { select: { email: true } } } } },
      take: 200,
    });
    for (const p of toRemind) {
      queued += await this.queue(p.tenantId, p.batchId!, p.id, 'REMINDER', p.application.email ?? p.application.candidate.email, `REMINDER:${p.id}:${p.batchId}`);
    }
    return queued;
  }

  /** Result emails after HR confirmed a group (called by the results service). */
  async queueResult(tenantId: string, batchId: string, participantId: string, selected: boolean, toEmail: string): Promise<void> {
    await this.queue(tenantId, batchId, participantId, selected ? 'SELECTED' : 'NOT_SELECTED', toEmail, `RESULT:${participantId}:${batchId}`);
  }

  async sendDue(): Promise<number> {
    const now = this.now();
    const ids = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE gd_emails
         SET status = 'SENDING'::email_delivery_status, locked_at = ${now}, attempts = attempts + 1, updated_at = ${now}
       WHERE id IN (
         SELECT id FROM gd_emails
          WHERE (status = 'QUEUED'::email_delivery_status AND next_attempt_at <= ${now})
             OR (status = 'SENDING'::email_delivery_status AND locked_at < ${new Date(now.getTime() - STALE_MS)})
          ORDER BY next_attempt_at
          LIMIT 10
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`);
    if (!ids.length) return 0;
    const rows = await this.db.gdEmail.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
    for (const row of rows) await this.send(row); // one by one: mail servers dislike bursts
    return rows.length;
  }

  private async queue(tenantId: string, batchId: string, participantId: string | null, kind: EmailRow['kind'], toEmail: string, dedupeKey: string): Promise<number> {
    const r = await this.db.gdEmail.createMany({ data: { id: uuidv7(), tenantId, batchId, participantId, kind, toEmail, dedupeKey }, skipDuplicates: true });
    return r.count;
  }

  private async send(row: EmailRow) {
    let delivered = false;
    try {
      if (!this.mailer.enabled) throw new PermanentEmailError('Email sending is not set up on the server (SMTP / Gmail settings).');
      const batch = await this.db.gdBatch.findUnique({ where: { id: row.batchId }, include: { event: true } });
      if (!batch) throw new PermanentEmailError('The group no longer exists.');
      const ctx = await this.context(batch.tenantId, batch.event.jobId, batch.event.roundId);
      const settings = settingsOf(batch.event);
      const size = await this.db.gdParticipant.count({ where: { batchId: batch.id } });

      let message;
      let afterSend: (() => Promise<unknown>) | null = null;
      if (row.kind === 'HR_LINK') {
        const user = batch.event.createdById ? await this.db.user.findUnique({ where: { id: batch.event.createdById }, select: { name: true } }) : null;
        message = buildGdHrLinkEmail({ hrName: user?.name ?? 'there', companyName: ctx.companyName, jobTitle: ctx.jobTitle, roundName: ctx.roundName, groupNumber: batch.number, students: size, startsAt: batch.startsAt, link: hrLiveLink(this.config.env, batch.id) });
      } else {
        const p = await this.db.gdParticipant.findUnique({ where: { id: row.participantId! }, include: { application: { select: { candidate: { select: { name: true } } } } } });
        if (!p) throw new PermanentEmailError('The student was removed.');
        const base = { candidateName: p.application.candidate.name, jobTitle: ctx.jobTitle, companyName: ctx.companyName, companyWebsite: ctx.companyWebsite };
        if (row.kind === 'SELECTED' || row.kind === 'NOT_SELECTED') {
          message = buildGdResultEmail({ ...base, roundName: ctx.roundName, selected: row.kind === 'SELECTED' });
        } else {
          if (p.batchId !== batch.id) throw new PermanentEmailError('The student was moved to another group.');
          const closesAt = batch.startsAt.getTime() + settings.graceMinutes * 60_000;
          if (this.now().getTime() >= closesAt) throw new PermanentEmailError('Too late: the joining window of the group has closed.');
          const linkBase = this.linkBase();
          let token: string;
          if (row.kind === 'INVITE') {
            if (!this.box) throw new PermanentEmailError('ENCRYPTION_KEY is not set on the server (needed for GD links).');
            const t = newGdToken();
            token = t.token;
            const expiresAt = new Date(batch.endsAt.getTime() + 24 * 60 * 60_000);
            // a fresh link for every send attempt: an earlier attempt's link (never delivered) stops working
            await this.db.gdParticipant.update({ where: { id: p.id }, data: { tokenHash: t.tokenHash, tokenSealed: this.box.encrypt(t.token), tokenExpiresAt: expiresAt } });
            afterSend = () => this.db.gdParticipant.updateMany({ where: { id: p.id, attendance: 'SCHEDULED' }, data: { attendance: 'INVITED' } });
          } else {
            if (!this.box || !p.tokenSealed) throw new PermanentEmailError('The student has no link to remind them of.');
            token = this.box.decrypt(p.tokenSealed);
          }
          const link = gdLink(linkBase, token);
          message =
            row.kind === 'INVITE'
              ? buildGdInviteEmail({ ...base, roundName: ctx.roundName, startsAt: batch.startsAt, graceMinutes: settings.graceMinutes, durationMinutes: durationMinutes(settings, size), link })
              : buildGdReminderEmail({ ...base, roundName: ctx.roundName, startsAt: batch.startsAt, graceMinutes: settings.graceMinutes, link });
        }
      }
      await this.mailer.send(row.toEmail, message);
      delivered = true;
      await this.db.gdEmail.updateMany({ where: { id: row.id, status: 'SENDING' }, data: { status: 'SENT', sentAt: this.now(), lockedAt: null, lastError: null } });
      if (afterSend) await afterSend();
      await this.audit.record({
        tenantId: row.tenantId,
        actorUserId: null,
        action: 'gd.email_sent',
        subjectType: row.participantId ? 'gd_participant' : 'gd_batch',
        subjectId: row.participantId ?? row.batchId,
        metadata: { kind: row.kind, batchId: row.batchId },
      });
    } catch (err) {
      if (delivered) {
        this.logger.error(`GD email sent but not recorded id=${row.id}`);
        return;
      }
      await this.failed(row, err).catch(() => undefined);
      if (!(err instanceof WaitingForLinkError)) this.logger.warn(`GD ${row.kind} email not sent id=${row.id} (${reasonOf(err)})`);
    }
  }

  /** Never a broken link in a student's inbox: wait until the careers site has a public address. */
  private linkBase(): string {
    const base = this.config.baseUrl;
    if (!base) throw new WaitingForLinkError('Waiting for the GD link to be set up (GD_URL or CAREERS_SITE_URL).');
    if (!this.config.allowLocalLinks && !isPublicGdLink(base)) throw new WaitingForLinkError('Waiting for a public link (start the public link or deploy the careers site).');
    return base;
  }

  private async failed(row: EmailRow, err: unknown) {
    const now = this.now().getTime();
    if (err instanceof WaitingForLinkError) {
      await this.db.gdEmail.updateMany({
        where: { id: row.id, status: 'SENDING' },
        data: { status: 'QUEUED', lockedAt: null, lastError: err.message, nextAttemptAt: new Date(now + WAIT_FOR_LINK_MS), attempts: { decrement: 1 } },
      });
      return;
    }
    const error = reasonOf(err).slice(0, 500);
    const temporary =
      err instanceof MailError
        ? TEMPORARY.test(err.reason) || (err.responseCode !== undefined && err.responseCode >= 400 && err.responseCode < 500)
        : !(err instanceof PermanentEmailError);
    if (!temporary || row.attempts >= MAX_ATTEMPTS) {
      await this.db.gdEmail.updateMany({ where: { id: row.id, status: 'SENDING' }, data: { status: 'FAILED', lockedAt: null, lastError: error } });
      return;
    }
    await this.db.gdEmail.updateMany({
      where: { id: row.id, status: 'SENDING' },
      data: { status: 'QUEUED', lockedAt: null, lastError: error, nextAttemptAt: new Date(now + BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)]!) },
    });
  }

  private async context(tenantId: string, jobId: string, roundId: string) {
    const [job, profile, tenant, round] = await Promise.all([
      this.db.job.findFirst({ where: { id: jobId, tenantId }, select: { title: true } }),
      this.db.companyProfile.findUnique({ where: { tenantId }, select: { name: true, website: true, careersUrl: true } }),
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
      this.db.jobRound.findFirst({ where: { id: roundId, tenantId }, select: { name: true } }),
    ]);
    return {
      jobTitle: job?.title ?? '',
      companyName: profile?.name || tenant?.name || 'our company',
      companyWebsite: profile?.website || profile?.careersUrl || null,
      roundName: round?.name ?? 'Group Discussion',
    };
  }
}

function reasonOf(err: unknown): string {
  if (err instanceof PermanentEmailError || err instanceof WaitingForLinkError) return err.message;
  if (err instanceof MailError) return `The mail server did not accept the email: ${err.reason}`;
  return 'Unexpected error while sending the email.';
}
