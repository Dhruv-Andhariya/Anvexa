import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Post, Put, UseGuards } from '@nestjs/common';
import type { AssessmentPublicView, SaveAssessmentAnswersResult } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { RoundEngineService } from './round-engine.service';

/** The candidate's link token travels in this header (never in API URLs, so it stays out of access logs). */
export const TOKEN_HEADER = 'x-assessment-token';

/**
 * PUBLIC endpoints of the online test rounds, used by apps/careers-site (/assessment/[token]). No login: the link
 * token is the credential and is scoped to ONE application's ONE round. Per-IP rate limits on every call; writes need
 * `x-requested-with: hireflow` (AuthGuard CSRF). Off with FEATURE_ROUND_ENGINE=off.
 */
@Public()
@Controller('public/assessment')
@UseGuards(featureFlag('round_engine'))
export class PublicAssessmentController {
  constructor(@Inject(RoundEngineService) private readonly engine: RoundEngineService) {}

  /** GET /api/v1/public/assessment/session */
  @Get('session')
  @UseGuards(rateLimit('assessment'))
  @Header('Cache-Control', 'no-store')
  session(@Headers(TOKEN_HEADER) token: string | undefined): Promise<AssessmentPublicView> {
    return this.engine.view(token);
  }

  /** POST /api/v1/public/assessment/start - body { consent: true } */
  @Post('start')
  @HttpCode(200)
  @UseGuards(rateLimit('assessment'))
  @Header('Cache-Control', 'no-store')
  start(@Headers(TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AssessmentPublicView> {
    return this.engine.start(token, body);
  }

  /** PUT /api/v1/public/assessment/answers - autosave, body { revision, answers } */
  @Put('answers')
  @UseGuards(rateLimit('assessment'))
  @Header('Cache-Control', 'no-store')
  save(@Headers(TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<SaveAssessmentAnswersResult> {
    return this.engine.save(token, body);
  }

  /** POST /api/v1/public/assessment/submit - body { revision, answers } */
  @Post('submit')
  @HttpCode(200)
  @UseGuards(rateLimit('assessment'))
  @Header('Cache-Control', 'no-store')
  submit(@Headers(TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<AssessmentPublicView> {
    return this.engine.submit(token, body);
  }

  /** POST /api/v1/public/assessment/events - body { events: [{ type, occurredAt, detail }] } */
  @Post('events')
  @HttpCode(200)
  @UseGuards(rateLimit('assessment'))
  events(@Headers(TOKEN_HEADER) token: string | undefined, @Body() body: unknown): Promise<{ accepted: number }> {
    return this.engine.events(token, body);
  }
}
