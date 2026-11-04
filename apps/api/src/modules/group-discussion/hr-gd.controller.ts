/// <reference types="multer" /> // Express.Multer.File (tsconfig "types" lists only node)
import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  GD_AUDIO_LIMITS,
  type GdHrLive,
  type GdPrivateTalkStarted,
  type GdRecordingStarted,
  type GdResults,
  type GdRoundOverview,
  type GdRoundSummary,
} from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { GdLiveService } from './gd-live.service';
import { GdResultsService } from './gd-results.service';
import { GdService } from './gd.service';

/** The part of Express's response used to stream a file (no express types in this package; see auth.controller.ts). */
interface FileResponse {
  headersSent: boolean;
  sendFile(path: string, options: { headers: Record<string, string> }, done: (err?: Error) => void): void;
  status(code: number): { json(body: unknown): void };
}

/** HR side of the GD rounds. Company from the session; another company's ids are a 404. */
@Controller('group-discussion')
@UseGuards(featureFlag('group_discussion'))
export class HrGdController {
  constructor(
    @Inject(GdService) private readonly gd: GdService,
    @Inject(GdLiveService) private readonly liveService: GdLiveService,
    @Inject(GdResultsService) private readonly resultsService: GdResultsService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/group-discussion/rounds - every GD round of the company's jobs. */
  @RequirePermission('jobs.read')
  @Get('rounds')
  async rounds(): Promise<GdRoundSummary[]> {
    return this.gd.listRounds(await this.tenant.currentTenantId());
  }

  /** GET /api/v1/group-discussion/rounds/:roundId - topics, waiting students, events and their groups. */
  @RequirePermission('jobs.read')
  @Get('rounds/:roundId')
  async overview(@Param('roundId', ParseUUIDPipe) roundId: string): Promise<GdRoundOverview> {
    return this.gd.overview(await this.tenant.currentTenantId(), roundId);
  }

  /** POST /api/v1/group-discussion/rounds/:roundId/events - body { name, startsAt, settings }; groups every waiting student. */
  @RequirePermission('jobs.write')
  @Post('rounds/:roundId/events')
  async createEvent(@Param('roundId', ParseUUIDPipe) roundId: string, @Body() body: unknown): Promise<GdRoundOverview> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.gd.createEvent(tenantId, roundId, body, actor);
  }

  /** POST /api/v1/group-discussion/events/:eventId/cancel - only before any group starts; students go back to the pool. */
  @RequirePermission('jobs.write')
  @Post('events/:eventId/cancel')
  @HttpCode(200)
  async cancelEvent(@Param('eventId', ParseUUIDPipe) eventId: string): Promise<GdRoundOverview> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.gd.cancelEvent(tenantId, eventId, actor);
  }

  /** PUT /api/v1/group-discussion/batches/:batchId/topic - body { topicId }; only before the group starts. */
  @RequirePermission('jobs.write')
  @Put('batches/:batchId/topic')
  async setTopic(@Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: unknown): Promise<GdRoundOverview> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.gd.setBatchTopic(tenantId, batchId, body, actor);
  }

  // ---------------------------------------------------------------- live dashboard (HR joins hidden and muted)

  /** GET /api/v1/group-discussion/batches/:batchId/live - HR's LiveKit connection (hidden), state, attendance, flags. */
  @RequirePermission('jobs.read')
  @Get('batches/:batchId/live')
  @Header('Cache-Control', 'no-store')
  async live(@Param('batchId', ParseUUIDPipe) batchId: string): Promise<GdHrLive> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.hrLive(tenantId, batchId, actor);
  }

  /** POST .../batches/:batchId/speak - body { on }; HR visible + audible, discussion timer paused while on. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/speak')
  @HttpCode(200)
  async speak(@Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: unknown): Promise<GdHrLive> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.speak(tenantId, batchId, body, actor);
  }

  /** POST .../batches/:batchId/private-talks - body { participantId }; HR's connection to the private room. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/private-talks')
  @HttpCode(200)
  async startPrivateTalk(@Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: unknown): Promise<GdPrivateTalkStarted> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.startPrivateTalk(tenantId, batchId, body, actor);
  }

  /** POST .../private-talks/:talkId/end - "Send back". */
  @RequirePermission('jobs.write')
  @Post('private-talks/:talkId/end')
  @HttpCode(200)
  async endPrivateTalk(@Param('talkId', ParseUUIDPipe) talkId: string): Promise<GdHrLive> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.endPrivateTalk(tenantId, talkId, actor);
  }

  /** POST .../batches/:batchId/participants/:participantId/admit - an absent student may still join. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/participants/:participantId/admit')
  @HttpCode(200)
  async admit(@Param('batchId', ParseUUIDPipe) batchId: string, @Param('participantId', ParseUUIDPipe) participantId: string): Promise<GdHrLive> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.admit(tenantId, batchId, participantId, actor);
  }

  /** POST .../participants/:participantId/reschedule - body { batchId }; a new link is emailed. */
  @RequirePermission('jobs.write')
  @Post('participants/:participantId/reschedule')
  @HttpCode(200)
  async reschedule(@Param('participantId', ParseUUIDPipe) participantId: string, @Body() body: unknown): Promise<{ batchId: string }> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.reschedule(tenantId, participantId, body, actor);
  }

  /** POST .../batches/:batchId/recordings - body { mimeType }; HR's microphone while speaking. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/recordings')
  @HttpCode(200)
  async startRecording(@Param('batchId', ParseUUIDPipe) batchId: string, @Body() body: unknown): Promise<GdRecordingStarted> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.startHrRecording(tenantId, batchId, body, actor);
  }

  /** POST .../recordings/:recordingId/chunks - multipart: chunk (file), seq. */
  @RequirePermission('jobs.write')
  @Post('recordings/:recordingId/chunks')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: GD_AUDIO_LIMITS.chunkMaxBytes, files: 1, fields: 3, fieldSize: 64 } }))
  async chunk(
    @Param('recordingId', ParseUUIDPipe) recordingId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() chunk: Express.Multer.File | undefined,
  ): Promise<{ received: number }> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.liveService.putHrChunk(tenantId, recordingId, Number(body.seq), chunk?.buffer, actor);
  }

  // ---------------------------------------------------------------- results

  /** GET .../batches/:batchId/results - ranked students, scores, evidence, private talks, HR activity. */
  @RequirePermission('jobs.read')
  @Get('batches/:batchId/results')
  @Header('Cache-Control', 'no-store')
  async results(@Param('batchId', ParseUUIDPipe) batchId: string): Promise<GdResults> {
    return this.resultsService.results(await this.tenant.currentTenantId(), batchId);
  }

  /**
   * GET .../batches/:batchId/session-audio - the whole session as one audio file (WebM / Opus). Supports Range
   * requests, so HR can jump to any moment.
   */
  @RequirePermission('jobs.read')
  @Get('batches/:batchId/session-audio')
  async sessionAudio(@Param('batchId', ParseUUIDPipe) batchId: string, @Res() res: FileResponse): Promise<void> {
    const file = await this.resultsService.sessionAudioFile(await this.tenant.currentTenantId(), batchId);
    res.sendFile(file, { headers: { 'Content-Type': 'audio/webm', 'Cache-Control': 'private, no-store' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ statusCode: 404, code: 'GD_SESSION_AUDIO_NOT_FOUND', message: 'This group has no session recording.' });
    });
  }

  /** POST .../batches/:batchId/session-audio - build the session recording again (e.g. after the worker was down). */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/session-audio')
  @HttpCode(200)
  async rebuildSessionAudio(@Param('batchId', ParseUUIDPipe) batchId: string): Promise<GdResults> {
    return this.resultsService.rebuildSessionAudio(await this.tenant.currentTenantId(), batchId);
  }

  /** PUT .../batches/:batchId/students/:participantId/decision - body { decision, reason }; logged with HR + time. */
  @RequirePermission('jobs.write')
  @Put('batches/:batchId/students/:participantId/decision')
  async decide(@Param('batchId', ParseUUIDPipe) batchId: string, @Param('participantId', ParseUUIDPipe) participantId: string, @Body() body: unknown): Promise<GdResults> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.resultsService.decide(tenantId, batchId, participantId, body, actor);
  }

  /** PUT .../batches/:batchId/students/:participantId/rubric - body { scores: [{ parameter, marks }], remarks }; HR's evaluator form. */
  @RequirePermission('jobs.write')
  @Put('batches/:batchId/students/:participantId/rubric')
  async scoreRubric(@Param('batchId', ParseUUIDPipe) batchId: string, @Param('participantId', ParseUUIDPipe) participantId: string, @Body() body: unknown): Promise<GdResults> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.resultsService.scoreRubric(tenantId, batchId, participantId, body, actor);
  }

  /** PUT .../private-talks/:talkId/include - body { include }; the group is evaluated again. */
  @RequirePermission('jobs.write')
  @Put('private-talks/:talkId/include')
  async include(@Param('talkId', ParseUUIDPipe) talkId: string, @Body() body: unknown): Promise<GdResults> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.resultsService.includePrivateTalk(tenantId, talkId, body, actor);
  }

  /** POST .../batches/:batchId/reprocess - run a failed evaluation again. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/reprocess')
  @HttpCode(200)
  async reprocess(@Param('batchId', ParseUUIDPipe) batchId: string): Promise<GdResults> {
    return this.resultsService.reprocess(await this.tenant.currentTenantId(), batchId);
  }

  /** POST .../batches/:batchId/confirm - "Confirm selection": results recorded, result emails queued. Once. */
  @RequirePermission('jobs.write')
  @Post('batches/:batchId/confirm')
  @HttpCode(200)
  async confirm(@Param('batchId', ParseUUIDPipe) batchId: string): Promise<GdResults> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.resultsService.confirm(tenantId, batchId, actor);
  }
}
