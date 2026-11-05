import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post, UseGuards } from '@nestjs/common';
import { featureFlag } from '../../common/feature-flags';
import { rateLimit } from '../applications';
import { Public } from '../auth';
import { GdMailService, gdWorkerConfigFromEnv, type GdStudentLink } from '../group-discussion';
import { RoundEngineService, type ContinueAfterCoding } from '../round-engine';

/** What the coding page gets after a round: the engine's answer without internal ids, plus the GD state when relevant. */
export type ContinueResponse = Exclude<ContinueAfterCoding, { status: 'GROUP_DISCUSSION' }> | { status: 'GROUP_DISCUSSION'; roundName: string; gd: GdStudentLink };
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
  constructor(
    @Inject(DsaService) private readonly service: DsaService,
    /** Moves the student on after the round (next coding round on this page). None / demo mode: nothing to continue. */
    @Optional() @Inject(RoundEngineService) private readonly engine: RoundEngineService | null = null,
    /** Qualified for a group discussion: the page takes the student to their GD page (same tab). */
    @Optional() @Inject(GdMailService) private readonly gd: GdMailService | null = null,
  ) {}

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

  /**
   * POST /api/v1/dsa/:token/continue - after the round ended: the next coding round's token (same page, no email), or
   * what comes next (group discussion / email). Only for the holder of this round's link.
   */
  @Post(':token/continue')
  @HttpCode(200)
  async continue(@Param('token') token: string): Promise<ContinueResponse> {
    if (!this.engine || ['on', 'true', '1'].includes((process.env.DSA_DEMO_MODE ?? '').trim().toLowerCase())) return { status: 'DONE' };
    const next = await this.engine.continueAfterCoding(token);
    if (next.status !== 'GROUP_DISCUSSION') return next;
    const gd: GdStudentLink =
      next.ref && this.gd
        ? await this.gd.studentLink(next.ref.tenantId, next.ref.applicationId, next.ref.roundId, gdWorkerConfigFromEnv().autoScheduleMin ?? 6)
        : { status: 'NONE' };
    return { status: 'GROUP_DISCUSSION', roundName: next.roundName, gd };
  }
}
