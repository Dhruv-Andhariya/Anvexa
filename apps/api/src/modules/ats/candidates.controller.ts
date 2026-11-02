import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import type { JobCandidates, ScreeningJob } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { CandidatesService } from './candidates.service';

/** HR "Shortlisted Students" page data. Company from the session; another company's job is a 404. */
@Controller('ats/jobs')
@UseGuards(featureFlag('ats'))
export class CandidatesController {
  constructor(
    @Inject(CandidatesService) private readonly service: CandidatesService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/ats/jobs - approved jobs with screening counts. */
  @RequirePermission('jobs.read')
  @Get()
  async jobs(): Promise<ScreeningJob[]> {
    return this.service.jobs(await this.tenant.currentTenantId());
  }

  /** GET /api/v1/ats/jobs/:jobId/candidates?view=shortlisted (default) | not_shortlisted | needs_review | pending | all */
  @RequirePermission('jobs.read')
  @Get(':jobId/candidates')
  async candidates(@Param('jobId', ParseUUIDPipe) jobId: string, @Query('view') view?: string): Promise<JobCandidates> {
    return this.service.candidates(await this.tenant.currentTenantId(), jobId, view);
  }
}
