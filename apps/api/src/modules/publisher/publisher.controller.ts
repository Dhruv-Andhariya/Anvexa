import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import {
  channelKeySchema,
  type ChannelInfo,
  type PublishableJob,
  type PublishPreview,
  type PublishResult,
  type RefreshLinksResult,
  type UnpublishResult,
} from '@hireflow/contracts';
import { z } from 'zod';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { publisherError } from './jd-checks';
import { PublisherService } from './publisher.service';

/** Non-secret channel settings only (e.g. LinkedIn organizationId). Tokens never go through this endpoint. */
const channelSettingSchema = z.object({
  enabled: z.boolean(),
  config: z.record(z.string().max(200)).refine((c) => Object.keys(c).length <= 10).default({}),
});

/**
 * M06 publisher, for HR. Every route works on the caller's own company (from the session, via TenantContext);
 * a job id from another company is a 404. Publishing re-uses the 'jd.approve' permission: whoever may approve
 * a JD may also put the approved JD live.
 */
@Controller('publisher')
@UseGuards(featureFlag('publisher'))
export class PublisherController {
  constructor(
    @Inject(PublisherService) private readonly service: PublisherService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/publisher/channels - live and coming-soon channels for this company. */
  @RequirePermission('jobs.read')
  @Get('channels')
  async channels(): Promise<ChannelInfo[]> {
    return this.service.channels(await this.tenant.currentTenantId());
  }

  /** GET /api/v1/publisher/jobs - every APPROVED job with its listing, per-channel status and application count. */
  @RequirePermission('jobs.read')
  @Get('jobs')
  async jobs(): Promise<PublishableJob[]> {
    return this.service.listJobs(await this.tenant.currentTenantId());
  }

  /** POST /api/v1/publisher/jobs/:jobId/preview - body { selectionProcess }; what every channel would post. Saves nothing. */
  @RequirePermission('jobs.read')
  @Post('jobs/:jobId/preview')
  @HttpCode(200)
  async preview(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<PublishPreview> {
    return this.service.preview(await this.tenant.currentTenantId(), jobId, body);
  }

  /** POST /api/v1/publisher/jobs/:jobId/publish - body { selectionProcess }; publishes the APPROVED JD everywhere. */
  @RequirePermission('jd.approve')
  @Post('jobs/:jobId/publish')
  @HttpCode(200)
  async publish(@Param('jobId', ParseUUIDPipe) jobId: string, @Body() body: unknown): Promise<PublishResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.publish(tenantId, jobId, body, actor);
  }

  /** POST /api/v1/publisher/jobs/:jobId/retry - re-try channels that failed or were not configured. */
  @RequirePermission('jd.approve')
  @Post('jobs/:jobId/retry')
  @HttpCode(200)
  async retry(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<PublishResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.retry(tenantId, jobId, actor);
  }

  /** POST /api/v1/publisher/jobs/:jobId/close - stop taking applications (careers page shows "closed"). */
  @RequirePermission('jd.approve')
  @Post('jobs/:jobId/close')
  @HttpCode(200)
  async close(@Param('jobId', ParseUUIDPipe) jobId: string) {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.close(tenantId, jobId, actor);
  }

  /** POST /api/v1/publisher/jobs/:jobId/reopen - take applications again. */
  @RequirePermission('jd.approve')
  @Post('jobs/:jobId/reopen')
  @HttpCode(200)
  async reopen(@Param('jobId', ParseUUIDPipe) jobId: string) {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.reopen(tenantId, jobId, actor);
  }

  /**
   * DELETE /api/v1/publisher/jobs/:jobId - take the job off the careers page and every channel ("Not published"
   * again, can be published fresh later). The job, its approved JD and its applications stay.
   */
  @RequirePermission('jd.approve')
  @Delete('jobs/:jobId')
  async unpublish(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<UnpublishResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.unpublish(tenantId, jobId, actor);
  }

  /**
   * POST /api/v1/publisher/jobs/:jobId/refresh-links - edit the posts already made (same posts) so they carry the
   * current apply link, e.g. after the public careers-site URL changed.
   */
  @RequirePermission('jd.approve')
  @Post('jobs/:jobId/refresh-links')
  @HttpCode(200)
  async refreshLinks(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<RefreshLinksResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.service.refreshLinks(tenantId, jobId, actor);
  }

  /** GET /api/v1/publisher/jobs/:jobId/posts - per-channel status. */
  @RequirePermission('jobs.read')
  @Get('jobs/:jobId/posts')
  async posts(@Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.service.posts(await this.tenant.currentTenantId(), jobId);
  }

  /** PUT /api/v1/publisher/channels/:channel/settings - e.g. LinkedIn {"enabled":true,"config":{"organizationId":"123"}}. */
  @RequirePermission('company.update')
  @Put('channels/:channel/settings')
  @HttpCode(204)
  async putChannelSetting(@Param('channel') channel: string, @Body() body: unknown) {
    if (!channelKeySchema.safeParse(channel).success) {
      throw publisherError(HttpStatus.BAD_REQUEST, 'INVALID_CHANNEL', 'Unknown channel.');
    }
    const parsed = channelSettingSchema.safeParse(body);
    if (!parsed.success) {
      throw publisherError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'The channel settings are invalid.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    await this.service.setChannelSetting(tenantId, channel, { enabled: parsed.data.enabled, config: parsed.data.config }, actor);
  }
}
