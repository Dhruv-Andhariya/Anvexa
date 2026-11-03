/// <reference types="multer" /> // Express.Multer.File (tsconfig "types" lists only node)
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GD_AUDIO_LIMITS, type GdJoinResult, type GdLiveState, type GdPrivateTalkConnection, type GdPublicSession, type GdRecordingStarted } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { GdLiveService } from './gd-live.service';
import { GD_TOKEN_HEADER } from './link';

/**
 * PUBLIC endpoints of the GD round, used by apps/careers-site (/gd/[token]). No login: the personal link token (header
 * x-gd-token, never in a URL) is the credential and opens ONE student's place in ONE group. Per-IP rate limits;
 * writes need `x-requested-with: hireflow` (AuthGuard CSRF). Off with FEATURE_GROUP_DISCUSSION=off.
 */
@Public()
@Controller('public/gd')
@UseGuards(featureFlag('group_discussion'))
export class PublicGdController {
  constructor(@Inject(GdLiveService) private readonly live: GdLiveService) {}

  /** GET /api/v1/public/gd/session - lobby facts and where the student stands. */
  @Get('session')
  @UseGuards(rateLimit('gd'))
  @Header('Cache-Control', 'no-store')
  session(@Headers(GD_TOKEN_HEADER) token: string | undefined): Promise<GdPublicSession> {
    return this.live.session(token);
  }

  /** POST /api/v1/public/gd/join - body { consent: true }; also the reconnect path. */
  @Post('join')
  @HttpCode(200)
  @UseGuards(rateLimit('gd'))
  @Header('Cache-Control', 'no-store')
  join(@Headers(GD_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<GdJoinResult> {
    return this.live.join(token, body);
  }

  /** GET /api/v1/public/gd/state - the live state (fallback for the room metadata). */
  @Get('state')
  @UseGuards(rateLimit('gd'))
  @Header('Cache-Control', 'no-store')
  state(@Headers(GD_TOKEN_HEADER) token: string | undefined): Promise<GdLiveState> {
    return this.live.state(token);
  }

  /** GET /api/v1/public/gd/private - the private room HR opened for this student, if any. */
  @Get('private')
  @UseGuards(rateLimit('gd'))
  @Header('Cache-Control', 'no-store')
  privateTalk(@Headers(GD_TOKEN_HEADER) token: string | undefined): Promise<GdPrivateTalkConnection> {
    return this.live.privateTalk(token);
  }

  /** POST /api/v1/public/gd/events - body { events: [{ type, occurredAt }] } (camera / mic / hand / joined / left). */
  @Post('events')
  @HttpCode(200)
  @UseGuards(rateLimit('gd'))
  events(@Headers(GD_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<{ accepted: number }> {
    return this.live.events(token, body);
  }

  /** POST /api/v1/public/gd/recordings - body { mimeType }; a new recording of the student's own microphone. */
  @Post('recordings')
  @HttpCode(200)
  @UseGuards(rateLimit('gd'))
  startRecording(@Headers(GD_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<GdRecordingStarted> {
    return this.live.startRecording(token, body);
  }

  /** POST /api/v1/public/gd/recordings/:recordingId/chunks - multipart: chunk (file), seq. Idempotent per seq. */
  @Post('recordings/:recordingId/chunks')
  @HttpCode(200)
  @UseGuards(rateLimit('gd-audio'))
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: GD_AUDIO_LIMITS.chunkMaxBytes, files: 1, fields: 3, fieldSize: 64 } }))
  chunk(
    @Headers(GD_TOKEN_HEADER) token: string | undefined,
    @Param('recordingId', ParseUUIDPipe) recordingId: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() chunk: Express.Multer.File | undefined,
  ): Promise<{ received: number }> {
    return this.live.putChunk(token, recordingId, Number(body.seq), chunk?.buffer);
  }
}
