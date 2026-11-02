import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import type { DeleteJobResult, JobDetail, JobSummary } from '@hireflow/contracts';
import { RequirePermission } from '../auth';
import { JobsService } from './jobs.service';

// Every route works on the caller's own company (from the session). A job id from another company is a 404.
@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly service: JobsService) {}

  /** POST /api/v1/jobs - body: JobForm. Step 2: creates a DRAFT job (needs the company profile). */
  @RequirePermission('jobs.write')
  @Post()
  create(@Body() body: unknown): Promise<JobDetail> {
    return this.service.create(body);
  }

  /** GET /api/v1/jobs - newest first */
  @RequirePermission('jobs.read')
  @Get()
  list(): Promise<JobSummary[]> {
    return this.service.list();
  }

  /** GET /api/v1/jobs/:id - job, form, every JD version (newest first) and the approval */
  @RequirePermission('jobs.read')
  @Get(':id')
  get(@Param('id') id: string): Promise<JobDetail> {
    return this.service.get(id);
  }

  /** PATCH /api/v1/jobs/:id - body: JobForm. Not allowed once approved. */
  @RequirePermission('jobs.write')
  @Patch(':id')
  updateForm(@Param('id') id: string, @Body() body: unknown): Promise<JobDetail> {
    return this.service.updateForm(id, body);
  }

  /**
   * DELETE /api/v1/jobs/:id - deletes the job for good, whatever its status: its posts (LinkedIn too), careers page,
   * every application with its resume and ATS result, and its JD versions. Returns posts that must be removed by hand.
   */
  @RequirePermission('jobs.write')
  @Delete(':id')
  remove(@Param('id') id: string): Promise<DeleteJobResult> {
    return this.service.remove(id);
  }

  /** POST /api/v1/jobs/:id/jd/generate - Step 3: AI writes a new JD version from job form + company profile */
  @RequirePermission('jd.generate')
  @Post(':id/jd/generate')
  @HttpCode(200)
  generateJd(@Param('id') id: string): Promise<JobDetail> {
    return this.service.generateJd(id);
  }

  /** PATCH /api/v1/jobs/:id/jd - body: { baseVersionId, content }. Step 4: HR edit, saved as a new version. */
  @RequirePermission('jd.edit')
  @Patch(':id/jd')
  editJd(@Param('id') id: string, @Body() body: unknown): Promise<JobDetail> {
    return this.service.editJd(id, body);
  }

  /** POST /api/v1/jobs/:id/approve - body: { jdVersionId, companyDetailsVerified: true, note? }. Approver = logged-in user. */
  @RequirePermission('jd.approve')
  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown): Promise<JobDetail> {
    return this.service.approve(id, body);
  }
}
