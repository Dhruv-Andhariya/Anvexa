import { Body, Controller, Get, Header, Inject, Param, ParseIntPipe, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import type { DsaProctoringReview } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { ProctoringHrService } from './proctoring/proctoring-hr.service';

/**
 * HR's review of what was noticed during a student's DSA / SQL coding round(s): warnings, incidents, termination. The
 * company comes from the HR session: another company's application id finds nothing (an empty list / 404).
 */
@Controller('dsa-hr')
@UseGuards(featureFlag('dsa'))
export class DsaHrController {
  constructor(
    @Inject(ProctoringHrService) private readonly hr: ProctoringHrService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/dsa-hr/applications/:applicationId/proctoring */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId/proctoring')
  @Header('Cache-Control', 'no-store')
  async review(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<DsaProctoringReview> {
    return this.hr.review(await this.tenant.currentTenantId(), applicationId);
  }

  /**
   * PUT /api/v1/dsa-hr/applications/:applicationId/proctoring/:roundId/incidents/:incidentId/review - body
   * { status: CONFIRMED | DISMISSED | NEEDS_REVIEW, reason }. Audited; never changes a score or a warning count.
   */
  @RequirePermission('jobs.write')
  @Put('applications/:applicationId/proctoring/:roundId/incidents/:incidentId/review')
  @Header('Cache-Control', 'no-store')
  async reviewIncident(
    @Param('applicationId', ParseUUIDPipe) applicationId: string,
    @Param('roundId', ParseUUIDPipe) roundId: string,
    @Param('incidentId', ParseIntPipe) incidentId: number,
    @Body() body: unknown,
  ): Promise<DsaProctoringReview> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.hr.reviewIncident(tenantId, applicationId, roundId, incidentId, body, actor);
  }
}
