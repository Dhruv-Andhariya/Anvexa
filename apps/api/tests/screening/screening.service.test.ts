import { HttpException } from '@nestjs/common';
import { aiScreeningAnswerResultSchema, aiScreeningDetailSchema, aiScreeningPublicSessionSchema } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/modules/screening/flow';
import { HrScreeningService } from '../../src/modules/screening/hr-screening.service';
import { ScreeningService } from '../../src/modules/screening/screening.service';
import { SpeechCache } from '../../src/modules/screening/speech-cache';
import type { ScreeningWorkerClient } from '../../src/modules/screening/screening-worker.client';
import type { AuditService } from '../../src/modules/audit';
import {
  APP,
  CTX,
  FakeAudit,
  FakeWorker,
  JOB,
  MemoryStore,
  OTHER_APP,
  OTHER_TENANT,
  OTHER_TOKEN,
  TENANT,
  TOKEN,
  audio,
  busy,
  hash,
} from './fakes';

let store: MemoryStore;
let worker: FakeWorker;
let audit: FakeAudit;
let now: Date;
let service: ScreeningService;
let hr: HrScreeningService;

const errorOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpException);
  return { status: (err as HttpException).getStatus(), body: (err as HttpException).getResponse() as Record<string, unknown> };
};
let n = 0;
const answer = (seq: number, id = `turn-${++n}-xxxxxx`) => service.answer(TOKEN, { seq, clientTurnId: id, durationMs: 4200, audio: audio() });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store = new MemoryStore();
  worker = new FakeWorker();
  audit = new FakeAudit();
  now = new Date('2026-10-29T10:00:00Z');
  store.invites.set(hash(TOKEN), { applicationId: APP, tenantId: TENANT, expiresAt: new Date('2026-11-05T10:00:00Z') });
  store.contexts.set(APP, CTX);
  const clock = () => now;
  service = new ScreeningService(store, worker as unknown as ScreeningWorkerClient, new SpeechCache(), audit as unknown as AuditService, DEFAULT_LIMITS, clock);
  hr = new HrScreeningService(store, service, audit as unknown as AuditService, clock);
});

describe('screening link', () => {
  it('opens the session for a valid shortlisted application (no ids, no email in the page data)', async () => {
    const view = await service.view(TOKEN);
    expect(aiScreeningPublicSessionSchema.parse(view)).toBeTruthy();
    expect(view).toMatchObject({ status: 'NOT_STARTED', jobTitle: 'Backend Intern', companyName: 'Acme Tech', candidateFirstName: 'Asha', current: null });
    expect(JSON.stringify(view)).not.toContain(APP);
    expect(JSON.stringify(view)).not.toContain('cand-1');
    expect(store.sessions.size).toBe(1);
    await service.view(TOKEN);
    expect(store.sessions.size).toBe(1); // opening it again never creates a second session
  });

  it('rejects missing, malformed and unknown tokens the same way', async () => {
    for (const t of [undefined, '', 'short', 'x'.repeat(40) + '!', OTHER_TOKEN]) {
      const { status, body } = await errorOf(service.view(t));
      expect(status).toBe(404);
      expect(body.code).toBe('SCREENING_LINK_INVALID');
    }
  });

  it('rejects an expired link', async () => {
    now = new Date('2026-11-06T00:00:00Z');
    const { status, body } = await errorOf(service.view(TOKEN));
    expect(status).toBe(410);
    expect(body.code).toBe('SCREENING_LINK_EXPIRED');
  });

  it('rejects a token whose invite points at an application of another company', async () => {
    store.invites.set(hash(OTHER_TOKEN), { applicationId: APP, tenantId: OTHER_TENANT, expiresAt: new Date('2026-11-05T10:00:00Z') });
    expect((await errorOf(service.view(OTHER_TOKEN))).status).toBe(404);
  });

  it('needs consent before the first start, and records it', async () => {
    await service.view(TOKEN);
    expect((await errorOf(service.start(TOKEN, {}))).body.code).toBe('CONSENT_REQUIRED');
    const started = await service.start(TOKEN, { consent: true });
    expect(started.status).toBe('IN_PROGRESS');
    expect(started.consentGiven).toBe(true);
    expect(started.current).toMatchObject({ seq: 1, step: 'INTRO', kind: 'MAIN' });
    expect(started.current!.text).toContain('Hi Asha');
    expect(store.consents).toEqual([{ applicationId: APP, purpose: 'ai_voice_screening' }]);
    expect(audit.entries.map((e) => e.action)).toEqual(['screening.started']);
  });
});

describe('answers', () => {
  beforeEach(async () => {
    await service.start(TOKEN, { consent: true });
  });

  it('saves each answer right away and moves to the next question', async () => {
    worker.queue({ transcript: 'I am Asha, a final year student.' });
    const res = await answer(1);
    expect(aiScreeningAnswerResultSchema.parse(res)).toBeTruthy();
    expect(res).toMatchObject({ outcome: 'ANSWERED', transcript: 'I am Asha, a final year student.', done: false, stepsDone: 1 });
    expect(res.next).toMatchObject({ seq: 2, step: 'EDUCATION', kind: 'MAIN' });
    const turns = await store.turns('s1');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ seq: 1, step: 'INTRO', answer: 'I am Asha, a final year student.', answerSeconds: 4.2 });
    expect(turns[0]!.question).toContain('Could you briefly introduce yourself?');
    expect(worker.turnCalls[0]!.job.salary).toContain('15,000 to 20,000'); // verified facts only
  });

  it('asks the follow-up the AI suggested, at most once per step, and stores the actual question', async () => {
    worker.queue({}); // INTRO -> EDUCATION
    await answer(1);
    worker.queue(
      { needsFollowUp: true, followUpQuestion: 'Which college are you studying at?' },
      { needsFollowUp: true, followUpQuestion: 'And the year?' },
    );
    const r2 = await answer(2);
    expect(r2.next).toMatchObject({ step: 'EDUCATION', kind: 'FOLLOW_UP', text: 'Which college are you studying at?' });
    expect(worker.turnCalls[1]!.followUpAllowed).toBe(true);
    const r3 = await answer(3);
    expect(worker.turnCalls[2]!.followUpAllowed).toBe(false);
    expect(r3.next).toMatchObject({ step: 'BACKGROUND', kind: 'MAIN' }); // second follow-up refused by the server
    const turns = await store.turns('s1');
    expect(turns.map((t) => [t.seq, t.kind])).toEqual([[1, 'MAIN'], [2, 'MAIN'], [3, 'FOLLOW_UP']]);
    expect(turns[2]!.question).toBe('Which college are you studying at?');
  });

  it('nothing heard: asks again and saves nothing', async () => {
    worker.queue({ audible: false, transcript: '' });
    const res = await answer(1);
    expect(res).toMatchObject({ outcome: 'RETRY', transcript: null, done: false });
    expect(res.next!.seq).toBe(1);
    expect(await store.turns('s1')).toEqual([]);
  });

  it('the same upload twice is saved once (double click / network retry)', async () => {
    worker.queue({ transcript: 'Once.' });
    const first = await answer(1, 'same-upload-1');
    const again = await answer(1, 'same-upload-1');
    expect(again).toEqual(first);
    expect(worker.turnCalls).toHaveLength(1);
    expect(await store.turns('s1')).toHaveLength(1);
  });

  it('an answer to an old question is refused with the current question (two tabs)', async () => {
    worker.queue({});
    await answer(1);
    const { status, body } = await errorOf(answer(1, 'other-tab-upload'));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'OUT_OF_SYNC', current: { seq: 2, step: 'EDUCATION' } });
  });

  it('AI errors keep every saved answer and tell the browser to retry', async () => {
    worker.queue({ transcript: 'Saved one.' }, busy());
    await answer(1);
    const { status, body } = await errorOf(answer(2));
    expect(status).toBe(429);
    expect(body).toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true, retryAfterSeconds: 20 });
    expect(await store.turns('s1')).toHaveLength(1);
    worker.queue({ transcript: 'Second try.' });
    expect((await answer(2)).outcome).toBe('ANSWERED');
  });

  it('rejects empty, huge and non-audio uploads before calling the AI', async () => {
    const send = (a: ReturnType<typeof audio> | undefined) => service.answer(TOKEN, { seq: 1, clientTurnId: 'upload-check-1', durationMs: null, audio: a });
    expect((await errorOf(send(undefined))).body.code).toBe('AUDIO_EMPTY');
    expect((await errorOf(send(audio(10)))).body.code).toBe('AUDIO_EMPTY');
    expect((await errorOf(send(audio(7 * 1024 * 1024)))).status).toBe(413);
    expect((await errorOf(send({ bytes: Buffer.alloc(5000), mimeType: 'video/x-msvideo' }))).status).toBe(415);
    expect(worker.turnCalls).toHaveLength(0);
  });

  it('runs to the end: candidate questions answered from verified info, then the closing words', async () => {
    worker.queue({}, {}, {}, {}, {}); // INTRO..AVAILABILITY
    for (let seq = 1; seq <= 5; seq++) await answer(seq);
    worker.queue({ transcript: 'Is it paid?', candidateAskedQuestion: true, reply: 'The CTC is 15,000 to 20,000 INR.' });
    const q = await answer(6);
    expect(q.next).toMatchObject({ step: 'CANDIDATE_QUESTIONS', kind: 'FOLLOW_UP' });
    expect(q.next!.text).toBe('The CTC is 15,000 to 20,000 INR. Do you have any other questions?');
    expect(q.aiReply).toBe('The CTC is 15,000 to 20,000 INR.');
    worker.queue({ transcript: 'No, thank you.', candidateIsDone: true });
    const done = await answer(7);
    expect(done).toMatchObject({ outcome: 'ANSWERED', done: true, stepsDone: 6 });
    expect(done.next).toMatchObject({ kind: 'CLOSING' });
    expect(done.next!.text).toContain('That is the end of this screening');
    expect(store.sessions.get(APP)!.status).toBe('COMPLETED');
    expect(store.inviteUsed.has(APP)).toBe(true);
    await tick();
    expect(worker.extractCalls).toBe(1);
    expect(store.results.get('s1')!.status).toBe('DONE');
    expect(audit.entries.map((e) => e.action)).toContain('screening.completed');
    // after completion: no more answers, but the page still opens (even after the link expires)
    expect((await errorOf(answer(8))).body.code).toBe('SCREENING_COMPLETED');
    now = new Date('2026-12-01T00:00:00Z');
    expect((await service.view(TOKEN)).status).toBe('COMPLETED');
  });

  it('ending early keeps the answers; the candidate can resume', async () => {
    worker.queue({ transcript: 'Kept.' });
    await answer(1);
    const ended = await service.end(TOKEN);
    expect(ended.status).toBe('ENDED_EARLY');
    expect((await errorOf(answer(2))).body.code).toBe('SCREENING_NOT_STARTED');
    const resumed = await service.start(TOKEN, {});
    expect(resumed.status).toBe('IN_PROGRESS');
    expect(resumed.current).toMatchObject({ seq: 2, step: 'EDUCATION' });
    expect(resumed.transcript.map((t) => t.answer)).toEqual(['Kept.']);
  });

  it('a refresh returns the same place and the transcript so far', async () => {
    worker.queue({ transcript: 'First.' });
    await answer(1);
    const view = await service.view(TOKEN);
    expect(view.current).toMatchObject({ seq: 2 });
    expect(view.transcript).toEqual([{ seq: 1, step: 'INTRO', question: expect.stringContaining('introduce'), answer: 'First.', aiReply: null }]);
  });

  it('speaks the current and earlier questions only, from the cache the second time', async () => {
    const a = await service.speech(TOKEN, 1);
    const b = await service.speech(TOKEN, 1);
    expect(a.equals(b)).toBe(true);
    expect(worker.spoken).toHaveLength(1);
    expect((await errorOf(service.speech(TOKEN, 5))).status).toBe(404);
  });
});

describe('HR view', () => {
  it('lists the job, shows the transcript and summary, and keeps other companies out', async () => {
    await service.start(TOKEN, { consent: true });
    worker.queue({ transcript: 'I am Asha.' });
    await answer(1);
    const list = await hr.listForJob(TENANT, JOB);
    expect(list.items).toEqual([expect.objectContaining({ applicationId: APP, candidateName: 'Asha Patel', status: 'IN_PROGRESS', stepsDone: 1 })]);
    expect((await hr.listForJob(OTHER_TENANT, JOB)).items).toEqual([]);
    expect((await errorOf(hr.detail(OTHER_TENANT, APP))).status).toBe(404);
    expect((await errorOf(hr.detail(TENANT, OTHER_APP))).status).toBe(404);

    const detail = await hr.detail(TENANT, APP);
    expect(aiScreeningDetailSchema.parse(detail)).toBeTruthy();
    expect(detail.turns).toEqual([expect.objectContaining({ seq: 1, answer: 'I am Asha.' })]);
    expect(detail.result).toBeNull();

    const retried = await hr.retrySummary(TENANT, APP);
    expect(retried.result).toMatchObject({ status: 'DONE', extraction: expect.objectContaining({ summary: 'Asha is a student.' }) });

    const reviewed = await hr.setReview(TENANT, APP, { reviewStatus: 'REVIEWED' }, { id: 'hr-1', name: 'HR' });
    expect(reviewed.reviewStatus).toBe('REVIEWED');
    expect((await errorOf(hr.setReview(OTHER_TENANT, APP, { reviewStatus: 'REVIEWED' }, { id: 'x', name: 'x' }))).status).toBe(404);
    expect((await errorOf(hr.setReview(TENANT, APP, { reviewStatus: 'HIRED' }, { id: 'hr-1', name: 'HR' }))).status).toBe(400);
  });

  it('a failed summary is shown as such and can be retried; the transcript stays', async () => {
    await service.start(TOKEN, { consent: true });
    worker.queue({ transcript: 'Kept.' });
    await answer(1);
    worker.extractError = busy();
    const failed = await hr.retrySummary(TENANT, APP);
    expect(failed.result).toMatchObject({ status: 'FAILED', extraction: null });
    expect(failed.turns).toHaveLength(1);
    worker.extractError = null;
    expect((await hr.retrySummary(TENANT, APP)).result!.status).toBe('DONE');
  });

  it('shows NOT_STARTED, INTERRUPTED and EXPIRED correctly', async () => {
    expect((await hr.listForJob(TENANT, JOB)).items[0]!.status).toBe('NOT_STARTED'); // invite sent, link not opened
    await service.start(TOKEN, { consent: true });
    worker.queue({});
    await answer(1);
    now = new Date('2026-10-29T11:00:00Z'); // idle for an hour
    expect((await hr.listForJob(TENANT, JOB)).items[0]!.status).toBe('INTERRUPTED');
    now = new Date('2026-11-06T00:00:00Z');
    expect((await hr.listForJob(TENANT, JOB)).items[0]!.status).toBe('EXPIRED');
  });
});
