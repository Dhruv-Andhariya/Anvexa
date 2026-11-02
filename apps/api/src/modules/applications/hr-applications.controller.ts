import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, StreamableFile, UseGuards } from '@nestjs/common';
import type { JobApplications } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { HrApplicationsService } from './hr-applications.service';

/** Content-Disposition for a student's file name: plain ASCII fallback + the exact UTF-8 name (RFC 6266/5987). */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'resume';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * M09 for HR: the applications of the caller's own company (company from the session via TenantContext).
 * Read-only. Uses 'jobs.read': everyone who can see the company's jobs can see who applied to them.
 */
@Controller('applications')
@UseGuards(featureFlag('publisher'))
export class HrApplicationsController {
  constructor(
    @Inject(HrApplicationsService) private readonly service: HrApplicationsService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/applications/jobs/:jobId - every application of one job, newest first. */
  @RequirePermission('jobs.read')
  @Get('jobs/:jobId')
  @Header('Cache-Control', 'private, no-store')
  async forJob(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobApplications> {
    return this.service.listForJob(await this.tenant.currentTenantId(), jobId);
  }

  /** GET /api/v1/applications/:applicationId/resume - the resume file, always as a download (never shown inline). */
  @RequirePermission('jobs.read')
  @Get(':applicationId/resume')
  @Header('Cache-Control', 'private, no-store')
  async resume(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<StreamableFile> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    const file = await this.service.resume(tenantId, applicationId, actor);
    return new StreamableFile(file.bytes, {
      type: file.mimeType,
      length: file.bytes.length,
      disposition: attachmentHeader(file.fileName),
    });
  }
}
