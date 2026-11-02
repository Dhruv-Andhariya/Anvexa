import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { SendDecisionEmailsResult } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { DecisionService } from './decision.service';

/**
 * HR decisions on screened candidates and the decision emails (never sent automatically).
 * Company from the session; another company's application id is a 404.
 */
@Controller('ats')
@UseGuards(featureFlag('ats'))
export class DecisionController {
  constructor(
    @Inject(DecisionService) private readonly service: DecisionService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** PUT /api/v1/ats/applications/:applicationId/decision - body { decision: SHORTLISTED | NOT_SHORTLISTED | null }. */
  @RequirePermission('jobs.write')
  @Put('applications/:applicationId/decision')
  async decide(@Param('applicationId', ParseUUIDPipe) applicationId: string, @Body() body: unknown) {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.setDecision(tenantId, applicationId, body, actor);
  }

  /** POST /api/v1/ats/applications/:applicationId/retry - screen a resume waiting for HR review again. */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/retry')
  @HttpCode(200)
  async retry(@Param('applicationId', ParseUUIDPipe) applicationId: string) {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.retryScreening(tenantId, applicationId, actor);
  }

  /** POST /api/v1/ats/emails - body { kind: SHORTLIST | REJECTION, applicationIds }. Queues HR's decision emails. */
  @RequirePermission('jobs.write')
  @Post('emails')
  @HttpCode(200)
  async emails(@Body() body: unknown): Promise<SendDecisionEmailsResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.sendEmails(tenantId, body, actor);
  }
}
