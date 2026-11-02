import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import type { AssessmentJob, JobAssessments, StudentAssessment } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { AssessmentsService } from './assessments.service';

/** HR "Assessments" page: round results. Company from the session; another company's ids are a 404. Never public. */
@Controller('assessments')
@UseGuards(featureFlag('rounds'))
export class AssessmentsController {
  constructor(
    @Inject(AssessmentsService) private readonly service: AssessmentsService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/assessments/jobs - approved jobs with their rounds status and how many results came in. */
  @RequirePermission('jobs.read')
  @Get('jobs')
  async jobs(): Promise<AssessmentJob[]> {
    return this.service.jobs(await this.tenant.currentTenantId());
  }

  /** GET /api/v1/assessments/jobs/:jobId - every student who reached the rounds, with status and score per round. */
  @RequirePermission('jobs.read')
  @Get('jobs/:jobId')
  async job(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobAssessments> {
    return this.service.job(await this.tenant.currentTenantId(), jobId);
  }

  /** GET /api/v1/assessments/applications/:applicationId - one student's full review. */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId')
  async student(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<StudentAssessment> {
    return this.service.student(await this.tenant.currentTenantId(), applicationId);
  }

  /** PUT /api/v1/assessments/applications/:applicationId/rounds/:roundId/override - body { passed, reason }. */
  @RequirePermission('jobs.write')
  @Put('applications/:applicationId/rounds/:roundId/override')
  async override(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Body() body: unknown,
  ): Promise<StudentAssessment> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.override(tenantId, applicationId, roundId, body, actor);
  }
}
