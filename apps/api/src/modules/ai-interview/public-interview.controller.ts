/// <reference types="multer" /> // Express.Multer.File (tsconfig "types" lists only node)
import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Post, Query, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AiInterviewAnswerResult, AiInterviewPublicSession, AiInterviewViolationResult } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { AUDIO_LIMITS, AiInterviewService, interviewError } from './ai-interview.service';
import { INTERVIEW_TOKEN_HEADER } from './link';
import { InterviewProtectionService } from './protection.service';

/**
 * PUBLIC endpoints of the AI technical interview, used by apps/careers-site (/interview/[token]). No login: the link
 * token is the credential and is scoped to ONE application's one round. Per-IP rate limits on every call; uploads are
 * refused before they are buffered when the IP is over its limit. Writes need `x-requested-with: hireflow` (CSRF).
 */
@Public()
@Controller('public/interview')
@UseGuards(featureFlag('ai_interview'))
export class PublicInterviewController {
  constructor(
    @Inject(AiInterviewService) private readonly interviews: AiInterviewService,
    @Inject(InterviewProtectionService) private readonly protection: InterviewProtectionService,
  ) {}

  /** GET /api/v1/public/interview/session */
  @Get('session')
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  session(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined): Promise<AiInterviewPublicSession> {
    return this.interviews.view(token);
  }

  /** POST /api/v1/public/interview/start - body { consent: true, camera: true, microphone: true } */
  @Post('start')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  start(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AiInterviewPublicSession> {
    return this.interviews.start(token, body);
  }

  /** POST /api/v1/public/interview/answer - multipart: audio (file), seq, clientTurnId, durationMs */
  @Post('answer')
  @HttpCode(200)
  @UseGuards(rateLimit('interview-answer'))
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: AUDIO_LIMITS.maxBytes, files: 1, fields: 5, fieldSize: 1024 } }))
  @Header('Cache-Control', 'no-store')
  answer(
    @Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined,
    @Body() body: Record<string, unknown>,
    @UploadedFile() audio: Express.Multer.File | undefined,
  ): Promise<AiInterviewAnswerResult> {
    const seq = Number(body.seq);
    if (!Number.isInteger(seq) || seq < 1) throw interviewError(400, 'INVALID_REQUEST', 'Invalid question number.');
    const durationMs = Number(body.durationMs);
    return this.interviews.answer(token, {
      seq,
      clientTurnId: typeof body.clientTurnId === 'string' ? body.clientTurnId : '',
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, 30 * 60_000) : null,
      audio: audio ? { bytes: audio.buffer, mimeType: audio.mimetype } : undefined,
    });
  }

  /** GET /api/v1/public/interview/speech?seq=N - the question spoken (audio/wav). */
  @Get('speech')
  @UseGuards(rateLimit('interview'))
  async speech(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Query('seq') seqRaw: string): Promise<StreamableFile> {
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 1) throw interviewError(400, 'INVALID_REQUEST', 'Invalid question number.');
    const audio = await this.interviews.speech(token, seq);
    return new StreamableFile(audio, { type: 'audio/wav', length: audio.length, disposition: 'inline' });
  }

  /** POST /api/v1/public/interview/repeat - hear the current question again (limited). */
  @Post('repeat')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  repeat(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined): Promise<{ repeatsLeft: number }> {
    return this.interviews.repeat(token);
  }

  /** POST /api/v1/public/interview/pause - body { reason } (a device or the connection was lost). */
  @Post('pause')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  pause(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AiInterviewPublicSession> {
    return this.interviews.pause(token, body);
  }

  /** POST /api/v1/public/interview/resume - body { camera: true, microphone: true } */
  @Post('resume')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  resume(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AiInterviewPublicSession> {
    return this.interviews.resume(token, body);
  }

  /** POST /api/v1/public/interview/events - body { events: [{ type, occurredAt, detail }] } */
  @Post('events')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  events(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<{ saved: number }> {
    return this.interviews.events(token, body);
  }

  /**
   * POST /api/v1/public/interview/violation - body { incidentId, type, detail? }. A monitored incident (tab hidden,
   * focus lost, fullscreen left, device stopped). The server decides if it counts; the answer carries its warning count.
   */
  @Post('violation')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  violation(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AiInterviewViolationResult> {
    return this.protection.report(token, body);
  }

  /** POST /api/v1/public/interview/violation/ack - body { warningNumber } (the candidate read the warning). */
  @Post('violation/ack')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  acknowledge(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<{ acknowledged: boolean }> {
    return this.protection.acknowledge(token, body);
  }

  /** POST /api/v1/public/interview/end - the candidate ends the interview (answers so far go to HR). */
  @Post('end')
  @HttpCode(200)
  @UseGuards(rateLimit('interview'))
  @Header('Cache-Control', 'no-store')
  end(@Headers(INTERVIEW_TOKEN_HEADER) token: string | undefined): Promise<AiInterviewPublicSession> {
    return this.interviews.end(token);
  }
}
