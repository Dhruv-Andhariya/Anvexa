import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { CodingProblemsResult } from '@hireflow/contracts';
import { featureFlag } from '../../../common/feature-flags';
import { RequirePermission } from '../../auth';
import { TenantContext } from '../../tenants';
import { CODING_UPLOAD_LIMITS, CodingAuthorService } from './coding-author.service';

/**
 * HR's rounds editor, DSA coding round: problems from the AI or from HR's own file, returned for review (nothing is
 * saved here). Company from the session; another company's job is a 404. Never public.
 */
@Controller('dsa-hr/jobs/:jobId/coding-problems')
@UseGuards(featureFlag('dsa'))
export class CodingAuthorController {
  constructor(
    @Inject(CodingAuthorService) private readonly service: CodingAuthorService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** POST /api/v1/dsa-hr/jobs/:jobId/coding-problems/generate - body { count, difficulty, topics, avoid }. */
  @RequirePermission('jobs.write')
  @Post('generate')
  @HttpCode(200)
  async generate(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<CodingProblemsResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.generate(tenantId, jobId, body, actor);
  }

  /** POST /api/v1/dsa-hr/jobs/:jobId/coding-problems/import - multipart, field "file": a PDF, Word (.docx) or CSV file. */
  @RequirePermission('jobs.write')
  @Post('import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CODING_UPLOAD_LIMITS.maxBytes, files: 1, fields: 5 }, defParamCharset: 'utf8' }))
  async import(@Param('jobId', ParseUUIDPipe) jobId: string, @UploadedFile() file: Express.Multer.File | undefined): Promise<CodingProblemsResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.importFile(tenantId, jobId, file, actor);
  }
}
