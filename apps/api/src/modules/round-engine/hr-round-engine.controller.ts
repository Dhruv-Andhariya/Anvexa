import { Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { ApplicationRoundEngine } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { RoundEngineService } from './round-engine.service';

/** HR view of the online test rounds of one student. Company from the session; another company's ids are a 404. */
@Controller('round-engine')
@UseGuards(featureFlag('round_engine'))
export class HrRoundEngineController {
  constructor(
    @Inject(RoundEngineService) private readonly engine: RoundEngineService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/round-engine/applications/:applicationId - invitations, attempts, proctoring events, outcome emails. */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId')
  async forApplication(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<ApplicationRoundEngine> {
    return this.engine.forApplication(await this.tenant.currentTenantId(), applicationId);
  }

  /** POST /api/v1/round-engine/applications/:applicationId/rounds/:roundId/revoke - the link stops working at once. */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/rounds/:roundId/revoke')
  @HttpCode(200)
  async revoke(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
  ): Promise<ApplicationRoundEngine> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.engine.revoke(tenantId, applicationId, roundId, actor);
  }

  /** POST /api/v1/round-engine/applications/:applicationId/rounds/:roundId/resend - only after the email FAILED. */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/rounds/:roundId/resend')
  @HttpCode(200)
  async resend(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
  ): Promise<ApplicationRoundEngine> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.engine.resend(tenantId, applicationId, roundId, actor);
  }
}
