import { Injectable } from '@nestjs/common';
import type { ProctorSession } from './proctoring.types';

export const DSA_PROCTOR_STORE = Symbol('DSA_PROCTOR_STORE');

/**
 * Persistence for integrity events, keyed by the invitation hash.
 * The in-memory implementation loses data on API restart. A Prisma-backed store
 * (see docs/dsa-proctoring-implementation.md, "Database changes") replaces it without touching the service.
 */
export interface ProctorStore {
  get(inviteRef: string): Promise<ProctorSession | undefined>;
  save(session: ProctorSession): Promise<void>;
  list(): Promise<ProctorSession[]>;
}

@Injectable()
export class InMemoryProctorStore implements ProctorStore {
  private readonly sessions = new Map<string, ProctorSession>();

  async get(inviteRef: string): Promise<ProctorSession | undefined> {
    return this.sessions.get(inviteRef);
  }

  async save(session: ProctorSession): Promise<void> {
    this.sessions.set(session.inviteRef, session);
  }

  async list(): Promise<ProctorSession[]> {
    return [...this.sessions.values()];
  }
}
