import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { applicationRoundEngineSchema, assessmentPublicViewSchema, type AssessmentProtectionSettings, type RoundInput, type SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { assessmentProtectionFromEnv } from '../../src/modules/round-engine/assessment-protection';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, OTHER_JOB, OTHER_TENANT, TENANT, student } from '../rounds/fakes';
import { MemoryRoundEngineStore } from './fakes';

const OTHER_APP = '0192f3a1-aaaa-7000-8000-000000000002';
const T0 = new Date('2026-11-04T09:00:00Z');
const DAY = 24 * 60 * 60_000;
const RULES: AssessmentProtectionSettings = { maxWarnings: 2, tabSwitchMonitoring: true, fullscreenRequired: true, multipleFacesPolicy: 'WARN' };

/** Aptitude & English Literacy: 4 single-answer MCQs (1 mark, option 1 right) + 1 "select all" (2 marks, 0 + 2). Pass = 4 marks. */
const aptitude: RoundInput = {
  type: 'APTITUDE',
  name: 'Aptitude & English Literacy',
  timeLimitMinutes: 30,
  passRule: { mode: 'MARKS', value: 4 },
  questions: [
    ...Array.from({ length: 4 }, (_, i) => ({ kind: 'MCQ' as const, text: `Q${i + 1}`, options: ['a', 'b', 'c'], correct: [1] })),
    { kind: 'MCQ' as const, text: 'Pick the nouns', options: ['cat', 'run', 'tree'], correct: [0, 2], marks: 2 },
  ],
};
const reading: RoundInput = { type: 'CUSTOM', name: 'Reading Test', passRule: { mode: 'PERCENTAGE', value: 50 }, questions: [{ kind: 'TRUE_FALSE', text: 'Sky is blue', correct: [0] }] };

let now: Date;
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let engine: RoundEngineService;
let saved: SavedRound[];
let otherSaved: SavedRound[];
let n = 0;

const clock = () => new Date(now);
const later = (s: number) => (now = new Date(now.getTime() + s * 1000));
const settle = () => new Promise((r) => setTimeout(r, 0));
const incident = () => `inc_${++n}_xxxxxxxx`;
const errorOf = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  expect(err).toBeInstanceOf(HttpException);
  return { status: (err as HttpException).getStatus(), code: ((err as HttpException).getResponse() as { code: string }).code };
};

function invite(roundId: string, app = APP, tenant = TENANT, job = JOB) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-dddd-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: tenant,
    applicationId: app,
    jobId: job,
    roundId,
    tokenHash: t.tokenHash,
    expiresAt: new Date(now.getTime() + 7 * DAY),
    revokedAt: null,
    emailStatus: 'SENT',
    attempts: 1,
    sentAt: now,
    lastError: null,
  });
  return t.token;
}

function answers(right: number) {
  const qs = saved[0]!.questions;
  return [...qs.slice(0, 4).map((q, i) => ({ questionId: q.id, selected: [i < right ? 1 : 0], marked: false })), { questionId: qs[4]!.id, selected: [0, 2], marked: false }];
}

function build(protection: AssessmentProtectionSettings | null = RULES) {
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true, protection }, clock);
}

beforeEach(async () => {
  now = new Date(T0);
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  roundsStore.addJob(OTHER_TENANT, OTHER_JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' }, { id: OTHER_JOB, tenantId: OTHER_TENANT, title: 'Other' });
  results.students.push({ ...student(), tenantId: TENANT }, { ...student({ applicationId: OTHER_APP, jobId: OTHER_JOB }), tenantId: OTHER_TENANT });
  store = new MemoryRoundEngineStore();
  const ctx = { jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: null };
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', ...ctx });
  store.contexts.set(OTHER_APP, { tenantId: OTHER_TENANT, applicationId: OTHER_APP, jobId: OTHER_JOB, candidateName: 'Ravi Shah', email: 'ravi@example.com', ...ctx });
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  saved = (await rounds.save(TENANT, JOB, { rounds: [aptitude, reading], complete: true }, ACTOR)).rounds;
  otherSaved = (await rounds.save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude], complete: true }, ACTOR)).rounds;
  build();
});

/** Started aptitude test with 4 correct answers saved (a passing score). */
async function started(token = invite(saved[0]!.id)) {
  await engine.start(token, { consent: true });
  await engine.save(token, { revision: 1, answers: answers(4) });
  return token;
}
const report = (token: string, type: 'TAB_SWITCH' | 'WINDOW_BLUR' | 'FULLSCREEN_EXIT' | 'MULTIPLE_FACES', id = incident()) => engine.violation(token, { incidentId: id, type });

describe('assessment protection: tab switch + multiple faces, 2 warnings then terminated', () => {
  it('tab switch -> warning 1, multiple faces -> final warning 2, tab switch -> test terminated, answers kept', async () => {
    const token = await started();
    expect((await engine.view(token)).protection).toMatchObject({ enabled: true, warningCount: 0, maxWarnings: 2, multipleFacesPolicy: 'WARN', pendingWarning: null });

    expect(await report(token, 'TAB_SWITCH')).toEqual({ outcome: 'WARNING', warningNumber: 1, warningCount: 1, maxWarnings: 2, status: 'IN_PROGRESS' });
    later(60);
    expect(await report(token, 'MULTIPLE_FACES')).toMatchObject({ outcome: 'WARNING', warningNumber: 2, status: 'IN_PROGRESS' });
    expect((await engine.view(token)).protection.pendingWarning).toEqual({ warningNumber: 2, type: 'MULTIPLE_FACES', final: true });
    later(60);
    expect(await report(token, 'TAB_SWITCH')).toMatchObject({ outcome: 'TERMINATED', warningNumber: 3, warningCount: 3, status: 'TERMINATED' });
    await settle();

    const view = assessmentPublicViewSchema.parse(await engine.view(token));
    expect(view.status).toBe('TERMINATED');
    expect(view.attempt?.questions).toEqual([]); // no more questions shown
    expect(await errorOf(engine.save(token, { revision: 2, answers: answers(0) }))).toMatchObject({ status: 409, code: 'ASSESSMENT_TERMINATED' });
    expect((await engine.submit(token, { revision: 3, answers: answers(0) })).status).toBe('TERMINATED'); // cannot turn into a normal submit
    expect(await report(token, 'TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', warningCount: 3 });

    const a = store.attempts[0]!;
    expect(a).toMatchObject({ status: 'TERMINATED', integrityStatus: 'INTEGRITY_VIOLATION_REVIEW', systemPassed: true, progressedAt: null });
    expect(a.answers[saved[0]!.questions[0]!.id]?.selected).toEqual([1]); // the saved answers, not the later submit
    expect(audit.entries.filter((e) => e.action === 'assessment.terminated')).toHaveLength(1);
  });

  it('a terminated test is held: no result email and no next invite until HR decides (also after worker retries)', async () => {
    const token = await started();
    for (let i = 0; i < 3; i++) {
      await report(token, 'TAB_SWITCH');
      later(30);
    }
    await settle();
    await engine.progress(store.attempts[0]!.id); // what the worker's retry does
    expect(store.outcomeEmails).toHaveLength(0);
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(0);
    expect(await store.unprogressedAttempts(new Date(now.getTime() + DAY), 10)).toHaveLength(0);
  });

  it('HR decides with a reason; REJECT overrides the passing score and sends the rejection, once', async () => {
    const token = await started();
    for (let i = 0; i < 3; i++) {
      await report(token, 'TAB_SWITCH');
      later(30);
    }
    await settle();
    expect(await errorOf(engine.integrityDecision(TENANT, APP, saved[0]!.id, { decision: 'REJECT', reason: '' }, ACTOR))).toMatchObject({ status: 400 });
    const view = applicationRoundEngineSchema.parse(await engine.integrityDecision(TENANT, APP, saved[0]!.id, { decision: 'REJECT', reason: 'Left the test three times.' }, ACTOR));
    const round = view.rounds.find((r) => r.roundId === saved[0]!.id)!;
    expect(round.integrity).toMatchObject({ status: 'REVIEWED', warningCount: 3, decision: { decision: 'REJECT', reason: 'Left the test three times.' } });
    expect(round.integrity!.incidents.map((i) => [i.type, i.outcome, i.warningNumber])).toEqual([
      ['TAB_SWITCH', 'WARNING', 1],
      ['TAB_SWITCH', 'WARNING', 2],
      ['TAB_SWITCH', 'TERMINATED', 3],
    ]);
    expect(store.outcomeEmails.map((e) => e.kind)).toEqual(['REJECTED']);
    expect(audit.entries.some((e) => e.action === 'assessment.result_overridden')).toBe(true);
    expect(await errorOf(engine.integrityDecision(TENANT, APP, saved[0]!.id, { decision: 'ADVANCE', reason: 'Changed my mind' }, ACTOR))).toMatchObject({ status: 409 });
  });

  it('HR may ADVANCE after review: the next round is invited', async () => {
    const token = await started();
    for (let i = 0; i < 3; i++) {
      await report(token, 'MULTIPLE_FACES');
      later(30);
    }
    await settle();
    await engine.integrityDecision(TENANT, APP, saved[0]!.id, { decision: 'ADVANCE', reason: 'A sibling walked in; answers are consistent.' }, ACTOR);
    expect(store.invites.filter((i) => i.roundId === saved[1]!.id)).toHaveLength(1);
    expect(store.outcomeEmails).toHaveLength(0);
  });
});

describe('assessment protection: duplicates, grouping, persistence', () => {
  it('the same incident sent twice is one warning; events of one act within 3 s are grouped', async () => {
    const token = await started();
    const id = incident();
    await report(token, 'TAB_SWITCH', id);
    expect(await report(token, 'TAB_SWITCH', id)).toMatchObject({ outcome: 'WARNING', warningNumber: 1, warningCount: 1 });
    later(1);
    expect(await report(token, 'FULLSCREEN_EXIT')).toMatchObject({ outcome: 'GROUPED', warningNumber: 1, warningCount: 1 });
  });

  it('simultaneous reports never double count', async () => {
    const token = await started();
    const out = await Promise.all(Array.from({ length: 5 }, () => report(token, 'TAB_SWITCH')));
    expect(out.filter((r) => r.outcome === 'WARNING')).toHaveLength(1);
    expect(store.attempts[0]!.warningCount).toBe(1);
  });

  it('a reload sees the same count and the unread warning until acknowledged; the page cannot set the count', async () => {
    const token = await started();
    await report(token, 'TAB_SWITCH');
    expect((await engine.view(token)).protection).toMatchObject({ warningCount: 1, pendingWarning: { warningNumber: 1, final: false } });
    expect(await engine.acknowledge(token, { warningNumber: 1 })).toEqual({ acknowledged: true });
    expect((await engine.view(token)).protection.pendingWarning).toBeNull();
    later(10);
    expect(await engine.violation(token, { incidentId: incident(), type: 'TAB_SWITCH', warningCount: 0, maxWarnings: 9 })).toMatchObject({ warningCount: 2, maxWarnings: 2 });
    expect(await errorOf(engine.violation(token, { incidentId: incident(), type: 'CAMERA_STOPPED' }))).toMatchObject({ status: 400 });
  });

  it('nothing counts before the start, after the deadline, or when protection is off', async () => {
    const token = invite(saved[0]!.id);
    expect((await engine.view(token)).protection).toMatchObject({ enabled: true, maxWarnings: 2 }); // the notice shows the rules
    expect(await report(token, 'TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', status: 'NOT_STARTED' });
    await started(token);
    later(31 * 60);
    expect(await report(token, 'TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED' });

    build(null);
    const other = invite(saved[1]!.id);
    await engine.start(other, { consent: true });
    expect(await report(other, 'TAB_SWITCH')).toMatchObject({ outcome: 'IGNORED', maxWarnings: 0 });
    expect((await engine.view(other)).protection.enabled).toBe(false);
  });

  it('faces: RECORD notes without a warning; OFF ignores', async () => {
    build({ ...RULES, multipleFacesPolicy: 'RECORD' });
    const token = await started();
    expect(await report(token, 'MULTIPLE_FACES')).toMatchObject({ outcome: 'RECORDED', warningCount: 0 });
    build({ ...RULES, multipleFacesPolicy: 'OFF' });
    const other = invite(saved[1]!.id);
    await engine.start(other, { consent: true });
    expect(await report(other, 'MULTIPLE_FACES')).toMatchObject({ outcome: 'IGNORED' });
  });

  it("one candidate's incidents never touch another's; another company cannot decide", async () => {
    const mine = await started();
    const theirs = invite(otherSaved[0]!.id, OTHER_APP, OTHER_TENANT, OTHER_JOB);
    await engine.start(theirs, { consent: true });
    await report(theirs, 'TAB_SWITCH');
    expect((await engine.view(mine)).protection.warningCount).toBe(0);
    for (let i = 0; i < 3; i++) {
      await report(mine, 'TAB_SWITCH');
      later(30);
    }
    await settle();
    expect(await errorOf(engine.integrityDecision(OTHER_TENANT, APP, saved[0]!.id, { decision: 'REJECT', reason: 'Not my candidate' }, ACTOR))).toMatchObject({ status: 404 });
  });
});

describe('assessment protection settings (env)', () => {
  it('defaults: 2 warnings, tab + fullscreen + faces warn; camera off = faces not checked; off switch', () => {
    expect(assessmentProtectionFromEnv({})).toEqual(RULES);
    expect(assessmentProtectionFromEnv({ ASSESSMENT_MAX_WARNINGS: '3', ASSESSMENT_FACE_POLICY: 'record' })).toMatchObject({ maxWarnings: 3, multipleFacesPolicy: 'RECORD' });
    expect(assessmentProtectionFromEnv({ ASSESSMENT_MAX_WARNINGS: '99' })?.maxWarnings).toBe(2);
    expect(assessmentProtectionFromEnv({}, false)?.multipleFacesPolicy).toBe('OFF');
    expect(assessmentProtectionFromEnv({ ASSESSMENT_PROTECTION: 'off' })).toBeNull();
  });
});
