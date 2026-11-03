import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { DsaService, type AssessmentState, type RunResponse, type SubmitResponse } from './dsa.service';

/**
 * Candidate-facing DSA assessment API. The invitation token in the URL identifies the assessment.
 * Responses never contain hidden test cases. PUBLIC (no login): the link token is the credential and is scoped to ONE
 * application's ONE round; per-IP rate limit; writes need `x-requested-with: hireflow` (AuthGuard CSRF).
 * Off with FEATURE_DSA=off.
 */
@Public()
@UseGuards(featureFlag('dsa'), rateLimit('assessment'))
@Controller('dsa')
export class DsaController {
  constructor(@Inject(DsaService) private readonly service: DsaService) {}

  /** GET /api/v1/dsa/:token - instructions, timer and (once started) the questions. */
  @Get(':token')
  state(@Param('token') token: string): Promise<AssessmentState> {
    return this.service.getState(token);
  }

  /** POST /api/v1/dsa/:token/start - starts the server-side timer (idempotent). */
  @Post(':token/start')
  @HttpCode(200)
  start(@Param('token') token: string): Promise<AssessmentState> {
    return this.service.start(token);
  }

  /** POST /api/v1/dsa/:token/run - executes the code against the public sample tests only. */
  @Post(':token/run')
  @HttpCode(200)
  run(@Param('token') token: string, @Body() body: unknown): Promise<RunResponse> {
    return this.service.run(token, body);
  }

  /** POST /api/v1/dsa/:token/submit - judges against sample + hidden tests and records the score. */
  @Post(':token/submit')
  @HttpCode(200)
  submit(@Param('token') token: string, @Body() body: unknown): Promise<SubmitResponse> {
    return this.service.submit(token, body);
  }

  /** POST /api/v1/dsa/:token/finish - ends the assessment and returns the final result. */
  @Post(':token/finish')
  @HttpCode(200)
  finish(@Param('token') token: string): Promise<AssessmentState> {
    return this.service.finish(token);
  }
}
