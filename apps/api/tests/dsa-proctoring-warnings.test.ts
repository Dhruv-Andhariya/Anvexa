import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { PROCTOR_TERMINATION_MESSAGE } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import type { CodeRunner } from '../src/modules/dsa/execution/code-runner';
import { policyFromEnv, type ProctorPolicy } from '../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringHrService, type ProctorRecordsByApplication } from '../src/modules/dsa/proctoring/proctoring-hr.service';
import { ProctoringService, inviteRefFor } from '../src/modules/dsa/proctoring/proctoring.service';
import { InMemoryProctorStore, type ProctorStore } from '../src/modules/dsa/proctoring/proctoring.store';
import { CAMERA_CONSENT_VERSION, type ProctorSession } from '../src/modules/dsa/proctoring/proctoring.types';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';
import { MemoryAudit } from './in-memory';

/**
 * The warning manager of the DSA / SQL coding rounds (docs/PROCTORING.md): 2 warnings, the 3rd confirmed incident
 * terminates; per attempt; duplicates and simultaneous reports never count twice; the backend enforces termination.
 */

const T0 = Date.parse('2026-11-11T09:00:00Z');
const TOKEN = 'demo-dsa-token';
const noPrograms = { runBatch: async () => [] } as unknown as CodeRunner;
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const consent = { consent: true, consentVersion: CAMERA_CONSENT_VERSION, fullscreen: true, camera: true };

let now: number;
let store: InMemoryProctorStore;
let proctoring: ProctoringService;
let dsa: DsaService;

function setup(policy: Partial<ProctorPolicy> = {}, proctorStore: ProctorStore = new InMemoryProctorStore()) {
  now = T0;
  store = proctorStore as InMemoryProctorStore;
  proctoring = new ProctoringService(proctorStore, { ...policyFromEnv({}), enabled: true, ...policy }, () => now);
  dsa = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), noPrograms, () => now, proctoring);
}
async function begin() {
  await dsa.proctorStart(TOKEN, consent);
  await dsa.start(TOKEN);
}
/** Confirmed camera incidents (long enough and sure enough for the server). */
const phone = (sec: number, extra: Record<string, unknown> = {}) => ({ type: 'CAMERA_DEVICE_DETECTED', at: T0 + sec * 1000, durationMs: 4000, confidence: 0.8, detail: 'cell phone visible 4 s', ...extra });
const twoPeople = (sec: number) => ({ type: 'CAMERA_MULTIPLE_FACES', at: T0 + sec * 1000, durationMs: 5000, confidence: 0.85, detail: '2 people in view' });
const lookedAway = (sec: number, seconds: number) => ({ type: 'CAMERA_GAZE_AWAY', at: T0 + sec * 1000, durationMs: seconds * 1000, confidence: 0.8, detail: `left: looked away continuously ${seconds} s` });
async function send(sec: number, ...events: Record<string, unknown>[]) {
  now = T0 + sec * 1000;
  return dsa.proctorEvents(TOKEN, { events });
}

describe('warning policy: two warnings, the third confirmed incident terminates', () => {
  beforeEach(() => setup());

  it('1st incident -> Warning 1, 2nd -> Warning 2 (final), 3rd -> terminated, with the exact candidate messages', async () => {
    await begin();
    const w1 = await send(60, phone(55));
    expect(w1).toMatchObject({ strikesUsed: 1, strikesAllowed: 2, ended: false, terminated: false, level: 'warning' });
    expect(w1.warning).toEqual({
      warningNumber: 1,
      maxWarnings: 2,
      final: false,
      reason: 'A phone was visible in your camera.',
      message:
        'Warning 1 of 2: Potential suspicious activity has been detected during your assessment. Please remain alone in the assessment area and keep your attention on the assessment screen. Further confirmed incidents may result in assessment termination.',
    });

    const w2 = await send(200, twoPeople(190));
    expect(w2).toMatchObject({ strikesUsed: 2, ended: false, level: 'final_warning' });
    expect(w2.warning).toMatchObject({ warningNumber: 2, final: true, reason: 'More than one person was visible in your camera.' });
    expect(w2.warning!.message).toBe('Warning 2 of 2: Another potential assessment integrity incident has been detected. One more confirmed incident will automatically terminate this assessment.');

    const end = await send(400, lookedAway(260, 125));
    expect(end).toMatchObject({ ended: true, terminated: true, strikesUsed: 3 });
    const state = await dsa.getState(TOKEN);
    expect(state).toMatchObject({ status: 'finished', result: { reason: 'disqualified' }, proctoring: { terminated: true } });

    const summary = (await proctoring.summary(inviteRefFor(TOKEN)))!;
    expect(summary).toMatchObject({ status: 'disqualified', flagged: true, strikesUsed: 3, terminatedAt: new Date(T0 + 400_000).toISOString() });
    expect(summary.terminationReason).toBe('Used all 2 allowed warnings; the 3rd confirmed incident (looked away from the screen) terminated the assessment automatically.');
  });

  it('the termination message is the one the specification gives', () => {
    expect(PROCTOR_TERMINATION_MESSAGE).toBe(
      'Your assessment has been terminated because the maximum number of permitted warnings was exceeded. Your assessment activity and incident history have been recorded for review.',
    );
  });

  it('after termination: run, submit and finish are refused by the server, and further events are not processed', async () => {
    await begin();
    await send(60, phone(55));
    await send(200, twoPeople(190));
    await send(400, phone(390));
    const q = (await new MockQuestionRepository().findForAssessment('demo', {} as never))[0]!;
    for (const call of [
      () => dsa.submit(TOKEN, { questionId: q.id, language: 'python', code: 'print(1)' }),
      () => dsa.run(TOKEN, { questionId: q.id, language: 'python', code: 'print(1)' }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(code(err)).toBe('ATTEMPT_ENDED');
      expect((err as HttpException).message).toBe(PROCTOR_TERMINATION_MESSAGE);
    }
    expect(code(await dsa.proctorEvents(TOKEN, { events: [phone(500)] }).catch((e: unknown) => e))).toBe('ATTEMPT_ENDED');
    // even straight on the proctoring record: nothing more is counted, the attempt is not terminated twice
    const before = (await store.get(inviteRefFor(TOKEN)))!;
    const again = await proctoring.record(inviteRefFor(TOKEN), { assessmentId: 'x', startedAt: T0, endsAt: null }, [phone(600) as never]);
    expect(again).toMatchObject({ accepted: 0, ignored: 1, strikesUsed: 3 });
    expect((await store.get(inviteRefFor(TOKEN)))!.terminatedAt).toBe(before.terminatedAt);
  });

  it('the backend enforces a termination even if ending the attempt failed right after the decision', async () => {
    await begin();
    // the decision is stored on the proctoring record...
    for (const [i, sec] of [60, 200, 400].entries()) {
      now = T0 + sec * 1000;
      await proctoring.record(inviteRefFor(TOKEN), { assessmentId: 'x', startedAt: T0, endsAt: null }, [phone(sec - 5 - i) as never]);
    }
    // ...but the assessment itself was never ended: the next request ends it, and no answer is accepted
    expect((await dsa.getState(TOKEN)).status).toBe('finished');
    expect(code(await dsa.submit(TOKEN, { questionId: 'q', language: 'python', code: 'print(1)' }).catch((e: unknown) => e))).toBe('ATTEMPT_ENDED');
  });

  it('DSA_PROCTOR_MAX_STRIKES changes the limit; 0 = no termination', async () => {
    setup({ maxStrikes: 0 });
    await begin();
    for (const sec of [60, 200, 400, 600]) expect(await send(sec, phone(sec - 5))).toMatchObject({ ended: false, warning: null });
    expect((await dsa.getState(TOKEN)).status).toBe('in_progress');
  });
});

describe('separate warning counts: per assessment attempt, never per candidate', () => {
  it('a DSA attempt and a SQL attempt each start at zero; a warning in one never counts in the other', async () => {
    setup();
    const dsaRef = 'dsa-attempt-ref';
    const sqlRef = 'sql-attempt-ref';
    const window = { assessmentId: 'a', startedAt: T0, endsAt: null };
    await proctoring.start(dsaRef, 'a', consent, true, 'code');
    await proctoring.start(sqlRef, 'a', consent, true, 'sql');
    now = T0 + 60_000;
    expect(await proctoring.record(dsaRef, window, [phone(50) as never])).toMatchObject({ strikesUsed: 1 });
    now = T0 + 200_000;
    expect(await proctoring.record(dsaRef, window, [twoPeople(190) as never])).toMatchObject({ strikesUsed: 2 });
    // the SQL round, later: a fresh count
    now = T0 + 900_000;
    const sql = await proctoring.record(sqlRef, window, [phone(890) as never]);
    expect(sql).toMatchObject({ strikesUsed: 1, terminated: false, warning: { warningNumber: 1 } });
    expect(await proctoring.candidateStateFor(dsaRef)).toMatchObject({ strikesUsed: 2, terminated: false });
    expect((await store.get(sqlRef))!.kind).toBe('sql');
  });

  it('a new attempt (a new invitation) starts with zero warnings', async () => {
    setup();
    expect(await proctoring.candidateStateFor('a-brand-new-attempt')).toMatchObject({ strikesUsed: 0, warning: null, terminated: false });
  });
});

describe('duplicates and simultaneous reports', () => {
  beforeEach(() => setup());

  it('the same event sent again (a retry with the same eventId) is ignored: no second warning', async () => {
    await begin();
    expect(await send(60, phone(55, { eventId: 'evt-00000001' }))).toMatchObject({ accepted: 1, strikesUsed: 1 });
    expect(await send(90, phone(55, { eventId: 'evt-00000001' }))).toMatchObject({ accepted: 0, ignored: 1, strikesUsed: 1 });
  });

  it('two signals of the same act (within 3 s) are one warning; the camera cool-down drops a repeated alert', async () => {
    await begin();
    expect(await send(60, { type: 'FULLSCREEN_EXIT', at: T0 + 50_000 }, phone(51))).toMatchObject({ accepted: 2, strikesUsed: 1 });
    expect(await send(70, phone(60))).toMatchObject({ accepted: 0, strikesUsed: 1 });
  });

  it('a tab switch that absorbs its own full-screen exit keeps that warning instead of counting a second one', async () => {
    await begin();
    await send(60, { type: 'FULLSCREEN_EXIT', at: T0 + 50_000 });
    expect(await send(61, { type: 'TAB_SWITCH', at: T0 + 50_500 })).toMatchObject({ strikesUsed: 1 });
    const session = (await store.get(inviteRefFor(TOKEN)))!;
    expect(session.events.map((e) => [e.type, e.outcome, e.warningNumber])).toEqual([['TAB_SWITCH', 'WARNING', 1]]);
  });

  it('many simultaneous reports never exceed the policy: exactly warnings 1, 2, then one termination', async () => {
    await begin();
    now = T0 + 1_000_000;
    const results = await Promise.all(
      [100, 200, 300, 400, 500, 600].map((sec) => dsa.proctorEvents(TOKEN, { events: [phone(sec, { eventId: `evt-${String(sec).padStart(8, '0')}` })] }).catch((e: unknown) => e)),
    );
    const session = (await store.get(inviteRefFor(TOKEN)))!;
    const counted = session.events.filter((e) => e.outcome === 'WARNING' || e.outcome === 'TERMINATED');
    expect(counted.map((e) => [e.outcome, e.warningNumber])).toEqual([
      ['WARNING', 1],
      ['WARNING', 2],
      ['TERMINATED', 3],
    ]);
    expect(session.warningCount).toBe(3);
    // every answer is a normal one; those decided after the termination report it (the page then shows the message)
    expect(results.every((r) => !(r instanceof Error))).toBe(true);
    expect(results.filter((r) => (r as { terminated: boolean }).terminated).length).toBeGreaterThanOrEqual(1);
    expect(session.events.filter((e) => e.outcome === 'TERMINATED')).toHaveLength(1);
    expect((await dsa.getState(TOKEN)).status).toBe('finished');
  });
});

describe('what never counts as misconduct', () => {
  beforeEach(() => setup());

  it('camera interrupted, detection unavailable (poor lighting / model failure) and head movement: recorded, never a warning', async () => {
    await begin();
    const r = await send(
      120,
      { type: 'CAMERA_STOPPED', at: T0 + 10_000, detail: 'camera turned off', durationMs: 0, confidence: 1 },
      { type: 'CAMERA_DETECTION_UNAVAILABLE', at: T0 + 40_000, detail: 'poor lighting', durationMs: 30_000, confidence: 0.9 },
      { type: 'CAMERA_HEAD_MOVEMENT', at: T0 + 80_000, detail: '10 head turns in 30 s', durationMs: 30_000, confidence: 0.7 },
    );
    expect(r).toMatchObject({ accepted: 3, strikesUsed: 0, warning: null });
    const { events } = proctoring.reviewOf((await store.get(inviteRefFor(TOKEN)))!, 10);
    expect(events.map((e) => [e.type, e.outcome, e.strike])).toEqual([
      ['CAMERA_STOPPED', 'RECORDED', null],
      ['CAMERA_DETECTION_UNAVAILABLE', 'RECORDED', null],
      ['CAMERA_HEAD_MOVEMENT', 'RECORDED', null],
    ]);
    expect(events[0]!.note).toMatch(/technical/);
  });

  it('short looks, short absences, a brief second face or phone, and low-confidence detections are observations only', async () => {
    await begin();
    const r = await send(
      300,
      lookedAway(10, 100),
      { type: 'CAMERA_FACE_MISSING', at: T0 + 150_000, durationMs: 10_000, confidence: 0.9, detail: 'no face in view 10 s' },
      { ...twoPeople(200), durationMs: 1500 },
      phone(250, { confidence: 0.3 }),
    );
    expect(r).toMatchObject({ accepted: 4, strikesUsed: 0 });
    const notes = (await store.get(inviteRefFor(TOKEN)))!.events.map((e) => e.note);
    expect(notes).toEqual([
      'observation: shorter than 120 s, not counted as a warning',
      'observation: shorter than 20 s, not counted as a warning',
      'observation: shorter than 3 s, not counted as a warning',
      'observation: detection not confident enough, not counted as a warning',
    ]);
  });

  it('looking away continuously for more than 120 s is a confirmed incident', async () => {
    await begin();
    expect(await send(200, lookedAway(10, 125))).toMatchObject({ strikesUsed: 1, warning: { reason: 'You appeared to look away from the screen continuously for more than 2 minutes.' } });
  });
});

describe('reliability', () => {
  it('a database error while deciding is reported (the page retries) and nothing is half-counted', async () => {
    const failing = new InMemoryProctorStore();
    setup({}, failing);
    await begin();
    const original = failing.withLock.bind(failing);
    failing.withLock = (() => Promise.reject(new Error('connection lost'))) as typeof failing.withLock;
    await expect(send(60, phone(55, { eventId: 'evt-retry-0001' }))).rejects.toThrow('connection lost');
    failing.withLock = original;
    // the retry of the same event is counted once
    expect(await send(65, phone(55, { eventId: 'evt-retry-0001' }))).toMatchObject({ accepted: 1, strikesUsed: 1 });
    expect(await send(66, phone(55, { eventId: 'evt-retry-0001' }))).toMatchObject({ accepted: 0, strikesUsed: 1 });
  });

  it('events for an attempt whose monitoring never started are refused', async () => {
    setup();
    await expect(proctoring.record('never-started', { assessmentId: 'a', startedAt: null, endsAt: null }, [phone(1) as never])).rejects.toMatchObject({ status: 409 });
  });
});

describe('HR review of incidents', () => {
  const TENANT = '0192f3a1-0000-7000-8000-00000000aaaa';
  const OTHER = '0192f3a1-0000-7000-8000-00000000bbbb';
  const APP = '0192f3a1-0000-7000-8000-00000000cccc';
  const ROUND = '0192f3a1-0000-7000-8000-00000000dddd';
  let audit: MemoryAudit;
  let hr: ProctoringHrService;

  beforeEach(async () => {
    setup();
    await begin();
    await send(60, phone(55));
    await send(200, { type: 'CAMERA_STOPPED', at: T0 + 150_000, durationMs: 0, confidence: 1, detail: 'camera turned off' });
    const records: ProctorRecordsByApplication = {
      forApplication: async (tenantId, applicationId) =>
        tenantId === TENANT && applicationId === APP ? [{ inviteRef: inviteRefFor(TOKEN), roundId: ROUND, session: (await store.get(inviteRefFor(TOKEN))) as ProctorSession }] : [],
    };
    audit = new MemoryAudit();
    hr = new ProctoringHrService(records, proctoring, audit);
  });

  it('shows the module, warnings, incident categories, timestamps, durations, outcomes and evidence availability', async () => {
    const r = (await hr.review(TENANT, APP)).rounds[0]!;
    expect(r).toMatchObject({ roundId: ROUND, module: 'DSA', warningCount: 1, maxWarnings: 2, terminatedAt: null, cameraMonitored: true });
    expect(r.detectionVersion).toMatch(/camera-rules-2/);
    expect(r.incidents!.map((i) => [i.category, i.outcome, i.warningNumber, i.durationMs, i.evidence])).toEqual([
      ['DEVICE_DETECTED', 'WARNING', 1, 4000, 'METADATA_ONLY'],
      ['CAMERA_INTERRUPTED', 'RECORDED', null, 0, 'METADATA_ONLY'],
    ]);
  });

  it('a reviewer marks an incident Dismissed with a reason: who, when and why are stored and audited; counts and scores do not change', async () => {
    const actor = { id: '0192f3a1-0000-7000-8000-00000000eeee', name: 'Priya Shah' };
    const out = await hr.reviewIncident(TENANT, APP, ROUND, 1, { status: 'DISMISSED', reason: 'The phone was face-down and never touched.' }, actor);
    const incident = out.rounds[0]!.incidents![0]!;
    expect(incident.review).toMatchObject({ status: 'DISMISSED', reason: 'The phone was face-down and never touched.', by: 'Priya Shah' });
    expect(out.rounds[0]!.warningCount).toBe(1);
    expect(audit.entries).toEqual([
      expect.objectContaining({ tenantId: TENANT, actorUserId: actor.id, action: 'proctoring.incident_reviewed', subjectId: APP, metadata: expect.objectContaining({ status: 'DISMISSED', incidentId: 1, roundId: ROUND }) }),
    ]);
  });

  it('another company cannot read or review the records (404), and an invalid review is refused (400)', async () => {
    expect((await hr.review(OTHER, APP)).rounds).toEqual([]);
    const other = await hr.reviewIncident(OTHER, APP, ROUND, 1, { status: 'CONFIRMED', reason: 'looks bad' }, null).catch((e: unknown) => e);
    expect(code(other)).toBe('INCIDENT_NOT_FOUND');
    expect(code(await hr.reviewIncident(TENANT, APP, ROUND, 1, { status: 'GUILTY', reason: 'looks bad' }, null).catch((e: unknown) => e))).toBe('INVALID_REVIEW');
    expect(code(await hr.reviewIncident(TENANT, APP, ROUND, 1, { status: 'CONFIRMED', reason: '' }, null).catch((e: unknown) => e))).toBe('INVALID_REVIEW');
    expect(code(await hr.reviewIncident(TENANT, APP, ROUND, 99, { status: 'CONFIRMED', reason: 'looks bad' }, null).catch((e: unknown) => e))).toBe('INCIDENT_NOT_FOUND');
    expect(audit.entries).toEqual([]);
  });
});
