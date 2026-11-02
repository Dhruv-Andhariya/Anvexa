import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { GenerateQuestionsResult, JobRounds } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { RoundsConfigService } from './rounds-config.service';

/** HR-only assessment rounds of a job. Company from the session; another company's job id is a 404. Never public. */
@Controller('rounds/jobs/:jobId')
@UseGuards(featureFlag('rounds'))
export class RoundsConfigController {
  constructor(
    @Inject(RoundsConfigService) private readonly service: RoundsConfigService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/rounds/jobs/:jobId - the rounds, questions and passing criteria (status NOT_STARTED when none yet). */
  @RequirePermission('jobs.read')
  @Get()
  async get(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobRounds> {
    return this.service.get(await this.tenant.currentTenantId(), jobId);
  }

  /** PUT /api/v1/rounds/jobs/:jobId - body { rounds, complete }. 409 ROUNDS_LOCKED once students started. */
  @RequirePermission('jobs.write')
  @Put()
  async save(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<JobRounds> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.save(tenantId, jobId, body, actor);
  }

  /** POST /api/v1/rounds/jobs/:jobId/generate - AI question suggestions for one round. Saves nothing. */
  @RequirePermission('jobs.write')
  @Post('generate')
  @HttpCode(200)
  async generate(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<GenerateQuestionsResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.generate(tenantId, jobId, body, actor);
  }
}
