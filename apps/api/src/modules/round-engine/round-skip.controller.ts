import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { SkipRoundResult } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { RoundEngineService } from './round-engine.service';

/**
 * HR skips one round of a job (only DSA, only SQL, the GD, ...) or brings it back. Students who pass the round before
 * a skipped one get the next round that runs; students already waiting for it move on at once. Company from the
 * session; another company's job or round is a 404.
 */
@Controller('rounds/jobs/:jobId/rounds/:roundId')
@UseGuards(featureFlag('rounds'))
export class RoundSkipController {
  constructor(
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** POST /api/v1/rounds/jobs/:jobId/rounds/:roundId/skip - body { reason }. */
  @RequirePermission('jobs.write')
  @Post('skip')
  @HttpCode(200)
  async skip(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Body() body: unknown,
  ): Promise<SkipRoundResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.engine.skipRound(tenantId, jobId, roundId, body, actor);
  }

  /** POST /api/v1/rounds/jobs/:jobId/rounds/:roundId/unskip - the round runs again for students not yet past it. */
  @RequirePermission('jobs.write')
  @Post('unskip')
  @HttpCode(200)
  async unskip(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('roundId', ParseUUIDPipe) roundId: string): Promise<SkipRoundResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.engine.unskipRound(tenantId, jobId, roundId, actor);
  }
}
