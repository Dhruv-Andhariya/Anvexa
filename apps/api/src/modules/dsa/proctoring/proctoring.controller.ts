import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { featureFlag } from '../../../common/feature-flags';
import { rateLimit } from '../../applications';
import { Public } from '../../auth';
import { DsaService } from '../dsa.service';
import type { RecordResult } from './proctoring.service';
import type { ClientProctoringConfig } from './proctoring.types';

/**
 * Candidate-facing proctoring API. The invitation token in the URL is the only identity: bodies that name a
 * candidate or assessment are refused. Candidates can write events but cannot read the event log.
 */
// PUBLIC like the rest of the candidate routes: the token is the credential, per-IP rate limit, CSRF header on writes.
@Public()
@UseGuards(featureFlag('dsa'), rateLimit('assessment'))
@Controller('dsa')
export class ProctoringController {
  constructor(@Inject(DsaService) private readonly service: DsaService) {}

  /** POST /api/v1/dsa/:token/proctor/start - records consent (and that full screen was on). Call before /start. */
  @Post(':token/proctor/start')
  @HttpCode(200)
  start(@Param('token') token: string, @Body() body: unknown): Promise<ClientProctoringConfig> {
    return this.service.proctorStart(token, body);
  }

  /** POST /api/v1/dsa/:token/proctor/events - up to 20 integrity events per call. */
  @Post(':token/proctor/events')
  @HttpCode(200)
  events(@Param('token') token: string, @Body() body: unknown): Promise<RecordResult & { ended: boolean }> {
    return this.service.proctorEvents(token, body);
  }

  /** POST /api/v1/dsa/:token/proctor/end - only after the assessment is finished (it also ends automatically). */
  @Post(':token/proctor/end')
  @HttpCode(200)
  end(@Param('token') token: string): Promise<{ ended: true }> {
    return this.service.proctorEnd(token);
  }
}
