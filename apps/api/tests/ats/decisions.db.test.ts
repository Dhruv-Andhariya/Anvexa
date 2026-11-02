import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { MailError, type Mailer } from '../../src/modules/applications';
import type { EmailMessage } from '../../src/modules/applications/email/confirmation-email';
import { AtsProcessor, type AtsProcessorConfig } from '../../src/modules/ats/ats-processor.service';
import type { AtsWorkerClient, ScreenInput } from '../../src/modules/ats/ats-worker.client';
import { DecisionEmailSender } from '../../src/modules/ats/decision-email.sender';
import { DecisionService } from '../../src/modules/ats/decision.service';
import { hashScreeningToken } from '../../src/modules/ats/screening-link';
import { ScreeningSettingsService } from '../../src/modules/ats/screening-settings.service';
import { MemoryAudit } from '../in-memory';
import { screenResult, seedApplication, seedCompany, seedJob } from './seed';

/** HR decisions + decision emails against a REAL database (TEST_DATABASE_URL, see ats-processor.db.test.ts). */
const DB = process.env.TEST_DATABASE_URL;
const CONFIG: AtsProcessorConfig = { enabled: false, pollMs: 1000, concurrency: 2, maxAttempts: 3, staleMs: 60_000 };
const SCREEN_URL = 'https://screen.example/start';
const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya Shah' };

class FakeMailer implements Mailer {
  enabled = true;
  sent: { to: string; message: EmailMessage }[] = [];
  fail: Error | null = null;
  async send(to: string, message: EmailMessage) {
    if (this.fail) throw this.fail;
    this.sent.push({ to, message });
  }
}

describe.skipIf(!DB)('HR decisions and decision emails (real database)', () => {
  let db: PrismaClient;
  let prisma: PrismaService;
  let audit: MemoryAudit;
  let mailer: FakeMailer;
  let tenantId: string;

  /** autoReject off by default: most tests here are about what HR sends by hand. */
  const decisions = (screeningUrl: string | null = SCREEN_URL, autoReject = false) => new DecisionService(prisma, audit as never, screeningUrl, autoReject, false);
  const sender = (screeningUrl: string | null = SCREEN_URL) => new DecisionEmailSender(prisma, mailer, audit as never, screeningUrl, { ...CONFIG, onlyTenantId: tenantId });
  const emailOf = (applicationId: string) => db.candidateEmail.findUnique({ where: { applicationId } });

  /** Two screened candidates for one job (min score 70): one at 82 (shortlisted), one at 40 (not shortlisted). */
  async function screened(autoReject = false, autoShortlist = false) {
    const job = await seedJob(db, tenantId, { title: 'Backend Developer', minAtsScore: 70 });
    const strong = await seedApplication(db, tenantId, job, { name: 'Asha Patel', resume: Buffer.from('%PDF-1.4 strong') });
    const weak = await seedApplication(db, tenantId, job, { name: 'Ravi Kumar', resume: Buffer.from('%PDF-1.4 weak') });
    // the fake worker scores by the resume it is given
    const worker = {
      screen: vi.fn(async (input: ScreenInput) => screenResult(input.resume.bytes.toString().endsWith('strong') ? 82 : 40)),
    } as unknown as AtsWorkerClient;
    const p = new AtsProcessor(prisma, worker, { get: vi.fn() } as never, new ScreeningSettingsService(prisma, audit as never, autoReject, autoShortlist), audit as never, { ...CONFIG, onlyTenantId: tenantId }, autoReject, autoShortlist);
    await p.tick();
    return { job, strong, weak };
  }

  beforeAll(async () => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    db = new PrismaClient({ datasourceUrl: DB });
    prisma = db as unknown as PrismaService;
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    audit = new MemoryAudit();
    mailer = new FakeMailer();
    tenantId = await seedCompany(db);
    await db.companyProfile.create({ data: { tenantId, name: 'Acme Analytics', industry: 'SaaS', description: 'Analytics.', website: 'https://acme.dev', benefits: [] } });
  });

  it('(automatic rejections off) nothing is emailed until HR asks; then each candidate gets the email of THEIR decision', async () => {
    const { strong, weak } = await screened();
    expect(await sender().tick()).toBe(0);
    expect(mailer.sent).toHaveLength(0);

    const res = await decisions().sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [strong.applicationId, weak.applicationId] }, ACTOR);
    expect(res.queued).toEqual([weak.applicationId]);
    expect(res.skipped).toEqual([{ applicationId: strong.applicationId, reason: 'This candidate is shortlisted, not rejected.' }]);
    await sender().tick();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(weak.email);
    expect(mailer.sent[0]!.message.subject).toBe('Application Update – Backend Developer at Acme Analytics');
    expect(mailer.sent[0]!.message.text).toContain('Dear Ravi Kumar,');
    expect(await emailOf(weak.applicationId)).toMatchObject({ kind: 'REJECTION', status: 'SENT', attempts: 1, requestedById: ACTOR.id });
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['ats.emails_requested', 'ats.email_sent']));
  });

  it('a shortlist email carries a one-candidate screening link valid for 7 days from sending; only its hash is stored', async () => {
    const { strong } = await screened();
    await decisions().sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [strong.applicationId] }, ACTOR);
    const before = Date.now();
    await sender().tick();
    const { message } = mailer.sent[0]!;
    expect(message.subject).toBe("Congratulations! You've Been Shortlisted for Backend Developer – Next Step: AI Screening");
    const token = new URL(message.text.match(/https:\/\/screen\.example\/start\?token=\S+/)![0]).searchParams.get('token')!;
    const invite = await db.screeningInvite.findUniqueOrThrow({ where: { applicationId: strong.applicationId } });
    expect(invite.tokenHash).toBe(hashScreeningToken(token));
    expect(JSON.stringify(invite)).not.toContain(token);
    const sentAt = (await emailOf(strong.applicationId))!.sentAt!.getTime();
    expect(sentAt).toBeGreaterThanOrEqual(before - 1000);
    expect(invite.expiresAt.getTime() - sentAt).toBeGreaterThanOrEqual(7 * 24 * 3600_000 - 1000);
    expect(invite.expiresAt.getTime() - sentAt).toBeLessThanOrEqual(7 * 24 * 3600_000 + 1000);
  });

  it('shortlist emails wait for the screening link; rejections do not', async () => {
    const { strong, weak } = await screened();
    const err = await decisions(null).sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [strong.applicationId] }, ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: 'SCREENING_LINK_NOT_SET' });
    expect(await emailOf(strong.applicationId)).toBeNull();
    expect((await decisions(null).sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [weak.applicationId] }, ACTOR)).queued).toHaveLength(1);
  });

  it('a technical failure is never a rejection: no rejection email for a resume in HR review', async () => {
    const job = await seedJob(db, tenantId);
    const broken = await seedApplication(db, tenantId, job, { resume: null });
    // automatic rejections ON: still no rejection for a resume that could not be screened
    await new AtsProcessor(prisma, { screen: vi.fn() } as never, { get: vi.fn() } as never, new ScreeningSettingsService(prisma, audit as never, true, false), audit as never, { ...CONFIG, onlyTenantId: tenantId }, true, false).tick();
    expect(await emailOf(broken.applicationId)).toBeNull();
    expect((await db.atsEvaluation.findUniqueOrThrow({ where: { applicationId: broken.applicationId } })).status).toBe('NEEDS_REVIEW');
    const res = await decisions().sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [broken.applicationId] }, ACTOR);
    expect(res.queued).toEqual([]);
    expect(res.skipped[0]!.reason).toMatch(/not been screened successfully/);
    expect((await decisions().setDecision(tenantId, broken.applicationId, { decision: 'NOT_SHORTLISTED' }, ACTOR).catch((e) => e)).getStatus()).toBe(409);
    // HR can send it back to screening
    expect(await decisions().retryScreening(tenantId, broken.applicationId, ACTOR)).toEqual({ applicationId: broken.applicationId, status: 'PENDING' });
  });

  it('HR has the final say: an override changes which email may go, until an email was sent', async () => {
    const { weak } = await screened();
    await decisions().setDecision(tenantId, weak.applicationId, { decision: 'SHORTLISTED' }, ACTOR);
    expect(await db.atsEvaluation.findUniqueOrThrow({ where: { applicationId: weak.applicationId } })).toMatchObject({
      systemDecision: 'NOT_SHORTLISTED',
      hrDecision: 'SHORTLISTED',
      hrDecidedById: ACTOR.id,
    });
    expect((await decisions().sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [weak.applicationId] }, ACTOR)).queued).toEqual([]);
    expect((await decisions().sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [weak.applicationId] }, ACTOR)).queued).toEqual([weak.applicationId]);
    await sender().tick();
    const late = await decisions().setDecision(tenantId, weak.applicationId, { decision: 'NOT_SHORTLISTED' }, ACTOR).catch((e) => e);
    expect(late.getResponse()).toMatchObject({ code: 'EMAIL_ALREADY_SENT' });
  });

  it('one decision email per candidate, even when HR clicks twice at once', async () => {
    const { weak } = await screened();
    const req = { kind: 'REJECTION', applicationIds: [weak.applicationId, weak.applicationId] };
    const results = await Promise.all([decisions().sendEmails(tenantId, req, ACTOR), decisions().sendEmails(tenantId, req, ACTOR)]);
    expect(results.flatMap((r) => r.queued)).toEqual([weak.applicationId]);
    await Promise.all([sender().tick(), sender().tick()]);
    expect(mailer.sent).toHaveLength(1);
    expect((await decisions().sendEmails(tenantId, req, ACTOR)).skipped[0]!.reason).toMatch(/already sent/);
  });

  it('a temporary mail error is retried; a refused email ends FAILED and HR can send it again', async () => {
    const { strong, weak } = await screened();
    mailer.fail = new MailError('ECONNECTION: could not reach the mail server');
    await decisions().sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [weak.applicationId] }, ACTOR);
    await sender().tick();
    expect(await emailOf(weak.applicationId)).toMatchObject({ status: 'QUEUED', attempts: 1 });
    mailer.fail = null;
    await sender().tick(new Date(Date.now() + 10 * 60_000));
    expect(await emailOf(weak.applicationId)).toMatchObject({ status: 'SENT', attempts: 2 });

    mailer.fail = new MailError('EENVELOPE: the recipient address was refused', 550);
    await decisions().sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [strong.applicationId] }, ACTOR);
    await sender().tick();
    expect(await emailOf(strong.applicationId)).toMatchObject({ status: 'FAILED' });
    expect(await db.screeningInvite.findUnique({ where: { applicationId: strong.applicationId } })).toBeNull(); // undelivered link is dead
    mailer.fail = null;
    expect((await decisions().sendEmails(tenantId, { kind: 'SHORTLIST', applicationIds: [strong.applicationId] }, ACTOR)).queued).toEqual([strong.applicationId]);
    await sender().tick();
    expect(await emailOf(strong.applicationId)).toMatchObject({ status: 'SENT' });
  });

  it('without a mail server the email is FAILED with a clear reason (nothing is lost silently)', async () => {
    const { weak } = await screened();
    mailer.enabled = false;
    await decisions().sendEmails(tenantId, { kind: 'REJECTION', applicationIds: [weak.applicationId] }, ACTOR);
    await sender().tick();
    expect(await emailOf(weak.applicationId)).toMatchObject({ status: 'FAILED', lastError: expect.stringContaining('not set up') });
  });

  it('another company cannot decide on or email this company’s candidates', async () => {
    const { strong, weak } = await screened();
    const other = await seedCompany(db, 'Other');
    expect((await decisions().setDecision(other, strong.applicationId, { decision: 'NOT_SHORTLISTED' }, ACTOR).catch((e) => e)).getStatus()).toBe(404);
    const res = await decisions().sendEmails(other, { kind: 'REJECTION', applicationIds: [weak.applicationId] }, ACTOR);
    expect(res).toEqual({ queued: [], skipped: [{ applicationId: weak.applicationId, reason: 'Not found.' }] });
    expect((await decisions().retryScreening(other, weak.applicationId, ACTOR).catch((e) => e)).getStatus()).toBe(404);
  });

  it('rejects invalid requests', async () => {
    for (const body of [{ kind: 'SPAM', applicationIds: ['0192f3a1-7c2e-7a10-8b2c-123456789abc'] }, { kind: 'REJECTION', applicationIds: [] }, { kind: 'REJECTION', applicationIds: ['nope'] }]) {
      expect((await decisions().sendEmails(tenantId, body, ACTOR).catch((e) => e)).getStatus()).toBe(400);
    }
  });

  describe('automatic rejection emails', () => {
    it('a candidate below the minimum gets the rejection email right after screening; a shortlisted one waits for HR', async () => {
      const { strong, weak } = await screened(true);
      expect(await emailOf(weak.applicationId)).toMatchObject({ kind: 'REJECTION', status: 'QUEUED', requestedById: null });
      expect(await emailOf(strong.applicationId)).toBeNull();
      await sender().tick();
      expect(mailer.sent.map((m) => [m.to, m.message.subject])).toEqual([[weak.email, 'Application Update – Backend Developer at Acme Analytics']]);
      expect(await emailOf(weak.applicationId)).toMatchObject({ status: 'SENT' });
      expect(audit.entries.find((e) => e.action === 'ats.scored' && e.subjectId === weak.applicationId)!.metadata).toMatchObject({ autoRejected: true });
    });

    it('raising the minimum score emails the candidates who are now below it', async () => {
      const { job, strong } = await screened(true);
      await new ScreeningSettingsService(prisma, audit as never, true, false).save(tenantId, job.jobId, { minAtsScore: 90 }, ACTOR);
      expect(await emailOf(strong.applicationId)).toMatchObject({ kind: 'REJECTION', status: 'QUEUED' });
    });

    it('HR choosing "not shortlisted" sends the rejection at once; it cannot be undone after', async () => {
      const { strong } = await screened(true);
      const res = await decisions(SCREEN_URL, true).setDecision(tenantId, strong.applicationId, { decision: 'NOT_SHORTLISTED' }, ACTOR);
      expect(res).toMatchObject({ rejectionEmailQueued: true });
      const undo = await decisions(SCREEN_URL, true).setDecision(tenantId, strong.applicationId, { decision: 'SHORTLISTED' }, ACTOR).catch((e) => e);
      expect(undo.getResponse()).toMatchObject({ code: 'EMAIL_ALREADY_SENT' });
    });

    it('never twice: a candidate already emailed is not emailed again by a later threshold change', async () => {
      const { job, weak } = await screened(true);
      await sender().tick();
      await new ScreeningSettingsService(prisma, audit as never, true, false).save(tenantId, job.jobId, { minAtsScore: 95 }, ACTOR);
      await sender().tick();
      expect(mailer.sent.filter((m) => m.to === weak.email)).toHaveLength(1);
    });
  });

  describe('automatic shortlist emails', () => {
    it('a candidate at or above the minimum gets the shortlist email with a working screening link right after screening', async () => {
      const { strong, weak } = await screened(true, true);
      expect(await emailOf(strong.applicationId)).toMatchObject({ kind: 'SHORTLIST', status: 'QUEUED', requestedById: null });
      expect(await emailOf(weak.applicationId)).toMatchObject({ kind: 'REJECTION', status: 'QUEUED' });
      await sender().tick();
      const mail = mailer.sent.find((m) => m.to === strong.email)!;
      const token = new URL(mail.message.text.match(/https:\/\/screen\.example\/start\S*/)![0]).searchParams.get('token')!;
      const invite = await db.screeningInvite.findUnique({ where: { applicationId: strong.applicationId } });
      expect(invite!.tokenHash).toBe(hashScreeningToken(token)); // the emailed link opens this candidate's screening
      expect(await emailOf(strong.applicationId)).toMatchObject({ status: 'SENT' });
      expect(audit.entries.find((e) => e.action === 'ats.scored' && e.subjectId === strong.applicationId)!.metadata).toMatchObject({ autoShortlisted: true });
    });

    it('an API with only a localhost link leaves the email queued for one with a public link (shared database)', async () => {
      const { strong } = await screened(false, true);
      const local = new DecisionEmailSender(prisma, mailer, audit as never, 'http://localhost:3300/screening/{token}', { ...CONFIG, onlyTenantId: tenantId }, false);
      await local.tick();
      expect(mailer.sent).toHaveLength(0);
      const held = await emailOf(strong.applicationId);
      expect(held).toMatchObject({ kind: 'SHORTLIST', status: 'QUEUED', attempts: 0 });
      expect(await db.screeningInvite.findUnique({ where: { applicationId: strong.applicationId } })).toBeNull();
      // another API (or this one after the tunnel is up) has the public link: it sends at once - nobody clicked anything
      await sender().tick();
      expect(mailer.sent.map((m) => m.to)).toEqual([strong.email]);
      expect(await emailOf(strong.applicationId)).toMatchObject({ status: 'SENT' });
    });

    it('safety net: a shortlisted candidate without an email (e.g. shortlisted while auto was off) gets it queued and sent', async () => {
      const { strong } = await screened(true, false);
      expect(await emailOf(strong.applicationId)).toBeNull();
      const s = sender();
      expect(await s.queueMissedShortlists()).toContain(strong.applicationId);
      expect(await s.queueMissedShortlists()).toEqual([]); // never twice
      await s.tick();
      expect(mailer.sent.map((m) => m.to)).toContain(strong.email);
      expect(await emailOf(strong.applicationId)).toMatchObject({ kind: 'SHORTLIST', status: 'SENT' });
    });

    it('off: shortlisted candidates wait for HR, exactly as before', async () => {
      const { strong } = await screened(true, false);
      expect(await emailOf(strong.applicationId)).toBeNull();
    });

    it('HR shortlisting a candidate sends the shortlist email at once; lowering the minimum emails the newly shortlisted', async () => {
      const { job, weak } = await screened(false, false);
      await new ScreeningSettingsService(prisma, audit as never, false, true).save(tenantId, job.jobId, { minAtsScore: 30 }, ACTOR);
      expect(await emailOf(weak.applicationId)).toMatchObject({ kind: 'SHORTLIST', status: 'QUEUED' });

      const other = await screened(false, false);
      const res = await new DecisionService(prisma, audit as never, SCREEN_URL, false, true).setDecision(tenantId, other.weak.applicationId, { decision: 'SHORTLISTED' }, ACTOR);
      expect(res).toMatchObject({ shortlistEmailQueued: true });
    });

    it('never twice: a re-run of the threshold does not email a shortlisted candidate again', async () => {
      const { job, strong } = await screened(false, true);
      await sender().tick();
      await new ScreeningSettingsService(prisma, audit as never, false, true).save(tenantId, job.jobId, { minAtsScore: 60 }, ACTOR);
      await sender().tick();
      expect(mailer.sent.filter((m) => m.to === strong.email)).toHaveLength(1);
    });
  });
});
