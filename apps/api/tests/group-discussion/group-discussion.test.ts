import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import {
  GD_DEFAULT_SETTINGS,
  gdSettingsSchema,
  gdSlotMinutes,
  planGroupSizes,
  planGroupSlots,
  type GdSettings,
  type RoundInput,
  type SavedRound,
} from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { GdService } from '../../src/modules/group-discussion/gd.service';
import { GdWorker } from '../../src/modules/group-discussion/gd.worker';
import { assignTopics, isGroupDiscussionRound, topicsOf } from '../../src/modules/group-discussion/planning';
import { AssessmentsService } from '../../src/modules/assessments';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { nextStep } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { MemoryAudit } from '../in-memory';
import { MemoryRoundEngineStore } from '../round-engine/fakes';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, OTHER_JOB, OTHER_TENANT, TENANT, student } from '../rounds/fakes';
import { MemoryGdStore } from './fakes';

const T0 = new Date('2026-11-02T09:00:00Z');
const IN_2H = new Date(T0.getTime() + 2 * 60 * 60_000);

const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude & English Literacy',
  timeLimitMinutes: 30,
  passRule: { mode: 'MARKS', value: 1 },
  questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }],
};
const gd: RoundInput = {
  type: 'GROUP_DISCUSSION',
  name: 'Group Discussion',
  passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 },
  questions: [
    { kind: 'INTERVIEW', text: 'Should AI replace exams?' },
    { kind: 'INTERVIEW', text: 'Work from home or office?' },
    { kind: 'INTERVIEW', text: 'Is social media good for students?' },
  ],
};
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let now: Date;
let roundsStore: MemoryRoundsConfigStore;
let rounds: RoundsConfigService;
let store: MemoryGdStore;
let audit: MemoryAudit;
let service: GdService;
let saved: SavedRound[];
let gdRound: SavedRound;

const clock = () => new Date(now);
const status = (err: unknown) => (err as HttpException).getStatus();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);

const request = (settings: Partial<GdSettings> = {}, startsAt = IN_2H) => ({
  name: 'Campus drive - day 1',
  startsAt: startsAt.toISOString(),
  settings: { ...GD_DEFAULT_SETTINGS, ...settings },
});

/** `n` students waiting in the GD round's pool, the first one waiting longest. */
const waiting = (n: number) => Array.from({ length: n }, (_, i) => store.addWaiting(TENANT, gdRound.id, JOB, `Student ${i + 1}`, now, n - i));

beforeEach(async () => {
  now = new Date(T0);
  roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  roundsStore.addJob(OTHER_TENANT, OTHER_JOB);
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, gd, interview], complete: true }, ACTOR)).rounds;
  gdRound = saved[1]!;
  store = new MemoryGdStore();
  store.rounds.push({ tenantId: TENANT, roundId: gdRound.id, roundName: gdRound.name, position: gdRound.position, jobId: JOB, jobTitle: 'AI Engineer' });
  service = new GdService(store, rounds, audit, clock);
});

describe('group sizes and time slots', () => {
  it('splits students into as few groups as possible, as even as possible', () => {
    expect(planGroupSizes(0, 6, 10)).toEqual({ sizes: [], undersized: false });
    expect(planGroupSizes(6, 6, 10)).toEqual({ sizes: [6], undersized: false });
    expect(planGroupSizes(10, 6, 10)).toEqual({ sizes: [10], undersized: false });
    expect(planGroupSizes(12, 6, 10)).toEqual({ sizes: [6, 6], undersized: false });
    expect(planGroupSizes(20, 6, 10)).toEqual({ sizes: [10, 10], undersized: false });
    expect(planGroupSizes(21, 6, 10)).toEqual({ sizes: [7, 7, 7], undersized: false });
    expect(planGroupSizes(25, 6, 10)).toEqual({ sizes: [9, 8, 8], undersized: false });
  });

  it('flags groups below the minimum when the numbers do not allow better', () => {
    expect(planGroupSizes(11, 6, 10)).toEqual({ sizes: [6, 5], undersized: true });
    expect(planGroupSizes(4, 6, 10)).toEqual({ sizes: [4], undersized: true });
  });

  it('estimates a group\'s slot from the phases (grace + intro + thinking + discussion + summaries + HR + close)', () => {
    // 5 min + 1 + 2 + 15 + 10 x 1 + 5 + 1 = 39 minutes
    expect(gdSlotMinutes(GD_DEFAULT_SETTINGS, 10)).toBe(39);
    expect(gdSlotMinutes({ ...GD_DEFAULT_SETTINGS, hrQuestionsEnabled: false }, 10)).toBe(34);
    expect(gdSlotMinutes({ ...GD_DEFAULT_SETTINGS, summarySeconds: 90 }, 7)).toBe(40); // 10.5 min of summaries, rounded up
  });

  it('runs groups back to back with the break in between', () => {
    const slots = planGroupSlots(T0, GD_DEFAULT_SETTINGS, [10, 6]);
    expect(slots.map((s) => [s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ['2026-11-02T09:00:00.000Z', '2026-11-02T09:39:00.000Z'],
      ['2026-11-02T09:49:00.000Z', '2026-11-02T10:24:00.000Z'],
    ]);
  });

  it('rejects settings where the smallest group is larger than the largest', () => {
    expect(gdSettingsSchema.safeParse({ ...GD_DEFAULT_SETTINGS, minGroupSize: 8, maxGroupSize: 6 }).success).toBe(false);
    expect(gdSettingsSchema.safeParse({ ...GD_DEFAULT_SETTINGS, maxGroupSize: 40 }).success).toBe(false);
    expect(gdSettingsSchema.safeParse(GD_DEFAULT_SETTINGS).success).toBe(true);
  });
});

describe('topics', () => {
  it('uses the round\'s questions as topics, in HR\'s order', () => {
    expect(isGroupDiscussionRound(gdRound)).toBe(true);
    expect(isGroupDiscussionRound(saved[0]!)).toBe(false);
    expect(topicsOf(gdRound).map((t) => t.text)).toEqual(['Should AI replace exams?', 'Work from home or office?', 'Is social media good for students?']);
  });

  it('gives each group the next topic and continues the rotation in later events', () => {
    const topics = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
    expect(assignTopics(topics, 4, 0).map((t) => t?.id)).toEqual(['a', 'b', 'c', 'a']);
    expect(assignTopics(topics, 2, 4).map((t) => t?.id)).toEqual(['b', 'c']);
    expect(assignTopics([], 2, 0)).toEqual([null, null]);
  });
});

describe('who reaches the GD round (round engine hand-off)', () => {
  it('hands a student who passed the round before the GD to the GD module instead of emailing them', () => {
    expect(nextStep(saved, saved[0]!, true, { groupDiscussion: true })).toMatchObject({ kind: 'GROUP_DISCUSSION', round: { id: gdRound.id } });
    // a failed round still ends the journey
    expect(nextStep(saved, saved[0]!, false, { groupDiscussion: true })).toEqual({ kind: 'EMAIL', email: 'REJECTED', nextRoundName: null });
  });

  it('keeps the old "HR will contact you" email when the GD module is off', () => {
    expect(nextStep(saved, saved[0]!, true)).toEqual({ kind: 'EMAIL', email: 'CLEARED_NEXT_BY_HR', nextRoundName: 'Group Discussion' });
  });

  it('sends no "HR will contact you" email after passing the aptitude test when the GD comes next', async () => {
    const results = new MemoryAssessmentsStore();
    results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' });
    results.students.push({ ...student(), tenantId: TENANT });
    const engineStore = new MemoryRoundEngineStore();
    engineStore.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: null });
    const engine = new RoundEngineService(engineStore, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, clock);
    const t = newAssessmentToken();
    engineStore.invites.push({
      id: '0192f3a1-dddd-7000-8000-000000000001', tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id, tokenHash: t.tokenHash,
      expiresAt: new Date(T0.getTime() + 7 * 24 * 60 * 60_000), revokedAt: null, emailStatus: 'SENT', attempts: 1, sentAt: T0, lastError: null,
    });
    await engine.start(t.token, { consent: true });
    await engine.submit(t.token, { revision: 1, answers: [{ questionId: saved[0]!.questions[0]!.id, selected: [1], marked: false }] });

    expect(results.results[0]).toMatchObject({ systemPassed: true });
    expect(engineStore.outcomeEmails).toEqual([]);
    expect(engineStore.invites).toHaveLength(1);
    expect(audit.entries.find((e) => e.action === 'assessment.progressed')?.metadata).toMatchObject({ next: { groupDiscussion: gdRound.id } });
  });

  it('adds each student to the pool once and audits it', async () => {
    const worker = new GdWorker(store, null as never, null as never, null as never, audit, { enabled: false, pollMs: 10_000, livePollMs: 1000 });
    store.candidates.push({ tenantId: TENANT, applicationId: '0192f3a1-cccc-7000-8000-000000000001', jobId: JOB, roundId: gdRound.id });
    expect(await worker.fillPools()).toBe(1);
    expect(await worker.fillPools()).toBe(0);
    expect(store.participantRows).toHaveLength(1);
    expect(store.participantRows[0]!.attendance).toBe('WAITING');
    expect(audit.entries.map((e) => e.action)).toContain('gd.pool_joined');
  });
});

describe('scheduling an event', () => {
  it('puts every waiting student into groups with slots, a room and a topic each', async () => {
    waiting(12);
    const view = await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    expect(view.pool).toHaveLength(0);
    expect(view.events).toHaveLength(1);
    const event = view.events[0]!;
    expect(event.undersized).toBe(false);
    expect(event.batches.map((b) => b.participants.length)).toEqual([6, 6]);
    expect(event.batches.map((b) => b.topic?.text)).toEqual(['Should AI replace exams?', 'Work from home or office?']);
    expect(event.batches[0]!.startsAt).toBe(IN_2H.toISOString());
    // 6 students: 5 + 1 + 2 + 15 + 6 + 5 + 1 = 35 minutes, then a 10 minute break
    expect(event.batches[1]!.startsAt).toBe(new Date(IN_2H.getTime() + 45 * 60_000).toISOString());
    expect(event.batches.flatMap((b) => b.participants).every((p) => p.attendance === 'SCHEDULED')).toBe(true);
    // the students who waited longest are in the first group
    expect(event.batches[0]!.participants.map((p) => p.name)).toEqual(['Student 1', 'Student 2', 'Student 3', 'Student 4', 'Student 5', 'Student 6']);
    const rooms = store.eventRows[0]!.batches.map((b) => b.roomName);
    expect(new Set(rooms).size).toBe(2);
    expect(rooms.every((r) => /^gd-[A-Za-z0-9_-]{16}$/.test(r))).toBe(true);
    expect(audit.entries.find((e) => e.action === 'gd.event_scheduled')).toMatchObject({ actorUserId: ACTOR.id, metadata: { groups: 2, students: 12 } });
  });

  it('continues the topic rotation in the next event and leaves earlier groups alone', async () => {
    waiting(6);
    await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    store.addWaiting(TENANT, gdRound.id, JOB, 'Late Student', now);
    const view = await service.createEvent(TENANT, gdRound.id, request({ minGroupSize: 3 }, new Date(IN_2H.getTime() + 24 * 60 * 60_000)), ACTOR);
    const [later, first] = view.events;
    expect(first!.batches[0]!.topic?.text).toBe('Should AI replace exams?');
    expect(later!.batches[0]!.topic?.text).toBe('Work from home or office?');
    expect(later!.batches[0]!.participants.map((p) => p.name)).toEqual(['Late Student']);
    expect(later!.undersized).toBe(true);
    expect(view.suggestedSettings.minGroupSize).toBe(3); // prefilled from the latest event
  });

  it('refuses a start time too soon, too far ahead, or invalid settings', async () => {
    waiting(6);
    const soon = await caught(service.createEvent(TENANT, gdRound.id, request({}, new Date(T0.getTime() + 10 * 60_000)), ACTOR));
    expect([status(soon), code(soon)]).toEqual([400, 'GD_START_TOO_SOON']);
    const late = await caught(service.createEvent(TENANT, gdRound.id, request({}, new Date(T0.getTime() + 61 * 24 * 60 * 60_000)), ACTOR));
    expect(code(late)).toBe('GD_START_TOO_LATE');
    const bad = await caught(service.createEvent(TENANT, gdRound.id, request({ minGroupSize: 9, maxGroupSize: 6 }), ACTOR));
    expect([status(bad), code(bad)]).toEqual([400, 'INVALID_REQUEST']);
    expect(store.eventRows).toHaveLength(0);
  });

  it('needs waiting students, topics and COMPLETE rounds', async () => {
    const empty = await caught(service.createEvent(TENANT, gdRound.id, request(), ACTOR));
    expect([status(empty), code(empty)]).toEqual([409, 'GD_POOL_EMPTY']);

    waiting(6);
    saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, { ...gd, questions: [] }, interview], complete: true }, ACTOR)).rounds;
    store.rounds[0]!.roundId = saved[1]!.id;
    for (const p of store.participantRows) p.roundId = saved[1]!.id;
    const noTopics = await caught(service.createEvent(TENANT, saved[1]!.id, request(), ACTOR));
    expect(code(noTopics)).toBe('GD_NO_TOPICS');

    saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, gd, interview], complete: false }, ACTOR)).rounds;
    store.rounds[0]!.roundId = saved[1]!.id;
    for (const p of store.participantRows) p.roundId = saved[1]!.id;
    const draft = await caught(service.createEvent(TENANT, saved[1]!.id, request(), ACTOR));
    expect(code(draft)).toBe('ROUNDS_NOT_COMPLETE');
  });

  it('answers 409 when another HR user scheduled the same students first', async () => {
    waiting(6);
    store.failNextCreate = true;
    const err = await caught(service.createEvent(TENANT, gdRound.id, request(), ACTOR));
    expect([status(err), code(err)]).toEqual([409, 'GD_POOL_CHANGED']);
    expect(store.participantRows.every((p) => p.attendance === 'WAITING')).toBe(true);
  });

  it('never shows or schedules another company\'s round', async () => {
    waiting(6);
    for (const call of [
      service.overview(OTHER_TENANT, gdRound.id),
      service.createEvent(OTHER_TENANT, gdRound.id, request(), ACTOR),
    ]) {
      const err = await caught(call);
      expect([status(err), code(err)]).toEqual([404, 'GD_ROUND_NOT_FOUND']);
    }
    expect(await service.listRounds(OTHER_TENANT)).toEqual([]);
  });
});

describe('changing a schedule', () => {
  it('cancels an event that has not started and puts its students back in the pool', async () => {
    waiting(6);
    const view = await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    const after = await service.cancelEvent(TENANT, view.events[0]!.id, ACTOR);
    expect(after.events[0]!.status).toBe('CANCELLED');
    expect(after.pool).toHaveLength(6);
    expect(audit.entries.map((e) => e.action)).toContain('gd.event_cancelled');
    // a cancelled event's groups do not count for the topic rotation
    const again = await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    expect(again.events.find((e) => e.status === 'SCHEDULED')!.batches[0]!.topic?.text).toBe('Should AI replace exams?');
  });

  it('refuses to cancel once a group has started, and 404s for another company', async () => {
    waiting(6);
    const view = await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    const eventId = view.events[0]!.id;
    const other = await caught(service.cancelEvent(OTHER_TENANT, eventId, ACTOR));
    expect(status(other)).toBe(404);
    store.eventRows[0]!.batches[0]!.status = 'LOBBY_OPEN';
    const started = await caught(service.cancelEvent(TENANT, eventId, ACTOR));
    expect([status(started), code(started)]).toEqual([409, 'GD_EVENT_STARTED']);
  });

  it('lets HR pick another of the round\'s topics before a group starts', async () => {
    waiting(6);
    const view = await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    const batchId = view.events[0]!.batches[0]!.id;
    const topic = topicsOf(gdRound)[2]!;
    const after = await service.setBatchTopic(TENANT, batchId, { topicId: topic.id }, ACTOR);
    expect(after.events[0]!.batches[0]!.topic).toEqual(topic);

    const unknown = await caught(service.setBatchTopic(TENANT, batchId, { topicId: '0192f3a1-9999-7000-8000-000000000009' }, ACTOR));
    expect(code(unknown)).toBe('GD_TOPIC_NOT_FOUND');
    store.eventRows[0]!.batches[0]!.status = 'IN_PROGRESS';
    const started = await caught(service.setBatchTopic(TENANT, batchId, { topicId: topicsOf(gdRound)[0]!.id }, ACTOR));
    expect(code(started)).toBe('GD_BATCH_STARTED');
  });
});

describe('HR overview', () => {
  it('lists the company\'s GD rounds with waiting / scheduled counts and the next group\'s start', async () => {
    waiting(7);
    expect(await service.listRounds(TENANT)).toEqual([
      { roundId: gdRound.id, roundName: 'Group Discussion', jobId: JOB, jobTitle: 'AI Engineer', waiting: 7, scheduled: 0, nextStartsAt: null },
    ]);
    await service.createEvent(TENANT, gdRound.id, request(), ACTOR);
    expect((await service.listRounds(TENANT))[0]).toMatchObject({ waiting: 0, scheduled: 7, nextStartsAt: IN_2H.toISOString() });
  });

  it('shows the topics, the pool and default settings for a new round', async () => {
    waiting(2);
    const view = await service.overview(TENANT, gdRound.id);
    expect(view).toMatchObject({ roundName: 'Group Discussion', jobTitle: 'AI Engineer', roundsComplete: true, events: [], suggestedSettings: GD_DEFAULT_SETTINGS });
    expect(view.topics).toHaveLength(3);
    expect(view.pool.map((p) => p.name)).toEqual(['Student 1', 'Student 2']);
  });
});
