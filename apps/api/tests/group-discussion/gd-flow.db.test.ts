import 'reflect-metadata';
import { GD_DEFAULT_SETTINGS, type GdEvaluationResult, type RoundInput } from '@hireflow/contracts';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/prisma.service';
import { uuidv7 } from '../../src/common/uuidv7';
import type { EmailMessage } from '../../src/modules/applications/email/confirmation-email';
import type { Mailer } from '../../src/modules/applications';
import { AssessmentsService } from '../../src/modules/assessments';
import { PrismaAssessmentsStore } from '../../src/modules/assessments/assessments.store';
import { GdLiveService } from '../../src/modules/group-discussion/gd-live.service';
import { GdMailService } from '../../src/modules/group-discussion/gd-mail.service';
import { GdResultsService } from '../../src/modules/group-discussion/gd-results.service';
import { GdService } from '../../src/modules/group-discussion/gd.service';
import { PrismaGdStore } from '../../src/modules/group-discussion/gd.store';
import { GdWorkerClient, GdWorkerError, type EvaluateInput, type MixTrack } from '../../src/modules/group-discussion/gd-worker.client';
import { LiveKitGateway } from '../../src/modules/group-discussion/livekit';
import { LocalGdAudioStorage } from '../../src/modules/group-discussion/storage';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { PrismaRoundsConfigStore } from '../../src/modules/rounds-config/rounds-config.store';
import { seedApplication, seedCompany, seedJob } from '../ats/seed';
import { MemoryAudit } from '../in-memory';
import { FakeGenerator } from '../rounds/fakes';

/**
 * The whole GD of one group against a REAL database (TEST_DATABASE_URL, name containing "test"): invitations and the
 * reminder with the same link, lobby, join + consent, recording, the room locking (absent kept), admit late, the
 * phases, HR speaking (timer paused), a private talk, the end, transcription + evaluation, HR override, confirmation
 * (round results + result emails) and the retention clean-up. LiveKit, the mail server and the Python worker are fakes.
 */
const DB = process.env.TEST_DATABASE_URL;
const MIN = 60_000;

class FakeLiveKit extends LiveKitGateway {
  readonly url = 'wss://lk.example.test';
  calls: { op: string; args: unknown[] }[] = [];
  metadata = new Map<string, string>();
  async token(i: { room: string; identity: string; hidden?: boolean }) {
    this.calls.push({ op: 'token', args: [i.room, i.identity, i.hidden ?? false] });
    return `jwt-${i.identity}-${i.room}`;
  }
  async createRoom(room: string, metadata: string) {
    this.calls.push({ op: 'createRoom', args: [room] });
    this.metadata.set(room, metadata);
  }
  async setRoomMetadata(room: string, metadata: string) {
    this.metadata.set(room, metadata);
  }
  async setHidden(room: string, identity: string, hidden: boolean) {
    this.calls.push({ op: 'setHidden', args: [room, identity, hidden] });
  }
  async dispatchModerator(room: string) {
    this.calls.push({ op: 'dispatch', args: [room] });
  }
  async removeParticipant() {}
}

class FakeMailer implements Mailer {
  readonly enabled = true;
  sent: { to: string; message: EmailMessage }[] = [];
  async send(to: string, message: EmailMessage) {
    this.sent.push({ to, message });
  }
}

/** "Transcribes" a recording as the words written into its chunks; evaluates by the student's name. */
class FakeWorker extends GdWorkerClient {
  evaluated: EvaluateInput[] = [];
  mixed: { tracks: MixTrack[]; outPath: string }[] = [];
  async mix(tracks: MixTrack[], outPath: string) {
    this.mixed.push({ tracks, outPath });
    return { durationMs: 60_000, bytes: 1234 };
  }
  async transcribe(paths: string[]) {
    const { readFileSync } = await import('node:fs');
    const text = paths.map((p) => readFileSync(p, 'utf8')).join(' ');
    return { language: 'en', segments: text.trim() ? [{ start: 1, end: 9, text }] : [] };
  }
  async evaluate(i: EvaluateInput): Promise<{ result: GdEvaluationResult; model: string }> {
    this.evaluated.push(i);
    const strong = i.studentName.startsWith('Asha');
    return {
      model: 'fake',
      result: {
        student_id: i.studentId,
        scores: { content: strong ? 8 : 5, communication: 7, initiative: 6, listening: 6, balance: 7, summary: 6, hr_response: 9 },
        overall: strong ? 7.6 : 5.2,
        recommendation: strong ? 'selected' : 'not_selected',
        evidence: [{ criterion: 'content', quote: 'a quote', reason: 'relevant' }],
        feedback: 'ok',
      },
    };
  }
}

const aptitude: RoundInput = { type: 'APTITUDE', name: 'Aptitude', passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }] };
const gd: RoundInput = {
  type: 'GROUP_DISCUSSION',
  name: 'Group Discussion',
  passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 },
  questions: [{ kind: 'INTERVIEW', text: 'Should AI replace exams?' }],
};

describe.skipIf(!DB)('a whole group discussion (real database)', () => {
  let db: PrismaClient;
  let now: Date;
  const clock = () => new Date(now);
  const tmp = mkdtempSync(path.join(tmpdir(), 'gd-flow-'));

  beforeAll(() => {
    if (!/test/i.test(new URL(DB!).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    db = new PrismaClient({ datasourceUrl: DB });
  });
  afterAll(async () => {
    await db?.$disconnect();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs from invitation to confirmed selection and retention', async () => {
    now = new Date('2030-01-06T09:00:00Z');
    const prisma = db as unknown as PrismaService;
    const audit = new MemoryAudit();
    const livekit = new FakeLiveKit();
    const mailer = new FakeMailer();
    const worker = new FakeWorker();
    const storage = new LocalGdAudioStorage(tmp);
    const rounds = new RoundsConfigService(new PrismaRoundsConfigStore(prisma), audit as never, new FakeGenerator().asClient());
    const assessments = new AssessmentsService(new PrismaAssessmentsStore(prisma), rounds, audit as never);
    const store = new PrismaGdStore(prisma);
    const planner = new GdService(store, rounds, audit as never, clock);
    const live = new GdLiveService(prisma, livekit, storage, audit as never, clock);
    const mail = new GdMailService(prisma, mailer, audit as never, { baseUrl: 'https://jobs.example.com/gd/{token}', allowLocalLinks: false, reminderMinutes: 15, env: { HR_DASHBOARD_URL: 'https://hr.example.com' } }, clock);
    const results = new GdResultsService(prisma, worker, storage, mail, assessments, rounds, audit as never, { retentionDays: 90 }, clock);

    // ---- set-up: a job with Aptitude -> GD, four students waiting, an HR user
    const tenantId = await seedCompany(db);
    const hr = await db.user.create({ data: { id: uuidv7(), email: `hr-${uuidv7()}@example.com`, name: 'Priya HR', passwordHash: 'x' } });
    const actor = { id: hr.id, name: hr.name };
    const job = await seedJob(db, tenantId, { title: 'Analyst' });
    const [, round] = (await rounds.save(tenantId, job.jobId, { rounds: [aptitude, gd], complete: true }, actor)).rounds;
    const names = ['Asha Patel', 'Ravi Kumar', 'Meera Shah', 'Dev Rao'];
    const apps = [];
    for (const name of names) {
      const app = await seedApplication(db, tenantId, job, { name });
      apps.push(app);
      await store.addToPool({ tenantId, applicationId: app.applicationId, jobId: job.jobId, roundId: round!.id });
    }
    const startsAt = new Date(now.getTime() + 60 * MIN);
    const view = await planner.createEvent(tenantId, round!.id, { name: 'Day 1', startsAt: startsAt.toISOString(), settings: { ...GD_DEFAULT_SETTINGS, minGroupSize: 3, maxGroupSize: 4 } }, actor);
    const batchId = view.events[0]!.batches[0]!.id;
    const pid = (i: number) => view.events[0]!.batches[0]!.participants.find((p) => p.name === names[i])!.id;

    // ---- invitations (personal links) + HR's link; nothing twice
    expect(await mail.queueDue()).toBe(5);
    expect(await mail.queueDue()).toBe(0);
    await mail.sendDue();
    const invites = mailer.sent.filter((m) => m.message.subject.startsWith('Invitation'));
    expect(invites).toHaveLength(4);
    expect(mailer.sent.find((m) => m.to === hr.email)?.message.text).toContain(`https://hr.example.com/group-discussion/live/${batchId}`);
    const tokenOf = (i: number) => {
      const email = invites.find((m) => m.message.text.includes(`Dear ${names[i]}`))!;
      return email.message.text.match(/https:\/\/jobs\.example\.com\/gd\/([A-Za-z0-9_-]+)/)![1]!;
    };
    const tokens = names.map((_, i) => tokenOf(i));
    expect((await db.gdParticipant.findMany({ where: { batchId } })).every((p) => p.attendance === 'INVITED' && p.tokenHash && p.tokenSealed)).toBe(true);
    expect(JSON.stringify(await db.gdParticipant.findMany({ where: { batchId } }))).not.toContain(tokens[0]!);

    // ---- before the start: lobby facts only
    expect((await live.session(tokens[0])).status).toBe('UPCOMING');
    await expect(live.join(tokens[0], { consent: true })).rejects.toMatchObject({ response: { code: 'GD_NOT_OPEN_YET' } });
    await expect(live.session('x'.repeat(43))).rejects.toMatchObject({ response: { code: 'GD_LINK_INVALID' } });

    // ---- reminder 15 minutes before, with the SAME link
    now = new Date(startsAt.getTime() - 10 * MIN);
    expect(await mail.queueDue()).toBe(4);
    await mail.sendDue();
    const reminder = mailer.sent.find((m) => m.message.subject.startsWith('Reminder') && m.message.text.includes('Asha'));
    expect(reminder?.message.text).toContain(tokens[0]);

    // ---- the room opens; three students join (consent first), the fourth does not
    now = new Date(startsAt.getTime() + MIN);
    await live.tickLive({ onlyTenantId: tenantId });
    expect(livekit.calls.some((c) => c.op === 'createRoom')).toBe(true);
    expect((await live.session(tokens[0])).status).toBe('OPEN');
    await expect(live.join(tokens[0], {})).rejects.toMatchObject({ response: { code: 'CONSENT_REQUIRED' } });
    for (const i of [0, 1, 2]) {
      const joined = await live.join(tokens[i], { consent: true });
      expect(joined.connection.identity).toBe(`s:${pid(i)}`);
    }
    // a reconnect needs no consent again
    expect((await live.join(tokens[0], {})).connection.url).toBe('wss://lk.example.test');

    // ---- each student records their own microphone
    const record = async (i: number, words: string) => {
      const r = await live.startRecording(tokens[i], { mimeType: 'audio/webm;codecs=opus' });
      await live.putChunk(tokens[i], r.recordingId, 1, Buffer.from(words));
      return r.recordingId;
    };
    await expect(live.startRecording(tokens[0], { mimeType: 'video/x-evil' })).rejects.toMatchObject({ response: { code: 'GD_AUDIO_TYPE' } });

    // ---- the joining window closes: locked, the missing student ABSENT (kept), the moderator dispatched
    now = new Date(startsAt.getTime() + 5 * MIN + 1000);
    await live.tickLive({ onlyTenantId: tenantId });
    let batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({ status: 'IN_PROGRESS', phase: 'INTRO' });
    expect(batch.summaryOrder).toEqual([pid(0), pid(1), pid(2)]);
    expect((await db.gdParticipant.findUniqueOrThrow({ where: { id: pid(3) } })).attendance).toBe('ABSENT');
    expect(livekit.calls.some((c) => c.op === 'dispatch')).toBe(true);
    expect(JSON.parse(livekit.metadata.get(batch.roomName)!)).toMatchObject({ phase: 'INTRO', topic: null });
    expect((await live.session(tokens[3])).status).toBe('MISSED');
    await expect(live.join(tokens[3], { consent: true })).rejects.toMatchObject({ response: { code: 'GD_MISSED' } });

    // ---- HR admits the late student; they join and speak in the summary round too
    await live.admit(tenantId, batchId, pid(3), actor);
    await live.join(tokens[3], { consent: true });
    batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.summaryOrder).toHaveLength(4);

    // ---- thinking time shows the topic; discussion
    now = new Date(now.getTime() + 61_000);
    await live.tickLive({ onlyTenantId: tenantId });
    expect(JSON.parse(livekit.metadata.get(batch.roomName)!)).toMatchObject({ phase: 'THINKING', topic: 'Should AI replace exams?' });
    now = new Date(now.getTime() + 120_000);
    await live.tickLive({ onlyTenantId: tenantId });
    batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.phase).toBe('DISCUSSION');
    const discussionEnds = batch.phaseEndsAt!.getTime();

    const recA = await record(0, 'I think AI can help revision');
    await record(1, 'But exams test understanding');
    await record(2, 'Let us find a middle ground');

    // ---- HR speaks to the group: visible, timer paused 30 s, then resumed
    await live.speak(tenantId, batchId, { on: true }, actor);
    expect(livekit.calls.at(-1)).toEqual({ op: 'setHidden', args: [batch.roomName, `hr:${actor.id}`, false] });
    expect((await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } })).pausedAt).not.toBeNull();
    const hrRec = await live.startHrRecording(tenantId, batchId, { mimeType: 'audio/webm' }, actor);
    await live.putHrChunk(tenantId, hrRec.recordingId, 1, Buffer.from('Ravi, why do exams matter?'), actor);
    now = new Date(now.getTime() + 30_000);
    await live.speak(tenantId, batchId, { on: false }, actor);
    batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.pausedAt).toBeNull();
    expect(batch.phaseEndsAt!.getTime()).toBe(discussionEnds + 30_000);
    expect(batch.pausedIntervals).toHaveLength(1);

    // ---- a private talk: the student is told, then sent back
    const talk = await live.startPrivateTalk(tenantId, batchId, { participantId: pid(1) }, actor);
    expect(JSON.parse(livekit.metadata.get(batch.roomName)!).withHr).toEqual([`s:${pid(1)}`]);
    expect((await live.privateTalk(tokens[1])).active).toBe(true);
    expect((await live.privateTalk(tokens[0])).active).toBe(false);
    await expect(live.startPrivateTalk(tenantId, batchId, { participantId: pid(2) }, actor)).rejects.toMatchObject({ response: { code: 'GD_PRIVATE_TALK_OPEN' } });
    now = new Date(now.getTime() + 20_000);
    await live.endPrivateTalk(tenantId, talk.talkId, actor);
    expect(JSON.parse(livekit.metadata.get(batch.roomName)!).withHr).toEqual([]);

    // ---- to the end: summaries, HR questions, close -> COMPLETED, evaluation queued
    for (let i = 0; i < 60 && (await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } })).status !== 'COMPLETED'; i++) {
      now = new Date(now.getTime() + MIN);
      await live.tickLive({ onlyTenantId: tenantId });
    }
    batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch).toMatchObject({ status: 'COMPLETED', phase: 'ENDED', processingStatus: 'PENDING' });
    expect((batch.phaseLog as { phase: string }[]).map((p) => p.phase)).toEqual(['INTRO', 'THINKING', 'DISCUSSION', 'SUMMARY', 'HR_QUESTIONS', 'CLOSE', 'ENDED']);
    expect((await live.session(tokens[0])).status).toBe('ENDED');

    // ---- transcription + evaluation
    expect(await results.processNext()).toBe(true);
    batch = await db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.processingStatus).toBe('DONE');
    const r1 = await results.results(tenantId, batchId);
    expect(r1.students.map((s) => s.name)).toEqual(['Asha Patel', 'Meera Shah', 'Ravi Kumar', 'Dev Rao']);
    expect(r1.students[0]!.evaluation).toMatchObject({ status: 'OK', overall: 7.6, recommendation: 'SELECTED' });
    expect(r1.students.find((s) => s.name === 'Dev Rao')!.evaluation?.status).toBe('NO_AUDIO');
    // HR's line is context, never a student's; the private talk (excluded) is not in the transcript
    const forAsha = worker.evaluated.find((e) => e.studentName === 'Asha Patel')!;
    expect(forAsha.fullTranscript).toContain('HR asked: Ravi, why do exams matter?');
    expect(forAsha.studentTranscript).not.toContain('exams test');
    expect(r1.privateTalks).toHaveLength(1);

    // ---- the whole session as one audio file: every recording on the room's clock, the private talk muted
    expect(r1.sessionAudio).toMatchObject({ durationMs: 60_000, bytes: 1234 });
    expect(r1.sessionAudioError).toBeNull();
    const mixed = worker.mixed.at(-1)!;
    expect(mixed.outPath).toBe(path.join(tmp, tenantId, batchId, 'session.webm'));
    expect(mixed.tracks.length).toBe(await db.gdRecording.count({ where: { batchId, chunkCount: { gt: 0 } } }));
    const talkRow = await db.gdPrivateTalk.findUniqueOrThrow({ where: { id: talk.talkId } });
    const lockedAt = batch.lockedAt!.getTime();
    const talkerTrack = mixed.tracks.find((t) => t.mute.length)!;
    expect(talkerTrack.mute).toEqual([[talkRow.startedAt.getTime() - lockedAt, talkRow.endedAt!.getTime() - lockedAt]]);
    expect(mixed.tracks.filter((t) => t.mute.length)).toHaveLength(1);
    expect(await results.sessionAudioFile(tenantId, batchId)).toBe(mixed.outPath);
    await expect(results.sessionAudioFile(randomUUID(), batchId)).rejects.toMatchObject({ response: { code: 'GD_SESSION_AUDIO_NOT_FOUND' } });
    // the worker was down: the failure is kept on the group and HR builds it again
    const mix = worker.mix.bind(worker);
    worker.mix = async () => {
      throw new GdWorkerError('The GD worker (workers/gd-agent) is not reachable.', true);
    };
    expect(await results.buildSessionAudio(batchId)).toBe(false);
    worker.mix = mix;
    expect((await results.rebuildSessionAudio(tenantId, batchId)).sessionAudioError).toBeNull();

    // ---- HR overrides one decision (logged), then confirms
    const r2 = await results.decide(tenantId, batchId, pid(2), { decision: 'SELECTED', reason: 'Strong summary' }, actor);
    expect(r2.students.find((s) => s.name === 'Meera Shah')).toMatchObject({ finalDecision: 'SELECTED', hrDecision: { decision: 'SELECTED', reason: 'Strong summary', by: 'Priya HR' } });
    expect(await db.gdHrActivity.count({ where: { batchId, kind: 'OVERRIDE', hrUserId: actor.id } })).toBe(1);
    await results.confirm(tenantId, batchId, actor);
    await expect(results.confirm(tenantId, batchId, actor)).rejects.toMatchObject({ response: { code: 'GD_CONFIRMED' } });
    const recorded = await db.roundResult.findMany({ where: { roundId: round!.id } });
    expect(recorded).toHaveLength(4);
    const meera = recorded.find((r) => r.applicationId === apps[2]!.applicationId)!;
    expect(meera).toMatchObject({ systemPassed: false, overridePassed: true });
    expect(recorded.find((r) => r.applicationId === apps[0]!.applicationId)).toMatchObject({ systemPassed: true, interviewerScore: 7.6 });

    await mail.sendDue();
    const outcomes = mailer.sent.filter((m) => m.message.subject.startsWith('Congratulations') || m.message.subject.startsWith('Application Update'));
    expect(outcomes.filter((m) => m.message.subject.startsWith('Congratulations')).map((m) => m.message.text.match(/Dear ([^,]+)/)![1]).sort()).toEqual(['Asha Patel', 'Meera Shah']);
    expect(outcomes).toHaveLength(4);

    // ---- retention: audio files and transcripts go after 90 days; scores and decisions stay
    const rec = await db.gdRecording.findUniqueOrThrow({ where: { id: recA } });
    const folder = path.join(tmp, ...rec.storagePrefix.split('/'));
    expect(existsSync(folder)).toBe(true);
    now = new Date(now.getTime() + 91 * 24 * 60 * MIN);
    expect(await results.retention()).toBe(1);
    expect(existsSync(folder)).toBe(false);
    expect(await db.gdTranscript.count({ where: { batchId } })).toBe(0);
    expect((await db.gdRecording.findMany({ where: { batchId } })).every((r) => r.deletedAt)).toBe(true);
    expect((await db.gdEvaluation.findMany({ where: { batchId } })).every((e) => (e.evidence as unknown[]).length === 0 && e.status)).toBe(true);
    expect((await results.results(tenantId, batchId)).sessionAudio).toBeNull();
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['gd.joined', 'gd.started', 'gd.ended', 'gd.evaluated', 'gd.decision_overridden', 'gd.selection_confirmed', 'gd.recordings_deleted']));
  }, 60_000);
});
