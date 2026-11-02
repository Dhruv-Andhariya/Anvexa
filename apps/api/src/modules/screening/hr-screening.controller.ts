import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { AiScreeningDetail, AiScreeningJobList } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { HrScreeningService } from './hr-screening.service';

/** HR view of the AI screening round. Company from the session; another company's ids are a 404. */
@Controller('screening')
@UseGuards(featureFlag('screening'))
export class HrScreeningController {
  constructor(
    @Inject(HrScreeningService) private readonly service: HrScreeningService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/screening/jobs/:jobId - every shortlisted application of the job that got a screening link. */
  @RequirePermission('jobs.read')
  @Get('jobs/:jobId')
  async list(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<AiScreeningJobList> {
    return this.service.listForJob(await this.tenant.currentTenantId(), jobId);
  }

  /** GET /api/v1/screening/applications/:applicationId - transcript + structured summary. */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId')
  async detail(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<AiScreeningDetail> {
    return this.service.detail(await this.tenant.currentTenantId(), applicationId);
  }

  /** PUT /api/v1/screening/applications/:applicationId/review - body { reviewStatus } */
  @RequirePermission('jobs.write')
  @Put('applications/:applicationId/review')
  async review(@Param('applicationId', ParseUUIDPipe) applicationId: string, @Body() body: unknown): Promise<AiScreeningDetail> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.setReview(tenantId, applicationId, body, actor);
  }

  /** POST /api/v1/screening/applications/:applicationId/summary - create the structured summary again. */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/summary')
  @HttpCode(200)
  async retrySummary(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<AiScreeningDetail> {
    return this.service.retrySummary(await this.tenant.currentTenantId(), applicationId);
  }
}
