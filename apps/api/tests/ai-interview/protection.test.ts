import { HttpException } from '@nestjs/common';
import {
  DEFAULT_AI_INTERVIEW_PROTECTION,
  aiInterviewHrViewSchema,
  aiInterviewPublicSessionSchema,
  aiInterviewViolationResultSchema,
  type AiInterviewProtectionSettings,
  type AiInterviewViolationType,
} from '@hireflow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditService } from '../../src/modules/audit';
import type { RoundEngineService } from '../../src/modules/round-engine';
import type { RoundsConfigService } from '../../src/modules/rounds-config';
import { SpeechCache } from '../../src/modules/screening';
import { AiInterviewHrService } from '../../src/modules/ai-interview/ai-interview-hr.service';
import type { InterviewWorkerClient } from '../../src/modules/ai-interview/ai-interview-worker.client';
import { AiInterviewService } from '../../src/modules/ai-interview/ai-interview.service';
import { InterviewProtectionService } from '../../src/modules/ai-interview/protection.service';
import { classifyViolation, parseProtection, protectionState, type PriorIncident } from '../../src/modules/ai-interview/protection';
import {
  APP,
  CTX,
  FakeAudit,
  FakeEngine,
  FakeRounds,
  FakeWorker,
  GD_ROUND,
  JOB,
  MemoryStore,
  OTHER_APP,
  OTHER_TENANT,
  OTHER_TOKEN,
  ROUND,
  TENANT,
  TOKEN,
  audio,
  heard,
} from './fakes';

const S = DEFAULT_AI_INTERVIEW_PROTECTION;
const T0 = new Date('2026-11-03T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const prior = (type: AiInterviewViolationType, outcome: PriorIncident['outcome'], warningNumber: number | null, sec: number, extra: Partial<PriorIncident> = {}): PriorIncident => ({
  type,
  outcome,
  warningNumber,
  occurredAt: at(sec),
  resolvedAt: null,
  acknowledgedAt: null,
  ...extra,
});

describe('warning rules (pure)', () => {
  it('1st qualifying incident = warning 1, 2nd = warning 2 (final), 3rd = terminated', () => {
    expect(classifyViolation({ type: 'TAB_SWITCH', settings: S, warningCount: 0, prior: [], now: at(0) })).toEqual({ outcome: 'WARNING', warningNumber: 1, warningCount: 1, terminate: false });
    expect(classifyViolation({ type: 'TAB_SWITCH', settings: S, warningCount: 1, prior: [prior('TAB_SWITCH', 'WARNING', 1, 0)], now: at(60) })).toMatchObject({ outcome: 'WARNING', warningNumber: 2, terminate: false });
    expect(classifyViolation({ type: 'TAB_SWITCH', settings: S, warningCount: 2, prior: [prior('TAB_SWITCH', 'WARNING', 2, 60)], now: at(120) })).toEqual({ outcome: 'TERMINATED', warningNumber: 3, warningCount: 3, terminate: true });
  });

  it('every type shares the one counter (tab switch, fullscreen, window, devices under WARN)', () => {
    const warnAll: AiInterviewProtectionSettings = { ...S, cameraPolicy: 'WARN', microphonePolicy: 'WARN', maxWarnings: 5 };
    let count = 0;
    const history: PriorIncident[] = [];
    (['TAB_SWITCH', 'FULLSCREEN_EXIT', 'WINDOW_BLUR', 'CAMERA_LOST', 'MIC_LOST'] as const).forEach((type, i) => {
      const d = classifyViolation({ type, settings: warnAll, warningCount: count, prior: history, now: at(i * 60) });
      expect(d.warningNumber).toBe(i + 1);
      count = d.warningCount;
      history.push(prior(type, d.outcome, d.warningNumber, i * 60));
    });
    expect(count).toBe(5);
  });

  it('groups a second event within the window into the counted incident (Alt+Tab out of fullscreen)', () => {
    const d = classifyViolation({ type: 'TAB_SWITCH', settings: S, warningCount: 1, prior: [prior('FULLSCREEN_EXIT', 'WARNING', 1, 0)], now: at(1) });
    expect(d).toEqual({ outcome: 'GROUPED', warningNumber: 1, warningCount: 1, terminate: false });
  });

  it('the window is measured from the counted incident and never extended: rapid repeated switching keeps counting', () => {
    const history = [prior('TAB_SWITCH', 'WARNING', 1, 0), prior('TAB_SWITCH', 'GROUPED', 1, 2)];
    expect(classifyViolation({ type: 'TAB_SWITCH', settings: S, warningCount: 1, prior: history, now: at(3.5) })).toMatchObject({ outcome: 'WARNING', warningNumber: 2 });
  });

  it('devices: RECOVER records without a warning; one continuous failure is one incident; WARN counts it once', () => {
    expect(classifyViolation({ type: 'CAMERA_LOST', settings: S, warningCount: 0, prior: [], now: at(0) })).toMatchObject({ outcome: 'RECORDED', warningNumber: null, warningCount: 0 });
    const warn = { ...S, cameraPolicy: 'WARN' as const };
    const first = classifyViolation({ type: 'CAMERA_LOST', settings: warn, warningCount: 0, prior: [], now: at(0) });
    expect(first).toMatchObject({ outcome: 'WARNING', warningNumber: 1 });
    // still lost 30 s later (another report of the same failure): grouped, no second warning
    expect(classifyViolation({ type: 'CAMERA_LOST', settings: warn, warningCount: 1, prior: [prior('CAMERA_LOST', 'WARNING', 1, 0)], now: at(30) })).toMatchObject({ outcome: 'GROUPED', warningCount: 1 });
    // resolved, then lost again: a new incident
    expect(classifyViolation({ type: 'CAMERA_LOST', settings: warn, warningCount: 1, prior: [prior('CAMERA_LOST', 'WARNING', 1, 0, { resolvedAt: at(40) })], now: at(90) })).toMatchObject({ outcome: 'WARNING', warningNumber: 2 });
  });

  it('switched-off monitoring only records', () => {
    expect(classifyViolation({ type: 'TAB_SWITCH', settings: { ...S, tabSwitchMonitoring: false }, warningCount: 0, prior: [], now: at(0) }).outcome).toBe('RECORDED');
    expect(classifyViolation({ type: 'FULLSCREEN_EXIT', settings: { ...S, fullscreenRequired: false }, warningCount: 0, prior: [], now: at(0) }).outcome).toBe('RECORDED');
  });

  it('snapshot: null = not monitored (opened before protection); damaged = defaults', () => {
    expect(parseProtection(null)).toBeNull();
    expect(parseProtection({ maxWarnings: 'lots' })).toEqual(S);
    expect(protectionState(null, 0, [])).toMatchObject({ enabled: false, maxWarnings: 0 });
    const state = protectionState(S, 2, [prior('TAB_SWITCH', 'WARNING', 1, 0, { acknowledgedAt: at(5) }), prior('FULLSCREEN_EXIT', 'WARNING', 2, 60)]);
    expect(state.pendingWarning).toEqual({ warningNumber: 2, type: 'FULLSCREEN_EXIT', final: true });
  });
});

// ---------------------------------------------------------------- the service, end to end with the in-memory store

let store: MemoryStore;
let worker: FakeWorker;
let audit: FakeAudit;
let rounds: FakeRounds;
let engine: FakeEngine;
let now: Date;
let service: AiInterviewService;
let protection: InterviewProtectionService;
let hr: AiInterviewHrService;
let n = 0;

const START = { consent: true, camera: true, microphone: true };
const HR_ACTOR = { id: '01a20000-0000-7000-8000-0000000000e1', name: 'Riya (HR)' };
const later = (seconds: number) => (now = new Date(now.getTime() + seconds * 1000));
const settle = () => new Promise((r) => setTimeout(r, 0));
const incident = () => `inc-${++n}-xxxxxxxx`;
const report = async (type: AiInterviewViolationType, id = incident(), token = TOKEN) => aiInterviewViolationResultSchema.parse(await protection.report(token, { incidentId: id, type }));
const answer = (seq: number, token = TOKEN) => service.answer(token, { seq, clientTurnId: `turn-${++n}-xxxxxx`, durationMs: 9000, audio: audio() });
const sessionOf = (app = APP) => [...store.sessions.values()].find((s) => s.applicationId === app)!;
const errorOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpException);
  return { status: (err as HttpException).getStatus(), body: (err as HttpException).getResponse() as Record<string, unknown> };
};

beforeEach(() => {
  store = new MemoryStore();
  worker = new FakeWorker();
  audit = new FakeAudit();
  rounds = new FakeRounds();
  engine = new FakeEngine();
  now = new Date(T0);
  store.addInvite(TOKEN);
  store.contexts.set(APP, CTX);
  const clock = () => now;
  service = new AiInterviewService(store, worker as unknown as InterviewWorkerClient, new SpeechCache(), rounds as unknown as RoundsConfigService, audit as unknown as AuditService, clock);
  protection = new InterviewProtectionService(store, service, rounds as unknown as RoundsConfigService, audit as unknown as AuditService, clock);
  hr = new AiInterviewHrService(store, service, engine as unknown as RoundEngineService, rounds as unknown as RoundsConfigService, audit as unknown as AuditService, clock);
});

afterEach(() => {
  delete process.env.FEATURE_AI_INTERVIEW_PROTECTION;
});

/** Opened, started, greeting answered: the first technical question is pending. */
async function running() {
  await service.view(TOKEN);
  await service.start(TOKEN, START);
  worker.queue(heard("Yes, I'm ready."));
  await answer(1);
}

describe('protection: the expected flow', () => {
  it('tab switch -> warning 1, fullscreen exit -> final warning 2, tab switch again -> terminated by the server', async () => {
    await running();
    worker.queue(heard('A question is embedded, then retrieved from ChromaDB.'));
    await answer(2);
    expect((await service.view(TOKEN)).protection).toMatchObject({ enabled: true, warningCount: 0, maxWarnings: 2, tabSwitchMonitoring: true, fullscreenRequired: true, pendingWarning: null });

    expect(await report('TAB_SWITCH')).toEqual({ outcome: 'WARNING', warningNumber: 1, warningCount: 1, maxWarnings: 2, status: 'IN_PROGRESS' });
    later(60);
    expect(await report('FULLSCREEN_EXIT')).toMatchObject({ outcome: 'WARNING', warningNumber: 2, warningCount: 2, status: 'IN_PROGRESS' });
    expect((await service.view(TOKEN)).protection.pendingWarning).toEqual({ warningNumber: 2, type: 'FULLSCREEN_EXIT', final: true });
    later(60);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'TERMINATED', warningNumber: 3, warningCount: 3, status: 'TERMINATED' });

    const s = sessionOf();
    expect(s).toMatchObject({ status: 'TERMINATED', endedReason: 'MAX_WARNINGS_EXCEEDED', integrityStatus: 'INTEGRITY_VIOLATION_REVIEW', warningCount: 3 });
    expect(s.terminationReason).toContain('3rd qualifying incident');
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['ai_interview.protection_warning', 'ai_interview.terminated']));
    expect(audit.entries.filter((e) => e.action === 'ai_interview.terminated')).toHaveLength(1);

    // answers saved before the termination are kept and evaluated (as an unfinished interview)
    await settle();
    expect(store.turnRows.get(s.id)!.map((t) => t.seq)).toEqual([1, 2]);
    expect(worker.reportCalls).toHaveLength(1);
    expect(worker.reportCalls[0]!.status).toBe('INCOMPLETE');

    // nothing more is accepted from the candidate; the page shows the termination from the server
    const view = aiInterviewPublicSessionSchema.parse(await service.view(TOKEN));
    expect(view).toMatchObject({ status: 'TERMINATED', remainingSeconds: 0 });
    expect(await errorOf(answer(view.current!.seq))).toMatchObject({ status: 409, body: { code: 'INTERVIEW_TERMINATED' } });
    expect(await errorOf(service.start(TOKEN, START))).toMatchObject({ status: 409, body: { code: 'INTERVIEW_TERMINATED' } });
    expect(await errorOf(service.repeat(TOKEN))).toMatchObject({ body: { code: 'INTERVIEW_TERMINATED' } });
    expect(await errorOf(service.resume(TOKEN, { camera: true, microphone: true }))).toMatchObject({ body: { code: 'INTERVIEW_TERMINATED' } });
    expect((await service.end(TOKEN)).status).toBe('TERMINATED'); // "end" cannot turn it into a normal completion
    // a further report changes nothing (no 4th warning, no second termination)
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', warningCount: 3, status: 'TERMINATED' });
  });

  it('an answer being transcribed when the interview is terminated is not saved', async () => {
    await running();
    const real = worker.turn.bind(worker);
    worker.turn = async (input) => {
      // the candidate switches away three times while the answer is being transcribed
      for (let i = 0; i < 3; i++) {
        await report('TAB_SWITCH');
        later(10);
      }
      return real(input);
    };
    worker.queue(heard('Late answer'));
    expect(await errorOf(answer(2))).toMatchObject({ status: 409, body: { code: 'INTERVIEW_TERMINATED' } });
    expect(store.turnRows.get(sessionOf().id)!.map((t) => t.seq)).toEqual([1]);
  });
});

describe('protection: duplicates, grouping, concurrency', () => {
  it('the same incident sent again (retry, keepalive + normal send) is counted once', async () => {
    await running();
    const id = incident();
    const first = await report('TAB_SWITCH', id);
    later(30);
    const again = await report('TAB_SWITCH', id);
    expect(first).toMatchObject({ outcome: 'WARNING', warningNumber: 1, warningCount: 1 });
    expect(again).toMatchObject({ outcome: 'WARNING', warningNumber: 1, warningCount: 1 });
    expect(store.violationRows.get(sessionOf().id)).toHaveLength(1);
  });

  it('events of one incident arriving together (fullscreen exit + hidden) give one warning', async () => {
    await running();
    await report('FULLSCREEN_EXIT');
    later(1);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'GROUPED', warningNumber: 1, warningCount: 1 });
  });

  it('simultaneous reports never skip or double a warning number', async () => {
    await running();
    const results = await Promise.all(Array.from({ length: 6 }, () => report('TAB_SWITCH')));
    expect(results.filter((r) => r.outcome === 'WARNING')).toHaveLength(1);
    expect(sessionOf().warningCount).toBe(1);
    // genuinely separate later incidents still count, one after the other
    later(10);
    const [a, b] = await Promise.all([report('TAB_SWITCH'), report('WINDOW_BLUR')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['GROUPED', 'WARNING']);
    expect(sessionOf().warningCount).toBe(2);
  });

  it('a flood of uncounted reports is capped; counted ones are always stored', async () => {
    await running();
    await service.pause(TOKEN, { reason: 'CAMERA_LOST' });
    for (let i = 0; i < 205; i++) {
      await report('CAMERA_LOST');
      await service.resume(TOKEN, { camera: true, microphone: true });
      await service.pause(TOKEN, { reason: 'CAMERA_LOST' });
    }
    expect(store.violationRows.get(sessionOf().id)!.length).toBe(200);
    expect(sessionOf().warningCount).toBe(0);
  });
});

describe('protection: technical problems are not misconduct', () => {
  it('camera lost (default RECOVER): recorded, no warning; repeats while still lost are one incident; resolved on resume', async () => {
    await running();
    await service.pause(TOKEN, { reason: 'CAMERA_LOST' });
    expect(await report('CAMERA_LOST')).toMatchObject({ outcome: 'RECORDED', warningCount: 0, status: 'PAUSED' });
    later(5);
    expect(await report('CAMERA_LOST')).toMatchObject({ outcome: 'GROUPED', warningCount: 0 });
    // switching tabs while paused (e.g. to browser settings to allow the camera again) is not counted
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', warningCount: 0 });
    later(20);
    await service.resume(TOKEN, { camera: true, microphone: true });
    const rows = store.violationRows.get(sessionOf().id)!;
    expect(rows.every((r) => r.resolvedAt)).toBe(true);
    expect(sessionOf().status).toBe('IN_PROGRESS');
    // progress was not lost: the same question is still pending
    expect((await service.view(TOKEN)).current?.seq).toBe(2);
  });

  it('HR chose WARN for the microphone: one warning per incident, not per report', async () => {
    store.settings.set(ROUND, { tenantId: TENANT, settings: { ...S, microphonePolicy: 'WARN' }, updatedAt: T0, updatedByName: 'HR' });
    await running();
    expect(await report('MIC_LOST')).toMatchObject({ outcome: 'WARNING', warningNumber: 1 });
    await service.pause(TOKEN, { reason: 'MIC_LOST' });
    for (let i = 0; i < 5; i++) {
      later(10);
      expect(await report('MIC_LOST')).toMatchObject({ outcome: 'GROUPED', warningCount: 1 });
    }
  });

  it('nothing is counted before the interview starts or for interviews opened before protection existed', async () => {
    await service.view(TOKEN);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', warningCount: 0 });
    sessionOf().protection = null; // a legacy session
    await service.start(TOKEN, START);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', maxWarnings: 0 });
    expect((await service.view(TOKEN)).protection.enabled).toBe(false);
  });

  it('FEATURE_AI_INTERVIEW_PROTECTION=off: new interviews are not monitored', async () => {
    process.env.FEATURE_AI_INTERVIEW_PROTECTION = 'off';
    await service.view(TOKEN);
    expect(sessionOf().protection).toBeNull();
  });
});

describe('protection: multiple faces', () => {
  it('RECORD (HR choice): noted for HR, never a warning', async () => {
    store.settings.set(ROUND, { tenantId: TENANT, settings: { ...S, multipleFacesPolicy: 'RECORD' }, updatedAt: T0, updatedByName: 'HR' });
    await running();
    expect((await service.view(TOKEN)).protection.multipleFacesPolicy).toBe('RECORD');
    expect(await report('MULTIPLE_FACES')).toMatchObject({ outcome: 'RECORDED', warningCount: 0 });
    const rows = store.violationRows.get(sessionOf().id)!;
    expect(rows.map((r) => r.type)).toEqual(['MULTIPLE_FACES']);
  });

  it('default WARN: one episode is one warning on the shared counter; the 3rd incident terminates', async () => {
    await running();
    expect((await service.view(TOKEN)).protection.multipleFacesPolicy).toBe('WARN');
    const id = incident();
    expect(await report('MULTIPLE_FACES', id)).toMatchObject({ outcome: 'WARNING', warningNumber: 1 });
    expect(await report('MULTIPLE_FACES', id)).toMatchObject({ outcome: 'WARNING', warningNumber: 1, warningCount: 1 }); // same episode re-sent
    later(60);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'WARNING', warningNumber: 2 });
    later(60);
    expect(await report('MULTIPLE_FACES')).toMatchObject({ outcome: 'TERMINATED', warningNumber: 3 });
  });

  it('OFF: not accepted at all; never counted while paused', async () => {
    store.settings.set(ROUND, { tenantId: TENANT, settings: { ...S, multipleFacesPolicy: 'OFF' }, updatedAt: T0, updatedByName: 'HR' });
    await running();
    expect((await service.view(TOKEN)).protection.multipleFacesPolicy).toBe('OFF');
    expect(await report('MULTIPLE_FACES')).toMatchObject({ outcome: 'IGNORED' });
    expect(store.violationRows.get(sessionOf().id) ?? []).toHaveLength(0);
  });

  it('a paused interview does not take face reports', async () => {
    await running();
    await service.pause(TOKEN, { reason: 'CAMERA_LOST' });
    expect(await report('MULTIPLE_FACES')).toMatchObject({ outcome: 'IGNORED' });
  });

  it('HR can choose the policy; invalid values are refused', async () => {
    await protection.saveSettings(TENANT, JOB, ROUND, { ...S, multipleFacesPolicy: 'RECORD' }, HR_ACTOR);
    expect((await protection.settings(TENANT, JOB, ROUND)).settings.multipleFacesPolicy).toBe('RECORD');
    expect(await errorOf(protection.saveSettings(TENANT, JOB, ROUND, { ...S, multipleFacesPolicy: 'TERMINATE' }, HR_ACTOR))).toMatchObject({ status: 400 });
  });
});

describe('protection: persistence and security', () => {
  it('a reload (new page load) sees the same count and the unacknowledged warning until it is acknowledged', async () => {
    await running();
    await report('TAB_SWITCH');
    // "refresh": the page has no state; everything comes from the server
    let view = await service.view(TOKEN);
    expect(view.protection).toMatchObject({ warningCount: 1, pendingWarning: { warningNumber: 1, type: 'TAB_SWITCH', final: false } });
    expect(await protection.acknowledge(TOKEN, { warningNumber: 1 })).toEqual({ acknowledged: true });
    expect(await protection.acknowledge(TOKEN, { warningNumber: 1 })).toEqual({ acknowledged: false });
    view = await service.view(TOKEN);
    expect(view.protection).toMatchObject({ warningCount: 1, pendingWarning: null });
    // pause / resume (connection drop, reconnect) never resets it
    await service.pause(TOKEN, { reason: 'CONNECTION_LOST' });
    await service.resume(TOKEN, { camera: true, microphone: true });
    expect((await service.view(TOKEN)).protection.warningCount).toBe(1);
  });

  it('the page cannot set or lower the count: extra fields are ignored, unknown types refused', async () => {
    await running();
    await report('TAB_SWITCH');
    later(10);
    expect(await protection.report(TOKEN, { incidentId: incident(), type: 'TAB_SWITCH', warningCount: 0, maxWarnings: 99, status: 'IN_PROGRESS' })).toMatchObject({ warningNumber: 2, warningCount: 2, maxWarnings: 2 });
    expect(await errorOf(protection.report(TOKEN, { incidentId: incident(), type: 'RESET_WARNINGS' }))).toMatchObject({ status: 400 });
    expect(await errorOf(protection.report(TOKEN, { incidentId: 'x', type: 'TAB_SWITCH' }))).toMatchObject({ status: 400 });
    expect(await errorOf(protection.acknowledge(TOKEN, { warningNumber: -1 }))).toMatchObject({ status: 400 });
  });

  it("one candidate's incidents never touch another candidate's interview; a bad link is a 404", async () => {
    store.addInvite(OTHER_TOKEN, { applicationId: OTHER_APP });
    store.contexts.set(OTHER_APP, { ...CTX, applicationId: OTHER_APP, candidateId: 'cand-2' });
    await running();
    await service.view(OTHER_TOKEN);
    await service.start(OTHER_TOKEN, START);
    await report('TAB_SWITCH', incident(), OTHER_TOKEN);
    expect(sessionOf(OTHER_APP).warningCount).toBe(1);
    expect(sessionOf(APP).warningCount).toBe(0);
    // the same incident id used by another candidate is their own incident (idempotency is per interview)
    const shared = incident();
    later(10);
    await report('TAB_SWITCH', shared, OTHER_TOKEN);
    expect(await report('TAB_SWITCH', shared, TOKEN)).toMatchObject({ outcome: 'WARNING', warningCount: 1 });
    expect(await errorOf(protection.report('tok_' + 'z'.repeat(40), { incidentId: incident(), type: 'TAB_SWITCH' }))).toMatchObject({ status: 404 });
    expect(await errorOf(protection.report(undefined, { incidentId: incident(), type: 'TAB_SWITCH' }))).toMatchObject({ status: 404 });
  });
});

describe('protection: HR review and settings', () => {
  async function terminated() {
    await running();
    worker.queue(heard('Answer about RAG.'));
    await answer(2);
    for (let i = 0; i < 3; i++) {
      await report('TAB_SWITCH');
      later(30);
    }
    await settle();
  }

  it('HR sees the integrity review with every incident; another company sees nothing', async () => {
    await terminated();
    const view = aiInterviewHrViewSchema.parse(await hr.view(TENANT, APP));
    const round = view.rounds[0]!;
    expect(round.session?.status).toBe('TERMINATED');
    expect(round.integrity).toMatchObject({ status: 'INTEGRITY_VIOLATION_REVIEW', warningCount: 3, settings: S });
    expect(round.integrity!.violations.map((v) => [v.type, v.outcome, v.warningNumber])).toEqual([
      ['TAB_SWITCH', 'WARNING', 1],
      ['TAB_SWITCH', 'WARNING', 2],
      ['TAB_SWITCH', 'TERMINATED', 3],
    ]);
    expect(round.integrity!.terminationReason).toContain('3rd');
    expect(round.turns.map((t) => t.seq)).toEqual([1, 2]);
    expect(round.canDecide).toBe(true);
    expect(await errorOf(hr.view(OTHER_TENANT, APP))).toMatchObject({ status: 404 });
  });

  it('termination is not a rejection: HR decides with a written reason, through the round engine, once', async () => {
    await terminated();
    expect(engine.recorded).toHaveLength(0); // nothing moved on its own
    expect(await errorOf(hr.decide(TENANT, APP, ROUND, { decision: 'REJECT', reason: '' }, HR_ACTOR))).toMatchObject({ status: 400, body: { code: 'REASON_REQUIRED' } });
    await hr.decide(TENANT, APP, ROUND, { decision: 'REJECT', reason: 'Left the interview three times during technical questions.' }, HR_ACTOR);
    expect(engine.recorded).toHaveLength(1);
    expect(engine.recorded[0]!.hrDecision).toMatchObject({ passed: false });
    expect(sessionOf().integrityStatus).toBe('REVIEWED');
    expect(await errorOf(hr.decide(TENANT, APP, ROUND, { decision: 'ADVANCE', reason: 'Changed my mind.' }, HR_ACTOR))).toMatchObject({ status: 409 });
  });

  it("HR's round settings apply to interviews opened afterwards; an opened interview keeps the rules it showed", async () => {
    expect(await protection.settings(TENANT, JOB, ROUND)).toMatchObject({ isDefault: true, settings: S });
    await protection.saveSettings(TENANT, JOB, ROUND, { maxWarnings: 1, tabSwitchMonitoring: true, fullscreenRequired: false, cameraPolicy: 'RECOVER', microphonePolicy: 'RECOVER' }, HR_ACTOR);
    expect(await protection.settings(TENANT, JOB, ROUND)).toMatchObject({ isDefault: false, settings: { maxWarnings: 1, fullscreenRequired: false }, updatedBy: 'Riya (HR)' });
    expect(audit.entries.some((e) => e.action === 'ai_interview.protection_settings_updated')).toBe(true);

    await running();
    expect((await service.view(TOKEN)).protection).toMatchObject({ maxWarnings: 1, fullscreenRequired: false });
    expect(await report('FULLSCREEN_EXIT')).toMatchObject({ outcome: 'RECORDED', warningCount: 0 });
    later(10);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'WARNING', warningNumber: 1 });
    // HR tightens the rules mid-interview: this interview is not affected
    await protection.saveSettings(TENANT, JOB, ROUND, { ...S, fullscreenRequired: true }, HR_ACTOR);
    later(10);
    expect(await report('FULLSCREEN_EXIT')).toMatchObject({ outcome: 'RECORDED' });
    later(10);
    expect(await report('TAB_SWITCH')).toMatchObject({ outcome: 'TERMINATED', warningNumber: 2 });
  });

  it('settings: other company, non-AI rounds and invalid values are refused', async () => {
    expect(await errorOf(protection.settings(OTHER_TENANT, JOB, ROUND))).toMatchObject({ status: 404 });
    expect(await errorOf(protection.saveSettings(OTHER_TENANT, JOB, ROUND, S, HR_ACTOR))).toMatchObject({ status: 404 });
    expect(await errorOf(protection.settings(TENANT, JOB, GD_ROUND))).toMatchObject({ status: 404 });
    expect(await errorOf(protection.saveSettings(TENANT, JOB, ROUND, { ...S, maxWarnings: 0 }, HR_ACTOR))).toMatchObject({ status: 400 });
    expect(await errorOf(protection.saveSettings(TENANT, JOB, ROUND, { ...S, cameraPolicy: 'TERMINATE' }, HR_ACTOR))).toMatchObject({ status: 400 });
  });
});
