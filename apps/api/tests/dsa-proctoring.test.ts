import { describe, expect, it } from 'vitest';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { RESULT_MARKER } from '../src/modules/dsa/evaluation/harness';
import type { CodeRunner, Judge0Job } from '../src/modules/dsa/judge0/judge0.client';
import { DISABLED_POLICY, policyFromEnv, type ProctorPolicy } from '../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService, inviteRefFor } from '../src/modules/dsa/proctoring/proctoring.service';
import { InMemoryProctorStore } from '../src/modules/dsa/proctoring/proctoring.store';
import { CONSENT_VERSION } from '../src/modules/dsa/proctoring/proctoring.types';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../src/modules/dsa/session/session.store';

const A = 'demo-dsa-token';
const B = 'demo-dsa-short'; // 1 minute
const T0 = 1_700_000_000_000;
const expectedByStdin = new Map(MOCK_QUESTIONS.flatMap((q) => q.testCases.map((t) => [t.stdin, t.expectedOutput] as const)));
const perfectRunner: CodeRunner = {
  async runBatch(jobs: Judge0Job[]) {
    return jobs.map((j) => ({
      verdict: 'ok' as const, statusText: 'Accepted', stderr: '', compileOutput: '', timeMs: 3, memoryKb: 100,
      stdout: `\n${RESULT_MARKER}${expectedByStdin.get(j.stdin)}\n`,
    }));
  },
};

function setup(overrides: Partial<ProctorPolicy> = {}) {
  const clock = { t: T0 };
  // maxStrikes is 0 here so the earlier tests can record many events; the allowed-warnings rule has its own describe below.
  const policy: ProctorPolicy = { ...policyFromEnv({}), enabled: true, maxStrikes: 0, ...overrides };
  const proctoring = new ProctoringService(new InMemoryProctorStore(), policy, () => clock.t);
  const service = new DsaService(
    new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), perfectRunner, () => clock.t, proctoring,
  );
  const consent = { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true };
  const begin = async (token = A) => {
    await service.proctorStart(token, consent);
    return service.start(token);
  };
  /** Records events at `offsetSec` seconds after T0 (client time, which the server clamps). */
  const send = (token: string, ...events: { type: string; at?: number; detail?: string }[]) => service.proctorEvents(token, { events });
  const at = (sec: number) => T0 + sec * 1000;
  const summary = (token = A) => proctoring.summary(inviteRefFor(token));
  return { service, proctoring, clock, begin, send, at, summary, consent };
}
const rejects = (p: Promise<unknown>, code: string, status: number) => expect(p).rejects.toMatchObject({ response: { code }, status });

describe('consent and start gating', () => {
  it('will not start the assessment until the monitoring notice is accepted', async () => {
    const { service } = setup();
    await rejects(service.start(A), 'PROCTORING_NOT_STARTED', 409);
  });

  it('validates consent: required, current version, full screen on', async () => {
    const { service, consent } = setup();
    await rejects(service.proctorStart(A, { ...consent, consent: false }), 'CONSENT_REQUIRED', 400);
    await rejects(service.proctorStart(A, { ...consent, consentVersion: 'old' }), 'CONSENT_OUTDATED', 409);
    await rejects(service.proctorStart(A, { ...consent, fullscreen: false }), 'FULLSCREEN_REQUIRED', 400);
    await rejects(service.proctorStart(A, { ...consent, candidateId: 'someone-else' }), 'UNEXPECTED_FIELD', 400);
    await service.proctorStart(A, consent);
    expect((await service.start(A)).status).toBe('in_progress');
  });

  it('exposes the rules and the candidate standing but no thresholds or event log', async () => {
    const { service, begin } = setup();
    const state = await begin();
    expect(state.proctoring).toMatchObject({ enabled: true, requireFullscreen: true, fullscreenReentry: 'block', started: true, violationCount: 0, level: 'ok' });
    expect(state.proctoring.monitored.length).toBeGreaterThan(3);
    const json = JSON.stringify(state);
    expect(json).not.toMatch(/warnScore|reviewScore|disqualifyScore|inviteRef/);
    void service;
  });

  it('is off cleanly when disabled: no gating, events refused', async () => {
    const clock = { t: T0 };
    const service = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), perfectRunner, () => clock.t,
      new ProctoringService(new InMemoryProctorStore(), DISABLED_POLICY, () => clock.t));
    expect((await service.start(A)).proctoring.enabled).toBe(false);
    await rejects(service.proctorEvents(A, { events: [{ type: 'COPY' }] }), 'PROCTORING_DISABLED', 404);
  });
});

describe('recording events', () => {
  it('refuses events before the assessment starts and after it ends', async () => {
    const { service, begin, send } = setup();
    await service.proctorStart(A, { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true });
    await rejects(send(A, { type: 'COPY' }), 'NOT_STARTED', 409);
    await begin();
    await send(A, { type: 'COPY' });
    await service.finish(A);
    await rejects(send(A, { type: 'COPY' }), 'ALREADY_FINISHED', 403);
  });

  it('records a full-screen exit with its duration, and returning closes it', async () => {
    const { begin, send, at, summary, proctoring, clock } = setup();
    await begin();
    clock.t = at(30);
    await send(A, { type: 'FULLSCREEN_EXIT', at: at(10) });
    await send(A, { type: 'FULLSCREEN_RETURN', at: at(25) });
    const s = await summary();
    expect(s).toMatchObject({ fullscreenExitCount: 1, totalViolations: 1, totalTimeOutsideMs: 15_000 });
    const page = await proctoring.events(inviteRefFor(A), 10, 0);
    expect(page?.events[0]).toMatchObject({ type: 'FULLSCREEN_EXIT', durationMs: 15_000, severity: 'medium' });
  });

  it('counts the same action once: key event plus clipboard event, and repeated reports', async () => {
    const { begin, send, at, summary, clock } = setup();
    await begin();
    clock.t = at(20);
    const r = await send(A, { type: 'COPY', at: at(5) }, { type: 'COPY', at: at(5.1) });
    expect(r).toMatchObject({ accepted: 1, ignored: 1 });
    await send(A, { type: 'COPY', at: at(8) });
    expect((await summary())?.copyPasteAttempts).toBe(2);
  });

  it('merges a window blur into the tab switch it belongs to, in either order', async () => {
    const { begin, send, at, summary, clock } = setup();
    await begin();
    clock.t = at(60);
    await send(A, { type: 'WINDOW_BLUR', at: at(10) }, { type: 'TAB_SWITCH', at: at(10.2) }); // blur first
    await send(A, { type: 'TAB_RETURN', at: at(14) }, { type: 'WINDOW_RETURN', at: at(14.1) });
    await send(A, { type: 'TAB_SWITCH', at: at(30) }, { type: 'WINDOW_BLUR', at: at(30.3) }); // tab first
    await send(A, { type: 'TAB_RETURN', at: at(33) });
    await send(A, { type: 'WINDOW_BLUR', at: at(45) }); // a genuine focus loss with the tab still visible
    await send(A, { type: 'WINDOW_RETURN', at: at(50) });
    const s = await summary();
    expect(s).toMatchObject({ tabSwitchCount: 2, windowBlurCount: 1, totalViolations: 3 });
    expect(s?.totalTimeOutsideMs).toBe(4000 + 3000 + 5000);
  });

  it('treats the full-screen exit Chrome performs on a tab switch as part of the tab switch (real event order: exit, blur, hidden)', async () => {
    const { begin, send, at, summary, clock, proctoring } = setup();
    await begin();
    clock.t = at(200);
    // exactly what Chrome sends: fullscreenchange(false), window blur, visibilitychange(hidden) within a few ms
    await send(A, { type: 'FULLSCREEN_EXIT', at: at(10) }, { type: 'TAB_SWITCH', at: at(10.003) });
    await send(A, { type: 'TAB_RETURN', at: at(14) }, { type: 'FULLSCREEN_RETURN', at: at(16) }); // back, then re-enters full screen
    // the other order, and a genuinely separate exit a few seconds before a switch
    await send(A, { type: 'TAB_SWITCH', at: at(40) }, { type: 'FULLSCREEN_EXIT', at: at(40.002) });
    await send(A, { type: 'TAB_RETURN', at: at(43) });
    await send(A, { type: 'FULLSCREEN_EXIT', at: at(60) });
    await send(A, { type: 'FULLSCREEN_RETURN', at: at(63) });
    await send(A, { type: 'TAB_SWITCH', at: at(70) });
    await send(A, { type: 'TAB_RETURN', at: at(72) });
    expect(await summary()).toMatchObject({ tabSwitchCount: 3, fullscreenExitCount: 1, totalViolations: 4 });
    const page = await proctoring.events(inviteRefFor(A), 10, 0);
    expect(page?.events[0]).toMatchObject({ type: 'TAB_SWITCH', durationMs: 4000 }); // starts at the earliest signal (10.000 s), not at the later hidden event
  });

  it('ignores an episode that is already open and a return with nothing open', async () => {
    const { begin, send, at, summary, clock } = setup();
    await begin();
    clock.t = at(60);
    expect(await send(A, { type: 'TAB_RETURN', at: at(1) })).toMatchObject({ accepted: 0, ignored: 1 });
    await send(A, { type: 'TAB_SWITCH', at: at(10) });
    expect(await send(A, { type: 'TAB_SWITCH', at: at(20) })).toMatchObject({ accepted: 0, ignored: 1 });
    expect((await summary())?.tabSwitchCount).toBe(1);
  });

  it('escalates repeated full-screen exits to high severity', async () => {
    const { begin, send, at, proctoring, clock } = setup();
    await begin();
    clock.t = at(100);
    for (const s of [10, 20, 30]) {
      await send(A, { type: 'FULLSCREEN_EXIT', at: at(s) });
      await send(A, { type: 'FULLSCREEN_RETURN', at: at(s + 2) });
    }
    const page = await proctoring.events(inviteRefFor(A), 10, 0);
    expect(page?.events.map((e) => e.severity)).toEqual(['medium', 'medium', 'high']);
  });

  it('records low severity for copy/paste and context menu, medium for dev-tools, and info for a resumed session', async () => {
    const { begin, send, at, proctoring, summary, clock } = setup();
    await begin();
    clock.t = at(60);
    await send(A, { type: 'PASTE', at: at(5) }, { type: 'CONTEXT_MENU', at: at(6) }, { type: 'DEVTOOLS_SHORTCUT', at: at(7), detail: 'F12' }, { type: 'SESSION_RESUMED', at: at(8) });
    const page = await proctoring.events(inviteRefFor(A), 10, 0);
    expect(page?.events.map((e) => [e.type, e.severity])).toEqual([
      ['PASTE', 'low'], ['CONTEXT_MENU', 'low'], ['DEVTOOLS_SHORTCUT', 'medium'], ['SESSION_RESUMED', 'info'],
    ]);
    expect(await summary()).toMatchObject({ totalViolations: 3, sessionResumes: 1, devToolsAttempts: 1, contextMenuAttempts: 1, copyPasteAttempts: 1 });
  });

  it('never trusts client times: they are clamped into the attempt window', async () => {
    const { begin, send, at, proctoring, clock } = setup();
    await begin();
    clock.t = at(50);
    await send(A, { type: 'COPY', at: at(9999) }, { type: 'PASTE', at: at(-9999) });
    const page = await proctoring.events(inviteRefFor(A), 10, 0);
    const times = page!.events.map((e) => Date.parse(e.at));
    expect(times.every((t) => t >= at(0) && t <= at(50))).toBe(true);
  });

  it('caps the log per attempt and counts what it dropped', async () => {
    const { begin, send, at, summary, clock } = setup({ maxEventsPerAttempt: 10 });
    await begin();
    clock.t = at(1000);
    for (let i = 0; i < 15; i++) await send(A, { type: 'COPY', at: at(10 + i * 5) });
    expect(await summary()).toMatchObject({ totalViolations: 10, droppedEvents: 5 });
  });
});

describe('input validation and identity', () => {
  it('rejects bodies that try to name a candidate, assessment or invitation', async () => {
    const { begin, service } = setup();
    await begin();
    await rejects(service.proctorEvents(A, { events: [{ type: 'COPY' }], candidateId: 'victim' }), 'UNEXPECTED_FIELD', 400);
    await rejects(service.proctorEvents(A, { events: [{ type: 'COPY', assessmentId: 'x' }] }), 'UNEXPECTED_FIELD', 400);
    await rejects(service.proctorEvents(A, { events: [{ type: 'COPY', inviteRef: 'victim' }] }), 'UNEXPECTED_FIELD', 400);
  });

  it('rejects unknown types, empty and oversized batches, and sanitises labels', async () => {
    const { begin, service, send, proctoring, clock, at } = setup();
    await begin();
    await rejects(service.proctorEvents(A, { events: [{ type: 'MAKE_ME_PASS' }] }), 'INVALID_EVENT_TYPE', 400);
    await rejects(service.proctorEvents(A, { events: [] }), 'INVALID_REQUEST', 400);
    await rejects(service.proctorEvents(A, { events: Array.from({ length: 21 }, () => ({ type: 'COPY' })) }), 'TOO_MANY_EVENTS', 400);
    clock.t = at(30);
    await send(A, { type: 'DEVTOOLS_SHORTCUT', at: at(5), detail: `Ctrl+Shift+I\u0000\n${'x'.repeat(200)}` });
    const page = await proctoring.events(inviteRefFor(A), 5, 0);
    expect(page!.events[0].detail!.length).toBeLessThanOrEqual(60);
    expect(page!.events[0].detail).not.toMatch(/[\u0000-\u001f]/);
  });

  it('keeps each candidate\'s events separate: the token is the only identity', async () => {
    const { begin, send, at, summary, clock } = setup();
    await begin(A);
    await begin(B);
    clock.t = at(30);
    await send(A, { type: 'COPY', at: at(5) }, { type: 'PASTE', at: at(10) });
    await send(B, { type: 'CONTEXT_MENU', at: at(6) });
    expect((await summary(A))?.totalViolations).toBe(2);
    expect((await summary(B))?.totalViolations).toBe(1);
    expect((await summary(A))?.assessmentId).toBe('demo-assessment');
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { begin, send, at, summary, proctoring, clock } = setup();
    await begin();
    clock.t = at(30);
    await send(A, { type: 'COPY', at: at(5) });
    const s = await summary();
    const dump = JSON.stringify([s, await proctoring.events(inviteRefFor(A), 10, 0), await proctoring.flagged()]);
    expect(s?.inviteRef).toBe(inviteRefFor(A));
    expect(s?.inviteRef).toMatch(/^[0-9a-f]{24}$/);
    expect(dump).not.toContain(A);
  });
});

describe('policy: warnings, review flags, disqualification', () => {
  const burst = async (n: number, ctx: ReturnType<typeof setup>, type = 'COPY') => {
    ctx.clock.t = ctx.at(3000); // inside the 1-hour window
    for (let i = 0; i < n; i++) await ctx.send(A, { type, at: ctx.at(10 + i * 2) });
  };

  it('warns, then flags for review, as the weighted score grows - and a single event does neither', async () => {
    const ctx = setup();
    await ctx.begin();
    await burst(1, ctx);
    expect((await ctx.summary())?.status).toBe('clean');
    await burst(5, ctx); // 5 low = 5 points (dedupe keeps same-type events 2 s apart)
    const warn = await ctx.summary();
    expect(warn).toMatchObject({ status: 'warning', flagged: false });
    expect((await ctx.service.getState(A)).proctoring.level).toBe('warning');
    for (let i = 0; i < 8; i++) await ctx.send(A, { type: 'PASTE', at: ctx.at(100 + i * 2) });
    const review = await ctx.summary();
    expect(review).toMatchObject({ status: 'review', flagged: true });
    expect(review?.reasons.join(' ')).toMatch(/review threshold/);
    expect((await ctx.service.getState(A)).proctoring.level).toBe('final_warning');
  });

  it('flags for review on repeated full-screen exits and on long time outside, independent of the score', async () => {
    const a = setup({ reviewScore: 1000 });
    await a.begin();
    a.clock.t = a.at(500);
    for (const s of [10, 20, 30]) {
      await a.send(A, { type: 'FULLSCREEN_EXIT', at: a.at(s) });
      await a.send(A, { type: 'FULLSCREEN_RETURN', at: a.at(s + 1) });
    }
    expect((await a.summary())?.reasons.join(' ')).toMatch(/Left full screen 3 times/);
    expect((await a.summary())?.status).toBe('review');

    const b = setup({ reviewScore: 1000, reviewFullscreenExits: 0, warnScore: 1000 });
    await b.begin();
    b.clock.t = b.at(500);
    await b.send(A, { type: 'TAB_SWITCH', at: b.at(10) });
    await b.send(A, { type: 'TAB_RETURN', at: b.at(80) });
    expect(await b.summary()).toMatchObject({ status: 'review', totalTimeOutsideMs: 70_000 });
  });

  it('never disqualifies by default, even after many events', async () => {
    const ctx = setup({ maxEventsPerAttempt: 500 });
    await ctx.begin();
    await burst(40, ctx);
    const s = await ctx.summary();
    expect(s?.status).toBe('review');
    expect(s?.status).not.toBe('disqualified');
    expect((await ctx.service.getState(A)).status).toBe('in_progress');
  });

  it('marks disqualified at the configured threshold but keeps the attempt running unless autoEnd is on', async () => {
    const ctx = setup({ disqualifyScore: 10 });
    await ctx.begin();
    await burst(12, ctx);
    expect(await ctx.summary()).toMatchObject({ status: 'disqualified', flagged: true });
    expect((await ctx.service.getState(A)).status).toBe('in_progress');
  });

  it('ends the attempt when autoEnd is on and keeps the work done so far', async () => {
    const ctx = setup({ disqualifyScore: 6, autoEnd: true });
    await ctx.begin();
    await ctx.service.submit(A, { questionId: 'dsa-001', language: 'python', code: 'x = 1' });
    ctx.clock.t = ctx.at(3000);
    let ended = false;
    for (let i = 0; i < 10 && !ended; i++) ended = (await ctx.send(A, { type: 'COPY', at: ctx.at(10 + i * 2) })).ended;
    expect(ended).toBe(true);
    const state = await ctx.service.getState(A);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ reason: 'disqualified', totalScore: 10 });
    await rejects(ctx.service.submit(A, { questionId: 'dsa-001', language: 'python', code: 'x = 1' }), 'ATTEMPT_ENDED', 403);
  });
});

describe('allowed warnings: two tolerated, the next one ends the assessment', () => {
  const strike = (ctx: ReturnType<typeof setup>, n: number, type = 'COPY') =>
    ctx.send(A, { type, at: ctx.at(10 + n * 3) });

  it('defaults to 2 allowed warnings', () => {
    expect(policyFromEnv({}).maxStrikes).toBe(2);
    expect(policyFromEnv({ DSA_PROCTOR_MAX_STRIKES: '5' }).maxStrikes).toBe(5);
    expect(policyFromEnv({ DSA_PROCTOR_MAX_STRIKES: '0' }).maxStrikes).toBe(0);
  });

  it('tolerates the first two suspicious events, with warnings that say how many are used', async () => {
    const ctx = setup({ maxStrikes: 2 });
    await ctx.begin();
    ctx.clock.t = ctx.at(100);
    const one = await strike(ctx, 0);
    expect(one).toMatchObject({ violationCount: 1, strikesUsed: 1, strikesAllowed: 2, level: 'warning', ended: false });
    const two = await strike(ctx, 1, 'PRINT_SHORTCUT');
    expect(two).toMatchObject({ violationCount: 2, strikesUsed: 2, level: 'final_warning', ended: false });
    expect((await ctx.service.getState(A)).status).toBe('in_progress');
    expect((await ctx.service.getState(A)).proctoring).toMatchObject({ strikesUsed: 2, strikesAllowed: 2, level: 'final_warning' });
  });

  it('ends the assessment immediately on the third, keeping the work done so far', async () => {
    const ctx = setup({ maxStrikes: 2 });
    await ctx.begin();
    await ctx.service.submit(A, { questionId: 'dsa-001', language: 'python', code: 'x = 1' });
    ctx.clock.t = ctx.at(100);
    await strike(ctx, 0, 'SCREENSHOT_ATTEMPT');
    await strike(ctx, 1);
    const third = await ctx.send(A, { type: 'FULLSCREEN_EXIT', at: ctx.at(30) });
    expect(third.ended).toBe(true);
    const state = await ctx.service.getState(A);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ reason: 'disqualified', totalScore: 10 });
    expect(state.result?.questions[0]).toMatchObject({ solved: true });
    await rejects(ctx.service.run(A, { questionId: 'dsa-001', language: 'python', code: 'x = 1' }), 'ATTEMPT_ENDED', 403);
    await rejects(ctx.send(A, { type: 'COPY', at: ctx.at(40) }), 'ATTEMPT_ENDED', 403);
  });

  it('leaving full screen after the allowance is used ends it; leaving once before that does not', async () => {
    const early = setup({ maxStrikes: 2 });
    await early.begin();
    early.clock.t = early.at(100);
    expect((await early.send(A, { type: 'FULLSCREEN_EXIT', at: early.at(10) })).ended).toBe(false);
    await early.send(A, { type: 'FULLSCREEN_RETURN', at: early.at(12) });
    expect((await early.service.getState(A)).status).toBe('in_progress');

    const late = setup({ maxStrikes: 2 });
    await late.begin();
    late.clock.t = late.at(100);
    await strike(late, 0);
    await strike(late, 1);
    expect((await late.send(A, { type: 'FULLSCREEN_EXIT', at: late.at(30) })).ended).toBe(true);
  });

  it('counts one real action once: tab switch + the browser\'s full-screen exit + blur is a single warning', async () => {
    const ctx = setup({ maxStrikes: 2 });
    await ctx.begin();
    ctx.clock.t = ctx.at(100);
    const r = await ctx.send(A, { type: 'FULLSCREEN_EXIT', at: ctx.at(10) }, { type: 'WINDOW_BLUR', at: ctx.at(10.002) }, { type: 'TAB_SWITCH', at: ctx.at(10.003) });
    expect(r).toMatchObject({ violationCount: 1, strikesUsed: 1, ended: false });
    await ctx.send(A, { type: 'TAB_RETURN', at: ctx.at(12) });
    // a double-reported key press is also one
    const copy = await ctx.send(A, { type: 'COPY', at: ctx.at(20) }, { type: 'COPY', at: ctx.at(20.05) });
    expect(copy).toMatchObject({ violationCount: 2, ended: false });
  });

  it('does not count info events, and a screenshot attempt counts and is stored as medium', async () => {
    const ctx = setup({ maxStrikes: 2 });
    await ctx.begin();
    ctx.clock.t = ctx.at(100);
    await ctx.send(A, { type: 'SESSION_RESUMED', at: ctx.at(5) }, { type: 'SESSION_RESUMED', at: ctx.at(6) }, { type: 'SESSION_RESUMED', at: ctx.at(7) });
    expect((await ctx.service.getState(A)).status).toBe('in_progress');
    await ctx.send(A, { type: 'SCREENSHOT_ATTEMPT', at: ctx.at(20), detail: 'PrintScreen' });
    const page = await ctx.proctoring.events(inviteRefFor(A), 10, 0);
    expect(page?.events.find((e) => e.type === 'SCREENSHOT_ATTEMPT')).toMatchObject({ severity: 'medium', detail: 'PrintScreen' });
    expect(await ctx.summary()).toMatchObject({ screenshotAttempts: 1, strikesUsed: 1, strikesAllowed: 2 });
  });

  it('shows HR a disqualified status with the reason, and the sealed record', async () => {
    const ctx = setup({ maxStrikes: 2 });
    await ctx.begin();
    ctx.clock.t = ctx.at(100);
    for (let i = 0; i < 3; i++) await strike(ctx, i);
    const s = await ctx.summary();
    expect(s).toMatchObject({ status: 'disqualified', flagged: true, strikesUsed: 3, strikesAllowed: 2 });
    expect(s?.reasons.join(' ')).toMatch(/allowed warnings/);
    expect(s?.endedAt).not.toBeNull();
    expect((await ctx.proctoring.flagged()).map((f) => f.inviteRef)).toContain(inviteRefFor(A));
  });

  it('a limit of 0 means no limit', async () => {
    const ctx = setup({ maxStrikes: 0 });
    await ctx.begin();
    ctx.clock.t = ctx.at(200);
    for (let i = 0; i < 10; i++) await strike(ctx, i);
    expect((await ctx.service.getState(A)).status).toBe('in_progress');
  });
});

describe('ending proctoring', () => {
  it('seals the record on finish, closes open episodes, and only allows /end afterwards', async () => {
    const ctx = setup();
    await ctx.begin();
    await rejects(ctx.service.proctorEnd(A), 'ASSESSMENT_IN_PROGRESS', 409);
    ctx.clock.t = ctx.at(120);
    await ctx.send(A, { type: 'TAB_SWITCH', at: ctx.at(100) });
    ctx.clock.t = ctx.at(130);
    await ctx.service.finish(A);
    expect(await ctx.service.proctorEnd(A)).toEqual({ ended: true });
    const s = await ctx.summary();
    expect(s?.endedAt).toBe(new Date(ctx.at(130)).toISOString());
    expect(s?.totalTimeOutsideMs).toBe(30_000);
  });

  it('closes an open episode at the deadline when time runs out', async () => {
    const ctx = setup();
    await ctx.begin(B); // 1 minute
    ctx.clock.t = ctx.at(20);
    await ctx.send(B, { type: 'TAB_SWITCH', at: ctx.at(10) });
    ctx.clock.t = ctx.at(500); // long past the deadline
    const state = await ctx.service.getState(B);
    expect(state.status).toBe('finished');
    expect(state.result?.reason).toBe('time_expired');
    const s = await ctx.summary(B);
    expect(s?.totalTimeOutsideMs).toBe(50_000); // 10 s -> deadline at 60 s
  });
});

describe('integrity events never change the result', () => {
  it('scoring and submissions work exactly as before with proctoring on', async () => {
    const ctx = setup();
    await ctx.begin();
    ctx.clock.t = ctx.at(100);
    await ctx.send(A, { type: 'TAB_SWITCH', at: ctx.at(20) }, { type: 'COPY', at: ctx.at(30) });
    const res = await ctx.service.submit(A, { questionId: 'dsa-001', language: 'python', code: 'x = 1' });
    expect(res).toMatchObject({ verdict: 'passed', score: 10 });
    const done = await ctx.service.finish(A);
    expect(done.result?.totalScore).toBe(10);
    expect(JSON.stringify(done.result)).not.toMatch(/violation|proctor/i);
  });

  it('lists flagged attempts for review, worst first', async () => {
    const ctx = setup({ reviewScore: 3 });
    await ctx.begin(A);
    await ctx.begin(B);
    ctx.clock.t = ctx.at(50); // B's window is 60 s
    for (let i = 0; i < 6; i++) await ctx.send(A, { type: 'COPY', at: ctx.at(10 + i * 2) });
    for (let i = 0; i < 3; i++) await ctx.send(B, { type: 'COPY', at: ctx.at(10 + i * 2) });
    const flagged = await ctx.proctoring.flagged();
    expect(flagged.map((f) => f.inviteRef)).toEqual([inviteRefFor(A), inviteRefFor(B)]);
  });
});
