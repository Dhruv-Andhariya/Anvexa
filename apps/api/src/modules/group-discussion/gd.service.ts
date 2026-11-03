import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  GD_DEFAULT_SETTINGS,
  GD_LIMITS,
  createGdEventRequestSchema,
  planGroupSizes,
  planGroupSlots,
  setGdBatchTopicRequestSchema,
  type GdEvent,
  type GdParticipant,
  type GdRoundOverview,
  type GdRoundSummary,
  type SavedRound,
} from '@hireflow/contracts';
import { uuidv7 } from '../../common/uuidv7';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { GdStore, type EventRow, type GdRoundRow, type ParticipantRow } from './gd.store';
import { assignTopics, isGroupDiscussionRound, newRoomName, topicsOf } from './planning';

export const GD_CLOCK = Symbol('GD_CLOCK');

/** Same error body shape as the other modules: { statusCode, code, message, ...extra }. */
export const gdError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ statusCode: status, code, message, ...extra }, status);

const roundNotFound = () => gdError(HttpStatus.NOT_FOUND, 'GD_ROUND_NOT_FOUND', 'Group discussion round not found.');
const DAY_MS = 24 * 60 * 60_000;

/**
 * M18 AI group discussion - scheduling (phase 1). Students enter a GD round's pool on their own (gd.worker.ts); HR
 * schedules an event that splits the whole pool into groups with back-to-back time slots and one topic each. The
 * round (name, topics) comes from rounds-config; this module never changes it.
 */
@Injectable()
export class GdService {
  constructor(
    @Inject(GdStore) private readonly store: GdStore,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GD_CLOCK) private readonly now: () => Date,
  ) {}

  /** Every GD round of the company's jobs, with how many students wait and when the next group starts. */
  async listRounds(tenantId: string): Promise<GdRoundSummary[]> {
    const rows = await this.store.listRounds(tenantId);
    return Promise.all(
      rows.map(async (r) => {
        const [people, events] = await Promise.all([this.store.participants(tenantId, r.roundId), this.store.events(tenantId, r.roundId)]);
        const now = this.now().getTime();
        const next = events
          .flatMap((e) => (e.status === 'SCHEDULED' ? e.batches : []))
          .filter((b) => b.status === 'SCHEDULED' && b.startsAt.getTime() > now)
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
        return {
          roundId: r.roundId,
          roundName: r.roundName,
          jobId: r.jobId,
          jobTitle: r.jobTitle,
          waiting: people.filter((p) => p.attendance === 'WAITING').length,
          scheduled: people.filter((p) => p.batchId !== null).length,
          nextStartsAt: next?.startsAt.toISOString() ?? null,
        };
      }),
    );
  }

  async overview(tenantId: string, roundId: string): Promise<GdRoundOverview> {
    const row = await this.store.getRound(tenantId, roundId);
    if (!row) throw roundNotFound();
    const { round, complete } = await this.savedRound(tenantId, row);
    const [people, events] = await Promise.all([this.store.participants(tenantId, roundId), this.store.events(tenantId, roundId)]);
    const latest = events.find((e) => e.status !== 'CANCELLED') ?? events[0];
    return {
      roundId,
      roundName: row.roundName,
      position: row.position,
      jobId: row.jobId,
      jobTitle: row.jobTitle,
      roundsComplete: complete,
      topics: round ? topicsOf(round) : [],
      pool: people.filter((p) => p.attendance === 'WAITING').map(toParticipant),
      events: events.map((e) => toEvent(e, people)),
      suggestedSettings: latest?.settings ?? GD_DEFAULT_SETTINGS,
    };
  }

  /** Puts EVERY waiting student of the round into groups, starting at `startsAt`, one group after another. */
  async createEvent(tenantId: string, roundId: string, body: unknown, actor: Actor | null): Promise<GdRoundOverview> {
    const parsed = createGdEventRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'The request is invalid.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const req = parsed.data;
    const row = await this.store.getRound(tenantId, roundId);
    if (!row) throw roundNotFound();
    const { round, complete } = await this.savedRound(tenantId, row);
    if (!round || !complete) {
      throw gdError(HttpStatus.CONFLICT, 'ROUNDS_NOT_COMPLETE', 'Finish this job\'s rounds on the Publish page before scheduling the group discussion.');
    }
    const topics = topicsOf(round);
    if (!topics.length) {
      throw gdError(HttpStatus.CONFLICT, 'GD_NO_TOPICS', 'Add at least one discussion topic (a question of this round) on the Publish page first.');
    }

    const startsAt = new Date(req.startsAt);
    const now = this.now().getTime();
    if (startsAt.getTime() < now + GD_LIMITS.minLeadMinutes * 60_000) {
      throw gdError(HttpStatus.BAD_REQUEST, 'GD_START_TOO_SOON', `Pick a start time at least ${GD_LIMITS.minLeadMinutes} minutes from now, so students get their invitation and reminder.`);
    }
    if (startsAt.getTime() > now + GD_LIMITS.maxLeadDays * DAY_MS) {
      throw gdError(HttpStatus.BAD_REQUEST, 'GD_START_TOO_LATE', `Pick a start time within the next ${GD_LIMITS.maxLeadDays} days.`);
    }

    const pool = (await this.store.participants(tenantId, roundId)).filter((p) => p.attendance === 'WAITING');
    if (!pool.length) throw gdError(HttpStatus.CONFLICT, 'GD_POOL_EMPTY', 'No students are waiting for this group discussion yet.');

    const { sizes, undersized } = planGroupSizes(pool.length, req.settings.minGroupSize, req.settings.maxGroupSize);
    const slots = planGroupSlots(startsAt, req.settings, sizes);
    const groupTopics = assignTopics(topics, sizes.length, await this.store.countBatches(tenantId, roundId));
    let next = 0;
    const eventId = uuidv7();
    const created = await this.store.createEvent({
      id: eventId,
      tenantId,
      jobId: row.jobId,
      roundId,
      name: req.name,
      startsAt,
      settings: req.settings,
      undersized,
      createdById: actor?.id ?? null,
      batches: sizes.map((size, i) => {
        // oldest in the pool first: they have waited longest
        const participantIds = pool.slice(next, next + size).map((p) => p.id);
        next += size;
        return {
          id: uuidv7(),
          number: i + 1,
          startsAt: slots[i]!.startsAt,
          endsAt: slots[i]!.endsAt,
          roomName: newRoomName(),
          topicQuestionId: groupTopics[i]?.id ?? null,
          topicText: groupTopics[i]?.text ?? null,
          participantIds,
        };
      }),
    });
    if (!created) {
      throw gdError(HttpStatus.CONFLICT, 'GD_POOL_CHANGED', 'Someone else scheduled some of these students a moment ago. Reload and try again.');
    }
    await this.audit.record({
      tenantId,
      actorUserId: actor?.id ?? null,
      action: 'gd.event_scheduled',
      subjectType: 'gd_event',
      subjectId: eventId,
      metadata: { roundId, groups: sizes.length, students: pool.length, startsAt: startsAt.toISOString(), undersized },
    });
    return this.overview(tenantId, roundId);
  }

  /** Cancels an event whose groups have not started; its students go back to the pool. */
  async cancelEvent(tenantId: string, eventId: string, actor: Actor | null): Promise<GdRoundOverview> {
    const event = await this.store.getEvent(tenantId, eventId);
    if (!event) throw gdError(HttpStatus.NOT_FOUND, 'GD_EVENT_NOT_FOUND', 'Group discussion event not found.');
    const result = await this.store.cancelEvent(tenantId, eventId, actor?.id ?? null, this.now());
    if (result === 'NOT_FOUND') throw gdError(HttpStatus.NOT_FOUND, 'GD_EVENT_NOT_FOUND', 'Group discussion event not found.');
    if (result === 'STARTED') {
      throw gdError(HttpStatus.CONFLICT, 'GD_EVENT_STARTED', 'A group of this event has already started, so it can no longer be cancelled.');
    }
    if (result === 'CANCELLED') {
      await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'gd.event_cancelled', subjectType: 'gd_event', subjectId: eventId, metadata: { roundId: event.roundId } });
    }
    return this.overview(tenantId, event.roundId);
  }

  /** HR picks another of the round's topics for a group that has not started. */
  async setBatchTopic(tenantId: string, batchId: string, body: unknown, actor: Actor | null): Promise<GdRoundOverview> {
    const parsed = setGdBatchTopicRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Pick a topic.');
    const batch = await this.store.getBatch(tenantId, batchId);
    if (!batch) throw gdError(HttpStatus.NOT_FOUND, 'GD_BATCH_NOT_FOUND', 'Group not found.');
    const row = await this.store.getRound(tenantId, batch.roundId);
    const { round } = row ? await this.savedRound(tenantId, row) : { round: null };
    const topic = round ? topicsOf(round).find((t) => t.id === parsed.data.topicId) : undefined;
    if (!topic) throw gdError(HttpStatus.UNPROCESSABLE_ENTITY, 'GD_TOPIC_NOT_FOUND', 'That topic is not one of this round\'s topics.');
    if (!(await this.store.setBatchTopic(tenantId, batchId, topic.id, topic.text))) {
      throw gdError(HttpStatus.CONFLICT, 'GD_BATCH_STARTED', 'This group has already started; its topic can no longer change.');
    }
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'gd.topic_changed', subjectType: 'gd_batch', subjectId: batchId, metadata: { topicId: topic.id } });
    return this.overview(tenantId, batch.roundId);
  }

  /** The round as saved on the Publish page (for its topics), and whether the job's rounds are COMPLETE. */
  private async savedRound(tenantId: string, row: GdRoundRow): Promise<{ round: SavedRound | null; complete: boolean }> {
    const config = await this.rounds.forRoundEngine(tenantId, row.jobId);
    const round = config?.rounds.find((r) => r.id === row.roundId);
    return { round: round && isGroupDiscussionRound(round) ? round : null, complete: config?.status === 'COMPLETE' };
  }
}

const toParticipant = (p: ParticipantRow): GdParticipant => ({
  id: p.id,
  applicationId: p.applicationId,
  name: p.name,
  email: p.email,
  college: p.college,
  attendance: p.attendance,
  addedAt: p.createdAt.toISOString(),
});

function toEvent(e: EventRow, people: ParticipantRow[]): GdEvent {
  return {
    id: e.id,
    name: e.name,
    startsAt: e.startsAt.toISOString(),
    status: e.status,
    settings: e.settings,
    createdAt: e.createdAt.toISOString(),
    undersized: e.undersized,
    batches: e.batches.map((b) => ({
      id: b.id,
      number: b.number,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      status: b.status,
      topic: b.topicQuestionId && b.topicText ? { id: b.topicQuestionId, text: b.topicText } : null,
      participants: people.filter((p) => p.batchId === b.id).map(toParticipant),
      sessionAudio: b.sessionAudio ?? null,
    })),
  };
}
