import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  gdDecisionRequestSchema,
  gdIncludePrivateTalkRequestSchema,
  gdMetricsSchema,
  type GdAttendance,
  type GdPhase,
  type GdRecommendation,
  type GdResults,
} from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { uuidv7 } from '../../common/uuidv7';
import { AssessmentsService } from '../assessments';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { GdMailService } from './gd-mail.service';
import { GdWorkerClient, GdWorkerError, type MixTrack } from './gd-worker.client';
import { GD_CLOCK, gdError } from './gd.service';
import { applyPrivateTalks, computeMetrics, fullTranscript, phaseWindows, studentTranscript, type TranscriptLine } from './metrics';
import { sessionAudioOf } from './gd.store';
import { GdAudioStorage } from './storage';

export const GD_RESULTS_CONFIG = Symbol('GD_RESULTS_CONFIG');

export interface GdResultsConfig {
  /** Recordings and transcripts are deleted this many days after the GD (GD_RETENTION_DAYS, default 90). */
  retentionDays: number;
}

export const gdResultsConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): GdResultsConfig => {
  const n = Number(env.GD_RETENTION_DAYS);
  return { retentionDays: Number.isInteger(n) && n >= 1 && n <= 3650 ? n : 90 };
};

const ATTENDED: GdAttendance[] = ['JOINED', 'ADMITTED_LATE'];
const MAX_PROCESSING_ATTEMPTS = 5;
const RETRY_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
const STALE_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const batchNotFound = () => gdError(HttpStatus.NOT_FOUND, 'GD_BATCH_NOT_FOUND', 'Group not found.');

/**
 * After the GD (phases 5-7): Whisper per recording, one timeline with HR's lines labelled, speaking metrics, the LLM
 * rubric per student (strict JSON), the HR results screen (overrides, private talks in or out), "Confirm selection"
 * (results recorded in the assessments module, result emails queued), and the retention clean-up.
 */
@Injectable()
export class GdResultsService {
  private readonly logger = new Logger('GdResults');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(GdWorkerClient) private readonly worker: GdWorkerClient,
    @Inject(GdAudioStorage) private readonly storage: GdAudioStorage,
    @Inject(GdMailService) private readonly mail: GdMailService,
    @Inject(AssessmentsService) private readonly assessments: AssessmentsService,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GD_RESULTS_CONFIG) private readonly config: GdResultsConfig,
    @Inject(GD_CLOCK) private readonly now: () => Date,
  ) {}

  // ================================================================ processing (worker loop)

  /** Processes one finished group whose turn it is. Returns true when one was processed (or failed). */
  async processNext(): Promise<boolean> {
    const now = this.now();
    const claimed = await this.db.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE gd_batches
         SET processing_status = 'RUNNING'::gd_processing_status, processing_locked_at = ${now},
             processing_attempts = processing_attempts + 1, updated_at = ${now}
       WHERE id = (
         SELECT id FROM gd_batches
          WHERE (processing_status = 'PENDING'::gd_processing_status AND (processing_next_at IS NULL OR processing_next_at <= ${now}))
             OR (processing_status = 'RUNNING'::gd_processing_status AND processing_locked_at < ${new Date(now.getTime() - STALE_MS)})
          ORDER BY ended_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`);
    const id = claimed[0]?.id;
    if (!id) return false;
    try {
      await this.process(id);
      await this.db.gdBatch.update({ where: { id }, data: { processingStatus: 'DONE', processedAt: this.now(), processingLockedAt: null, processingError: null } });
      const b = await this.db.gdBatch.findUniqueOrThrow({ where: { id } });
      await this.audit.record({ tenantId: b.tenantId, actorUserId: null, action: 'gd.evaluated', subjectType: 'gd_batch', subjectId: id, metadata: {} });
      // after the results are visible: the recording is a convenience and never holds them up
      await this.buildSessionAudio(id);
    } catch (err) {
      const b = await this.db.gdBatch.findUniqueOrThrow({ where: { id } });
      const retry = (!(err instanceof GdWorkerError) || err.retryable) && b.processingAttempts < MAX_PROCESSING_ATTEMPTS;
      const message = err instanceof Error ? err.message.slice(0, 500) : 'Processing failed.';
      await this.db.gdBatch.update({
        where: { id },
        data: retry
          ? { processingStatus: 'PENDING', processingLockedAt: null, processingError: message, processingNextAt: new Date(this.now().getTime() + RETRY_MS[Math.min(b.processingAttempts - 1, RETRY_MS.length - 1)]!) }
          : { processingStatus: 'FAILED', processingLockedAt: null, processingError: message },
      });
      this.logger.warn(`GD processing ${retry ? 'will retry' : 'failed'} batch=${id} (${message})`);
    }
    return true;
  }

  /** Transcribe what is missing, then evaluate every student who was in the room. Safe to run again. */
  async process(batchId: string): Promise<void> {
    const batch = await this.db.gdBatch.findUniqueOrThrow({ where: { id: batchId }, include: { event: true } });
    if (!batch.lockedAt) return;
    const recordings = await this.db.gdRecording.findMany({ where: { batchId, deletedAt: null, chunkCount: { gt: 0 } }, include: { transcript: true } });
    for (const rec of recordings) {
      if (rec.transcript) continue;
      const paths = await this.storage.chunkPaths(rec.storagePrefix);
      const { language, segments } = paths.length ? await this.worker.transcribe(paths, rec.mimeType) : { language: null, segments: [] };
      const offset = rec.startedAt.getTime() - batch.lockedAt.getTime();
      await this.db.gdTranscript.create({
        data: {
          id: uuidv7(),
          tenantId: batch.tenantId,
          batchId,
          recordingId: rec.id,
          participantId: rec.participantId,
          speaker: rec.speaker,
          language,
          segments: segments.map((s) => ({ start: Math.round(offset + s.start * 1000), end: Math.round(offset + s.end * 1000), text: s.text })) as Prisma.InputJsonArray,
        },
      });
    }

    const people = await this.db.gdParticipant.findMany({
      where: { batchId, attendance: { in: ATTENDED } },
      include: { application: { select: { candidate: { select: { name: true } } } } },
    });
    const names = new Map(people.map((p) => [p.id, p.application.candidate.name]));
    const transcripts = await this.db.gdTranscript.findMany({ where: { batchId } });
    // before the room locked (lobby chatter) does not count
    const raw: TranscriptLine[] = transcripts.flatMap((t) =>
      (t.segments as { start: number; end: number; text: string }[])
        .filter((s) => s.start >= 0 && (t.participantId === null || names.has(t.participantId)))
        .map((s) => ({ participantId: t.participantId, name: t.participantId ? names.get(t.participantId)! : 'HR', startMs: s.start, endMs: Math.max(s.end, s.start), text: s.text, private: false })),
    );
    const talks = await this.db.gdPrivateTalk.findMany({ where: { batchId } });
    const ref = batch.lockedAt.getTime();
    const endMs = (batch.endedAt ?? this.now()).getTime() - ref;
    const lines = applyPrivateTalks(
      raw,
      talks.map((t) => ({ participantId: t.participantId, fromMs: t.startedAt.getTime() - ref, toMs: (t.endedAt ?? batch.endedAt ?? this.now()).getTime() - ref, include: t.includeInEvaluation })),
    );
    const windows = phaseWindows(batch.phaseLog as { phase: GdPhase; at: string }[], batch.lockedAt, endMs);
    const metrics = computeMetrics(lines, windows, people.map((p) => p.id), { order: batch.summaryOrder, slotMs: batch.event.summarySeconds * 1000 });
    const full = fullTranscript(lines, windows);

    for (const p of people) {
      const m = metrics.get(p.id)!;
      const own = studentTranscript(lines, p.id);
      const base = { tenantId: batch.tenantId, batchId, participantId: p.id, metrics: m as unknown as Prisma.InputJsonObject };
      if (!own.trim()) {
        await this.saveEvaluation(base, { status: 'NO_AUDIO', scores: Prisma.DbNull, overall: null, recommendation: 'NOT_SELECTED', evidence: [], feedback: 'Nothing this student said was recorded, so the discussion could not be evaluated.', model: null, error: null });
        continue;
      }
      try {
        const { result, model } = await this.worker.evaluate({
          studentId: p.id,
          studentName: names.get(p.id)!,
          topic: batch.topicText ?? '',
          studentTranscript: own,
          fullTranscript: full,
          metrics: m,
          askedByHr: m.answeredHr,
        });
        if (result.student_id !== p.id) throw new GdWorkerError('The evaluator answered for another student.', true);
        const scores = { ...result.scores, hr_response: m.answeredHr ? result.scores.hr_response : null };
        await this.saveEvaluation(base, {
          status: 'OK',
          scores: scores as Prisma.InputJsonObject,
          overall: result.overall,
          recommendation: result.recommendation === 'selected' ? 'SELECTED' : 'NOT_SELECTED',
          evidence: result.evidence as unknown as Prisma.InputJsonArray,
          feedback: result.feedback,
          model,
          error: null,
        });
      } catch (err) {
        // the worker itself is down: the whole group is retried later
        if (err instanceof GdWorkerError && err.message.includes('not reachable')) throw err;
        await this.saveEvaluation(base, {
          status: 'FAILED',
          scores: Prisma.DbNull,
          overall: null,
          recommendation: null,
          evidence: [],
          feedback: '',
          model: null,
          error: err instanceof Error ? err.message.slice(0, 500) : 'Evaluation failed.',
        });
      }
    }
  }

  /**
   * The whole session as one audio file for HR: every recording (students and HR) mixed on the room's timeline, with a
   * student's private talks with HR muted (they are not the group's discussion). Never throws: a failure is kept on
   * the group and HR can build it again from the results page. Returns true when the file was built.
   */
  async buildSessionAudio(batchId: string): Promise<boolean> {
    const batch = await this.db.gdBatch.findUniqueOrThrow({ where: { id: batchId } });
    if (!batch.lockedAt) return false;
    const ref = batch.lockedAt.getTime();
    try {
      const [recordings, talks] = await Promise.all([
        this.db.gdRecording.findMany({ where: { batchId, deletedAt: null, chunkCount: { gt: 0 } }, orderBy: { startedAt: 'asc' } }),
        this.db.gdPrivateTalk.findMany({ where: { batchId } }),
      ]);
      const tracks: MixTrack[] = [];
      for (const r of recordings) {
        const chunkPaths = await this.storage.chunkPaths(r.storagePrefix);
        if (!chunkPaths.length) continue;
        const mute = talks
          .filter((t) => r.participantId && t.participantId === r.participantId)
          .map((t): [number, number] => [t.startedAt.getTime() - ref, (t.endedAt ?? batch.endedAt ?? this.now()).getTime() - ref]);
        tracks.push({ chunkPaths, mimeType: r.mimeType, offsetMs: r.startedAt.getTime() - ref, mute });
      }
      if (!tracks.length) throw new GdWorkerError('Nothing was recorded in this group.', false);
      const { durationMs, bytes } = await this.worker.mix(tracks, this.storage.sessionAudioPath(batch.tenantId, batchId));
      await this.db.gdBatch.update({
        where: { id: batchId },
        data: { sessionAudioAt: this.now(), sessionAudioMs: durationMs, sessionAudioBytes: bytes, sessionAudioError: null },
      });
      return true;
    } catch (err) {
      const message = err instanceof GdWorkerError ? err.message.slice(0, 300) : 'The session recording could not be built.';
      this.logger.warn(`GD session audio not built batch=${batchId} (${err instanceof Error ? err.message : 'unknown'})`);
      await this.db.gdBatch.update({ where: { id: batchId }, data: { sessionAudioError: message } }).catch(() => undefined);
      return false;
    }
  }

  /** HR "Build the recording again" on the results page. */
  async rebuildSessionAudio(tenantId: string, batchId: string): Promise<GdResults> {
    const batch = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, select: { lockedAt: true } });
    if (!batch) throw batchNotFound();
    if (!batch.lockedAt) throw gdError(HttpStatus.CONFLICT, 'GD_NOT_STARTED', 'This group has not started, so there is nothing to record yet.');
    await this.buildSessionAudio(batchId);
    return this.results(tenantId, batchId);
  }

  /** Absolute path of a group's session audio for streaming to HR; 404 for another company or when not built. */
  async sessionAudioFile(tenantId: string, batchId: string): Promise<string> {
    const batch = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, select: { sessionAudioAt: true } });
    if (!batch?.sessionAudioAt) throw gdError(HttpStatus.NOT_FOUND, 'GD_SESSION_AUDIO_NOT_FOUND', 'This group has no session recording.');
    return this.storage.sessionAudioPath(tenantId, batchId);
  }

  private async saveEvaluation(
    base: { tenantId: string; batchId: string; participantId: string; metrics: Prisma.InputJsonObject },
    v: { status: 'OK' | 'NO_AUDIO' | 'FAILED'; scores: Prisma.InputJsonObject | typeof Prisma.DbNull; overall: number | null; recommendation: GdRecommendation | null; evidence: Prisma.InputJsonArray | never[]; feedback: string; model: string | null; error: string | null },
  ) {
    const data = { status: v.status, metrics: base.metrics, scores: v.scores, overall: v.overall, recommendation: v.recommendation, evidence: v.evidence, feedback: v.feedback, model: v.model, error: v.error };
    // a new evaluation keeps HR's decision (HR decided on purpose)
    await this.db.gdEvaluation.upsert({ where: { participantId: base.participantId }, create: { id: uuidv7(), tenantId: base.tenantId, batchId: base.batchId, participantId: base.participantId, ...data }, update: data });
  }

  // ================================================================ HR results screen

  async results(tenantId: string, batchId: string): Promise<GdResults> {
    const batch = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, include: { event: true } });
    if (!batch) throw batchNotFound();
    const [people, evals, emails, talks, acts, round, job] = await Promise.all([
      this.db.gdParticipant.findMany({ where: { batchId }, include: { application: { select: { email: true, candidate: { select: { name: true, email: true } } } } } }),
      this.db.gdEvaluation.findMany({ where: { batchId } }),
      this.db.gdEmail.findMany({ where: { batchId, kind: { in: ['SELECTED', 'NOT_SELECTED'] } } }),
      this.db.gdPrivateTalk.findMany({ where: { batchId }, orderBy: { startedAt: 'asc' } }),
      this.db.gdHrActivity.findMany({ where: { batchId }, orderBy: { occurredAt: 'desc' }, take: 200 }),
      this.db.jobRound.findFirst({ where: { id: batch.event.roundId }, select: { name: true } }),
      this.db.job.findFirst({ where: { id: batch.event.jobId }, select: { title: true } }),
    ]);
    const nameOf = new Map(people.map((p) => [p.id, p.application.candidate.name]));
    const students = people.map((p) => {
      const e = evals.find((x) => x.participantId === p.id);
      const email = emails.find((x) => x.participantId === p.id);
      const metrics = e ? gdMetricsSchema.safeParse(e.metrics) : null;
      return {
        participantId: p.id,
        applicationId: p.applicationId,
        name: p.application.candidate.name,
        email: p.application.email ?? p.application.candidate.email,
        attendance: p.attendance,
        evaluation: e
          ? {
              status: e.status,
              scores: (e.scores ?? null) as Scores | null,
              overall: e.overall,
              recommendation: e.recommendation,
              evidence: e.evidence as { criterion: string; quote: string; reason: string }[],
              feedback: e.feedback,
              metrics: metrics?.success ? metrics.data : null,
              error: e.error,
            }
          : null,
        hrDecision: e?.hrDecision ? { decision: e.hrDecision, reason: e.hrDecisionReason ?? '', by: e.hrDecidedByName, at: (e.hrDecidedAt ?? e.updatedAt).toISOString() } : null,
        finalDecision: finalDecisionOf(p.attendance, e ?? null),
        resultEmail: email ? { status: email.status, sentAt: email.sentAt?.toISOString() ?? null } : null,
      };
    });
    // best first; students without a score at the end, absent ones last
    students.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    return {
      batchId,
      number: batch.number,
      eventName: batch.event.name,
      roundName: round?.name ?? 'Group Discussion',
      jobTitle: job?.title ?? '',
      roundId: batch.event.roundId,
      topic: batch.topicText,
      startsAt: batch.startsAt.toISOString(),
      batchStatus: batch.status,
      processing: { status: batch.processingStatus, error: batch.processingError, processedAt: batch.processedAt?.toISOString() ?? null },
      confirmedAt: batch.confirmedAt?.toISOString() ?? null,
      sessionAudio: sessionAudioOf(batch),
      sessionAudioError: batch.sessionAudioAt ? null : batch.sessionAudioError,
      students,
      privateTalks: talks.map((t) => ({
        id: t.id,
        participantId: t.participantId,
        studentName: nameOf.get(t.participantId) ?? 'Student',
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
        includeInEvaluation: t.includeInEvaluation,
      })),
      activity: acts.map((a) => ({ kind: a.kind, hrName: a.hrName, participantName: a.participantId ? (nameOf.get(a.participantId) ?? null) : null, at: a.occurredAt.toISOString() })),
    };
  }

  /** HR overrides the AI's recommendation (null = back to the AI). Logged with HR's name and the time. */
  async decide(tenantId: string, batchId: string, participantId: string, body: unknown, actor: Actor): Promise<GdResults> {
    const parsed = gdDecisionRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The request is invalid.');
    const batch = await this.editable(tenantId, batchId);
    const p = await this.db.gdParticipant.findFirst({ where: { id: participantId, batchId: batch.id } });
    if (!p) throw gdError(HttpStatus.NOT_FOUND, 'GD_PARTICIPANT_NOT_FOUND', 'Student not found.');
    if (!ATTENDED.includes(p.attendance)) throw gdError(HttpStatus.CONFLICT, 'GD_ABSENT', 'This student did not take part, so they cannot be selected.');
    const { decision, reason } = parsed.data;
    const now = this.now();
    const fields = decision
      ? { hrDecision: decision, hrDecisionReason: reason || null, hrDecidedById: actor.id, hrDecidedByName: actor.name, hrDecidedAt: now }
      : { hrDecision: null, hrDecisionReason: null, hrDecidedById: actor.id, hrDecidedByName: actor.name, hrDecidedAt: now };
    await this.db.gdEvaluation.upsert({
      where: { participantId },
      create: { id: uuidv7(), tenantId, batchId, participantId, status: 'FAILED', error: 'Not evaluated yet.', ...fields },
      update: fields,
    });
    await this.activityLog(batch.tenantId, batchId, actor, 'OVERRIDE', participantId, { decision, reason });
    await this.audit.record({ tenantId, actorUserId: actor.id, action: 'gd.decision_overridden', subjectType: 'application', subjectId: p.applicationId, metadata: { batchId, decision, reason } });
    return this.results(tenantId, batchId);
  }

  /** "Include in evaluation" for one private talk. The group is evaluated again (HR's overrides are kept). */
  async includePrivateTalk(tenantId: string, talkId: string, body: unknown, actor: Actor): Promise<GdResults> {
    const parsed = gdIncludePrivateTalkRequestSchema.safeParse(body);
    if (!parsed.success) throw gdError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The request is invalid.');
    const talk = await this.db.gdPrivateTalk.findFirst({ where: { id: talkId, tenantId } });
    if (!talk) throw gdError(HttpStatus.NOT_FOUND, 'GD_PRIVATE_TALK_NOT_FOUND', 'Private talk not found.');
    const batch = await this.editable(tenantId, talk.batchId);
    if (talk.includeInEvaluation !== parsed.data.include) {
      await this.db.gdPrivateTalk.update({ where: { id: talk.id }, data: { includeInEvaluation: parsed.data.include } });
      await this.activityLog(tenantId, batch.id, actor, parsed.data.include ? 'PRIVATE_INCLUDED' : 'PRIVATE_EXCLUDED', talk.participantId);
      if (batch.status === 'COMPLETED' && batch.lockedAt) {
        await this.db.gdBatch.update({ where: { id: batch.id }, data: { processingStatus: 'PENDING', processingNextAt: this.now(), processingAttempts: 0, processingError: null } });
      }
    }
    return this.results(tenantId, batch.id);
  }

  /** Runs a failed evaluation again. */
  async reprocess(tenantId: string, batchId: string): Promise<GdResults> {
    const batch = await this.editable(tenantId, batchId);
    if (batch.status !== 'COMPLETED' || !batch.lockedAt) throw gdError(HttpStatus.CONFLICT, 'GD_NOT_ENDED', 'This group has not finished yet.');
    if (batch.processingStatus === 'RUNNING') throw gdError(HttpStatus.CONFLICT, 'GD_PROCESSING', 'The evaluation is running right now.');
    await this.db.gdBatch.update({ where: { id: batchId }, data: { processingStatus: 'PENDING', processingNextAt: this.now(), processingAttempts: 0, processingError: null } });
    return this.results(tenantId, batchId);
  }

  /**
   * "Confirm selection": every student's final decision is recorded as their result of the GD round (assessments
   * module; the AI's overall score as the interviewer score, HR's decision as an override where it differs) and the
   * result emails are queued. Once only.
   */
  async confirm(tenantId: string, batchId: string, actor: Actor): Promise<GdResults> {
    const batch = await this.editable(tenantId, batchId);
    if (batch.status !== 'COMPLETED') throw gdError(HttpStatus.CONFLICT, 'GD_NOT_ENDED', 'This group has not finished yet.');
    if (batch.processingStatus === 'PENDING' || batch.processingStatus === 'RUNNING') {
      throw gdError(HttpStatus.CONFLICT, 'GD_PROCESSING', 'The evaluation is still running. Wait for the results first.');
    }
    const view = await this.results(tenantId, batchId);
    const claimed = await this.db.gdBatch.updateMany({ where: { id: batchId, confirmedAt: null }, data: { confirmedAt: this.now(), confirmedById: actor.id } });
    if (!claimed.count) throw gdError(HttpStatus.CONFLICT, 'GD_CONFIRMED', 'This selection was already confirmed.');

    const config = await this.rounds.forRoundEngine(tenantId, batch.event.jobId);
    const round = config?.rounds.find((r) => r.id === batch.event.roundId);
    const maxScore = round?.passRule?.mode === 'INTERVIEWER_SCORE' ? (round.passRule.maxScore ?? 10) : 10;
    for (const s of view.students) {
      if (ATTENDED.includes(s.attendance) && round) {
        try {
          const overall = s.evaluation?.overall ?? 0;
          const recorded = await this.assessments.record(tenantId, {
            applicationId: s.applicationId,
            roundId: round.id,
            interviewerScore: Math.round((overall / 10) * maxScore * 10) / 10,
            notes: s.evaluation?.feedback || null,
            startedAt: batch.lockedAt?.toISOString() ?? null,
            submittedAt: (batch.endedAt ?? this.now()).toISOString(),
          });
          const selected = s.finalDecision === 'SELECTED';
          if (recorded.systemPassed !== selected) {
            const reason = (s.hrDecision?.reason ?? '').trim();
            await this.assessments.override(tenantId, s.applicationId, round.id, { passed: selected, reason: reason.length >= 5 ? reason : 'Group discussion: selection confirmed by HR' }, actor);
          }
        } catch (err) {
          // the decision and the email still stand; HR can fix the round result on the Assessments page
          this.logger.warn(`GD result not recorded application=${s.applicationId} (${err instanceof Error ? err.message : 'unknown'})`);
        }
      }
      await this.mail.queueResult(tenantId, batchId, s.participantId, s.finalDecision === 'SELECTED', s.email);
    }
    await this.activityLog(tenantId, batchId, actor, 'CONFIRMED', null, { selected: view.students.filter((s) => s.finalDecision === 'SELECTED').length });
    await this.audit.record({ tenantId, actorUserId: actor.id, action: 'gd.selection_confirmed', subjectType: 'gd_batch', subjectId: batchId, metadata: {} });
    return this.results(tenantId, batchId);
  }

  // ================================================================ retention (DPDP: purpose limitation, deletion)

  /**
   * Deletes the audio files and transcripts of groups that ended more than GD_RETENTION_DAYS ago (evidence quotes are
   * transcript excerpts, so they go too; scores and decisions stay as the hiring record), and audio folders whose
   * group no longer exists (application or job deleted).
   */
  async retention(): Promise<number> {
    const before = new Date(this.now().getTime() - this.config.retentionDays * DAY_MS);
    const old = await this.db.gdBatch.findMany({ where: { endedAt: { lt: before }, recordings: { some: { deletedAt: null } } }, select: { id: true, tenantId: true }, take: 20 });
    for (const b of old) {
      const recs = await this.db.gdRecording.findMany({ where: { batchId: b.id, deletedAt: null } });
      for (const r of recs) await this.storage.deletePrefix(r.storagePrefix);
      await this.db.$transaction([
        this.db.gdRecording.updateMany({ where: { batchId: b.id, deletedAt: null }, data: { deletedAt: this.now() } }),
        this.db.gdTranscript.deleteMany({ where: { batchId: b.id } }),
        this.db.gdEvaluation.updateMany({ where: { batchId: b.id }, data: { evidence: [] } }),
        // the session file is in the group folder deleted below
        this.db.gdBatch.update({ where: { id: b.id }, data: { sessionAudioAt: null, sessionAudioMs: null, sessionAudioBytes: null, sessionAudioError: null } }),
      ]);
      await this.storage.deleteBatchFolder(b.tenantId, b.id);
      await this.audit.record({ tenantId: b.tenantId, actorUserId: null, action: 'gd.recordings_deleted', subjectType: 'gd_batch', subjectId: b.id, metadata: { recordings: recs.length, retentionDays: this.config.retentionDays } });
    }
    // folders the database no longer knows (cascade-deleted with an application / job)
    for (const tenantId of await this.storage.listTenantFolders()) {
      const folders = await this.storage.listBatchFolders(tenantId);
      if (!folders.length) continue;
      const known = new Set((await this.db.gdBatch.findMany({ where: { id: { in: folders } }, select: { id: true } })).map((b) => b.id));
      for (const f of folders) if (!known.has(f)) await this.storage.deleteBatchFolder(tenantId, f);
    }
    return old.length;
  }

  // ================================================================ helpers

  private async editable(tenantId: string, batchId: string) {
    const batch = await this.db.gdBatch.findFirst({ where: { id: batchId, tenantId }, include: { event: true } });
    if (!batch) throw batchNotFound();
    if (batch.confirmedAt) throw gdError(HttpStatus.CONFLICT, 'GD_CONFIRMED', 'This selection is already confirmed and can no longer change.');
    return batch;
  }

  private async activityLog(tenantId: string, batchId: string, actor: Actor, kind: 'OVERRIDE' | 'CONFIRMED' | 'PRIVATE_INCLUDED' | 'PRIVATE_EXCLUDED', participantId: string | null, detail: Record<string, unknown> = {}) {
    await this.db.gdHrActivity.create({
      data: { id: uuidv7(), tenantId, batchId, hrUserId: actor.id, hrName: actor.name, kind, participantId, occurredAt: this.now(), detail: detail as Prisma.InputJsonObject },
    });
  }
}

/** Absent = never selected; else HR's decision, else the AI's recommendation, else not selected. */
export function finalDecisionOf(attendance: GdAttendance, e: { hrDecision: GdRecommendation | null; recommendation: GdRecommendation | null } | null): GdRecommendation {
  if (!ATTENDED.includes(attendance)) return 'NOT_SELECTED';
  return e?.hrDecision ?? e?.recommendation ?? 'NOT_SELECTED';
}

const rank = (s: { attendance: GdAttendance; evaluation: { overall: number | null } | null }) =>
  !ATTENDED.includes(s.attendance) ? -2 : (s.evaluation?.overall ?? -1);

type Scores = NonNullable<NonNullable<GdResults['students'][number]['evaluation']>['scores']>;
