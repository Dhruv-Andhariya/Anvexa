import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { RoundInput } from '@hireflow/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoundsConfigService } from '../../src/modules/rounds-config';
import { MemoryAudit } from '../in-memory';
import { ACTOR, FakeGenerator, JOB, MemoryRoundsConfigStore, OTHER_JOB, OTHER_TENANT, TENANT } from './fakes';

const mcq = (text = '2 + 2 = ?') => ({ kind: 'MCQ' as const, text, options: ['3', '4'], correct: [1] });
const aptitude = (n = 10, pass = 8): RoundInput => ({
  type: 'APTITUDE',
  name: 'Online Aptitude Exam',
  timeLimitMinutes: 30,
  passRule: { mode: 'CORRECT_COUNT', value: pass },
  questions: Array.from({ length: n }, (_, i) => mcq(`Question ${i + 1}`)),
});
const interview: RoundInput = { type: 'HR_INTERVIEW', name: 'Personal Interview', passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } };

let store: MemoryRoundsConfigStore;
let audit: MemoryAudit;
let generator: FakeGenerator;
const service = () => new RoundsConfigService(store, audit, generator.asClient());
const status = (err: unknown) => (err as HttpException).getStatus();
const code = (err: unknown) => ((err as HttpException).getResponse() as { code: string }).code;

beforeEach(() => {
  store = new MemoryRoundsConfigStore();
  audit = new MemoryAudit();
  generator = new FakeGenerator();
  store.addJob(TENANT, JOB);
  store.addJob(OTHER_TENANT, OTHER_JOB, 'Other company job');
});

describe('saving rounds', () => {
  it('starts empty with the fixed screening steps first', async () => {
    const view = await service().get(TENANT, JOB);
    expect(view).toMatchObject({ status: 'NOT_STARTED', locked: false, rounds: [], fixedSteps: ['Resume screening', 'AI voice screening'] });
    expect(view.problems).toEqual(['Add at least one assessment round.']);
  });

  it('saves a draft with missing parts and lists what is still missing', async () => {
    const view = await service().save(TENANT, JOB, { rounds: [{ type: 'CODING', name: 'Coding' }] }, ACTOR);
    expect(view.status).toBe('DRAFT');
    expect(view.problems).toEqual(['Round 1 (Coding): choose the passing criterion.']);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'rounds.draft_saved', subjectId: JOB });
  });

  it('saves complete rounds in order with totals, and keeps ids between saves', async () => {
    const first = await service().save(TENANT, JOB, { rounds: [aptitude(), interview], complete: true }, ACTOR);
    expect(first.status).toBe('COMPLETE');
    expect(first.problems).toEqual([]);
    expect(first.rounds.map((r) => [r.position, r.name])).toEqual([
      [1, 'Online Aptitude Exam'],
      [2, 'Personal Interview'],
    ]);
    expect(first.rounds[0]!.totals).toEqual({ questions: 10, marks: 10 });

    // HR moves the interview first and renames it: same round ids, new order
    const [apt, int] = first.rounds;
    const again = await service().save(
      TENANT,
      JOB,
      { rounds: [{ ...interview, id: int!.id, name: 'HR Interview' }, { ...aptitude(), id: apt!.id, questions: apt!.questions }], complete: true },
      ACTOR,
    );
    expect(again.rounds.map((r) => r.id)).toEqual([int!.id, apt!.id]);
    expect(again.rounds[1]!.questions.map((q) => q.id)).toEqual(apt!.questions.map((q) => q.id));
  });

  it('gives a new id to an id that is not part of this job (never reuses another job’s ids)', async () => {
    const other = await service().save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude()] }, ACTOR);
    const mine = await service().save(TENANT, JOB, { rounds: [{ ...aptitude(), id: other.rounds[0]!.id }] }, ACTOR);
    expect(mine.rounds[0]!.id).not.toBe(other.rounds[0]!.id);
  });

  it('refuses a pass mark above the number of questions, even in a draft', async () => {
    const err = await service().save(TENANT, JOB, { rounds: [aptitude(10, 11)] }, ACTOR).catch((e) => e);
    expect(status(err)).toBe(400);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain('cannot be more than the 10 questions');
  });

  it('refuses "complete" while something is missing', async () => {
    const err = await service().save(TENANT, JOB, { rounds: [{ type: 'SQL', name: 'SQL Round', passRule: { mode: 'PERCENTAGE', value: 60 } }], complete: true }, ACTOR).catch((e) => e);
    expect(status(err)).toBe(400);
    expect(JSON.stringify((err as HttpException).getResponse())).toContain('add at least one question');
  });

  it('stores true / false questions with fixed options', async () => {
    const view = await service().save(
      TENANT,
      JOB,
      { rounds: [{ type: 'TECHNICAL_MCQ', name: 'MCQ', questions: [{ kind: 'TRUE_FALSE', text: 'SQL is declarative', options: ['x'], correct: [0] }] }] },
      ACTOR,
    );
    expect(view.rounds[0]!.questions[0]).toMatchObject({ options: ['True', 'False'], correct: [0] });
  });
});

describe('company isolation', () => {
  it('another company’s job is a 404 for read, save and generate', async () => {
    await service().save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude()] }, ACTOR);
    for (const call of [
      () => service().get(TENANT, OTHER_JOB),
      () => service().save(TENANT, OTHER_JOB, { rounds: [] }, ACTOR),
      () => service().generate(TENANT, OTHER_JOB, { roundType: 'APTITUDE', roundName: 'Aptitude', count: 2, difficulty: 'EASY' }, ACTOR),
    ]) {
      const err = await call().catch((e) => e);
      expect(status(err)).toBe(404);
    }
    expect(store.configs.get(OTHER_JOB)!.rounds).toHaveLength(1);
    expect(generator.calls).toHaveLength(0);
  });

  it('the round engine sees only the job’s own company rounds', async () => {
    await service().save(OTHER_TENANT, OTHER_JOB, { rounds: [aptitude()] }, ACTOR);
    expect(await service().forRoundEngine(TENANT, OTHER_JOB)).toBeNull();
  });
});

describe('locking once students start', () => {
  it('cannot lock rounds that are not complete', async () => {
    await service().save(TENANT, JOB, { rounds: [{ type: 'CODING', name: 'Coding' }] }, ACTOR);
    expect(code(await service().lockForAttempts(TENANT, JOB).catch((e) => e))).toBe('ROUNDS_NOT_COMPLETE');
  });

  it('locks once, then refuses every change and every AI generation', async () => {
    await service().save(TENANT, JOB, { rounds: [aptitude()], complete: true }, ACTOR);
    const at = await service().lockForAttempts(TENANT, JOB, new Date('2026-11-01T09:00:00Z'));
    expect(await service().lockForAttempts(TENANT, JOB, new Date('2026-11-02T09:00:00Z'))).toEqual(at);
    expect((await service().get(TENANT, JOB)).locked).toBe(true);

    const save = await service().save(TENANT, JOB, { rounds: [aptitude(10, 5)], complete: true }, ACTOR).catch((e) => e);
    expect([status(save), code(save)]).toEqual([409, 'ROUNDS_LOCKED']);
    const gen = await service().generate(TENANT, JOB, { roundType: 'APTITUDE', roundName: 'Aptitude', count: 2, difficulty: 'EASY' }, ACTOR).catch((e) => e);
    expect(code(gen)).toBe('ROUNDS_LOCKED');
    expect(audit.entries.filter((e) => e.action === 'rounds.locked')).toHaveLength(1);
  });
});

describe('AI question suggestions', () => {
  const ask = { roundType: 'APTITUDE', roundName: 'Online Aptitude Exam', count: 2, difficulty: 'MEDIUM', topics: ['Percentages'] };

  it('sends the job facts and returns only valid, new questions of the asked kinds (nothing saved)', async () => {
    generator.questions = [
      { kind: 'MCQ', text: '10% of 50?', options: ['5', '10'], correct: [0], modelAnswer: null, language: null, marks: 1, difficulty: null, topics: ['Percentages'] },
      { kind: 'MCQ', text: 'Broken', options: ['only one'], correct: [0], modelAnswer: null, language: null, marks: 1, difficulty: null, topics: [] },
      { kind: 'CODING', text: 'Write a loop', options: [], correct: [], modelAnswer: null, language: 'Python', marks: 5, difficulty: null, topics: [] },
      { kind: 'MCQ', text: 'Question 1', options: ['a', 'b'], correct: [0], modelAnswer: null, language: null, marks: 1, difficulty: null, topics: [] },
      { kind: 'TRUE_FALSE', text: '25% of 8 is 2', options: [], correct: [0], modelAnswer: null, language: null, marks: 1, difficulty: 'EASY', topics: [] },
    ];
    generator.invalid = 1;
    const res = await service().generate(TENANT, JOB, { ...ask, avoid: ['question 1'] }, ACTOR);

    expect(res.questions.map((q) => q.text)).toEqual(['10% of 50?', '25% of 8 is 2']);
    expect(res.questions[0]).toMatchObject({ source: 'AI', difficulty: 'MEDIUM' });
    expect(res.questions[1]!.options).toEqual(['True', 'False']);
    expect(res.dropped).toBe(4);
    expect(generator.calls[0]).toMatchObject({ job: { title: 'AI Engineer', mustHaveSkills: ['Python', 'SQL'] }, kinds: ['MCQ', 'TRUE_FALSE'], count: 2 });
    expect(store.configs.has(JOB)).toBe(false);
  });

  it('rejects more than 20 questions at once', async () => {
    expect(status(await service().generate(TENANT, JOB, { ...ask, count: 21 }, ACTOR).catch((e) => e))).toBe(400);
  });
});

describe('public selection process', () => {
  it('is the round names in order, and says whether the rounds are complete', async () => {
    expect(await service().publicSteps(TENANT, JOB)).toEqual({ complete: false, steps: [] });
    await service().save(TENANT, JOB, { rounds: [aptitude(), interview], complete: true }, ACTOR);
    expect(await service().publicSteps(TENANT, JOB)).toEqual({ complete: true, steps: ['Online Aptitude Exam', 'Personal Interview'] });
  });

  it('is null when the rounds migration is not applied (publishing keeps working as before)', async () => {
    store.getConfig = async () => {
      throw Object.assign(new Error('missing'), { code: 'P2021' });
    };
    expect(await service().publicSteps(TENANT, JOB)).toBeNull();
    expect(code(await service().get(TENANT, JOB).catch((e) => e))).toBe('ROUNDS_NOT_READY');
  });
});
