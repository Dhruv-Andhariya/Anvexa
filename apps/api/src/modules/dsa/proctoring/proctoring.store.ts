import { Injectable } from '@nestjs/common';
import type { ProctorSession } from './proctoring.types';

export const DSA_PROCTOR_STORE = Symbol('DSA_PROCTOR_STORE');

/**
 * Persistence for integrity events, keyed by the invitation hash. In production: PrismaProctorStore
 * (table dsa_proctor_sessions); in demo mode and tests: the in-memory store below (lost on restart).
 */
export interface ProctorStore {
  get(inviteRef: string): Promise<ProctorSession | undefined>;
  save(session: ProctorSession): Promise<void>;
  list(): Promise<ProctorSession[]>;
  /**
   * Runs `fn` on the record while nobody else can change it (one writer at a time: the warning counter must never be
   * decided on stale data), then saves what `fn` changed. `init` makes the record when there is none yet.
   */
  withLock<T>(inviteRef: string, init: () => ProctorSession, fn: (session: ProctorSession) => T): Promise<T>;
}

@Injectable()
export class InMemoryProctorStore implements ProctorStore {
  private readonly sessions = new Map<string, ProctorSession>();
  /** Per record: the tail of the queue of writers waiting for it. */
  private readonly queues = new Map<string, Promise<unknown>>();

  async get(inviteRef: string): Promise<ProctorSession | undefined> {
    const s = this.sessions.get(inviteRef);
    return s ? structuredClone(s) : undefined;
  }

  async save(session: ProctorSession): Promise<void> {
    this.sessions.set(session.inviteRef, structuredClone(session));
  }

  async list(): Promise<ProctorSession[]> {
    return [...this.sessions.values()].map((s) => structuredClone(s));
  }

  withLock<T>(inviteRef: string, init: () => ProctorSession, fn: (session: ProctorSession) => T): Promise<T> {
    const run = async () => {
      const session = (await this.get(inviteRef)) ?? init();
      const result = fn(session);
      await this.save(session);
      return result;
    };
    const next = (this.queues.get(inviteRef) ?? Promise.resolve()).then(run, run);
    this.queues.set(
      inviteRef,
      next.catch(() => undefined),
    );
    return next;
  }
}
