import {
  GdStore,
  type BatchRow,
  type CancelResult,
  type EventRow,
  type GdRoundRow,
  type NewEvent,
  type ParticipantRow,
  type PoolCandidate,
} from '../../src/modules/group-discussion/gd.store';

let seq = 0;
export const pid = () => `0192f3a1-bbbb-7000-8000-${String(++seq).padStart(12, '0')}`;

type Participant = ParticipantRow & { tenantId: string; roundId: string; jobId: string };

/** The GD tables in memory. Rows of every tenant live together, like in the database. */
export class MemoryGdStore extends GdStore {
  rounds: (GdRoundRow & { tenantId: string })[] = [];
  participantRows: Participant[] = [];
  eventRows: EventRow[] = [];
  /** What poolCandidates() returns (the SQL lives in the Prisma store). */
  candidates: PoolCandidate[] = [];
  /** Simulates another HR user scheduling the same students first. */
  failNextCreate = false;

  /** A student waiting in a round's pool, `minutesAgo` minutes before `at`. */
  addWaiting(tenantId: string, roundId: string, jobId: string, name: string, at: Date, minutesAgo = 0): Participant {
    const p: Participant = {
      id: pid(),
      tenantId,
      roundId,
      jobId,
      applicationId: pid(),
      batchId: null,
      attendance: 'WAITING',
      name,
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      college: 'GTU',
      createdAt: new Date(at.getTime() - minutesAgo * 60_000),
    };
    this.participantRows.push(p);
    return p;
  }

  async poolCandidates(limit: number) {
    return this.candidates
      .filter((c) => !this.participantRows.some((p) => p.applicationId === c.applicationId && p.roundId === c.roundId))
      .slice(0, limit);
  }
  async addToPool(c: PoolCandidate) {
    if (this.participantRows.some((p) => p.applicationId === c.applicationId && p.roundId === c.roundId)) return false;
    this.participantRows.push({ id: pid(), ...c, batchId: null, attendance: 'WAITING', name: 'Student', email: 's@example.com', college: null, createdAt: new Date() });
    return true;
  }
  async listRounds(tenantId: string) {
    return this.rounds.filter((r) => r.tenantId === tenantId).map(({ tenantId: _t, ...r }) => r);
  }
  async getRound(tenantId: string, roundId: string) {
    const r = this.rounds.find((x) => x.tenantId === tenantId && x.roundId === roundId);
    if (!r) return null;
    const { tenantId: _t, ...row } = r;
    return row;
  }
  async participants(tenantId: string, roundId: string) {
    return this.participantRows
      .filter((p) => p.tenantId === tenantId && p.roundId === roundId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => structuredClone(p));
  }
  async events(tenantId: string, roundId: string) {
    return this.eventRows
      .filter((e) => e.tenantId === tenantId && e.roundId === roundId)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      .map((e) => structuredClone(e));
  }
  async getEvent(tenantId: string, eventId: string) {
    const e = this.eventRows.find((x) => x.id === eventId && x.tenantId === tenantId);
    return e ? structuredClone(e) : null;
  }
  async countBatches(tenantId: string, roundId: string) {
    return this.eventRows.filter((e) => e.tenantId === tenantId && e.roundId === roundId && e.status !== 'CANCELLED').reduce((n, e) => n + e.batches.length, 0);
  }
  async createEvent(e: NewEvent) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      return false;
    }
    const ids = e.batches.flatMap((b) => b.participantIds);
    const movable = this.participantRows.filter((p) => ids.includes(p.id) && p.tenantId === e.tenantId && p.roundId === e.roundId && p.attendance === 'WAITING');
    if (movable.length !== ids.length) return false;
    for (const b of e.batches) {
      for (const p of this.participantRows) if (b.participantIds.includes(p.id)) Object.assign(p, { batchId: b.id, attendance: 'SCHEDULED' });
    }
    this.eventRows.push({
      id: e.id,
      tenantId: e.tenantId,
      jobId: e.jobId,
      roundId: e.roundId,
      name: e.name,
      startsAt: e.startsAt,
      status: 'SCHEDULED',
      settings: structuredClone(e.settings),
      undersized: e.undersized,
      createdAt: new Date(),
      batches: e.batches.map(({ participantIds: _p, ...b }): BatchRow => ({ ...b, eventId: e.id, status: 'SCHEDULED' })),
    });
    return true;
  }
  async cancelEvent(tenantId: string, eventId: string): Promise<CancelResult> {
    const e = this.eventRows.find((x) => x.id === eventId && x.tenantId === tenantId);
    if (!e) return 'NOT_FOUND';
    if (e.status === 'CANCELLED') return 'ALREADY_CANCELLED';
    if (e.status !== 'SCHEDULED' || e.batches.some((b) => b.status !== 'SCHEDULED')) return 'STARTED';
    e.status = 'CANCELLED';
    for (const b of e.batches) b.status = 'CANCELLED';
    const batchIds = e.batches.map((b) => b.id);
    for (const p of this.participantRows) if (p.batchId && batchIds.includes(p.batchId)) Object.assign(p, { batchId: null, attendance: 'WAITING' });
    return 'CANCELLED';
  }
  async getBatch(tenantId: string, batchId: string) {
    for (const e of this.eventRows) {
      const b = e.batches.find((x) => x.id === batchId);
      if (b && e.tenantId === tenantId) return { ...structuredClone(b), roundId: e.roundId, jobId: e.jobId };
    }
    return null;
  }
  async setBatchTopic(tenantId: string, batchId: string, topicId: string, topicText: string) {
    for (const e of this.eventRows) {
      const b = e.batches.find((x) => x.id === batchId);
      if (b && e.tenantId === tenantId && b.status === 'SCHEDULED') {
        Object.assign(b, { topicQuestionId: topicId, topicText });
        return true;
      }
    }
    return false;
  }
}
