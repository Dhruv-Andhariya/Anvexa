import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput, SavedRound, SqlBankQuestion } from '@hireflow/contracts';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import type { CodeRunner } from '../../src/modules/dsa/execution/code-runner';
import { parseProctorEvents } from '../../src/modules/dsa/proctoring/proctoring.dto';
import { policyFromEnv, type ProctorPolicy } from '../../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService, inviteRefFor } from '../../src/modules/dsa/proctoring/proctoring.service';
import { InMemoryProctorStore } from '../../src/modules/dsa/proctoring/proctoring.store';
import { CAMERA_CONSENT_VERSION, CONSENT_VERSION } from '../../src/modules/dsa/proctoring/proctoring.types';
import { BankQuestionRepository } from '../../src/modules/dsa/questions/bank-question.repository';
import { MockQuestionRepository } from '../../src/modules/dsa/questions/mock-question.repository';
import { EngineSessionStore } from '../../src/modules/dsa/session/engine-session.store';
import { DemoInvitationResolver } from '../../src/modules/dsa/session/invitation.resolver';
import { RoundInvitationResolver } from '../../src/modules/dsa/session/round-invitation.resolver';
import { InMemorySessionStore } from '../../src/modules/dsa/session/session.store';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { cameraModeFromEnv, cameraMonitored } from '../../src/modules/round-engine/coding-round';
import { buildRoundInviteEmail } from '../../src/modules/round-engine/emails';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { SqlBankService } from '../../src/modules/sql/bank/sql-bank.service';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, TENANT, student } from '../rounds/fakes';
import { MemoryRoundEngineStore } from '../round-engine/fakes';
import { MemorySqlBankStore, testSandbox } from './fakes';

const T0 = Date.parse('2026-11-04T09:00:00Z');
const noPrograms = { runBatch: async () => [] } as unknown as CodeRunner;
const sandbox = testSandbox();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;

let bankQuestion: SqlBankQuestion;
beforeAll(async () => {
  const bank = new SqlBankService(new MemorySqlBankStore(), sandbox, new MemoryAudit());
  await bank.importStarter(TENANT, ACTOR);
  bankQuestion = await bank.get(TENANT, (await bank.list(TENANT)).find((q) => q.title === 'Employees per department')!.id);
}, 120_000);

let now: number;
let saved: SavedRound[];
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let proctoring: ProctoringService;
let service: DsaService;
let token: string;

/** A SQL round (camera-monitored by default) taken through the round engine, with the given proctoring policy. */
async function setup(policy: Partial<ProctorPolicy> = {}) {
  now = T0;
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'Data Analyst' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Candidate', email: 'c@example.com', jobTitle: 'Data Analyst', companyName: 'Pattern Labs', companyWebsite: null });
  const audit = new MemoryAudit();
  const rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  const engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, () => new Date(now));
  const sqlRound: RoundInput = {
    type: 'SQL',
    name: 'SQL Assessment',
    timeLimitMinutes: 30,
    passRule: { mode: 'MARKS', value: 1 },
    questions: [{ kind: 'CODING', text: bankQuestion.description, marks: 5, difficulty: 'EASY', sql: bankQuestion.problem }],
  };
  saved = (await rounds.save(TENANT, JOB, { rounds: [sqlRound], complete: true }, ACTOR)).rounds;
  const t = newAssessmentToken();
  store.invites.push({ id: '0192f3a1-dddd-7000-8000-000000000001', tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: saved[0]!.id, tokenHash: t.tokenHash, expiresAt: new Date(T0 + 86_400_000), revokedAt: null, emailStatus: 'SENT', attempts: 1, sentAt: new Date(T0), lastError: null });
  token = t.token;
  // two allowed warnings: the third violation ends the attempt (the rule this suite walks through)
  proctoring = new ProctoringService(new InMemoryProctorStore(), { ...policyFromEnv({}), enabled: true, maxStrikes: 2, ...policy }, () => now);
  service = new DsaService(new RoundInvitationResolver(engine), new BankQuestionRepository(), new EngineSessionStore(engine), noPrograms, () => now, proctoring, sandbox);
}

const consent = (camera?: boolean) => ({ consent: true, consentVersion: CAMERA_CONSENT_VERSION, fullscreen: true, ...(camera === undefined ? {} : { camera }) });
const begin = async () => {
  await service.proctorStart(token, consent(true));
  return service.start(token);
};
/** A grouped camera alert as the page sends it. */
const alert = (type: string, sec: number, extra: Record<string, unknown> = {}) => ({ type, at: T0 + sec * 1000, durationMs: 8000, confidence: 0.82, detail: 'left: 4 looks in 60 s', ...extra });
const send = async (sec: number, ...events: Record<string, unknown>[]) => {
  now = T0 + sec * 1000;
  return service.proctorEvents(token, { events });
};

describe('which attempts are camera-monitored', () => {
  it('SQL and DSA rounds by default; DSA_PROCTOR_CAMERA=sql keeps DSA rounds camera-free; off switches it off', () => {
    expect(cameraModeFromEnv({})).toBe('all');
    expect([cameraModeFromEnv({ DSA_PROCTOR_CAMERA: 'sql' }), cameraModeFromEnv({ DSA_PROCTOR_CAMERA: 'off' }), cameraModeFromEnv({ DSA_PROCTOR_CAMERA: 'on' })]).toEqual(['sql', 'off', 'all']);
    expect([cameraMonitored('sql', 'sql'), cameraMonitored('code', 'sql'), cameraMonitored('mixed', 'sql')]).toEqual([true, false, false]);
    expect([cameraMonitored('code', 'all'), cameraMonitored('mixed', 'all'), cameraMonitored('sql', 'off')]).toEqual([true, true, false]);
  });

  it('a DSA round is camera-monitored by default too', async () => {
    now = T0;
    const dsaProctoring = new ProctoringService(new InMemoryProctorStore(), { ...policyFromEnv({}), enabled: true }, () => now);
    const dsa = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), noPrograms, () => now, dsaProctoring);
    expect((await dsa.getState('demo-dsa-token')).proctoring).toMatchObject({ camera: true, requireCamera: true, consentVersion: CAMERA_CONSENT_VERSION });
  });

  it('a SQL round asks for the camera (its own notice); with DSA_PROCTOR_CAMERA=sql a DSA round has no camera', async () => {
    await setup();
    const sql = await service.getState(token);
    expect(sql.proctoring).toMatchObject({ camera: true, consentVersion: CAMERA_CONSENT_VERSION });
    expect(sql.proctoring.monitored.join(' ')).toMatch(/webcam must stay on/);
    expect(sql.proctoring.monitored.join(' ')).toMatch(/No video, image or face data leaves your computer/);

    const dsaProctoring = new ProctoringService(new InMemoryProctorStore(), { ...policyFromEnv({}), enabled: true, cameraMode: 'sql' }, () => now);
    const dsa = new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), noPrograms, () => now, dsaProctoring);
    const state = await dsa.getState('demo-dsa-token');
    expect(state.proctoring).toMatchObject({ camera: false, consentVersion: CONSENT_VERSION });
    expect(state.proctoring.monitored.join(' ')).not.toMatch(/webcam/);
  });

  it('the SQL round cannot start without the camera, or with consent to the notice without the camera', async () => {
    await setup();
    expect(code(await service.proctorStart(token, consent()).catch((e: unknown) => e))).toBe('CAMERA_REQUIRED');
    expect(code(await service.proctorStart(token, consent(false)).catch((e: unknown) => e))).toBe('CAMERA_REQUIRED');
    expect(code(await service.proctorStart(token, { ...consent(true), consentVersion: CONSENT_VERSION }).catch((e: unknown) => e))).toBe('CONSENT_OUTDATED');
    await service.proctorStart(token, consent(true));
    expect((await service.start(token)).status).toBe('in_progress');
  });

  it('with DSA_PROCTOR_CAMERA=off a SQL round is taken without the camera', async () => {
    await setup({ cameraMode: 'off' });
    expect((await service.getState(token)).proctoring).toMatchObject({ camera: false, consentVersion: CONSENT_VERSION });
  });
});

describe('a DSA round with the camera (default DSA_PROCTOR_CAMERA=all)', () => {
  const dsaSetup = () => {
    now = T0;
    const p = new ProctoringService(new InMemoryProctorStore(), { ...policyFromEnv({}), enabled: true, maxStrikes: 2 }, () => now);
    return new DsaService(new DemoInvitationResolver(), new MockQuestionRepository(), new InMemorySessionStore(), noPrograms, () => now, p);
  };
  const T = 'demo-dsa-token';

  it('cannot start without the camera, and starts with it', async () => {
    const dsa = dsaSetup();
    expect(code(await dsa.proctorStart(T, consent()).catch((e: unknown) => e))).toBe('CAMERA_REQUIRED');
    expect(code(await dsa.proctorStart(T, { ...consent(true), consentVersion: CONSENT_VERSION }).catch((e: unknown) => e))).toBe('CONSENT_OUTDATED');
    await dsa.proctorStart(T, consent(true));
    expect((await dsa.start(T)).status).toBe('in_progress');
  });

  it('camera alerts are warnings on a DSA round too, and the third violation ends it', async () => {
    const dsa = dsaSetup();
    await dsa.proctorStart(T, consent(true));
    await dsa.start(T);
    now = T0 + 60_000;
    expect(await dsa.proctorEvents(T, { events: [alert('CAMERA_GAZE_AWAY', 50)] })).toMatchObject({ accepted: 1, strikesUsed: 1, ended: false, level: 'warning' });
    now = T0 + 120_000;
    expect(await dsa.proctorEvents(T, { events: [alert('CAMERA_FACE_MISSING', 110)] })).toMatchObject({ strikesUsed: 2, ended: false, level: 'final_warning' });
    now = T0 + 180_000;
    expect(await dsa.proctorEvents(T, { events: [alert('CAMERA_MULTIPLE_FACES', 175)] })).toMatchObject({ ended: true });
    expect((await dsa.getState(T)).status).toBe('finished');
  });

  it('the older webcam events (camera off, no face, two faces) still count on a DSA round', async () => {
    const dsa = dsaSetup();
    await dsa.proctorStart(T, consent(true));
    await dsa.start(T);
    now = T0 + 60_000;
    expect(await dsa.proctorEvents(T, { events: [{ type: 'NO_FACE', at: T0 + 50_000 }] })).toMatchObject({ accepted: 1, strikesUsed: 1 });
  });
});

describe('camera alerts in the existing warning system', () => {
  beforeEach(() => setup());

  it('warning 1 (looking away), warning 2 (full screen), and the third violation (two faces) ends the attempt', async () => {
    await begin();
    expect(await send(60, alert('CAMERA_GAZE_AWAY', 50))).toMatchObject({ strikesUsed: 1, strikesAllowed: 2, ended: false, level: 'warning' });
    expect(await send(120, { type: 'FULLSCREEN_EXIT', at: T0 + 115_000 })).toMatchObject({ strikesUsed: 2, ended: false, level: 'final_warning' });
    expect(await send(180, alert('CAMERA_MULTIPLE_FACES', 175, { detail: '2 faces in view' }))).toMatchObject({ ended: true });
    expect((await service.getState(token)).status).toBe('finished');
    // graded with what was submitted (nothing here), like every other way an attempt ends
    expect(results.results[0]).toMatchObject({ roundId: saved[0]!.id, systemPassed: false });
  }, 30_000);

  it('the same behaviour reported again within the cool-down is one alert, not two warnings', async () => {
    await begin();
    await send(60, alert('CAMERA_GAZE_AWAY', 50));
    expect(await send(65, alert('CAMERA_GAZE_AWAY', 55))).toMatchObject({ accepted: 0, ignored: 1, strikesUsed: 1 });
  }, 30_000);

  it('stores time, duration, confidence and the warning number; any camera alert asks HR to review', async () => {
    await begin();
    await send(60, alert('CAMERA_FACE_MISSING', 40, { detail: 'no face in view', confidence: 0.9 }));
    await send(200, { type: 'TAB_SWITCH', at: T0 + 190_000 });
    const session = (await (proctoring as unknown as { store: InMemoryProctorStore }).store.get(inviteRefFor(token)))!;
    const { summary, events } = proctoring.reviewOf(session, 50);
    expect(summary).toMatchObject({ status: 'review', flagged: true, camera: { monitored: true, faceMissing: 1, gazeAway: 0 } });
    expect(summary.reasons.join(' ')).toMatch(/1 AI camera alert \(suspicious patterns, not proof\)/);
    expect(events[0]).toMatchObject({ type: 'CAMERA_FACE_MISSING', camera: true, confidence: 0.9, durationMs: 8000, detail: 'no face in view', strike: 1, at: new Date(T0 + 40_000).toISOString() });
    expect(events[1]).toMatchObject({ type: 'TAB_SWITCH', camera: false, confidence: null, strike: 2 });
  }, 30_000);
});

describe('options and safeguards', () => {
  it('DSA_PROCTOR_CAMERA_STRIKES=off: camera alerts are kept for review only, never a warning', async () => {
    await setup({ cameraStrikes: false });
    await begin();
    for (const [i, type] of ['CAMERA_GAZE_AWAY', 'CAMERA_FACE_MISSING', 'CAMERA_MULTIPLE_FACES'].entries()) {
      expect(await send(60 + i * 30, alert(type, 50 + i * 30))).toMatchObject({ strikesUsed: 0, ended: false });
    }
    const summary = await proctoring.summary(inviteRefFor(token));
    expect(summary).toMatchObject({ status: 'review', camera: { gazeAway: 1, faceMissing: 1, multipleFaces: 1 }, totalViolations: 0 });
  }, 30_000);

  it('an attempt taken without the camera ignores camera alerts (a page cannot invent them)', async () => {
    await setup({ cameraMode: 'off' });
    await service.proctorStart(token, { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true });
    await service.start(token);
    expect(await send(60, alert('CAMERA_GAZE_AWAY', 50))).toMatchObject({ accepted: 0, strikesUsed: 0 });
  }, 30_000);

  it('duration and confidence are accepted for camera alerts only, and within bounds', () => {
    const refused = (events: unknown[]) => code((() => {
      try {
        parseProctorEvents({ events });
      } catch (e) {
        return e;
      }
    })());
    expect(refused([{ type: 'TAB_SWITCH', durationMs: 5 }])).toBe('UNEXPECTED_FIELD');
    expect(refused([{ type: 'CAMERA_GAZE_AWAY', confidence: 1.5 }])).toBe('INVALID_REQUEST');
    expect(refused([{ type: 'CAMERA_GAZE_AWAY', durationMs: -1 }])).toBe('INVALID_REQUEST');
    expect(parseProctorEvents({ events: [{ type: 'CAMERA_GAZE_AWAY', durationMs: 99_999_999, confidence: 0.876 }] })[0]).toMatchObject({ durationMs: 30 * 60_000, confidence: 0.88 });
  });
});

describe('the invitation email says what the camera does', () => {
  const mail = (codingKind: 'sql' | 'code', codingCamera: boolean) =>
    buildRoundInviteEmail({
      candidateName: 'Candidate', jobTitle: 'Data Analyst', companyName: 'Pattern Labs', companyWebsite: null, roundName: 'SQL Assessment', clearedStep: 'Aptitude',
      timeLimitMinutes: 30, questionCount: 2, instructions: '', link: 'https://x.example/dsa/t', linkExpiresAt: new Date(T0), cameraRequired: false, coding: true, codingKind, codingCamera,
    }).text;

  it('a camera-monitored round asks for a webcam and says nothing is recorded; a round without the camera says no camera', () => {
    expect(mail('sql', true)).toMatch(/You will need a working webcam/);
    expect(mail('sql', true)).toMatch(/No video or image is recorded or sent/);
    expect(mail('sql', true)).not.toMatch(/No camera/);
    expect(mail('code', false)).toMatch(/No camera, microphone or screen recording is used/);
  });
});
