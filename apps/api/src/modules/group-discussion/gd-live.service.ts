import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  GD_AUDIO_LIMITS,
  GD_CONSENT_VERSION,
  GD_IDENTITY,
  gdClientEventsRequestSchema,
  gdJoinRequestSchema,
  gdRescheduleRequestSchema,
  gdSlotMinutes,
  gdSpeakRequestSchema,
  gdStartPrivateTalkRequestSchema,
  gdStartRecordingRequestSchema,
  type GdAttendance,
  type GdHrActivityKind,
  type GdHrLive,
  type GdJoinResult,
  type GdLiveState,
  type GdPhase,
  type GdPrivateTalkConnection,
  type GdPrivateTalkStarted,
  type GdPublicSession,
  type GdPublicStatus,
  type GdRecordingStarted,
  type GdSettings,
} from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { AuditService } from '../audit';
import type { Actor } from '../tenants';
import { GD_CLOCK, gdError } from './gd.service';
import { GD_TOKEN_SHAPE, hashGdToken } from './link';
import { LiveKitGateway } from './livekit';
import { GdAudioStorage } from './storage';
import { pause, planOf, resume, start, step, type Timeline } from './timeline';

type Batch = Prisma.GdBatchGetPayload<{ include: { event: true } }>;
type Participant = Prisma.GdParticipantGetPayload<object>;

const ATTENDED: GdAttendance[] = ['JOINED', 'ADMITTED_LATE'];
const LIVE_STATUSES = ['LOBBY_OPEN', 'IN_PROGRESS'] as const;
/** Join tokens live this long after the group's estimated end (a slow GD, reconnects). */
const TOKEN_SLACK_S = 45 * 60;
/** Audio may still arrive this long after the GD ended (uploads queued in a browser that lost its connection). */
const LATE_AUDIO_MS = 15 * 60_000;
const EVENTS_PER_PARTICIPANT = 500;

const invalidLink = () => gdError(HttpStatus.NOT_FOUND, 'GD_LINK_INVALID', 'This group discussion link is not valid. Please use the link from your latest email.');
const notJoined = () => gdError(HttpStatus.CONFLICT, 'GD_NOT_JOINED', 'Please join the group discussion first.');
const batchNotFound = () => gdError(HttpStatus.NOT_FOUND, 'GD_BATCH_NOT_FOUND', 'Group not found.');

export const settingsOf = (e: Batch['event']): GdSettings => ({
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

const timelineOf = (b: Batch): Timeline => ({
  phase: b.phase,
  phaseStartedAt: b.phaseStartedAt,
  phaseEndsAt: b.phaseEndsAt,
  pausedAt: b.pausedAt,
  summaryIndex: b.summaryIndex,
});

const firstName = (name: string) => name.trim().split(/\s+/)[0]?.slice(0, 40) ?? '';

/**
 * M18 live GD (phases 2-4, 6): the student's link (lobby, join, reconnect, own-mic recording, client events, private
 * talk), HR's live controls (speak to the group, private talks, admit / move absent students), and the timeline loop
 * that opens rooms at the start time, locks them after the joining window, runs the phases and pushes the live state
 * to LiveKit (room metadata) so every screen and the moderator bot stay in sync.
 */
@Injectable()
export class GdLiveService {
  private readonly logger = new Logger('GdLive');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(LiveKitGateway) private readonly livekit: LiveKitGateway,
    @Inject(GdAudioStorage) private readonly storage: GdAudioStorage,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GD_CLOCK) private readonly now: () => Date,
  ) {}

  // ================================================================ student (public, personal link)

  async session(token: string | undefined): Promise<GdPublicSession> {
    const { participant, batch } = await this.open(token);
    const ctx = await this.context(participant);
    const s = settingsOf(batch.event);
    const size = await this.db.gdParticipant.count({ where: { batchId: batch.id } });
    const startsAt = batch.startsAt;
    return {
      status: this.publicStatus(participant, batch),
      candidateFirstName: firstName(ctx.candidateName),
      companyName: ctx.companyName,
      jobTitle: ctx.jobTitle,
      roundName: ctx.roundName,
      startsAt: startsAt.toISOString(),
      joinClosesAt: new Date(startsAt.getTime() + s.graceMinutes * 60_000).toISOString(),
      estimatedEndAt: batch.endsAt.toISOString(),
      groupSize: size,
      settings: {
        graceMinutes: s.graceMinutes,
        introSeconds: s.introSeconds,
        thinkingSeconds: s.thinkingSeconds,
        discussionMinutes: s.discussionMinutes,
        summarySeconds: s.summarySeconds,
        hrQuestionsEnabled: s.hrQuestionsEnabled,
        hrQuestionsMinutes: s.hrQuestionsMinutes,
      },
      consentVersion: GD_CONSENT_VERSION,
      joined: !!participant.joinedAt,
      serverNow: this.now().toISOString(),
    };
  }

  /** POST /public/gd/join - consent (first time), then a LiveKit token for the group's room. Also the reconnect path. */
  async join(token: string | undefined, body: unknown): Promise<GdJoinResult> {
    let { participant, batch } = await this.open(token);
    if (batch.status === 'SCHEDULED' && this.now() >= batch.startsAt) batch = await this.openLobby(batch);
    const status = this.publicStatus(participant, batch);
    if (status === 'UPCOMING') throw gdError(HttpStatus.CONFLICT, 'GD_NOT_OPEN_YET', 'The room opens at the start time. Please wait on this page.');
    if (status === 'MISSED') throw gdError(HttpStatus.GONE, 'GD_MISSED', 'The joining window for your group has closed. Please contact the hiring team.');
    if (status === 'ENDED') throw gdError(HttpStatus.GONE, 'GD_ENDED', 'This group discussion has ended.');
    if (status === 'CANCELLED') throw gdError(HttpStatus.GONE, 'GD_CANCELLED', 'This group discussion was cancelled. The hiring team will contact you.');
    if (!participant.consentAt && !gdJoinRequestSchema.safeParse(body).success) {
      throw gdError(HttpStatus.BAD_REQUEST, 'CONSENT_REQUIRED', 'Please accept the recording consent before joining.');
    }
    const now = this.now();
    participant = await this.db.gdParticipant.update({
      where: { id: participant.id },
      data: {
        consentVersion: participant.consentVersion ?? GD_CONSENT_VERSION,
        consentAt: participant.consentAt ?? now,
        joinedAt: participant.joinedAt ?? now,
        lastSeenAt: now,
        attendance: participant.attendance === 'ADMITTED_LATE' ? 'ADMITTED_LATE' : 'JOINED',
      },
    });
    if (!participant.joinedAt || participant.joinedAt.getTime() === now.getTime()) {
      await this.audit.record({ tenantId: participant.tenantId, actorUserId: null, action: 'gd.joined', subjectType: 'application', subjectId: participant.applicationId, metadata: { batchId: batch.id } });
    }
    // admitted after the lock: speaks in the summary round too (if it has not begun)
    if (batch.status === 'IN_PROGRESS' && !batch.summaryOrder.includes(participant.id) && ['INTRO', 'THINKING', 'DISCUSSION'].includes(batch.phase)) {
      batch = await this.db.gdBatch.update({ where: { id: batch.id }, data: { summaryOrder: { push: participant.id } }, include: { event: true } });
    }
    const ctx = await this.context(participant);
    const connection = await this.connection(batch.roomName, GD_IDENTITY.student(participant.id), ctx.candidateName, batch, false);
    const state = await this.liveState(batch);
    if (batch.status !== 'SCHEDULED') await this.push(batch, state);
    return { connection, state };
  }

  async state(token: string | undefined): Promise<GdLiveState> {
    const { participant, batch } = await this.open(token);
    await this.db.gdParticipant.update({ where: { id: participant.id }, data: { lastSeenAt: this.now() } });
    return this.liveState(batch);
  }

  /** A new continuous recording of the student's own microphone (a reload or reconnect starts another). */
  async startRecording(token: string | undefined, body: unknown): Promise<GdRecordingStarted> {
    const { participant, batch } = await this.open(token);
    if (!participant.joinedAt) throw notJoined();
    this.audioWindow(batch);
    return this.newRecording(participant.tenantId, batch.id, { participantId: participant.id, hrUserId: null }, body);
  }

  async putChunk(token: string | undefined, recordingId: string, seq: number, bytes: Buffer | undefined): Promise<{ received: number }> {
    const { participant, batch } = await this.open(token);
    const rec = await this.db.gdRecording.findFirst({ where: { id: recordingId, participantId: participant.id, batchId: batch.id } });
    if (!rec) throw gdError(HttpStatus.NOT_FOUND, 'GD_RECORDING_NOT_FOUND', 'Recording not found.');
    this.audioWindow(batch);
    return this.storeChunk(rec, seq, bytes);
  }

  async events(token: string | undefined, body: unknown): Promise<{ accepted: number }> {
    const { participant, batch } = await this.open(token);
    const parsed = gdClientEventsRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The request is invalid.');
    const room = EVENTS_PER_PARTICIPANT - (await this.db.gdParticipantEvent.count({ where: { participantId: participant.id } }));
    if (room <= 0) return { accepted: 0 };
    const now = this.now();
    const events = parsed.data.events.slice(0, room).map((e) => {
      const at = Date.parse(e.occurredAt);
      // the browser clock is only trusted within a few minutes of the server's
      const occurredAt = Math.abs(at - now.getTime()) < 5 * 60_000 ? new Date(at) : now;
      return { id: uuidv7(), tenantId: participant.tenantId, batchId: batch.id, participantId: participant.id, type: e.type, occurredAt };
    });
    await this.db.gdParticipantEvent.createMany({ data: events });
    await this.db.gdParticipant.update({ where: { id: participant.id }, data: { lastSeenAt: now } });
    return { accepted: events.length };
  }

  /** GET /public/gd/private - the private room HR opened for this student (the page asks when the state says so). */
  async privateTalk(token: string | undefined): Promise<GdPrivateTalkConnection> {
    const { participant, batch } = await this.open(token);
    const talk = await this.db.gdPrivateTalk.findFirst({ where: { participantId: participant.id, batchId: batch.id, endedAt: null } });
    if (!talk) return { active: false, talkId: null, connection: null };
    const ctx = await this.context(participant);
    return { active: true, talkId: talk.id, connection: await this.connection(talk.roomName, GD_IDENTITY.student(participant.id), ctx.candidateName, batch, false) };
  }

  // ================================================================ HR live page

  async hrLive(tenantId: string, batchId: string, actor: Actor): Promise<GdHrLive> {
    let batch = await this.hrBatch(tenantId, batchId);
    if (batch.status === 'SCHEDULED' && this.now() >= batch.startsAt) batch = await this.openLobby(batch);
    const live = batch.status === 'LOBBY_OPEN' || batch.status === 'IN_PROGRESS';
    if (live && !(await this.db.gdHrActivity.findFirst({ where: { batchId, hrUserId: actor.id, kind: 'JOINED' } }))) {
      await this.activity(batch, actor, 'JOINED');
    }
    // HR is a normal, visible participant (camera and mic off until HR turns them on)
    return this.hrView(batch, live ? await this.connection(batch.roomName, GD_IDENTITY.hr(actor.id), `HR · ${actor.name}`, batch, false) : null);
  }

  /** "Speak to group": HR is audible to everyone; the discussion timer pauses until HR mutes again. */
  async speak(tenantId: string, batchId: string, body: unknown, actor: Actor): Promise<GdHrLive> {
    const parsed = gdSpeakRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The request is invalid.');
    let batch = await this.hrBatch(tenantId, batchId);
    if (batch.status !== 'LOBBY_OPEN' && batch.status !== 'IN_PROGRESS') throw gdError(HttpStatus.CONFLICT, 'GD_NOT_LIVE', 'This group is not running.');
    const on = parsed.data.on;
    try {
      // also checks HR is in the room; and un-hides a connection made while HR used to join hidden
      await this.livekit.setHidden(batch.roomName, GD_IDENTITY.hr(actor.id), false);
    } catch (err) {
      this.logger.warn(`HR visibility not changed batch=${batchId} (${err instanceof Error ? err.name : 'unknown'})`);
      if (on) throw gdError(HttpStatus.CONFLICT, 'GD_HR_NOT_IN_ROOM', 'Your video connection to the room is not ready yet. Wait a moment and try again.');
    }
    if (on === batch.hrSpeaking) return this.hrView(batch, null);
    const now = this.now();
    const data: Prisma.GdBatchUpdateInput = { hrSpeaking: on };
    if (on) {
      const paused = pause(timelineOf(batch), now);
      if (paused) data.pausedAt = paused.pausedAt;
    } else {
      const resumed = resume(timelineOf(batch), now);
      if (resumed) {
        data.pausedAt = null;
        data.phaseEndsAt = resumed.timeline.phaseEndsAt;
        data.pausedIntervals = [...(batch.pausedIntervals as unknown[]), { phase: batch.phase, from: batch.pausedAt!.toISOString(), to: now.toISOString() }] as Prisma.InputJsonArray;
      }
    }
    batch = await this.db.gdBatch.update({ where: { id: batch.id }, data, include: { event: true } });
    await this.activity(batch, actor, on ? 'SPEAK_START' : 'SPEAK_END');
    if (data.pausedAt) await this.activity(batch, actor, 'TIMER_PAUSED');
    if (data.pausedAt === null) await this.activity(batch, actor, 'TIMER_RESUMED');
    await this.push(batch);
    return this.hrView(batch, null);
  }

  /** "Talk privately": the student and HR move to a temporary private room; the group carries on. */
  async startPrivateTalk(tenantId: string, batchId: string, body: unknown, actor: Actor): Promise<GdPrivateTalkStarted> {
    const parsed = gdStartPrivateTalkRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Pick a student.');
    const batch = await this.hrBatch(tenantId, batchId);
    if (batch.status !== 'LOBBY_OPEN' && batch.status !== 'IN_PROGRESS') throw gdError(HttpStatus.CONFLICT, 'GD_NOT_LIVE', 'This group is not running.');
    const participant = await this.db.gdParticipant.findFirst({ where: { id: parsed.data.participantId, batchId, tenantId } });
    if (!participant || !ATTENDED.includes(participant.attendance)) throw gdError(HttpStatus.CONFLICT, 'GD_NOT_IN_ROOM', 'This student is not in the room.');
    if (await this.db.gdPrivateTalk.findFirst({ where: { batchId, endedAt: null } })) {
      throw gdError(HttpStatus.CONFLICT, 'GD_PRIVATE_TALK_OPEN', 'Send the other student back first: one private talk at a time.');
    }
    const roomName = `${batch.roomName}-p-${randomBytes(6).toString('base64url')}`;
    await this.livekit.createRoom(roomName, JSON.stringify({ privateTalk: true }), 3);
    const talk = await this.db.gdPrivateTalk.create({
      data: { id: uuidv7(), tenantId, batchId, participantId: participant.id, hrUserId: actor.id, roomName, startedAt: this.now() },
    });
    await this.activity(batch, actor, 'PRIVATE_START', participant.id);
    await this.push(batch);
    return { talkId: talk.id, connection: await this.connection(roomName, GD_IDENTITY.hr(actor.id), `HR · ${actor.name}`, batch, false) };
  }

  /** "Send back": the student returns to the group's room. */
  async endPrivateTalk(tenantId: string, talkId: string, actor: Actor): Promise<GdHrLive> {
    const talk = await this.db.gdPrivateTalk.findFirst({ where: { id: talkId, tenantId } });
    if (!talk) throw gdError(HttpStatus.NOT_FOUND, 'GD_PRIVATE_TALK_NOT_FOUND', 'Private talk not found.');
    const batch = await this.hrBatch(tenantId, talk.batchId);
    if (!talk.endedAt) {
      await this.db.gdPrivateTalk.update({ where: { id: talk.id }, data: { endedAt: this.now() } });
      await this.activity(batch, actor, 'PRIVATE_END', talk.participantId);
      await this.push(batch);
    }
    return this.hrView(batch, null);
  }

  /** An ABSENT student may still come in (same link). */
  async admit(tenantId: string, batchId: string, participantId: string, actor: Actor): Promise<GdHrLive> {
    const batch = await this.hrBatch(tenantId, batchId);
    if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') throw gdError(HttpStatus.CONFLICT, 'GD_NOT_LIVE', 'This group has already ended.');
    const done = await this.db.gdParticipant.updateMany({
      where: { id: participantId, batchId, tenantId, attendance: 'ABSENT' },
      data: { attendance: 'ADMITTED_LATE', admittedLateAt: this.now(), admittedById: actor.id },
    });
    if (!done.count) throw gdError(HttpStatus.CONFLICT, 'GD_NOT_ABSENT', 'Only a student marked absent can be admitted.');
    await this.activity(batch, actor, 'ADMITTED_LATE', participantId);
    return this.hrView(batch, null);
  }

  /** Moves a student who missed (or has not started) their group to another group of the same round; a new link is emailed. */
  async reschedule(tenantId: string, participantId: string, body: unknown, actor: Actor): Promise<{ batchId: string }> {
    const parsed = gdRescheduleRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Pick a group.');
    const participant = await this.db.gdParticipant.findFirst({ where: { id: participantId, tenantId }, include: { batch: { include: { event: true } } } });
    if (!participant?.batch) throw gdError(HttpStatus.NOT_FOUND, 'GD_PARTICIPANT_NOT_FOUND', 'Student not found.');
    if (!['ABSENT', 'SCHEDULED', 'INVITED'].includes(participant.attendance)) {
      throw gdError(HttpStatus.CONFLICT, 'GD_CANNOT_MOVE', 'This student has already joined a group discussion.');
    }
    const target = await this.db.gdBatch.findFirst({ where: { id: parsed.data.batchId, tenantId, status: 'SCHEDULED', event: { roundId: participant.roundId, status: 'SCHEDULED' } }, include: { event: true } });
    if (!target || target.id === participant.batchId || target.startsAt <= this.now()) {
      throw gdError(HttpStatus.CONFLICT, 'GD_TARGET_NOT_AVAILABLE', 'Pick a group of this round that has not started yet.');
    }
    const from = participant.batch;
    await this.db.gdParticipant.update({
      where: { id: participant.id },
      // the old link stops working; the email worker sends an invitation with a new one
      data: { batchId: target.id, attendance: 'SCHEDULED', tokenHash: null, tokenSealed: null, tokenExpiresAt: null, admittedLateAt: null },
    });
    await this.activity(from, actor, 'RESCHEDULED', participant.id, { toBatchId: target.id });
    await this.audit.record({ tenantId, actorUserId: actor.id, action: 'gd.rescheduled', subjectType: 'application', subjectId: participant.applicationId, metadata: { from: from.id, to: target.id } });
    return { batchId: target.id };
  }

  /** HR's own microphone while speaking (labelled "HR asked:" for the evaluator; never scored). */
  async startHrRecording(tenantId: string, batchId: string, body: unknown, actor: Actor): Promise<GdRecordingStarted> {
    const batch = await this.hrBatch(tenantId, batchId);
    this.audioWindow(batch);
    return this.newRecording(tenantId, batch.id, { participantId: null, hrUserId: actor.id }, body);
  }

  async putHrChunk(tenantId: string, recordingId: string, seq: number, bytes: Buffer | undefined, actor: Actor): Promise<{ received: number }> {
    const rec = await this.db.gdRecording.findFirst({ where: { id: recordingId, tenantId, speaker: 'HR', hrUserId: actor.id } });
    if (!rec) throw gdError(HttpStatus.NOT_FOUND, 'GD_RECORDING_NOT_FOUND', 'Recording not found.');
    this.audioWindow(await this.hrBatch(tenantId, rec.batchId));
    return this.storeChunk(rec, seq, bytes);
  }

  // ================================================================ timeline loop (gd.worker.ts, about once a second)

  /**
   * Opens rooms at the start time, locks them after the joining window, moves the phases on. Returns batches touched.
   * `onlyTenantId` (tests on a shared database): leave other companies' groups alone.
   */
  async tickLive(opts: { onlyTenantId?: string } = {}): Promise<number> {
    const now = this.now();
    let touched = 0;
    const due = await this.db.gdBatch.findMany({
      where: {
        ...(opts.onlyTenantId ? { tenantId: opts.onlyTenantId } : {}),
        OR: [
          { status: 'SCHEDULED', startsAt: { lte: now }, event: { status: 'SCHEDULED' } },
          { status: { in: [...LIVE_STATUSES] } },
        ],
      },
      include: { event: true },
      take: 50,
    });
    for (const b of due) {
      try {
        let batch = b;
        if (batch.status === 'SCHEDULED') batch = await this.openLobby(batch);
        const lockAt = batch.startsAt.getTime() + batch.event.graceMinutes * 60_000;
        if (batch.status === 'LOBBY_OPEN' && now.getTime() >= lockAt) batch = await this.lock(batch, now);
        if (batch.status === 'IN_PROGRESS') batch = await this.advance(batch, now);
        if (batch !== b) touched++;
      } catch (err) {
        this.logger.warn(`GD live tick failed batch=${b.id} (${err instanceof Error ? err.name : 'unknown'})`);
      }
    }
    return touched;
  }

  private async openLobby(batch: Batch): Promise<Batch> {
    const size = await this.db.gdParticipant.count({ where: { batchId: batch.id } });
    const opened = await this.db.gdBatch.updateMany({ where: { id: batch.id, status: 'SCHEDULED' }, data: { status: 'LOBBY_OPEN', lobbyOpenedAt: this.now() } });
    const fresh = await this.db.gdBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { event: true } });
    if (opened.count) {
      // students + moderator + HR + a few reconnects
      await this.livekit.createRoom(fresh.roomName, JSON.stringify(await this.liveState(fresh)), size + 6).catch((err: unknown) => {
        this.logger.warn(`LiveKit room not created batch=${batch.id} (${err instanceof Error ? err.name : 'unknown'})`);
      });
    }
    return fresh;
  }

  /** Joining window over: the room locks, students who did not come are ABSENT (kept), the moderator starts. */
  private async lock(batch: Batch, now: Date): Promise<Batch> {
    await this.db.gdParticipant.updateMany({ where: { batchId: batch.id, attendance: { in: ['SCHEDULED', 'INVITED'] } }, data: { attendance: 'ABSENT' } });
    const present = await this.db.gdParticipant.findMany({ where: { batchId: batch.id, attendance: { in: ATTENDED } }, orderBy: { joinedAt: 'asc' } });
    const settings = settingsOf(batch.event);
    if (!present.length) {
      const ended = await this.db.gdBatch.update({
        where: { id: batch.id },
        data: { status: 'COMPLETED', lockedAt: now, endedAt: now, phase: 'ENDED', phaseLog: [{ phase: 'ENDED', at: now.toISOString() }] },
        include: { event: true },
      });
      await this.push(ended);
      await this.finishEventIfDone(batch.eventId);
      return ended;
    }
    const t = start(planOf(settings, present.length), now);
    const locked = await this.db.gdBatch.update({
      where: { id: batch.id },
      data: {
        status: 'IN_PROGRESS',
        lockedAt: now,
        phase: t.phase,
        phaseStartedAt: t.phaseStartedAt,
        phaseEndsAt: t.phaseEndsAt,
        summaryOrder: present.map((p) => p.id),
        summaryIndex: 0,
        phaseLog: [{ phase: t.phase, at: now.toISOString() }],
      },
      include: { event: true },
    });
    const state = await this.liveState(locked);
    await this.push(locked, state);
    try {
      await this.livekit.dispatchModerator(locked.roomName, JSON.stringify({ batchId: locked.id }));
      await this.db.gdBatch.update({ where: { id: locked.id }, data: { agentDispatchedAt: now } });
    } catch (err) {
      // the timeline, timer and banner still run; only the spoken announcements are missing
      this.logger.warn(`moderator bot not dispatched batch=${locked.id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
    await this.audit.record({ tenantId: locked.tenantId, actorUserId: null, action: 'gd.started', subjectType: 'gd_batch', subjectId: locked.id, metadata: { students: present.length } });
    return locked;
  }

  private async advance(batch: Batch, now: Date): Promise<Batch> {
    const settings = settingsOf(batch.event);
    const next = step(timelineOf(batch), planOf(settings, batch.summaryOrder.length), settings.summarySeconds, now);
    if (!next) return batch;
    const ended = next.phase === 'ENDED';
    const log = batch.phaseLog as { phase: GdPhase; at: string }[];
    const updated = await this.db.gdBatch.update({
      where: { id: batch.id },
      data: {
        phase: next.phase,
        phaseStartedAt: next.phaseStartedAt,
        phaseEndsAt: next.phaseEndsAt,
        summaryIndex: next.summaryIndex,
        ...(next.phase !== batch.phase ? { phaseLog: [...log, { phase: next.phase, at: next.phaseStartedAt!.toISOString() }] } : {}),
        ...(ended ? { status: 'COMPLETED', endedAt: next.phaseStartedAt, hrSpeaking: false, processingStatus: 'PENDING', processingNextAt: now } : {}),
      },
      include: { event: true },
    });
    if (ended) {
      await this.db.gdPrivateTalk.updateMany({ where: { batchId: batch.id, endedAt: null }, data: { endedAt: now } });
      await this.audit.record({ tenantId: batch.tenantId, actorUserId: null, action: 'gd.ended', subjectType: 'gd_batch', subjectId: batch.id, metadata: {} });
      await this.finishEventIfDone(batch.eventId);
    }
    await this.push(updated);
    return updated;
  }

  private async finishEventIfDone(eventId: string) {
    const open = await this.db.gdBatch.count({ where: { eventId, status: { notIn: ['COMPLETED', 'CANCELLED'] } } });
    if (!open) await this.db.gdEvent.updateMany({ where: { id: eventId, status: 'SCHEDULED' }, data: { status: 'COMPLETED' } });
  }

  // ================================================================ shared

  /** What every screen shows (also pushed as the LiveKit room metadata). */
  async liveState(batch: Batch): Promise<GdLiveState> {
    const settings = settingsOf(batch.event);
    const order = batch.summaryOrder.length
      ? await this.db.gdParticipant.findMany({ where: { id: { in: batch.summaryOrder } }, include: { application: { select: { candidate: { select: { name: true } } } } } })
      : [];
    const byId = new Map(order.map((p) => [p.id, firstName(p.application.candidate.name)]));
    const summaryOrder = batch.summaryOrder.filter((id) => byId.has(id)).map((id) => ({ identity: GD_IDENTITY.student(id), name: byId.get(id)! }));
    const talks = await this.db.gdPrivateTalk.findMany({ where: { batchId: batch.id, endedAt: null }, select: { participantId: true } });
    const showTopic = !['NOT_STARTED', 'INTRO'].includes(batch.phase);
    return {
      v: 1,
      batchStatus: batch.status,
      phase: batch.phase,
      phaseStartedAt: batch.phaseStartedAt?.toISOString() ?? null,
      phaseEndsAt: batch.phaseEndsAt?.toISOString() ?? null,
      pausedAt: batch.pausedAt?.toISOString() ?? null,
      serverNow: this.now().toISOString(),
      topic: showTopic ? batch.topicText : null,
      currentSpeaker: batch.phase === 'SUMMARY' ? (summaryOrder[batch.summaryIndex] ?? null) : null,
      summaryOrder,
      hrSpeaking: batch.hrSpeaking,
      withHr: talks.map((t) => GD_IDENTITY.student(t.participantId)),
      plan: planOf(settings, Math.max(summaryOrder.length, batch.phase === 'NOT_STARTED' ? await this.db.gdParticipant.count({ where: { batchId: batch.id } }) : 0)),
      silencePromptSeconds: settings.silencePromptSeconds,
    };
  }

  /** Sends the live state to everyone in the room. A LiveKit hiccup is logged; the clients' polling catches up. */
  private async push(batch: Batch, state?: GdLiveState) {
    try {
      await this.livekit.setRoomMetadata(batch.roomName, JSON.stringify(state ?? (await this.liveState(batch))));
    } catch (err) {
      this.logger.warn(`live state not pushed batch=${batch.id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  private async connection(room: string, identity: string, name: string, batch: Batch, hidden: boolean) {
    if (!this.livekit.url) throw gdError(HttpStatus.SERVICE_UNAVAILABLE, 'GD_VIDEO_NOT_SET_UP', 'The video service is not set up on the server yet.');
    const ttl = Math.max(15 * 60, Math.round((batch.endsAt.getTime() - this.now().getTime()) / 1000) + TOKEN_SLACK_S);
    return { url: this.livekit.url, identity, token: await this.livekit.token({ room, identity, name, hidden, ttlSeconds: ttl }) };
  }

  private publicStatus(p: Participant, b: Batch): GdPublicStatus {
    if (b.status === 'CANCELLED' || b.event.status === 'CANCELLED') return 'CANCELLED';
    if (b.status === 'COMPLETED') return 'ENDED';
    const attended = ATTENDED.includes(p.attendance);
    if (p.attendance === 'ABSENT') return 'MISSED';
    if (b.status === 'IN_PROGRESS') return attended ? 'IN_PROGRESS' : 'MISSED';
    const now = this.now().getTime();
    if (now < b.startsAt.getTime()) return 'UPCOMING';
    if (now >= b.startsAt.getTime() + b.event.graceMinutes * 60_000 && !attended) return 'MISSED';
    return 'OPEN';
  }

  /** Token -> participant -> their CURRENT group. Every public call goes through here. */
  private async open(token: string | undefined): Promise<{ participant: Participant; batch: Batch }> {
    if (!token || !GD_TOKEN_SHAPE.test(token)) throw invalidLink();
    const participant = await this.db.gdParticipant.findUnique({ where: { tokenHash: hashGdToken(token) } });
    if (!participant?.batchId) throw invalidLink();
    if (participant.tokenExpiresAt && participant.tokenExpiresAt <= this.now()) {
      throw gdError(HttpStatus.GONE, 'GD_LINK_EXPIRED', 'This group discussion link has expired.');
    }
    const batch = await this.db.gdBatch.findUnique({ where: { id: participant.batchId }, include: { event: true } });
    if (!batch) throw invalidLink();
    return { participant, batch };
  }

  private async hrBatch(tenantId: string, batchId: string): Promise<Batch> {
    const batch = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, include: { event: true } });
    if (!batch) throw batchNotFound();
    return batch;
  }

  private async context(p: Participant) {
    const app = await this.db.application.findFirst({
      where: { id: p.applicationId, tenantId: p.tenantId },
      select: { candidate: { select: { name: true } } },
    });
    const [job, profile, tenant, round] = await Promise.all([
      this.db.job.findFirst({ where: { id: p.jobId, tenantId: p.tenantId }, select: { title: true } }),
      this.db.companyProfile.findUnique({ where: { tenantId: p.tenantId }, select: { name: true } }),
      this.db.tenant.findUnique({ where: { id: p.tenantId }, select: { name: true } }),
      this.db.jobRound.findFirst({ where: { id: p.roundId, tenantId: p.tenantId }, select: { name: true } }),
    ]);
    return {
      candidateName: app?.candidate.name ?? 'Student',
      jobTitle: job?.title ?? '',
      companyName: profile?.name || tenant?.name || 'our company',
      roundName: round?.name ?? 'Group Discussion',
    };
  }

  private audioWindow(batch: Batch) {
    if (batch.status === 'CANCELLED') throw gdError(HttpStatus.GONE, 'GD_CANCELLED', 'This group discussion was cancelled.');
    if (batch.endedAt && this.now().getTime() > batch.endedAt.getTime() + LATE_AUDIO_MS) {
      throw gdError(HttpStatus.GONE, 'GD_ENDED', 'This group discussion has ended.');
    }
  }

  private async newRecording(tenantId: string, batchId: string, who: { participantId: string | null; hrUserId: string | null }, body: unknown): Promise<GdRecordingStarted> {
    const parsed = gdStartRecordingRequestSchema.safeParse(body);
    const mime = parsed.success ? parsed.data.mimeType.toLowerCase().replace(/\s+/g, '') : '';
    if (!(GD_AUDIO_LIMITS.mimeTypes as readonly string[]).includes(mime)) {
      throw gdError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'GD_AUDIO_TYPE', 'This browser records audio in a format we cannot use. Please use Chrome, Edge, Firefox or Safari.');
    }
    const id = uuidv7();
    const startedAt = this.now();
    await this.db.gdRecording.create({
      data: {
        id,
        tenantId,
        batchId,
        participantId: who.participantId,
        hrUserId: who.hrUserId,
        speaker: who.participantId ? 'STUDENT' : 'HR',
        mimeType: mime,
        startedAt,
        storagePrefix: this.storage.prefixFor(tenantId, batchId, id),
      },
    });
    return { recordingId: id, startedAt: startedAt.toISOString() };
  }

  private async storeChunk(rec: Prisma.GdRecordingGetPayload<object>, seq: number, bytes: Buffer | undefined): Promise<{ received: number }> {
    if (!Number.isInteger(seq) || seq < 1 || seq > GD_AUDIO_LIMITS.chunksPerRecording) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid chunk number.');
    if (!bytes?.length || bytes.length > GD_AUDIO_LIMITS.chunkMaxBytes) throw gdError(HttpStatus.BAD_REQUEST, 'GD_AUDIO_SIZE', 'Invalid audio chunk.');
    if (rec.deletedAt) throw gdError(HttpStatus.GONE, 'GD_ENDED', 'This recording is closed.');
    // the same chunk twice (a retry) overwrites itself: the upload is idempotent
    await this.storage.putChunk(rec.storagePrefix, seq, bytes);
    await this.db.$executeRaw`
      UPDATE gd_recordings
         SET chunk_count = GREATEST(chunk_count, ${seq}), bytes = bytes + ${bytes.length}, last_chunk_at = ${this.now()}
       WHERE id = ${rec.id}::uuid`;
    return { received: seq };
  }

  private async activity(batch: Batch, actor: Actor | null, kind: GdHrActivityKind, participantId: string | null = null, detail: Record<string, unknown> = {}) {
    await this.db.gdHrActivity.create({
      data: {
        id: uuidv7(),
        tenantId: batch.tenantId,
        batchId: batch.id,
        hrUserId: actor?.id ?? null,
        hrName: actor?.name ?? null,
        kind,
        participantId,
        occurredAt: this.now(),
        detail: detail as Prisma.InputJsonObject,
      },
    });
  }

  private async hrView(batch: Batch, connection: GdHrLive['connection']): Promise<GdHrLive> {
    const [people, events, talks, acts, round, job, others] = await Promise.all([
      this.db.gdParticipant.findMany({
        where: { batchId: batch.id },
        orderBy: { createdAt: 'asc' },
        include: { application: { select: { email: true, college: true, candidate: { select: { name: true, email: true } } } } },
      }),
      this.db.gdParticipantEvent.findMany({ where: { batchId: batch.id }, orderBy: { occurredAt: 'asc' } }),
      this.db.gdPrivateTalk.findMany({ where: { batchId: batch.id }, orderBy: { startedAt: 'asc' } }),
      this.db.gdHrActivity.findMany({ where: { batchId: batch.id }, orderBy: { occurredAt: 'desc' }, take: 100 }),
      this.db.jobRound.findFirst({ where: { id: batch.event.roundId }, select: { name: true } }),
      this.db.job.findFirst({ where: { id: batch.event.jobId }, select: { title: true } }),
      this.db.gdBatch.findMany({
        where: { tenantId: batch.tenantId, status: 'SCHEDULED', startsAt: { gt: this.now() }, id: { not: batch.id }, event: { roundId: batch.event.roundId, status: 'SCHEDULED' } },
        include: { event: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
        take: 20,
      }),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, p.application.candidate.name]));
    const settings = settingsOf(batch.event);
    return {
      batchId: batch.id,
      number: batch.number,
      eventName: batch.event.name,
      roundName: round?.name ?? 'Group Discussion',
      jobTitle: job?.title ?? '',
      roundId: batch.event.roundId,
      startsAt: batch.startsAt.toISOString(),
      joinClosesAt: new Date(batch.startsAt.getTime() + settings.graceMinutes * 60_000).toISOString(),
      settings,
      connection,
      state: await this.liveState(batch),
      participants: people.map((p) => {
        const own = events.filter((e) => e.participantId === p.id);
        const last = own.at(-1);
        return {
          id: p.id,
          identity: GD_IDENTITY.student(p.id),
          name: p.application.candidate.name,
          email: p.application.email ?? p.application.candidate.email,
          college: p.application.college || null,
          attendance: p.attendance,
          joinedAt: p.joinedAt?.toISOString() ?? null,
          cameraOffCount: own.filter((e) => e.type === 'CAMERA_OFF').length,
          lastEvent: last ? { type: last.type, at: last.occurredAt.toISOString() } : null,
        };
      }),
      privateTalks: talks.map((t) => ({
        id: t.id,
        participantId: t.participantId,
        studentName: nameOf.get(t.participantId) ?? 'Student',
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
        includeInEvaluation: t.includeInEvaluation,
      })),
      activity: acts.map((a) => ({ kind: a.kind, hrName: a.hrName, participantName: a.participantId ? (nameOf.get(a.participantId) ?? null) : null, at: a.occurredAt.toISOString() })),
      rescheduleTargets: others.map((o) => ({ batchId: o.id, eventName: o.event.name, number: o.number, startsAt: o.startsAt.toISOString() })),
    };
  }
}

/** Minutes a group is expected to take (for the emails). */
export const durationMinutes = (settings: GdSettings, size: number) => gdSlotMinutes(settings, size) - settings.graceMinutes;
