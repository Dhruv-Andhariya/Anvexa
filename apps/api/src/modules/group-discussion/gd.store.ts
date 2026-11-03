import { Inject, Injectable } from '@nestjs/common';
import type { GdAttendance, GdBatchStatus, GdEventStatus, GdSessionAudio, GdSettings } from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';

/** A student who may enter a GD round's pool (found by poolCandidates()). */
export interface PoolCandidate {
  tenantId: string;
  applicationId: string;
  jobId: string;
  roundId: string;
}

export interface ParticipantRow {
  id: string;
  applicationId: string;
  batchId: string | null;
  attendance: GdAttendance;
  name: string;
  email: string;
  college: string | null;
  createdAt: Date;
}

export interface BatchRow {
  id: string;
  eventId: string;
  number: number;
  startsAt: Date;
  endsAt: Date;
  status: GdBatchStatus;
  roomName: string;
  topicQuestionId: string | null;
  topicText: string | null;
  /** The whole session as one audio file; null / absent = not built. */
  sessionAudio?: GdSessionAudio | null;
}

/** A group's whole-session audio as HR sees it, from its gd_batches columns. */
export const sessionAudioOf = (b: { sessionAudioAt: Date | null; sessionAudioMs: number | null; sessionAudioBytes: number | null }): GdSessionAudio | null =>
  b.sessionAudioAt ? { durationMs: b.sessionAudioMs ?? 0, bytes: b.sessionAudioBytes ?? 0, createdAt: b.sessionAudioAt.toISOString() } : null;

export interface EventRow {
  id: string;
  tenantId: string;
  jobId: string;
  roundId: string;
  name: string;
  startsAt: Date;
  status: GdEventStatus;
  settings: GdSettings;
  undersized: boolean;
  createdAt: Date;
  batches: BatchRow[];
}

/** A GD round of the company with its job (only rounds of type GROUP_DISCUSSION). */
export interface GdRoundRow {
  roundId: string;
  roundName: string;
  position: number;
  jobId: string;
  jobTitle: string;
}

export interface NewEvent {
  id: string;
  tenantId: string;
  jobId: string;
  roundId: string;
  name: string;
  startsAt: Date;
  settings: GdSettings;
  undersized: boolean;
  createdById: string | null;
  batches: (Omit<BatchRow, 'eventId' | 'status'> & { participantIds: string[] })[];
}

export type CancelResult = 'CANCELLED' | 'NOT_FOUND' | 'ALREADY_CANCELLED' | 'STARTED';

/**
 * All database access of the GD module. Every HR-facing read and write filters by tenant id. Participants move from
 * the pool into a group only if they are still WAITING, so two HR users scheduling at once can never put a student
 * in two groups.
 */
export abstract class GdStore {
  // ---- pool
  /**
   * Students who reached a GD round and are not in its pool yet: every earlier round passed (HR's override counts),
   * or - when the GD is the job's first round - AI screening completed. Only rounds of COMPLETE configurations.
   */
  abstract poolCandidates(limit: number): Promise<PoolCandidate[]>;
  /** Adds the student to the round's pool (WAITING). false = already there. */
  abstract addToPool(c: PoolCandidate): Promise<boolean>;

  // ---- HR
  abstract listRounds(tenantId: string): Promise<GdRoundRow[]>;
  abstract getRound(tenantId: string, roundId: string): Promise<GdRoundRow | null>;
  abstract participants(tenantId: string, roundId: string): Promise<ParticipantRow[]>;
  abstract events(tenantId: string, roundId: string): Promise<EventRow[]>;
  abstract getEvent(tenantId: string, eventId: string): Promise<EventRow | null>;
  /** Groups already made in this round (cancelled events excluded): the topic rotation continues from here. */
  abstract countBatches(tenantId: string, roundId: string): Promise<number>;
  /**
   * Creates the event, its groups, and moves the listed participants into them - all or nothing. false = a
   * participant was no longer WAITING (another HR user scheduled them first); nothing was written.
   */
  abstract createEvent(e: NewEvent): Promise<boolean>;
  /** Cancels an event none of whose groups started yet; its students go back to the pool. */
  abstract cancelEvent(tenantId: string, eventId: string, byId: string | null, at: Date): Promise<CancelResult>;
  abstract getBatch(tenantId: string, batchId: string): Promise<(BatchRow & { roundId: string; jobId: string }) | null>;
  /** Changes a group's topic while it is still SCHEDULED. false = it started meanwhile. */
  abstract setBatchTopic(tenantId: string, batchId: string, topicId: string, topicText: string): Promise<boolean>;
}

const settingsOf = (e: Prisma.GdEventGetPayload<object>): GdSettings => ({
  minGroupSize: e.minGroupSize,
  maxGroupSize: e.maxGroupSize,
  graceMinutes: e.graceMinutes,
  introSeconds: e.introSeconds,
  thinkingSeconds: e.thinkingSeconds,
  discussionMinutes: e.discussionMinutes,
  summarySeconds: e.summarySeconds,
  hrQuestionsEnabled: e.hrQuestionsEnabled,
  hrQuestionsMinutes: e.hrQuestionsMinutes,
  silencePromptSeconds: e.silencePromptSeconds,
  breakMinutes: e.breakMinutes,
});

const toBatch = (b: Prisma.GdBatchGetPayload<object>): BatchRow => ({
  id: b.id,
  eventId: b.eventId,
  number: b.number,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  status: b.status,
  roomName: b.roomName,
  topicQuestionId: b.topicQuestionId,
  topicText: b.topicText,
  sessionAudio: sessionAudioOf(b),
});

const toEvent = (e: Prisma.GdEventGetPayload<{ include: { batches: true } }>): EventRow => ({
  id: e.id,
  tenantId: e.tenantId,
  jobId: e.jobId,
  roundId: e.roundId,
  name: e.name,
  startsAt: e.startsAt,
  status: e.status,
  settings: settingsOf(e),
  undersized: e.undersized,
  createdAt: e.createdAt,
  batches: [...e.batches].sort((a, b) => a.number - b.number).map(toBatch),
});

@Injectable()
export class PrismaGdStore extends GdStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  poolCandidates(limit: number) {
    return this.db.$queryRaw<PoolCandidate[]>(Prisma.sql`
      SELECT a.tenant_id::text AS "tenantId", a.id::text AS "applicationId", a.job_id::text AS "jobId", r.id::text AS "roundId"
        FROM job_rounds r
        JOIN job_round_configs c ON c.job_id = r.job_id AND c.tenant_id = r.tenant_id AND c.status = 'COMPLETE'
        JOIN applications a ON a.job_id = r.job_id AND a.tenant_id = r.tenant_id
       WHERE r.type = 'GROUP_DISCUSSION'
         AND NOT EXISTS (SELECT 1 FROM gd_participants p WHERE p.application_id = a.id AND p.round_id = r.id)
         AND (
           -- GD is the first round: AI screening completed (like the round engine's first online test)
           (r.position = 1 AND EXISTS (
              SELECT 1 FROM screening_sessions s
               WHERE s.application_id = a.id AND s.tenant_id = a.tenant_id AND s.status = 'COMPLETED'))
           OR
           -- later round: every earlier round has a result that counts as passed (HR override first)
           (r.position > 1 AND NOT EXISTS (
              SELECT 1 FROM job_rounds e
               WHERE e.job_id = r.job_id AND e.tenant_id = r.tenant_id AND e.position < r.position
                 AND NOT EXISTS (
                   SELECT 1 FROM round_results rr
                    WHERE rr.application_id = a.id AND rr.round_id = e.id
                      AND COALESCE(rr.override_passed, rr.system_passed))))
         )
       ORDER BY a.created_at
       LIMIT ${limit}`);
  }

  async addToPool(c: PoolCandidate) {
    const r = await this.db.gdParticipant.createMany({ data: { id: uuidv7(), ...c }, skipDuplicates: true });
    return r.count > 0;
  }

  async listRounds(tenantId: string) {
    const rounds = await this.db.jobRound.findMany({
      where: { tenantId, type: 'GROUP_DISCUSSION' },
      select: { id: true, name: true, position: true, jobId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!rounds.length) return [];
    const jobs = await this.db.job.findMany({ where: { tenantId, id: { in: [...new Set(rounds.map((r) => r.jobId))] } }, select: { id: true, title: true } });
    const title = new Map(jobs.map((j) => [j.id, j.title]));
    return rounds
      .filter((r) => title.has(r.jobId))
      .map((r) => ({ roundId: r.id, roundName: r.name, position: r.position, jobId: r.jobId, jobTitle: title.get(r.jobId)! }));
  }

  async getRound(tenantId: string, roundId: string) {
    const r = await this.db.jobRound.findFirst({
      where: { id: roundId, tenantId, type: 'GROUP_DISCUSSION' },
      select: { id: true, name: true, position: true, jobId: true },
    });
    if (!r) return null;
    const job = await this.db.job.findFirst({ where: { id: r.jobId, tenantId }, select: { title: true } });
    return job ? { roundId: r.id, roundName: r.name, position: r.position, jobId: r.jobId, jobTitle: job.title } : null;
  }

  async participants(tenantId: string, roundId: string) {
    const rows = await this.db.gdParticipant.findMany({
      where: { tenantId, roundId },
      orderBy: { createdAt: 'asc' },
      include: { application: { select: { email: true, college: true, candidate: { select: { name: true, email: true } } } } },
    });
    return rows.map((p) => ({
      id: p.id,
      applicationId: p.applicationId,
      batchId: p.batchId,
      attendance: p.attendance,
      name: p.application.candidate.name,
      email: p.application.email ?? p.application.candidate.email,
      college: p.application.college || null,
      createdAt: p.createdAt,
    }));
  }

  async events(tenantId: string, roundId: string) {
    const rows = await this.db.gdEvent.findMany({ where: { tenantId, roundId }, include: { batches: true }, orderBy: { startsAt: 'desc' } });
    return rows.map(toEvent);
  }

  async getEvent(tenantId: string, eventId: string) {
    const row = await this.db.gdEvent.findFirst({ where: { id: eventId, tenantId }, include: { batches: true } });
    return row ? toEvent(row) : null;
  }

  countBatches(tenantId: string, roundId: string) {
    return this.db.gdBatch.count({ where: { tenantId, event: { roundId, status: { not: 'CANCELLED' } } } });
  }

  async createEvent(e: NewEvent) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.gdEvent.create({
          data: {
            id: e.id,
            tenantId: e.tenantId,
            jobId: e.jobId,
            roundId: e.roundId,
            name: e.name,
            startsAt: e.startsAt,
            ...e.settings,
            undersized: e.undersized,
            createdById: e.createdById,
          },
        });
        await tx.gdBatch.createMany({
          data: e.batches.map((b) => ({
            id: b.id,
            tenantId: e.tenantId,
            eventId: e.id,
            number: b.number,
            startsAt: b.startsAt,
            endsAt: b.endsAt,
            roomName: b.roomName,
            topicQuestionId: b.topicQuestionId,
            topicText: b.topicText,
          })),
        });
        for (const b of e.batches) {
          const moved = await tx.gdParticipant.updateMany({
            where: { id: { in: b.participantIds }, tenantId: e.tenantId, roundId: e.roundId, attendance: 'WAITING', batchId: null },
            data: { batchId: b.id, attendance: 'SCHEDULED' },
          });
          if (moved.count !== b.participantIds.length) throw new PoolChanged();
        }
      });
      return true;
    } catch (err) {
      if (err instanceof PoolChanged) return false;
      throw err;
    }
  }

  async cancelEvent(tenantId: string, eventId: string, byId: string | null, at: Date): Promise<CancelResult> {
    return this.db.$transaction(async (tx) => {
      const event = await tx.gdEvent.findFirst({ where: { id: eventId, tenantId }, select: { status: true } });
      if (!event) return 'NOT_FOUND';
      if (event.status === 'CANCELLED') return 'ALREADY_CANCELLED';
      // a group that opened its lobby has students in it (or absent ones on record): never undo that
      const started = await tx.gdBatch.count({ where: { eventId, tenantId, status: { not: 'SCHEDULED' } } });
      if (started || event.status !== 'SCHEDULED') return 'STARTED';
      const done = await tx.gdEvent.updateMany({
        where: { id: eventId, tenantId, status: 'SCHEDULED' },
        data: { status: 'CANCELLED', cancelledAt: at, cancelledById: byId },
      });
      if (!done.count) return 'STARTED';
      await tx.gdBatch.updateMany({ where: { eventId, tenantId }, data: { status: 'CANCELLED' } });
      await tx.gdParticipant.updateMany({ where: { tenantId, batch: { eventId } }, data: { batchId: null, attendance: 'WAITING' } });
      return 'CANCELLED';
    });
  }

  async getBatch(tenantId: string, batchId: string) {
    const b = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, include: { event: { select: { roundId: true, jobId: true } } } });
    return b ? { ...toBatch(b), roundId: b.event.roundId, jobId: b.event.jobId } : null;
  }

  async setBatchTopic(tenantId: string, batchId: string, topicId: string, topicText: string) {
    const r = await this.db.gdBatch.updateMany({ where: { id: batchId, tenantId, status: 'SCHEDULED' }, data: { topicQuestionId: topicId, topicText } });
    return r.count > 0;
  }
}

/** Thrown inside createEvent's transaction to roll it back when the pool changed. */
class PoolChanged extends Error {}
