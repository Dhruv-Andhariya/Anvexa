import { Controller, Get, Header, Inject, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import type { DsaProctoringReview } from '@hireflow/contracts';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { PrismaProctorStore } from './proctoring/prisma-proctor.store';
import { ProctoringService } from './proctoring/proctoring.service';

/** At most this many events per round are sent to the HR page (the full log stays in the database). */
const EVENT_LIMIT = 300;

/**
 * HR's review of what the browser noticed during a student's DSA coding round. The company comes from the HR session:
 * another company's application id finds nothing (an empty list). Read-only.
 */
@Controller('dsa-hr')
@UseGuards(featureFlag('dsa'))
export class DsaHrController {
  constructor(
    @Inject(PrismaProctorStore) private readonly store: PrismaProctorStore,
    @Inject(ProctoringService) private readonly proctoring: ProctoringService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/dsa-hr/applications/:applicationId/proctoring */
  @RequirePermission('jobs.read')
  @Get('applications/:applicationId/proctoring')
  @Header('Cache-Control', 'no-store')
  async review(@Param('applicationId', ParseUUIDPipe) applicationId: string): Promise<DsaProctoringReview> {
    const rows = await this.store.forApplication(await this.tenant.currentTenantId(), applicationId);
    return {
      applicationId,
      rounds: rows.map(({ roundId, session }) => {
        const { summary: s, events } = this.proctoring.reviewOf(session, EVENT_LIMIT);
        return {
          roundId,
          status: s.status,
          flagged: s.flagged,
          reasons: s.reasons,
          totalViolations: s.totalViolations,
          strikesAllowed: s.strikesAllowed,
          strikesUsed: s.strikesUsed,
          fullscreenExitCount: s.fullscreenExitCount,
          tabSwitchCount: s.tabSwitchCount,
          copyPasteAttempts: s.copyPasteAttempts,
          devToolsAttempts: s.devToolsAttempts,
          totalTimeOutsideMs: s.totalTimeOutsideMs,
          events: events.map((e) => ({ type: e.type, severity: e.severity, at: e.at, durationMs: e.durationMs, detail: e.detail })),
        };
      }),
    };
  }
}
