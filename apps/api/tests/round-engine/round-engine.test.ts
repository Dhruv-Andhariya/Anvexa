import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { MailError } from '../../src/modules/applications';
import { AssessmentsService } from '../../src/modules/assessments';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { buildRoundInviteEmail } from '../../src/modules/round-engine/emails';
import { assessmentBaseUrlFromEnv, dsaBaseUrlFromEnv, hashAssessmentToken, isPublicLink, newAssessmentToken } from '../../src/modules/round-engine/link';
import { isOnlineRound, nextStep } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { RoundEngineWorker, type RoundEngineWorkerConfig } from '../../src/modules/round-engine/round-engine.worker';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, OTHER_JOB, OTHER_TENANT, TENANT, student } from '../rounds/fakes';
import { FakeMailer, MemoryRoundEngineStore } from './fakes';

const OTHER_APP = '0192f3a1-aaaa-7000-8000-000000000002';
const T0 = new Date('2026-11-02T09:00:00Z');
const DAY = 24 * 60 * 60_000;

/** Aptitude & English Literacy: 4 single-answer MCQs (1 mark, option 1 right) + 1 "select all" (2 marks, options 0 + 2). */
const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude & English Literacy',
  description: 'Answer every question. No calculators.',
  timeLimitMinutes: 30,
  passRule: { mode: 'MARKS', value: 4 },
  questions: [
    ...Array.from({ length: 4 }, (_, i) => ({ kind: 'MCQ' as const, text: `Q${i + 1}`, options: ['a', 'b', 'c'], correct: [1] })),
    { kind: 'MCQ' as const, text: 'Pick the nouns', options: ['cat', 'run', 'tree'], correct: [0, 2], marks: 2 },
  ],
};
const reading: RoundInput = {
  type: 'CUSTOM',
  name: 'Reading Test',
  passRule: { mode: 'PERCENTAGE', value: 50 },
  questions: [
    { kind: 'TRUE_FALSE', text: 'The sky is blue', correct: [0] },
    { kind: 'TRUE_FALSE', text: 'Fire is cold', correct: [1] },
  ],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let now: Date;
let roundsStore: MemoryRoundsConfigStore;
let results: MemoryAssessmentsStore;
let store: MemoryRoundEngineStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let assessments: AssessmentsService;
let engine: RoundEngineService;
let saved: SavedRound[];

const clock = () => new Date(now);
const status = (err: unknown) => (err as HttpException).getStatus();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);
const ago = (ms: number) => new Date(now.getTime() - ms);

/** A sent invitation for APP (or another app) with a real token; returns the raw token (as in the email). */
function invite(roundId: string, opts: { app?: string; tenant?: string; job?: string; expiresAt?: Date; revoked?: boolean } = {}) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-dddd-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: opts.tenant ?? TENANT,
    applicationId: opts.app ?? APP,
    jobId: opts.job ?? JOB,
    roundId,
    tokenHash: t.tokenHash,
    expiresAt: opts.expiresAt ?? new Date(now.getTime() + 7 * DAY),
    revokedAt: opts.revoked ? now : null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: now,
    lastError: null,
  });
  return t.token;
}

/** Answers to the aptitude round: the first `right` single-answer questions right, the rest wrong; multi right or not. */
function aptitudeAnswers(right: number, multiRight: boolean) {
  const qs = saved[0]!.questions;
  return [
    ...qs.slice(0, 4).map((q, i) => ({ questionId: q.id, selected: [i < right ? 1 : 0], marked: false })),
    { questionId: qs[4]!.id, selected: multiRight ? [0, 2] : [0], marked: false },
  ];
}

function worker(config: Partial<RoundEngineWorkerConfig> = {}, mailer = new FakeMailer()) {
  const w = new RoundEngineWorker(
    store,
    engine,
    rounds,
    mailer,
    audit,
    { enabled: false, pollMs: 5000, autoInvite: true, baseUrl: 'https://careers.example.com/assessment/{token}', dsaBaseUrl: null, linkDays: 7, allowLocalLinks: false, ...config },
    { cameraRequired: true },
    clock,
  );
  return { w, mailer };
}

beforeEach(async () => {
  now = new Date(T0);
  roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  roundsStore.addJob(OTHER_TENANT, OTHER_JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' }, { id: OTHER_JOB, tenantId: OTHER_TENANT, title: 'Other' });
  results.students.push({ ...student(), tenantId: TENANT }, { ...student({ applicationId: OTHER_APP, jobId: OTHER_JOB }), tenantId: OTHER_TENANT });
  store = new MemoryRoundEngineStore();
  const ctx = { jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: 'https://pattern.example.com' };
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', ...ctx });
  store.contexts.set(OTHER_APP, { tenantId: OTHER_TENANT, applicationId: OTHER_APP, jobId: OTHER_JOB, candidateName: 'Ravi Shah', email: 'ravi@example.com', ...ctx });
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  assessments = new AssessmentsService(results, rounds, audit);
  engine = new RoundEngineService(store, rounds, assessments, audit, { cameraRequired: true }, clock);
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, reading, interview], complete: true }, ACTOR)).rounds;
  await rounds.save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude], complete: true }, ACTOR);
});

describe('which rounds run online', () => {
  it('runs MCQ / true-false rounds with a score rule, and leaves interviews and open questions to HR', () => {
    expect(isOnlineRound(saved[0]!)).toBe(true);
    expect(isOnlineRound(saved[1]!)).toBe(true);
    expect(isOnlineRound(saved[2]!)).toBe(false);
    expect(isOnlineRound({ ...saved[0]!, questions: [...saved[0]!.questions, { ...saved[0]!.questions[0]!, id: 'x', kind: 'DESCRIPTIVE' }] })).toBe(false);
  });

  it('goes to the next round in HR order, stops at the first failure', () => {
    expect(nextStep(saved, saved[0]!, false)).toEqual({ kind: 'EMAIL', email: 'REJECTED', nextRoundName: null });
    expect(nextStep(saved, saved[0]!, true)).toMatchObject({ kind: 'INVITE', round: { id: saved[1]!.id } });
    expect(nextStep(saved, saved[1]!, true)).toEqual({ kind: 'EMAIL', email: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' });
    expect(nextStep(saved.slice(0, 1), saved[0]!, true)).toEqual({ kind: 'EMAIL', email: 'CLEARED_ALL', nextRoundName: null });
  });
});

describe('the assessment link (candidate)', () => {
  it('opens a valid invitation: job, company, round, duration, marks - and no questions before the start', async () => {
    const v = await engine.view(invite(saved[0]!.id));
    expect(v).toMatchObject({
      status: 'NOT_STARTED',
      candidateFirstName: 'Asha',
      companyName: 'Pattern Labs',
      jobTitle: 'AI Engineer',
      roundName: 'Aptitude & English Literacy',
      instructions: 'Answer every question. No calculators.',
      timeLimitMinutes: 30,
      questionCount: 5,
      totalMarks: 6,
      cameraRequired: true,
      attempt: null,
    });
  });

  it('refuses a malformed or unknown token (404) without revealing anything', async () => {
    for (const token of [undefined, 'short', 'x'.repeat(43)]) {
      const err = await caught(engine.view(token));
      expect([status(err), code(err)]).toEqual([404, 'ASSESSMENT_LINK_INVALID']);
    }
  });

  it('refuses an expired link (410) before the start, and a withdrawn one at any time', async () => {
    const expired = invite(saved[0]!.id, { expiresAt: ago(1) });
    expect(code(await caught(engine.view(expired)))).toBe('ASSESSMENT_LINK_EXPIRED');
    expect(code(await caught(engine.start(expired, { consent: true })))).toBe('ASSESSMENT_LINK_EXPIRED');

    store.invites.length = 0;
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    store.invites[0]!.revokedAt = now;
    const err = await caught(engine.save(token, { revision: 1, answers: [] }));
    expect([status(err), code(err)]).toEqual([410, 'ASSESSMENT_LINK_REVOKED']);
  });

  it('a link only ever reaches its own application, job and company', async () => {
    // an invite whose application belongs to another job (tampered row) is refused
    const token = invite(saved[0]!.id, { job: OTHER_JOB });
    expect(code(await caught(engine.view(token)))).toBe('ASSESSMENT_LINK_INVALID');
    // another company's candidate gets their own company's round, never ours
    const other = invite(saved[0]!.id, { app: OTHER_APP, tenant: OTHER_TENANT, job: OTHER_JOB });
    expect(code(await caught(engine.view(other)))).toBe('ASSESSMENT_UNAVAILABLE');
  });

  it('needs consent; starting gives the published questions (never the answers) and a server deadline', async () => {
    const token = invite(saved[0]!.id);
    expect(code(await caught(engine.start(token, {})))).toBe('CONSENT_REQUIRED');
    const v = await engine.start(token, { consent: true });
    expect(v.status).toBe('IN_PROGRESS');
    expect(v.attempt!.questions.map((q) => q.text)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Pick the nouns']);
    expect(v.attempt!.questions[4]!.multiple).toBe(true);
    expect(v.attempt!.questions[0]!.multiple).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/"correct"|modelAnswer|passRule|"value"/);
    expect(Date.parse(v.attempt!.deadlineAt!) - Date.parse(v.attempt!.startedAt)).toBe(30 * 60_000);
    expect(store.events.map((e) => e.type)).toEqual(['ASSESSMENT_STARTED']);
  });

  it('starting again (refresh, second tab) continues the same attempt and clock', async () => {
    const token = invite(saved[0]!.id);
    const first = await engine.start(token, { consent: true });
    now = new Date(now.getTime() + 5 * 60_000);
    const again = await engine.start(token, { consent: true });
    expect(again.attempt!.deadlineAt).toBe(first.attempt!.deadlineAt);
    expect(store.attempts).toHaveLength(1);
  });

  it('a round without a time limit runs until the link expires', async () => {
    const token = invite(saved[1]!.id);
    const v = await engine.start(token, { consent: true });
    expect(v.attempt!.deadlineAt).toBe(store.invites[0]!.expiresAt!.toISOString());
  });

  it('freezes the questions and pass rules at the first start', async () => {
    await engine.start(invite(saved[0]!.id), { consent: true });
    const err = await caught(rounds.save(TENANT, JOB, { rounds: [aptitude], complete: true }, ACTOR));
    expect(code(err)).toBe('ROUNDS_LOCKED');
  });
});

describe('answers (autosave)', () => {
  it('saves, ignores an older revision, and resumes with the saved answers', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    const q1 = saved[0]!.questions[0]!.id;
    expect((await engine.save(token, { revision: 2, answers: [{ questionId: q1, selected: [1], marked: true }] })).revision).toBe(2);
    // a late request from before (revision 1) never overwrites the newer answers
    expect((await engine.save(token, { revision: 1, answers: [] })).revision).toBe(2);
    const v = await engine.view(token);
    expect(v.attempt!.answers).toEqual([{ questionId: q1, selected: [1], marked: true }]);
    expect(v.attempt!.revision).toBe(2);
  });

  it('refuses answers to unknown questions, options that do not exist, and two picks on a single-answer question', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    const [q1, , , , multi] = saved[0]!.questions;
    const bad = [
      [{ questionId: saved[1]!.questions[0]!.id, selected: [0] }],
      [{ questionId: q1!.id, selected: [7] }],
      [{ questionId: q1!.id, selected: [0, 1] }],
    ];
    for (const answers of bad) expect(code(await caught(engine.save(token, { revision: 5, answers })))).toBe('INVALID_ANSWERS');
    expect((await engine.save(token, { revision: 6, answers: [{ questionId: multi!.id, selected: [2, 0] }] })).revision).toBe(6);
  });

  it('after the time is up a save is refused and the saved answers are submitted', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.save(token, { revision: 1, answers: aptitudeAnswers(4, true) });
    now = new Date(now.getTime() + 31 * 60_000);
    const err = await caught(engine.save(token, { revision: 2, answers: [] }));
    expect([status(err), code(err)]).toEqual([409, 'TIME_UP']);
    expect(store.attempts[0]!.status).toBe('TIMED_OUT');
    expect(store.attempts[0]!.submittedAt).toEqual(new Date(T0.getTime() + 30 * 60_000));
    expect(results.results[0]).toMatchObject({ score: 6, systemPassed: true });
  });
});

describe('submitting, grading and the next step', () => {
  it('PASS: grades on the server (marks, threshold from HR) and invites to the next online round', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    // 2 single answers right (2) + "select all" right (2) = 4 marks = exactly HR's pass mark
    const v = await engine.submit(token, { revision: 3, answers: aptitudeAnswers(2, true) });
    expect(v.status).toBe('SUBMITTED');
    expect(v.attempt!.questions).toEqual([]);
    expect(results.results[0]).toMatchObject({ roundId: saved[0]!.id, score: 4, maxScore: 6, passMark: 4, systemPassed: true });
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(1);
    expect(store.outcomeEmails).toHaveLength(0);
  });

  it('FAIL: below the threshold -> rejection email queued, no further round', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    // 3 right singles (3) + multi half-right (0) = 3 < 4
    await engine.submit(token, { revision: 1, answers: aptitudeAnswers(3, false) });
    expect(results.results[0]).toMatchObject({ score: 3, systemPassed: false });
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ kind: 'REJECTED', roundId: saved[0]!.id })]);
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(0);
  });

  it('unanswered questions count as wrong', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.submit(token, { revision: 1, answers: [] });
    expect(results.results[0]).toMatchObject({ score: 0, systemPassed: false });
    expect(results.results[0]!.answers).toHaveLength(5);
  });

  it('passing the last online round before an interview -> "HR will contact you" email naming that round', async () => {
    const token = invite(saved[1]!.id);
    await engine.start(token, { consent: true });
    const [t1, t2] = saved[1]!.questions;
    await engine.submit(token, { revision: 1, answers: [{ questionId: t1!.id, selected: [0] }, { questionId: t2!.id, selected: [1] }] });
    expect(store.outcomeEmails).toEqual([expect.objectContaining({ kind: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Personal Interview' })]);
  });

  it('submitting twice gives the same result, one result row and one email', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.submit(token, { revision: 1, answers: aptitudeAnswers(0, false) });
    const again = await engine.submit(token, { revision: 9, answers: aptitudeAnswers(4, true) });
    expect(again.status).toBe('SUBMITTED');
    expect(results.results).toHaveLength(1);
    expect(results.results[0]!.systemPassed).toBe(false);
    expect(store.outcomeEmails).toHaveLength(1);
    await engine.progress(store.attempts[0]!.id);
    expect(store.outcomeEmails).toHaveLength(1);
    // and no more saving after the submit
    expect(code(await caught(engine.save(token, { revision: 10, answers: [] })))).toBe('ASSESSMENT_SUBMITTED');
  });

  it('a proctoring warning never changes the result', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.events(token, { events: [{ type: 'TAB_SWITCH', occurredAt: now.toISOString() }] });
    await engine.submit(token, { revision: 1, answers: aptitudeAnswers(4, true) });
    expect(results.results[0]!.systemPassed).toBe(true);
  });
});

describe('proctoring events', () => {
  it('stores camera and tab events with severity, server-side clock bounds and a per-attempt cap', async () => {
    const token = invite(saved[0]!.id);
    expect(code(await caught(engine.events(token, { events: [{ type: 'TAB_SWITCH', occurredAt: now.toISOString() }] })))).toBe('ASSESSMENT_NOT_STARTED');
    await engine.start(token, { consent: true });
    const res = await engine.events(token, {
      events: [
        { type: 'CAMERA_STARTED', occurredAt: now.toISOString() },
        { type: 'CAMERA_STOPPED', occurredAt: now.toISOString(), detail: { reason: 'track ended' } },
        { type: 'TAB_SWITCH', occurredAt: '2001-01-01T00:00:00.000Z' }, // a wrong device clock
      ],
    });
    expect(res.accepted).toBe(3);
    const stored = store.events.slice(1);
    expect(stored.map((e) => [e.type, e.severity])).toEqual([
      ['CAMERA_STARTED', 'INFO'],
      ['CAMERA_STOPPED', 'WARNING'],
      ['TAB_SWITCH', 'WARNING'],
    ]);
    expect(stored[2]!.occurredAt).toEqual(now);
    expect(code(await caught(engine.events(token, { events: [{ type: 'ASSESSMENT_SUBMITTED', occurredAt: now.toISOString() }] })))).toBe('INVALID_REQUEST');

    const many = Array.from({ length: 20 }, () => ({ type: 'FULLSCREEN_EXIT' as const, occurredAt: now.toISOString() }));
    for (let i = 0; i < 30; i++) await engine.events(token, { events: many });
    expect(store.events.length).toBe(500);
  });
});

describe('HR view', () => {
  it('shows invitation, attempt, time taken, answered count, events and outcome email - own company only', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.events(token, { events: [{ type: 'TAB_SWITCH', occurredAt: now.toISOString() }] });
    now = new Date(now.getTime() + 12 * 60_000 + 5_000);
    await engine.submit(token, { revision: 1, answers: aptitudeAnswers(1, false) });

    const view = await engine.forApplication(TENANT, APP);
    expect(view.rounds.map((r) => r.online)).toEqual([true, true, false]);
    expect(view.rounds[0]).toMatchObject({
      invite: { emailStatus: 'SENT', revoked: false },
      attempt: { status: 'SUBMITTED', timeTakenSeconds: 725, answered: 5, questionCount: 5, warnings: 1 },
      outcomeEmail: { kind: 'REJECTED', status: 'QUEUED' },
    });
    expect(view.rounds[0]!.events.map((e) => e.type)).toEqual(['ASSESSMENT_STARTED', 'TAB_SWITCH', 'ASSESSMENT_SUBMITTED']);
    // the assessments page shows the same graded result
    const review = await assessments.student(TENANT, APP);
    expect(review.rounds[0]).toMatchObject({ outcome: 'FAILED', score: 1, maxScore: 6 });

    expect(status(await caught(engine.forApplication(OTHER_TENANT, APP)))).toBe(404);
    expect(status(await caught(engine.revoke(OTHER_TENANT, APP, saved[0]!.id, ACTOR)))).toBe(404);
  });

  it('HR can withdraw a link and resend an invitation whose email failed', async () => {
    const token = invite(saved[0]!.id);
    await engine.revoke(TENANT, APP, saved[0]!.id, ACTOR);
    expect(code(await caught(engine.view(token)))).toBe('ASSESSMENT_LINK_REVOKED');
    expect(audit.entries.map((e) => e.action)).toContain('assessment.invite_revoked');

    await store.queueInvite(TENANT, APP, JOB, saved[1]!.id);
    expect(code(await caught(engine.resend(TENANT, APP, saved[1]!.id, ACTOR)))).toBe('INVITE_NOT_FAILED');
    store.invites[1]!.emailStatus = 'FAILED';
    await engine.resend(TENANT, APP, saved[1]!.id, ACTOR);
    expect(store.invites[1]!.emailStatus).toBe('QUEUED');
  });
});

describe('background worker', () => {
  it('AI screening completed -> invitation to the first online round, emailed with a personal link (only its hash is stored)', async () => {
    store.completedScreenings.push({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id });
    const { w, mailer } = worker();
    expect(await w.discover()).toBe(1);
    expect(await w.discover()).toBe(0); // never twice
    expect(await w.sendInvites()).toBe(1);

    expect(mailer.sent).toHaveLength(1);
    const { to, message } = mailer.sent[0]!;
    expect(to).toBe('asha@example.com');
    expect(message.subject).toContain('Aptitude & English Literacy');
    expect(message.text).toContain('30 minutes');
    expect(message.text).toContain('5 questions');
    expect(message.text).toContain('Answer every question. No calculators.');
    const link = /https:\/\/careers\.example\.com\/assessment\/([A-Za-z0-9_-]+)/.exec(message.text);
    expect(link).not.toBeNull();
    const inv = store.invites[0]!;
    expect(inv).toMatchObject({ emailStatus: 'SENT', tokenHash: hashAssessmentToken(link![1]!) });
    expect(inv.expiresAt!.getTime() - inv.sentAt!.getTime()).toBe(7 * DAY);
    expect(JSON.stringify(store.invites)).not.toContain(link![1]!);

    // the emailed link works
    expect((await engine.view(link![1]!)).roundName).toBe('Aptitude & English Literacy');
  });

  it('does not invite when the first round is run by HR', async () => {
    await rounds.save(OTHER_TENANT, OTHER_JOB, { rounds: [interview, aptitude], complete: true }, ACTOR);
    const config = await rounds.forRoundEngine(OTHER_TENANT, OTHER_JOB);
    store.completedScreenings.push({ tenantId: OTHER_TENANT, applicationId: OTHER_APP, jobId: OTHER_JOB, roundId: config!.rounds[0]!.id });
    expect(await worker().w.discover()).toBe(0);
  });

  it('holds an invitation while the link is localhost (never emails a broken link)', async () => {
    await store.queueInvite(TENANT, APP, JOB, saved[0]!.id);
    const { w, mailer } = worker({ baseUrl: 'http://localhost:3300/assessment/{token}' });
    await w.sendInvites();
    expect(mailer.sent).toHaveLength(0);
    // held before any link token exists, and without using up a send attempt
    expect(store.invites[0]).toMatchObject({ emailStatus: 'QUEUED', attempts: 0, tokenHash: null });
    expect(store.invites[0]!.lastError).toMatch(/public assessment link/);
  });

  it('a failed email is retried, then FAILED with its link removed', async () => {
    await store.queueInvite(TENANT, APP, JOB, saved[0]!.id);
    const mailer = new FakeMailer();
    mailer.failWith = new MailError('EAUTH wrong password');
    const { w } = worker({}, mailer);
    await w.sendInvites();
    expect(store.invites[0]).toMatchObject({ emailStatus: 'FAILED', tokenHash: null });
  });

  it('submits attempts whose time ran out while the page was closed, and sends each outcome email once', async () => {
    const token = invite(saved[0]!.id);
    await engine.start(token, { consent: true });
    await engine.save(token, { revision: 1, answers: aptitudeAnswers(0, false) });
    const { w, mailer } = worker();
    now = new Date(now.getTime() + 29 * 60_000);
    await w.sweepOverdue();
    expect(store.attempts[0]!.status).toBe('IN_PROGRESS');
    now = new Date(now.getTime() + 2 * 60_000);
    await w.sweepOverdue();
    expect(store.attempts[0]!.status).toBe('TIMED_OUT');
    expect(store.events.at(-1)!.type).toBe('ASSESSMENT_TIMED_OUT');

    await w.sendOutcomeEmails();
    await w.sendOutcomeEmails();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.message.subject).toBe('Application Update – AI Engineer at Pattern Labs');
    expect(mailer.sent[0]!.message.text).not.toMatch(/score|mark|tab|camera/i);
  });

  it('finishes a next step that was interrupted (process stopped after grading)', async () => {
    await engine.start(invite(saved[0]!.id), { consent: true });
    store.attempts[0]!.status = 'SUBMITTED';
    store.attempts[0]!.submittedAt = now;
    now = new Date(now.getTime() + 2 * 60_000);
    await worker().w.recover();
    expect(store.attempts[0]!.progressedAt).not.toBeNull();
    expect(store.outcomeEmails).toHaveLength(1);
  });
});

describe('links and emails', () => {
  it('builds the link from ASSESSMENT_URL or the careers site, and refuses localhost in production', () => {
    expect(assessmentBaseUrlFromEnv({ CAREERS_SITE_URL: 'https://x.trycloudflare.com/' })).toBe('https://x.trycloudflare.com/assessment/{token}');
    expect(assessmentBaseUrlFromEnv({ ASSESSMENT_URL: 'https://exam.example.com/a/{token}', CAREERS_SITE_URL: 'https://x.example' })).toBe('https://exam.example.com/a/{token}');
    expect(assessmentBaseUrlFromEnv({ CAREERS_SITE_URL: 'http://localhost:3300', NODE_ENV: 'production' })).toBeNull();
    expect(assessmentBaseUrlFromEnv({})).toBeNull();
    expect(isPublicLink('http://localhost:3300/assessment/{token}')).toBe(false);
    expect(isPublicLink('https://x.trycloudflare.com/assessment/{token}')).toBe(true);
    expect(dsaBaseUrlFromEnv({ DSA_SITE_URL: 'https://y.trycloudflare.com/' })).toBe('https://y.trycloudflare.com/dsa/{token}');
    expect(dsaBaseUrlFromEnv({ DSA_URL: 'https://code.example.com/t/{token}', DSA_SITE_URL: 'https://y.example' })).toBe('https://code.example.com/t/{token}');
    expect(dsaBaseUrlFromEnv({ CAREERS_SITE_URL: 'https://x.trycloudflare.com' })).toBeNull();
  });

  it('the invitation email cannot be broken by names with line breaks or HTML', () => {
    const m = buildRoundInviteEmail({
      candidateName: 'Asha\r\nBcc: evil@x.com',
      jobTitle: '<b>AI</b>',
      companyName: 'Pattern',
      companyWebsite: 'javascript:alert(1)',
      roundName: 'Aptitude',
      clearedStep: 'AI screening round',
      timeLimitMinutes: null,
      questionCount: 1,
      instructions: '',
      link: 'https://c.example/assessment/abc',
      linkExpiresAt: T0,
      cameraRequired: false,
    });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain('<b>AI</b>');
    expect(m.html).not.toContain('javascript:');
    expect(m.text).toContain('no fixed time limit');
    expect(m.html).toContain('<a href="https://c.example/assessment/abc">');
  });
});
