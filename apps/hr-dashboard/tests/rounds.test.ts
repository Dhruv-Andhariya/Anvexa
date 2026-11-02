import { describe, expect, it, vi } from 'vitest';
import { fromGenerated, fromSaved, fromTypedSteps, keepKeys, move, newQuestion, newRound, passMarkHint, toRequest, validate } from '../src/lib/rounds';
import { overrideRoundResult, saveRounds } from '../src/lib/rounds-api';

const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const aptitude = (questions = 10, pass = '8') => {
  const r = newRound('APTITUDE');
  r.passMode = 'CORRECT_COUNT';
  r.passValue = pass;
  r.questions = Array.from({ length: questions }, (_, i) => ({ ...newQuestion('MCQ'), text: `Q${i + 1}`, options: ['a', 'b'], correct: [0] }));
  return r;
};

describe('rounds editor state', () => {
  it('new rounds get the type name; interviews default to an interviewer score out of 10', () => {
    expect(newRound('SQL')).toMatchObject({ name: 'SQL', passMode: '' });
    expect(newRound('HR_INTERVIEW')).toMatchObject({ name: 'HR Interview', passMode: 'INTERVIEWER_SCORE', passMaxScore: '10' });
    expect(newRound('CUSTOM').name).toBe('');
  });

  it('turns the old typed selection process into a first draft of rounds', () => {
    const drafts = fromTypedSteps(['Online Apptitude Exam', 'SQL Round', 'Group Discussion', 'Personal Interview', 'Puzzle hour']);
    expect(drafts.map((d) => [d.type, d.name])).toEqual([
      ['APTITUDE', 'Online Apptitude Exam'],
      ['SQL', 'SQL Round'],
      ['GROUP_DISCUSSION', 'Group Discussion'],
      ['HR_INTERVIEW', 'Personal Interview'],
      ['CUSTOM', 'Puzzle hour'],
    ]);
  });

  it('builds the API request: empty numbers are null, options only on choice questions', () => {
    const r = aptitude(1);
    r.timeLimitMinutes = '';
    r.questions.push({ ...newQuestion('DESCRIPTIVE'), text: 'Explain', options: ['stray'], correct: [1] });
    const req = toRequest([r], true);
    expect(req.rounds[0]).toMatchObject({ timeLimitMinutes: null, passRule: { mode: 'CORRECT_COUNT', value: 8, maxScore: null } });
    expect(req.rounds[0]!.questions![1]).toMatchObject({ options: [], correct: [], marks: 5 });
  });

  it('validates with the API rules: pass mark above the questions is marked on the field', () => {
    const v = validate([aptitude(10, '11')], false);
    expect(v.ok).toBe(false);
    expect(v.fields['rounds.0.passRule.value']).toEqual(['The pass mark cannot be more than the 10 questions.']);
    expect(validate([aptitude(10, '8')], true).ok).toBe(true);
  });

  it('lists what is still missing before publishing', () => {
    const v = validate([newRound('CODING')], true);
    expect(v.general).toEqual(['Round 1 (Coding): choose the passing criterion.']);
    expect(validate([], true).general).toEqual(['Add at least one assessment round.']);
  });

  it('marks an MCQ without a correct option on that question', () => {
    const r = aptitude(2);
    r.questions[1]!.correct = [];
    expect(validate([r], false).fields['rounds.0.questions.1']).toContain('Mark the correct option.');
  });

  it('says how the pass mark is counted', () => {
    expect(passMarkHint(aptitude(10))).toBe('out of 10 questions');
    expect(passMarkHint({ ...aptitude(2), passMode: 'MARKS' })).toBe('out of 2 marks');
  });

  it('moves rounds and keeps editor keys after a save', () => {
    const [a, b] = [aptitude(), newRound('SQL')];
    expect(move([a, b], 1, 0).map((r) => r.name)).toEqual(['SQL', 'Aptitude']);
    expect(move([a, b], 1, 2)).toEqual([a, b]);
    const saved = fromSaved([
      { id: 'r1', position: 1, type: 'SQL', name: 'SQL', description: '', timeLimitMinutes: null, passRule: null, questions: [], totals: { questions: 0, marks: 0 } },
    ]);
    expect(keepKeys(saved, [b])[0]).toMatchObject({ key: b.key, id: 'r1' });
  });

  it('keeps AI suggestions marked as AI', () => {
    const q = fromGenerated({ kind: 'MCQ', text: 'Q', options: ['a', 'b'], correct: [1], modelAnswer: null, language: null, marks: 1, difficulty: 'EASY', topics: [], source: 'AI' });
    expect(q).toMatchObject({ source: 'AI', marks: '1', correct: [1] });
  });
});

describe('rounds api client', () => {
  it('saves the rounds with the session cookie and CSRF header (never a tenant id)', async () => {
    const view = { jobId: JOB, jobTitle: 'AI', status: 'DRAFT', locked: false, lockedAt: null, updatedAt: null, fixedSteps: [], rounds: [], problems: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, view));
    await saveRounds(JOB, { rounds: [], complete: false }, { fetch, baseUrl: 'http://api.test' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://api.test/rounds/jobs/${JOB}`);
    expect(init!.method).toBe('PUT');
    expect(init!.credentials).toBe('include');
    expect((init!.headers as Record<string, string>)['x-requested-with']).toBe('hireflow');
    expect((init!.headers as Record<string, string>)['x-tenant-id']).toBeUndefined();
  });

  it('shows the lock message when students already started', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(409, { code: 'ROUNDS_LOCKED', message: 'Students have started the assessment rounds of this job.' }));
    const err = await saveRounds(JOB, { rounds: [] }, { fetch }).catch((e) => e);
    expect([err.code, err.message]).toEqual(['ROUNDS_LOCKED', 'Students have started the assessment rounds of this job.']);
  });

  it('sends an override to the student and round', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(500, {}));
    await overrideRoundResult('app-1', 'round-1', { passed: true, reason: 'Network issue' }, { fetch, baseUrl: 'http://api.test' }).catch(() => undefined);
    expect(String(fetch.mock.calls[0]![0])).toBe('http://api.test/assessments/applications/app-1/rounds/round-1/override');
  });
});
