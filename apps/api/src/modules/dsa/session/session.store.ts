import { Injectable } from '@nestjs/common';
import type { Language } from '../questions/question.types';

export const DSA_SESSION_STORE = Symbol('DSA_SESSION_STORE');

export interface QuestionProgress {
  questionId: string;
  attempts: number;
  bestScore: number;
  passed: number;
  total: number;
  language: Language | null;
  lastVerdict: string | null;
  /** Source of the best submission, kept for HR's review. Server side only: never part of the state sent to the browser. */
  bestCode?: string | null;
}

export type SessionStatus = 'not_started' | 'in_progress' | 'finished';

export interface DsaSession {
  token: string;
  assessmentId: string;
  candidateName: string;
  durationSec: number;
  status: SessionStatus;
  startedAt: number | null;
  deadlineAt: number | null;
  finishedAt: number | null;
  finishReason: 'submitted' | 'time_expired' | 'disqualified' | null;
  progress: Record<string, QuestionProgress>;
  /** Set when the proctoring warning limit terminated the attempt (finishReason 'disqualified'). */
  termination?: { reason: string; warnings: number } | null;
  /** Durable stores: an accepted submission whose tests are still running (epoch ms of its acceptance). */
  pending?: { questionId: string; acceptedAt: number } | null;
}

/**
 * Persistence for assessment state. The in-memory implementation (demo tokens only) loses state on API restart; for HR
 * rounds `EngineSessionStore` keeps it on the round engine's attempt, so nothing is lost on restart.
 */
export interface SessionStore {
  get(token: string): Promise<DsaSession | undefined>;
  save(session: DsaSession): Promise<void>;
  /**
   * Durable submissions (stores that persist, i.e. HR rounds): a Submit is ACCEPTED first - atomically, only while the
   * attempt runs and before its deadline, one at a time - and its result is recorded by that acceptance, even if the
   * attempt closes while its tests run. Stores without these (demo, in memory) keep the plain save.
   */
  acceptSubmission?(token: string, questionId: string): Promise<SubmissionAcceptance>;
  /** Records the accepted submission's result once; `build` applies the best-submission rule to the STORED previous result. Null = not recorded. */
  completeSubmission?(token: string, submissionId: string, questionId: string, build: (previous: QuestionProgress | undefined) => QuestionProgress): Promise<QuestionProgress | null>;
  /** The accepted submission could not be judged (code runner failure): nothing recorded. */
  releaseSubmission?(token: string, submissionId: string): Promise<void>;
}

export type SubmissionAcceptance = { accepted: true; id: string } | { accepted: false; reason: 'NOT_STARTED' | 'ENDED' | 'TIME_EXPIRED' | 'BUSY' };

@Injectable()
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, DsaSession>();

  async get(token: string): Promise<DsaSession | undefined> {
    return this.sessions.get(token);
  }

  async save(session: DsaSession): Promise<void> {
    this.sessions.set(session.token, session);
  }
}
