import { DSA_BANK } from '@hireflow/contracts';
import { describe, expect, it } from 'vitest';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { BankQuestionRepository } from '../src/modules/dsa/questions/bank-question.repository';

/** HR picks problems from the list in contracts; the API serves the real problems. They must describe the same set. */
describe('DSA bank: HR list and API problems stay in step', () => {
  it('every problem HR can pick exists in the API with the same id, title and difficulty', () => {
    expect(MOCK_QUESTIONS.map((q) => q.id)).toEqual(DSA_BANK.map((p) => p.id));
    for (const p of DSA_BANK) {
      const q = MOCK_QUESTIONS.find((x) => x.id === p.id)!;
      expect(q.title).toBe(p.title);
      expect(q.difficulty.toUpperCase()).toBe(p.difficulty);
      expect(q.marks).toBe(p.marks); // the suggested marks are the problem's own marks
      expect(q.testCases.some((t) => t.hidden)).toBe(true); // every problem has hidden tests
    }
  });

  it('serves an HR round under the round question ids, HR marks and order, never a problem that is not in the bank', async () => {
    const repo = new BankQuestionRepository();
    const questions = await repo.findForAssessment('x', {
      token: 't',
      assessmentId: 'x',
      candidateName: 'A',
      durationMinutes: 30,
      round: { questions: [{ id: 'q-hard', bankId: 'dsa-003', marks: 7 }, { id: 'q-easy', bankId: 'dsa-001', marks: 3 }] },
    });
    expect(questions.map((q) => [q.id, q.title, q.marks])).toEqual([['q-hard', 'Median of Two Sorted Arrays', 7], ['q-easy', 'Two Sum', 3]]);
    await expect(repo.findForAssessment('x', { token: 't', assessmentId: 'x', candidateName: 'A', durationMinutes: 30, round: { questions: [{ id: 'q', bankId: 'dsa-999', marks: 1 }] } })).rejects.toThrow(/not in the problem bank/);
    // without an HR round (demo tokens) the whole bank is served unchanged
    expect((await repo.findForAssessment('demo')).map((q) => q.id)).toEqual(DSA_BANK.map((p) => p.id));
  });
});
