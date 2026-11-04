import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { AiInterviewHrView, AiInterviewProtectionConfig } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { AiInterviewHrService } from './ai-interview-hr.service';
import { InterviewProtectionService } from './protection.service';

/** HR view of the AI technical interview rounds. Company from the session; another company's ids are a 404. */
@Controller('ai-interview')
@UseGuards(featureFlag('ai_interview'))
export class HrInterviewController {
  constructor(
    @Inject(AiInterviewHrService) private readonly service: AiInterviewHrService,
    @Inject(InterviewProtectionService) private readonly protection: InterviewProtectionService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/ai-interview/jobs/:jobId/rounds/:roundId/protection - the round's interview protection rules. */
  @RequirePermission('jobs.read')
  @Get('jobs/:jobId/rounds/:roundId/protection')
  async protectionSettings(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('roundId', ParseUUIDPipe) roundId: string): Promise<AiInterviewProtectionConfig> {
    return this.protection.settings(await this.tenant.currentTenantId(), jobId, roundId);
  }

  /** PUT /api/v1/ai-interview/jobs/:jobId/rounds/:roundId/protection - body AiInterviewProtectionSettings. */
  @RequirePermission('jobs.write')
  @Put('jobs/:jobId/rounds/:roundId/protection')
  async saveProtectionSettings(@Param('jobId', ParseUUIDPipe) jobId: string, @Param('roundId', ParseUUIDPipe) roundId: string, @Body() body: unknown): Promise<AiInterviewProtectionConfig> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.protection.saveSettings(tenantId, jobId, roundId, body, actor);
  }

  /** GET /api/v1/ai-interview/applications/:applicationId - transcript, events, report and decision per round. */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId')
  async view(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<AiInterviewHrView> {
    return this.service.view(await this.tenant.currentTenantId(), applicationId);
  }

  /** POST /api/v1/ai-interview/applications/:applicationId/rounds/:roundId/decision - body { decision, reason } */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/rounds/:roundId/decision')
  @HttpCode(200)
  async decide(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Body() body: unknown,
  ): Promise<AiInterviewHrView> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.decide(tenantId, applicationId, roundId, body, actor);
  }

  /** POST /api/v1/ai-interview/applications/:applicationId/rounds/:roundId/report - make the report again. */
  @RequirePermission('jobs.write')
  @Post('applications/:applicationId/rounds/:roundId/report')
  @HttpCode(200)
  async retryReport(@Param('applicationId', ParseUUIDPipe) applicationId: string, @Param('roundId', ParseUUIDPipe) roundId: string): Promise<AiInterviewHrView> {
    return this.service.retryReport(await this.tenant.currentTenantId(), applicationId, roundId);
  }
}
