import { HttpException } from '@nestjs/common';
import { aiInterviewAnswerResultSchema, aiInterviewHrViewSchema, aiInterviewPublicSessionSchema } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MailError } from '../../src/modules/applications';
import type { AuditService } from '../../src/modules/audit';
import type { RoundEngineService } from '../../src/modules/round-engine';
import type { RoundsConfigService } from '../../src/modules/rounds-config';
import { SpeechCache } from '../../src/modules/screening';
import { AiInterviewHrService } from '../../src/modules/ai-interview/ai-interview-hr.service';
import type { InterviewWorkerClient } from '../../src/modules/ai-interview/ai-interview-worker.client';
import { AiInterviewService } from '../../src/modules/ai-interview/ai-interview.service';
import { AiInterviewWorker, type AiInterviewWorkerConfig } from '../../src/modules/ai-interview/ai-interview.worker';
import {
  APP,
  CTX,
  FakeAudit,
  FakeEngine,
  FakeMailer,
  FakeRounds,
  FakeWorker,
  HR_Q,
  JOB,
  MemoryStore,
  NEXT_ROUND,
  OTHER_APP,
  OTHER_TENANT,
  OTHER_TOKEN,
  ROUND,
  TENANT,
  TOKEN,
  audio,
  busy,
  decision,
  hash,
  heard,
  report,
  silence,
} from './fakes';

let store: MemoryStore;
let worker: FakeWorker;
let audit: FakeAudit;
let rounds: FakeRounds;
let engine: FakeEngine;
let now: Date;
let service: AiInterviewService;
let hr: AiInterviewHrService;

const HR_ACTOR = { id: '01a20000-0000-7000-8000-0000000000e1', name: 'Riya (HR)' };
const START = { consent: true, camera: true, microphone: true };
const errorOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpException);
  return { status: (err as HttpException).getStatus(), body: (err as HttpException).getResponse() as Record<string, unknown> };
};
let n = 0;
const answer = (seq: number, id = `turn-${++n}-xxxxxx`, token = TOKEN) => service.answer(token, { seq, clientTurnId: id, durationMs: 9000, audio: audio() });
const later = (seconds: number) => (now = new Date(now.getTime() + seconds * 1000));
const settle = () => new Promise((r) => setTimeout(r, 0));
const sessionOf = () => [...store.sessions.values()][0]!;

beforeEach(() => {
  store = new MemoryStore();
  worker = new FakeWorker();
  audit = new FakeAudit();
  rounds = new FakeRounds();
  engine = new FakeEngine();
  now = new Date('2026-11-03T10:00:00Z');
  store.addInvite(TOKEN);
  store.contexts.set(APP, CTX);
  const clock = () => now;
  service = new AiInterviewService(store, worker as unknown as InterviewWorkerClient, new SpeechCache(), rounds as unknown as RoundsConfigService, audit as unknown as AuditService, clock);
  hr = new AiInterviewHrService(store, service, engine as unknown as RoundEngineService, rounds as unknown as RoundsConfigService, audit as unknown as AuditService, clock);
});

/** Starts and answers the greeting: the first planned question is pending. */
async function started() {
  await service.view(TOKEN);
  await service.start(TOKEN, START);
  worker.queue(heard("Yes, I'm ready."));
  return answer(1);
}

describe('interview link', () => {
  it('opens for the invited student: page data has no ids, no email, no resume, no score', async () => {
    const view = await service.view(TOKEN);
    expect(aiInterviewPublicSessionSchema.parse(view)).toBeTruthy();
    expect(view).toMatchObject({ status: 'NOT_STARTED', roundName: 'AI Technical Interview', jobTitle: 'AI Engineer Intern', candidateFirstName: 'Asha', durationMinutes: 20, cameraRequired: true, current: null });
    const json = JSON.stringify(view);
    for (const secret of [APP, TENANT, JOB, ROUND, 'asha@example.com', 'ChromaDB', 'process and a thread']) expect(json).not.toContain(secret);
  });

  it('refuses unknown, malformed and expired links', async () => {
    expect((await errorOf(service.view(OTHER_TOKEN))).body.code).toBe('INTERVIEW_LINK_INVALID');
    expect((await errorOf(service.view('../../etc'))).body.code).toBe('INTERVIEW_LINK_INVALID');
    now = new Date('2026-11-11T10:00:00Z');
    expect((await errorOf(service.view(TOKEN))).status).toBe(410);
  });

  it("one student's link never reaches another student's interview", async () => {
    store.contexts.set(OTHER_APP, { ...CTX, applicationId: OTHER_APP, candidateName: 'Ravi Kumar' });
    store.addInvite(OTHER_TOKEN, { applicationId: OTHER_APP });
    await service.view(TOKEN);
    const other = await service.view(OTHER_TOKEN);
    expect(other.candidateFirstName).toBe('Ravi');
    expect(store.sessions.size).toBe(2);
  });

  it('a link to a company it does not belong to is invalid (tenant from the invite, never from the request)', async () => {
    store.addInvite(OTHER_TOKEN, { tenantId: OTHER_TENANT });
    expect((await errorOf(service.view(OTHER_TOKEN))).status).toBe(404);
  });
});

describe('start: consent, camera and microphone', () => {
  it('needs consent and both devices', async () => {
    expect((await errorOf(service.start(TOKEN, { consent: true, camera: true }))).body.code).toBe('SETUP_REQUIRED');
    expect((await errorOf(service.start(TOKEN, { consent: true, camera: false, microphone: true }))).body.code).toBe('SETUP_REQUIRED');
    const view = await service.start(TOKEN, START);
    expect(view).toMatchObject({ status: 'IN_PROGRESS', consentGiven: true, current: { seq: 1, kind: 'INTRO' } });
    expect(view.current!.text).toContain('Are you ready to begin?');
    expect(store.consents).toEqual([{ applicationId: APP, purpose: 'ai_technical_interview' }]);
    expect(rounds.locked).toBe(1); // HR can no longer change the round under a running interview
  });

  it('a second tab joins the same interview and clock; the plan is made once', async () => {
    await service.start(TOKEN, START);
    later(30);
    const second = await service.start(TOKEN, START);
    expect(second.elapsedSeconds).toBe(30);
    await settle();
    expect(worker.planCalls).toBe(1);
  });

  it('later HR edits never change an interview already opened (config snapshot)', async () => {
    await service.view(TOKEN);
    rounds.list = rounds.list.map((r) => (r.id === ROUND ? { ...r, timeLimitMinutes: 10 } : r));
    expect((await service.view(TOKEN)).durationMinutes).toBe(20);
  });
});

describe('the conversation', () => {
  it('greeting reply -> resume question from the plan; the transcription gets the spellings and the clock', async () => {
    const res = await started();
    expect(aiInterviewAnswerResultSchema.parse(res)).toBeTruthy();
    expect(res).toMatchObject({ outcome: 'ANSWERED', transcript: "Yes, I'm ready.", done: false, next: { seq: 2, kind: 'MAIN', text: 'How does a question flow through your RAG chatbot?' }, questionsAnswered: 0 });
    const call = worker.turnCalls[0]!;
    expect(call.decide).toBe(false); // the greeting reply is only transcribed
    expect(call.vocabulary).toEqual(expect.arrayContaining(['FastAPI', 'ChromaDB', 'LangChain']));
    expect(sessionOf().pendingSource).toBe('RESUME');
    expect(sessionOf().pendingResumeRef).toBe('RAG chatbot for college notes');
  });

  it('adaptive: an incomplete answer gets a follow-up on the same topic, then the next topic', async () => {
    await started();
    later(60);
    worker.queue(heard('We used LangChain.', decision({ reading: 'INCOMPLETE', action: 'FOLLOW_UP', question: 'How did you decide which chunks to retrieve for a question?' })));
    const follow = await answer(2);
    expect(follow.next).toMatchObject({ seq: 3, kind: 'FOLLOW_UP', text: 'How did you decide which chunks to retrieve for a question?' });
    const call = worker.turnCalls[1]!;
    expect(call).toMatchObject({ decide: true, followUpAllowed: true, timing: { phase: 'CORE', durationMinutes: 20 }, question: { topicId: 't1' } });
    expect(call.history.map((h) => h.answer)).toEqual(["Yes, I'm ready."]);
    later(60);
    worker.queue(heard('By cosine similarity, top five.', decision({ reading: 'STRONG', topicId: 't2', question: 'Thanks. Could you explain how a process differs from a thread?' })));
    const nextTopic = await answer(3);
    expect(nextTopic.next).toMatchObject({ kind: 'MAIN' });
    expect(sessionOf().coveredTopics).toContain('t1');
    expect(sessionOf().pendingTopicId).toBe('t2');
  });

  it('raw and normalised transcripts are both kept, with the transcription quality', async () => {
    await started();
    worker.queue(heard('we stored it in chroma db', decision({}), { normalizedTranscript: 'we stored it in ChromaDB', quality: 'PARTLY_UNCLEAR', unclearTerms: ['chroma'] }));
    await answer(2);
    const t = (await store.turns(sessionOf().id))[1]!;
    expect(t).toMatchObject({ rawTranscript: 'we stored it in chroma db', normalizedTranscript: 'we stored it in ChromaDB', transcriptQuality: 'PARTLY_UNCLEAR', unclearTerms: ['chroma'], source: 'RESUME', topicId: 't1' });
  });

  it('the same upload twice is saved once; an old question number is out of sync', async () => {
    await started();
    worker.queue(heard('First answer.', decision({})));
    const a = await answer(2, 'same-upload-id');
    const b = await answer(2, 'same-upload-id');
    expect(b).toMatchObject({ transcript: 'First answer.', next: a.next });
    expect((await store.turns(sessionOf().id)).length).toBe(2);
    expect((await errorOf(answer(2))).body).toMatchObject({ code: 'OUT_OF_SYNC', current: { seq: 3 } });
  });

  it('silence is never saved: the candidate answers again', async () => {
    await started();
    worker.queue(silence());
    const res = await answer(2);
    expect(res).toMatchObject({ outcome: 'RETRY', next: { seq: 2 } });
    expect((await store.turns(sessionOf().id)).length).toBe(1);
  });

  it('AI busy: a retryable error, nothing saved, the same recording can be sent again', async () => {
    await started();
    worker.queue(busy());
    const err = await errorOf(answer(2, 'retry-me-123'));
    expect(err).toMatchObject({ status: 429, body: { code: 'AI_UNAVAILABLE', retryable: true } });
    worker.queue(heard('Now it works.', decision({})));
    expect((await answer(2, 'retry-me-123')).outcome).toBe('ANSWERED');
  });

  it('no AI planner: a plan by rule from the resume / job / HR questions', async () => {
    worker.planError = busy();
    const res = await started();
    expect(res.next!.text).toContain('RAG chatbot for college notes');
    const plan = sessionOf().plan as { ai: boolean; topics: { source: string; hrQuestionId?: string }[] };
    expect(plan.ai).toBe(false);
    expect(plan.topics.find((t) => t.source === 'HR')!.hrQuestionId).toBe(HR_Q);
  });

  it('the time limit is the server clock: an answer after the time -> closing, no new question', async () => {
    await started();
    later(20 * 60 + 10); // within the grace period
    worker.queue(heard('Last words.', decision({ action: 'FOLLOW_UP', question: 'One more thing?' })));
    const res = await answer(2);
    expect(res).toMatchObject({ done: true, next: { kind: 'CLOSING' }, remainingSeconds: 0 });
    expect(sessionOf()).toMatchObject({ status: 'COMPLETED', endedReason: 'TIME_UP' });
  });

  it('past the grace period nothing is accepted and the interview ends with what was saved', async () => {
    await started();
    later(20 * 60 + 120);
    const res = await answer(2);
    expect(res.done).toBe(true);
    expect(worker.turnCalls.length).toBe(1); // no AI call for an answer after the time
    expect(sessionOf().status).toBe('INCOMPLETE'); // no technical answer was given
  });
});

describe('devices, connection and repeats', () => {
  it('a lost camera pauses the clock; answers wait; resuming needs both devices again', async () => {
    await started();
    later(100);
    const paused = await service.pause(TOKEN, { reason: 'CAMERA_LOST' });
    expect(paused.status).toBe('PAUSED');
    expect((await errorOf(answer(2))).body.code).toBe('INTERVIEW_PAUSED');
    later(50);
    expect((await errorOf(service.resume(TOKEN, { camera: true }))).body.code).toBe('DEVICES_REQUIRED');
    const resumed = await service.resume(TOKEN, { camera: true, microphone: true });
    expect(resumed).toMatchObject({ status: 'IN_PROGRESS', elapsedSeconds: 100, current: { seq: 2 } });
    expect((await store.events(sessionOf().id)).map((e) => e.type)).toEqual(['PAUSED', 'RESUMED']);
  });

  it('device events are stored for HR (page clock checked), not before the start', async () => {
    expect(await service.events(TOKEN, { events: [{ type: 'CAMERA_LOST', occurredAt: now.toISOString() }] })).toEqual({ saved: 0 });
    await started();
    const res = await service.events(TOKEN, { events: [{ type: 'MIC_LOST', occurredAt: '2020-01-01T00:00:00Z', detail: 'track ended' }, { type: 'MIC_RESTORED', occurredAt: now.toISOString() }] });
    expect(res.saved).toBe(2);
    const events = await store.events(sessionOf().id);
    expect(events[0]!.occurredAt).toEqual(now); // a far-off page clock is replaced by the server's
    expect((await errorOf(service.events(TOKEN, { events: [{ type: 'FACE_NOT_DETECTED', occurredAt: now.toISOString() }] }))).status).toBe(400);
  });

  it('a question can be repeated a limited number of times', async () => {
    await started();
    expect(await service.repeat(TOKEN)).toEqual({ repeatsLeft: 1 });
    expect(await service.repeat(TOKEN)).toEqual({ repeatsLeft: 0 });
    expect((await errorOf(service.repeat(TOKEN))).body.code).toBe('NO_REPEATS_LEFT');
  });

  it('ending before the minimum time is INCOMPLETE; answers are kept', async () => {
    await started();
    worker.queue(heard('An answer.', decision({})));
    await answer(2);
    const view = await service.end(TOKEN);
    expect(view.status).toBe('INCOMPLETE');
    expect(sessionOf().endedReason).toBe('CANDIDATE_ENDED');
    expect(view.transcript.length).toBe(2);
  });

  it('the spoken question is cached (and the next one is prepared right after an answer)', async () => {
    await started();
    expect(worker.spoken).toContain('How does a question flow through your RAG chatbot?');
    await service.speech(TOKEN, 2);
    expect(worker.spoken.filter((t) => t === 'How does a question flow through your RAG chatbot?').length).toBe(1);
  });
});

async function finished(overall: number | null = 72) {
  worker.reportOut = report(overall);
  await started();
  for (const [i, text] of ['Answer one.', 'Answer two.', 'Answer three.'].entries()) {
    later(5 * 60);
    worker.queue(heard(text, decision({ topicId: `t${i + 2}` })));
    await answer(i + 2);
  }
  await service.end(TOKEN);
  await settle();
  await settle();
}

describe('report and HR decision', () => {
  it('a report is made in the background from the saved transcript', async () => {
    await finished();
    expect(store.reports.get(sessionOf().id)).toMatchObject({ status: 'DONE', overallScore: 72 });
    const input = worker.reportCalls[0]!;
    expect(input.turns.map((t) => t.answer)).toEqual(["Yes, I'm ready.", 'Answer one.', 'Answer two.', 'Answer three.']);
    expect(input.hrQuestions[0]!.expectedAnswer).toBe('Threads share memory within a process.');
    expect(input.status).toBe('COMPLETED');
  });

  it('HR sees transcript, report and the AI score as an interviewer score; another company sees nothing', async () => {
    await finished();
    const view = await hr.view(TENANT, APP);
    expect(aiInterviewHrViewSchema.parse(view)).toBeTruthy();
    const r = view.rounds[0]!;
    expect(r).toMatchObject({ roundId: ROUND, canDecide: true, proposedScore: { score: 7, maxScore: 10, passMark: 6 }, report: { status: 'DONE' } });
    expect(r.turns[1]).toMatchObject({ source: 'RESUME', resumeRef: 'RAG chatbot for college notes', rawTranscript: 'Answer one.' });
    expect((await errorOf(hr.view(OTHER_TENANT, APP))).status).toBe(404);
    expect((await errorOf(hr.decide(OTHER_TENANT, APP, ROUND, { decision: 'ADVANCE' }, HR_ACTOR))).status).toBe(404);
  });

  it('nothing moves on until HR decides; the decision goes to the round engine once', async () => {
    await finished();
    expect(engine.recorded).toEqual([]); // the AI never advances or rejects on its own
    const view = await hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE' }, HR_ACTOR);
    expect(view.rounds[0]!.decision).toMatchObject({ decision: 'ADVANCE', by: 'Riya (HR)' });
    expect(engine.recorded).toHaveLength(1);
    expect(engine.recorded[0]).toMatchObject({ tenantId: TENANT, module: 'AI_INTERVIEW', input: { applicationId: APP, roundId: ROUND, interviewerScore: 7 }, hrDecision: { passed: true } });
    expect((await errorOf(hr.decide(TENANT, APP, ROUND, { decision: 'REJECT', reason: 'changed my mind' }, HR_ACTOR))).body.code).toBe('ALREADY_DECIDED');
    expect(audit.entries.some((e) => e.action === 'ai_interview.decided')).toBe(true);
  });

  it('deciding against the AI score needs a reason (stored as an audited override)', async () => {
    await finished(40); // 4 of 10, pass mark 6
    expect((await errorOf(hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE' }, HR_ACTOR))).body.code).toBe('REASON_REQUIRED');
    await hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE', reason: 'Strong answers on the HR question; audio was poor.' }, HR_ACTOR);
    expect(engine.recorded[0]!.hrDecision).toMatchObject({ passed: true, reason: 'Strong answers on the HR question; audio was poor.' });
  });

  it("HR's own question goes to the Assessments page with the student's answer", async () => {
    await finished();
    await hr.decide(TENANT, APP, ROUND, { decision: 'REJECT', reason: 'Not deep enough for this role.' }, HR_ACTOR);
    const answers = engine.recorded[0]!.input.answers as { questionId: string; answer: string }[];
    expect(answers).toEqual([expect.objectContaining({ questionId: HR_Q, answer: 'Answer two.' })]);
  });

  it('a decision that could not be recorded is recorded by the worker loop later', async () => {
    await finished();
    engine.failNext = true;
    await hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE' }, HR_ACTOR);
    expect(engine.recorded).toHaveLength(0);
    const loop = workerLoop();
    await loop.recover();
    expect(engine.recorded).toHaveLength(1);
    await loop.recover();
    expect(engine.recorded).toHaveLength(1); // once
  });

  it('cannot decide while the interview is running', async () => {
    await started();
    expect((await errorOf(hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE' }, HR_ACTOR))).body.code).toBe('INTERVIEW_NOT_FINISHED');
  });
});

const config = (over: Partial<AiInterviewWorkerConfig> = {}): AiInterviewWorkerConfig => ({
  enabled: false,
  pollMs: 10_000,
  autoInvite: true,
  baseUrl: 'https://careers.example/interview/{token}',
  linkDays: 7,
  allowLocalLinks: false,
  ...over,
});
let mailer: FakeMailer;
function workerLoop(over: Partial<AiInterviewWorkerConfig> = {}) {
  mailer = new FakeMailer();
  return new AiInterviewWorker(
    store,
    service,
    hr,
    engine as unknown as RoundEngineService,
    rounds as unknown as RoundsConfigService,
    mailer as unknown as { enabled: boolean; send: (to: string, m: unknown) => Promise<void> } & { _?: MailError },
    audit as unknown as AuditService,
    config(over),
    () => now,
  );
}

describe('workflow: from the round before to the invitation', () => {
  beforeEach(() => {
    store.invites.clear();
    engine.waiting = [{ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: ROUND }];
  });

  it('a student who passed the round before (any round HR chose) is invited once, with a personal link', async () => {
    const loop = workerLoop();
    expect(await loop.discover()).toBe(1);
    expect(await loop.discover()).toBe(0); // never two invitations
    await loop.sendInvites();
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('asha@example.com');
    expect(mail.subject).toBe('Shortlisted: AI Technical Interview for AI Engineer Intern at Acme Tech');
    expect(mail.text).toContain('You have cleared the Group Discussion'); // the round before, as HR named it
    expect(mail.text).toContain('about 20 minutes');
    const token = /interview\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const invite = [...store.invites.values()][0]!;
    expect(invite).toMatchObject({ emailStatus: 'SENT', tokenHash: hash(token) });
    expect(mail.text).not.toMatch(/score|pass mark/i);
    expect((await service.view(token)).status).toBe('NOT_STARTED');
  });

  it('holds the invitation while no public link exists (never a localhost link in an inbox)', async () => {
    const loop = workerLoop({ baseUrl: 'http://localhost:3300/interview/{token}' });
    await loop.discover();
    await loop.sendInvites();
    expect(mailer.sent).toHaveLength(0);
    expect([...store.invites.values()][0]).toMatchObject({ emailStatus: 'QUEUED', attempts: 0 });
  });

  it('an interview whose time ran out with the page closed ends with the saved answers', async () => {
    store.addInvite(TOKEN);
    await started();
    worker.queue(heard('One answer.', decision({})));
    await answer(2);
    later(20 * 60 + 10 * 60);
    await workerLoop().sweep();
    expect(sessionOf()).toMatchObject({ status: 'COMPLETED', endedReason: 'TIME_UP' });
  });
});
