import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import type { JobScreeningSettings } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { ScreeningSettingsService } from './screening-settings.service';

/** HR-only ATS rules of a job. Company from the session; another company's job id is a 404. Never public. */
@Controller('ats/jobs/:jobId/settings')
@UseGuards(featureFlag('ats'))
export class ScreeningSettingsController {
  constructor(
    @Inject(ScreeningSettingsService) private readonly service: ScreeningSettingsService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/ats/jobs/:jobId/settings - { jobId, settings: { minAtsScore } | null, updatedAt }. */
  @RequirePermission('jobs.read')
  @Get()
  async get(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobScreeningSettings> {
    return this.service.get(await this.tenant.currentTenantId(), jobId);
  }

  /** PUT /api/v1/ats/jobs/:jobId/settings - body { minAtsScore: 0-100 }. Allowed any time (it is not part of the JD). */
  @RequirePermission('jobs.write')
  @Put()
  async put(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<JobScreeningSettings> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.save(tenantId, jobId, body, actor);
  }
}
