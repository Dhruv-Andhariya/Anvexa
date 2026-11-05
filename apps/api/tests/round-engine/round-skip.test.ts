import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { pipelineStatusOf, stage2Verdict, type RoundInput, type SavedRound } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AssessmentsService } from '../../src/modules/assessments';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import type { CodingState } from '../../src/modules/round-engine/coding-round';
import { newAssessmentToken } from '../../src/modules/round-engine/link';
import { nextStep } from '../../src/modules/round-engine/online-test';
import { RoundEngineService } from '../../src/modules/round-engine/round-engine.service';
import { RoundEngineWorker } from '../../src/modules/round-engine/round-engine.worker';
import { MemoryAudit } from '../in-memory';
import { ACTOR, APP, FakeGenerator, JOB, MemoryAssessmentsStore, MemoryRoundsConfigStore, OTHER_TENANT, TENANT, student } from '../rounds/fakes';
import { FakeMailer, MemoryRoundEngineStore } from './fakes';

/**
 * HR skips one round of a job (only DSA, only SQL, the GD): a student who passes the round before it gets the next
 * round that runs; if nothing is skipped, the next round as HR ordered them.
 */
const T0 = new Date('2026-11-04T09:00:00Z');
const DAY = 24 * 60 * 60_000;

const bank = (n: 1 | 2 | 3, marks: number) => ({ kind: 'CODING' as const, text: `Problem ${n}`, marks, difficulty: 'EASY' as const, topics: [`dsa:dsa-00${n}`] });
const aptitude: RoundInput = { type: 'APTITUDE', name: 'Aptitude', timeLimitMinutes: 20, passRule: { mode: 'MARKS', value: 1 }, questions: [{ kind: 'MCQ', text: 'Q1', options: ['a', 'b'], correct: [1] }] };
const dsa: RoundInput = { type: 'CODING', name: 'DSA Coding Round', timeLimitMinutes: 60, passRule: { mode: 'MARKS', value: 10 }, questions: [bank(1, 10), bank(2, 20)] };
// run on the same coding page by the engine (every question a coding-page problem), like a SQL-bank round
const sql: RoundInput = { type: 'SQL', name: 'SQL Round', timeLimitMinutes: 30, passRule: { mode: 'MARKS', value: 10 }, questions: [bank(3, 20)] };
const gd: RoundInput = { type: 'GROUP_DISCUSSION', name: 'Group Discussion', passRule: { mode: 'INTERVIEWER_SCORE', value: 15, maxScore: 30 } };
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let now: Date;
let store: MemoryRoundEngineStore;
let results: MemoryAssessmentsStore;
let audit: MemoryAudit;
let rounds: RoundsConfigService;
let engine: RoundEngineService;
let saved: SavedRound[];

const clock = () => new Date(now);
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error('expected an error'); }, (e: unknown) => e);
const round = (name: string) => saved.find((r) => r.name === name)!;
const invitedTo = () => store.invites.filter((i) => !i.revokedAt).map((i) => saved.find((r) => r.id === i.roundId)!.name);

function invite(roundId: string) {
  const t = newAssessmentToken();
  store.invites.push({
    id: `0192f3a1-dddd-7000-8000-${String(store.invites.length + 1).padStart(12, '0')}`,
    tenantId: TENANT, applicationId: APP, jobId: JOB, roundId, tokenHash: t.tokenHash,
    expiresAt: new Date(now.getTime() + 7 * DAY), revokedAt: null, emailStatus: 'SENT', attempts: 1, sentAt: now, lastError: null,
  });
  return t.token;
}

/** Full marks on every problem of the round. */
function solved(r: SavedRound): CodingState {
  const out: CodingState = { progress: {}, finishReason: null };
  for (const q of r.questions) out.progress[q.id] = { attempts: 1, bestScore: q.marks, passed: 3, total: 3, language: 'python', lastVerdict: 'passed', bestCode: 'ok' };
  return out;
}

async function passAptitude() {
  const token = invite(round('Aptitude').id);
  await engine.start(token, { consent: true });
  await engine.submit(token, { revision: 1, answers: [{ questionId: round('Aptitude').questions[0]!.id, selected: [1], marked: false }] });
}

/** The link of the invitation the engine queued for this round, as the worker would email it. */
function linkTo(name: string) {
  const row = store.invites.find((i) => i.roundId === round(name).id && !i.revokedAt);
  if (!row) return invite(round(name).id);
  const t = newAssessmentToken();
  Object.assign(row, { tokenHash: t.tokenHash, expiresAt: new Date(now.getTime() + 7 * DAY), emailStatus: 'SENT', sentAt: now });
  return t.token;
}

async function passCoding(name: string) {
  const token = linkTo(name);
  await engine.startCodingAttempt(token, new Date(now));
  await engine.finishCodingAttempt(token, 'submitted', solved(round(name)));
}

async function setup(inputs: RoundInput[]) {
  saved = (await rounds.save(TENANT, JOB, { rounds: inputs, complete: true }, ACTOR)).rounds;
}

/** HR presses "Skip round" (and the engine moves the waiting students on). */
async function skip(name: string, reason = 'Not needed for this batch') {
  const res = await engine.skipRound(TENANT, JOB, round(name).id, { reason }, ACTOR);
  saved = res.rounds.rounds;
  return res;
}

function worker() {
  const mailer = new FakeMailer();
  const w = new RoundEngineWorker(store, engine, rounds, mailer, audit, {
    enabled: false, pollMs: 5000, autoInvite: true,
    baseUrl: 'https://careers.example.com/assessment/{token}', dsaBaseUrl: 'https://candidates.example.com/dsa/{token}',
    linkDays: 7, allowLocalLinks: false,
  }, { cameraRequired: true }, clock);
  return { w, mailer };
}

beforeEach(async () => {
  now = new Date(T0);
  const roundsStore = new MemoryRoundsConfigStore();
  roundsStore.addJob(TENANT, JOB);
  results = new MemoryAssessmentsStore();
  results.jobs.push({ id: JOB, tenantId: TENANT, title: 'AI Engineer' });
  results.students.push({ ...student(), tenantId: TENANT });
  store = new MemoryRoundEngineStore();
  store.contexts.set(APP, { tenantId: TENANT, applicationId: APP, jobId: JOB, candidateName: 'Asha Patel', email: 'asha@example.com', jobTitle: 'AI Engineer', companyName: 'Pattern Labs', companyWebsite: null });
  audit = new MemoryAudit();
  rounds = new RoundsConfigService(roundsStore, audit, new FakeGenerator().asClient());
  engine = new RoundEngineService(store, rounds, new AssessmentsService(results, rounds, audit), audit, { cameraRequired: true }, clock);
  await setup([aptitude, dsa, sql, interview]);
});

describe('nothing skipped: the next round in HR order', () => {
  it('Aptitude -> DSA link -> SQL link -> "HR will contact you" for the interview', async () => {
    await passAptitude();
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round']);
    await passCoding('DSA Coding Round');
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round', 'SQL Round']);
    await passCoding('SQL Round');
    expect(store.outcomeEmails.map((e) => [e.kind, e.nextRoundName])).toEqual([['CLEARED_NEXT_BY_HR', 'Personal Interview']]);
  });
});

describe('HR skips one round', () => {
  it('only DSA skipped: after Aptitude the SQL link is emailed (shortlisted, naming Aptitude), never a DSA link', async () => {
    await skip('DSA Coding Round');
    await passAptitude();
    expect(invitedTo()).toEqual(['Aptitude', 'SQL Round']);
    const { w, mailer } = worker();
    await w.sendInvites();
    const mail = mailer.sent.find((m) => m.message.subject.includes('SQL Round'))!;
    expect(mail.message.subject).toBe("Congratulations! You've Been Shortlisted for AI Engineer – Next Step: SQL Round");
    expect(mail.message.text).toContain('Based on your performance in the Aptitude');
    expect(mail.message.text).toMatch(/https:\/\/candidates\.example\.com\/dsa\/[A-Za-z0-9_-]{43}/);
    expect(mailer.sent.some((m) => m.message.subject.includes('DSA'))).toBe(false);
  });

  it('only SQL skipped: after DSA the student goes straight to the interview', async () => {
    await skip('SQL Round');
    await passAptitude();
    await passCoding('DSA Coding Round');
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round']);
    expect(store.outcomeEmails.map((e) => [e.kind, e.nextRoundName])).toEqual([['CLEARED_NEXT_BY_HR', 'Personal Interview']]);
  });

  it('DSA and SQL both skipped: Aptitude leads to the interview', async () => {
    await skip('DSA Coding Round');
    await skip('SQL Round');
    await passAptitude();
    expect(invitedTo()).toEqual(['Aptitude']);
    expect(store.outcomeEmails.map((e) => e.nextRoundName)).toEqual(['Personal Interview']);
  });

  it('the first round skipped: AI screening leads to the next round that runs', async () => {
    await skip('Aptitude');
    expect(await engine.inviteToFirstRound({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: round('Aptitude').id })).toBe(false);
    expect(await engine.inviteToFirstRound({ tenantId: TENANT, applicationId: APP, jobId: JOB, roundId: round('DSA Coding Round').id })).toBe(true);
    expect(invitedTo()).toEqual(['DSA Coding Round']);
  });

  it('a failed round still rejects: skipping never lets a failing student through', async () => {
    await skip('DSA Coding Round');
    const token = invite(round('Aptitude').id);
    await engine.start(token, { consent: true });
    await engine.submit(token, { revision: 1, answers: [{ questionId: round('Aptitude').questions[0]!.id, selected: [0], marked: false }] });
    expect(invitedTo()).toEqual(['Aptitude']);
    expect(store.outcomeEmails.map((e) => e.kind)).toEqual(['REJECTED']);
  });
});

describe('skipping a round that is already running (after the lock)', () => {
  it('students waiting with an unused link move on at once: the link is withdrawn, the next link is queued', async () => {
    await passAptitude(); // DSA invitation queued, not started; the rounds are locked
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round']);
    const res = await skip('DSA Coding Round');
    expect(res).toMatchObject({ movedOn: 1, inProgress: 0 });
    expect(store.invites.find((i) => i.roundId === round('DSA Coding Round').id)!.revokedAt).not.toBeNull();
    expect(invitedTo()).toEqual(['Aptitude', 'SQL Round']);
    expect(res.rounds.locked).toBe(true);
    expect(round('DSA Coding Round').skipped).toMatchObject({ reason: 'Not needed for this batch', byName: 'Priya HR' });
    expect(audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['rounds.round_skipped', 'assessment.progressed']));
  });

  it('a student in the middle of the round finishes it, then continues to the next round that runs', async () => {
    await passAptitude();
    const token = linkTo('DSA Coding Round');
    await engine.startCodingAttempt(token, new Date(now));
    const res = await skip('DSA Coding Round');
    expect(res).toMatchObject({ movedOn: 0, inProgress: 1 });
    await engine.finishCodingAttempt(token, 'submitted', solved(round('DSA Coding Round')));
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round', 'SQL Round']);
  });

  it('students in the GD pool (not yet in a group) leave it and get the next round', async () => {
    await setup([aptitude, gd, dsa]);
    store.gdPlaces.push({ tenantId: TENANT, applicationId: APP, roundId: round('Group Discussion').id, batchId: null });
    const res = await skip('Group Discussion');
    expect(res).toMatchObject({ movedOn: 1, inProgress: 0 });
    expect(store.gdPlaces).toHaveLength(0);
    expect(invitedTo()).toEqual(['DSA Coding Round']);
  });

  it('students already placed in a GD group keep their GD', async () => {
    await setup([aptitude, gd, dsa]);
    store.gdPlaces.push({ tenantId: TENANT, applicationId: APP, roundId: round('Group Discussion').id, batchId: 'batch-1' });
    expect(await skip('Group Discussion')).toMatchObject({ movedOn: 0, inProgress: 1 });
    expect(store.gdPlaces).toHaveLength(1);
  });
});

describe('HR controls', () => {
  it('Undo skip: the round runs again for students who have not passed it yet', async () => {
    await skip('DSA Coding Round');
    await engine.unskipRound(TENANT, JOB, round('DSA Coding Round').id, ACTOR);
    await passAptitude();
    expect(invitedTo()).toEqual(['Aptitude', 'DSA Coding Round']);
    expect(audit.entries.map((e) => e.action)).toContain('rounds.round_unskipped');
  });

  it('a reason is required; skipping twice or undoing a round that runs is refused; another company gets 404', async () => {
    expect(code(await caught(engine.skipRound(TENANT, JOB, round('SQL Round').id, { reason: '' }, ACTOR)))).toBe('INVALID_SKIP');
    await skip('SQL Round');
    expect(code(await caught(skip('SQL Round')))).toBe('ROUND_ALREADY_SKIPPED');
    expect(code(await caught(engine.unskipRound(TENANT, JOB, round('DSA Coding Round').id, ACTOR)))).toBe('ROUND_NOT_SKIPPED');
    expect(code(await caught(engine.skipRound(OTHER_TENANT, JOB, round('DSA Coding Round').id, { reason: 'nope' }, ACTOR)))).toBe('JOB_NOT_FOUND');
  });

  it('the skip stays when HR saves the rounds again, and the public selection process leaves the round out', async () => {
    await skip('DSA Coding Round');
    const again = await rounds.save(TENANT, JOB, { rounds: saved.map((r) => ({ ...r, passRule: r.passRule! })), complete: true }, ACTOR);
    expect(again.rounds.find((r) => r.name === 'DSA Coding Round')!.skipped).not.toBeNull();
    expect((await rounds.publicSteps(TENANT, JOB))!.steps).toEqual(['Aptitude', 'SQL Round', 'Personal Interview']);
  });
});

describe('rules that read the round list ignore skipped rounds', () => {
  it('nextStep passes over skipped rounds', async () => {
    await skip('DSA Coding Round');
    expect(nextStep(saved, round('Aptitude'), true)).toMatchObject({ kind: 'INVITE', round: { name: 'SQL Round' } });
  });

  it('pipeline: a skipped technical round is neither "in progress" nor needed for the Stage 2 verdict', async () => {
    await skip('SQL Round');
    const passed = new Set([round('Aptitude').id, round('DSA Coding Round').id]);
    const resultOf = (id: string) => (passed.has(id) ? { outcome: 'PASSED' as const, score: 10, maxScore: 10 } : undefined);
    const settings = { stage2Rule: 'ALL_ROUNDS_PASSED' as const, stage2MinPercent: null, rejectionEmails: true };
    expect(stage2Verdict(saved, resultOf, settings)).toMatchObject({ decided: true, passed: true });
    expect(pipelineStatusOf(saved, resultOf, settings)).toBe('IN_PERSONAL_INTERVIEW');
  });
});
