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
}

/**
 * Persistence for assessment state. The in-memory implementation (demo tokens only) loses state on API restart; for HR
 * rounds `EngineSessionStore` keeps it on the round engine's attempt, so nothing is lost on restart.
 */
export interface SessionStore {
  get(token: string): Promise<DsaSession | undefined>;
  save(session: DsaSession): Promise<void>;
}

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
