import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import type { JobPipelineStatuses, PiBoard, PipelineSettingsView, RoundRubricView } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { PipelineService } from './pipeline.service';

/** HR-only pipeline rules and views of a job. Company from the session; another company's job id is a 404. */
@Controller('pipeline/jobs/:jobId')
@UseGuards(featureFlag('rounds'))
export class PipelineController {
  constructor(
    @Inject(PipelineService) private readonly service: PipelineService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/pipeline/jobs/:jobId/settings - Stage 2 overall criterion and the rejection-email switch. */
  @RequirePermission('jobs.read')
  @Get('settings')
  async settings(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<PipelineSettingsView> {
    return this.service.settingsView(await this.tenant.currentTenantId(), jobId);
  }

  /** PUT /api/v1/pipeline/jobs/:jobId/settings - 409 PIPELINE_LOCKED once students started. */
  @RequirePermission('jobs.write')
  @Put('settings')
  async saveSettings(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<PipelineSettingsView> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.saveSettings(tenantId, jobId, body, actor);
  }

  /** GET /api/v1/pipeline/jobs/:jobId/rounds/:roundId/rubric - HR's GD rubric (empty = none). */
  @RequirePermission('jobs.read')
  @Get('rounds/:roundId/rubric')
  async rubric(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('roundId', ParseUUIDPipe) roundId: string): Promise<RoundRubricView> {
    return this.service.rubricView(await this.tenant.currentTenantId(), jobId, roundId);
  }

  /** PUT /api/v1/pipeline/jobs/:jobId/rounds/:roundId/rubric - body { parameters: [{ name, maxMarks }] }. */
  @RequirePermission('jobs.write')
  @Put('rounds/:roundId/rubric')
  async saveRubric(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('roundId', ParseUUIDPipe) roundId: string, @Body() body: unknown): Promise<RoundRubricView> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.saveRubric(tenantId, jobId, roundId, body, actor);
  }

  /** GET /api/v1/pipeline/jobs/:jobId/statuses - every student's pipeline status (REJECTED_* reasons) and Stage 2 %. */
  @RequirePermission('jobs.read')
  @Get('statuses')
  async statuses(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobPipelineStatuses> {
    return this.service.statuses(await this.tenant.currentTenantId(), jobId);
  }

  /** GET /api/v1/pipeline/jobs/:jobId/personal-interview - students who cleared the technical interview. */
  @RequirePermission('jobs.read')
  @Get('personal-interview')
  async piBoard(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<PiBoard> {
    return this.service.piBoard(await this.tenant.currentTenantId(), jobId);
  }

  /** PUT /api/v1/pipeline/jobs/:jobId/personal-interview/:applicationId - body { status, notes }. */
  @RequirePermission('jobs.write')
  @Put('personal-interview/:applicationId')
  async updatePiCall(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('applicationId', ParseUUIDPipe) applicationId: string, @Body() body: unknown): Promise<PiBoard> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.updatePiCall(tenantId, jobId, applicationId, body, actor);
  }
}
