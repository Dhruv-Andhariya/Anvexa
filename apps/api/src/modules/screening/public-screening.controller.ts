/// <reference types="multer" /> // Express.Multer.File (tsconfig "types" lists only node)
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AiScreeningAnswerResult, AiScreeningPublicSession } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { screeningError } from './screening.errors';
import { AUDIO_LIMITS, ScreeningService } from './screening.service';

/** The candidate's link token travels in this header (never in API URLs, so it stays out of access logs). */
export const TOKEN_HEADER = 'x-screening-token';

/**
 * PUBLIC endpoints of the AI screening round, used by apps/careers-site (/screening/[token]). No login: the link
 * token is the credential and is scoped to ONE application. Per-IP rate limits on every call; uploads are refused
 * before they are buffered when the IP is over its limit. Writes need `x-requested-with: hireflow` (AuthGuard CSRF).
 */
@Public()
@Controller('public/screening')
@UseGuards(featureFlag('screening'))
export class PublicScreeningController {
  constructor(@Inject(ScreeningService) private readonly screening: ScreeningService) {}

  /** GET /api/v1/public/screening/session */
  @Get('session')
  @UseGuards(rateLimit('screening'))
  @Header('Cache-Control', 'no-store')
  session(@Headers(TOKEN_HEADER) token: string | undefined): Promise<AiScreeningPublicSession> {
    return this.screening.view(token);
  }

  /** POST /api/v1/public/screening/start - body { consent: true } */
  @Post('start')
  @HttpCode(200)
  @UseGuards(rateLimit('screening'))
  @Header('Cache-Control', 'no-store')
  start(@Headers(TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AiScreeningPublicSession> {
    return this.screening.start(token, body);
  }

  /** POST /api/v1/public/screening/answer - multipart: audio (file), seq, clientTurnId, durationMs */
  @Post('answer')
  @HttpCode(200)
  @UseGuards(rateLimit('screening-answer'))
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: AUDIO_LIMITS.maxBytes, files: 1, fields: 5, fieldSize: 1024 } }))
  @Header('Cache-Control', 'no-store')
  answer(
    @Headers(TOKEN_HEADER) token: string | undefined,
    @Body() body: Record<string, unknown>,
    @UploadedFile() audio: Express.Multer.File | undefined,
  ): Promise<AiScreeningAnswerResult> {
    const seq = Number(body.seq);
    if (!Number.isInteger(seq) || seq < 1) throw screeningError(400, 'INVALID_REQUEST', 'Invalid question number.');
    const durationMs = Number(body.durationMs);
    return this.screening.answer(token, {
      seq,
      clientTurnId: typeof body.clientTurnId === 'string' ? body.clientTurnId : '',
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.min(durationMs, 30 * 60_000) : null,
      audio: audio ? { bytes: audio.buffer, mimeType: audio.mimetype } : undefined,
    });
  }

  /** GET /api/v1/public/screening/speech?seq=N - the question spoken (audio/wav). */
  @Get('speech')
  @UseGuards(rateLimit('screening'))
  async speech(@Headers(TOKEN_HEADER) token: string | undefined, @Query('seq') seqRaw: string): Promise<StreamableFile> {
    const seq = Number(seqRaw);
    if (!Number.isInteger(seq) || seq < 1) throw screeningError(400, 'INVALID_REQUEST', 'Invalid question number.');
    const audio = await this.screening.speech(token, seq);
    return new StreamableFile(audio, { type: 'audio/wav', length: audio.length, disposition: 'inline' });
  }

  /** POST /api/v1/public/screening/end - stop early (answers so far are kept; resume possible while the link works). */
  @Post('end')
  @HttpCode(200)
  @UseGuards(rateLimit('screening'))
  @Header('Cache-Control', 'no-store')
  end(@Headers(TOKEN_HEADER) token: string | undefined): Promise<AiScreeningPublicSession> {
    return this.screening.end(token);
  }
}
