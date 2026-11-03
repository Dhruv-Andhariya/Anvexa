import { describe, expect, it } from 'vitest';
import type { CodeRunner } from '../../src/modules/dsa/judge0/judge0.client';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import { MockQuestionRepository } from '../../src/modules/dsa/questions/mock-question.repository';
import { LANGUAGES } from '../../src/modules/dsa/questions/question.types';
import { DemoInvitationResolver } from '../../src/modules/dsa/session/invitation.resolver';
import { InMemorySessionStore } from '../../src/modules/dsa/session/session.store';
import { BROKEN, CORRECT, WRONG } from '../dsa-fixtures';

const QUESTION_IDS = ['dsa-001', 'dsa-002', 'dsa-003'];
const T = 240_000;
const TOKEN = 'demo-dsa-token';

/**
 * End to end behaviour of the DSA module (harness -> runner -> evaluator -> scoring)
 * against any CodeRunner. `skipReason` set => the whole suite is skipped (and says why).
 */
export function defineExecutionSuite(label: string, makeRunner: () => CodeRunner, skipReason: string | null) {
  if (skipReason) console.warn(`[${label}] SKIPPED: ${skipReason}`);

  async function started() {
    const service = new DsaService(
      new DemoInvitationResolver(),
      new MockQuestionRepository(),
      new InMemorySessionStore(),
      makeRunner(),
    );
    await service.start(TOKEN);
    return service;
  }

  describe.skipIf(!!skipReason)(label, () => {
    for (const questionId of QUESTION_IDS) {
      for (const language of LANGUAGES) {
        it(`${questionId} ${language}: correct solution passes every sample + hidden test`, async () => {
          const service = await started();
          const res = await service.submit(TOKEN, { questionId, language, code: CORRECT[questionId][language] });
          const failing = res.cases.filter((c) => c.status !== 'passed');
          expect(failing, JSON.stringify(failing)).toEqual([]);
          expect(res.verdict).toBe('passed');
          expect(res.passed).toBe(res.total);
          expect(res.score).toBe(res.maxScore);
          expect(res.cases.some((c) => c.hidden)).toBe(true);
        }, T);

        it(`${questionId} ${language}: wrong solution is judged failed with a partial score`, async () => {
          const service = await started();
          const res = await service.submit(TOKEN, { questionId, language, code: WRONG[questionId][language] });
          expect(res.verdict).toBe('failed');
          expect(res.passed).toBeLessThan(res.total);
          expect(res.score).toBeLessThan(res.maxScore);
          expect(res.cases.some((c) => c.status === 'wrong_answer')).toBe(true);
        }, T);

        it(`${questionId} ${language}: Run executes the public samples only`, async () => {
          const service = await started();
          const res = await service.run(TOKEN, { questionId, language, code: CORRECT[questionId][language] });
          expect(res.verdict).toBe('passed');
          expect(res.cases.length).toBeGreaterThan(0);
          expect(res.cases.every((c) => !c.hidden)).toBe(true);
          expect(res.cases.every((c) => c.input && c.expected && c.actual !== undefined)).toBe(true);
        }, T);
      }
    }

    for (const language of LANGUAGES) {
      it(`${language}: compilation / syntax error is reported, never passed`, async () => {
        const service = await started();
        const res = await service.run(TOKEN, { questionId: 'dsa-001', language, code: BROKEN.compile[language] });
        expect(res.verdict).toBe('compile_error');
        expect(res.compileOutput.length).toBeGreaterThan(0);
        expect(res.passed).toBe(0);
      }, T);

      it(`${language}: runtime error is reported per test`, async () => {
        const service = await started();
        const res = await service.run(TOKEN, { questionId: 'dsa-001', language, code: BROKEN.runtime[language] });
        expect(res.verdict).toBe('failed');
        expect(res.cases.every((c) => c.status === 'runtime_error')).toBe(true);
        expect(res.cases[0].stderr?.length).toBeGreaterThan(0);
      }, T);

      it(`${language}: infinite loop hits the time limit`, async () => {
        const service = await started();
        const res = await service.run(TOKEN, { questionId: 'dsa-001', language, code: BROKEN.infinite[language] });
        expect(res.verdict).toBe('failed');
        expect(res.cases.every((c) => c.status === 'time_limit')).toBe(true);
      }, T);
    }

    it('candidate debug prints do not corrupt the result', async () => {
      const service = await started();
      const code = 'def two_sum(nums, target):\n    print("debugging", nums)\n    return [0, 1]\n';
      const res = await service.run(TOKEN, { questionId: 'dsa-001', language: 'python', code });
      expect(res.cases[0].status).toBe('passed');
      expect(res.cases[0].stdout).toContain('debugging');
    }, T);

    it('final score aggregates best submissions across the three questions', async () => {
      const service = await started();
      for (const questionId of QUESTION_IDS) {
        await service.submit(TOKEN, { questionId, language: 'python', code: CORRECT[questionId].python });
      }
      const state = await service.finish(TOKEN);
      expect(state.status).toBe('finished');
      expect(state.result?.totalScore).toBe(60);
      expect(state.result?.percentage).toBe(100);
      expect(state.result?.questions.every((q) => q.solved)).toBe(true);
    }, T);
  });
}
