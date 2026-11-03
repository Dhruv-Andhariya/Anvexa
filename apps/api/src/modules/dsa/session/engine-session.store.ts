import { Inject, Injectable } from '@nestjs/common';
import { RoundEngineService, emptyCodingState, type CodingQuestionState, type CodingState } from '../../round-engine';
import { LANGUAGES, type Language } from '../questions/question.types';
import { assessmentIdFor, firstNameOf } from './round-invitation.resolver';
import type { DsaSession, QuestionProgress, SessionStore } from './session.store';

const asLanguage = (v: string | null): Language | null => ((LANGUAGES as readonly string[]).includes(v ?? '') ? (v as Language) : null);

const toProgress = (questionId: string, p: CodingQuestionState): QuestionProgress => ({
  questionId,
  attempts: p.attempts,
  bestScore: p.bestScore,
  passed: p.passed,
  total: p.total,
  language: asLanguage(p.language),
  lastVerdict: p.lastVerdict,
  bestCode: p.bestCode,
});

function toState(session: DsaSession): CodingState {
  const state = emptyCodingState();
  for (const [id, p] of Object.entries(session.progress)) {
    state.progress[id] = {
      attempts: p.attempts,
      bestScore: p.bestScore,
      passed: p.passed,
      total: p.total,
      language: p.language,
      lastVerdict: p.lastVerdict,
      bestCode: p.bestCode ?? null,
    };
  }
  return state;
}

/**
 * Keeps a candidate's coding assessment on the round engine's attempt (table round_attempts), so it survives an API
 * restart, the engine's own clock sweeps a candidate who never comes back, and finishing it records the result and
 * sends the next email. The attempt exists from the moment the candidate starts: before that there is no session.
 */
@Injectable()
export class EngineSessionStore implements SessionStore {
  constructor(@Inject(RoundEngineService) private readonly engine: RoundEngineService) {}

  async get(token: string): Promise<DsaSession | undefined> {
    const ctx = await this.engine.openCodingRound(token);
    const a = ctx.attempt;
    if (!a) return undefined;
    const state = a.codingState ?? emptyCodingState();
    const finished = a.status !== 'IN_PROGRESS';
    return {
      token,
      assessmentId: assessmentIdFor(ctx),
      candidateName: firstNameOf(ctx.candidateName),
      durationSec: ctx.minutes * 60,
      status: finished ? 'finished' : 'in_progress',
      startedAt: a.startedAt.getTime(),
      deadlineAt: a.deadlineAt?.getTime() ?? null,
      finishedAt: a.submittedAt?.getTime() ?? null,
      finishReason: finished ? (state.finishReason ?? (a.status === 'TIMED_OUT' ? 'time_expired' : 'submitted')) : null,
      progress: Object.fromEntries(Object.entries(state.progress).map(([id, p]) => [id, toProgress(id, p)])),
    };
  }

  async save(session: DsaSession): Promise<void> {
    if (session.status === 'not_started') return; // nothing exists before the candidate presses Start
    if (session.status === 'in_progress') {
      // the first save after Start creates the attempt (and its clock); later saves keep the progress
      const ctx = await this.engine.openCodingRound(session.token);
      if (!ctx.attempt) await this.engine.startCodingAttempt(session.token, new Date(session.startedAt ?? Date.now()));
      else await this.engine.saveCodingProgress(session.token, toState(session));
      return;
    }
    await this.engine.finishCodingAttempt(session.token, session.finishReason ?? 'submitted', toState(session));
  }
}
