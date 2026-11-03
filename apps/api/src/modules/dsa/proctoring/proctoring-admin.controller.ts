import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, HttpStatus, Headers, Inject, Param, Query } from '@nestjs/common';
import { Public } from '../../auth';
import { dsaError } from '../dsa.dto';
import { ProctoringService, type ProctorEventView } from './proctoring.service';
import type { ProctoringSummary } from './proctoring.types';

/**
 * HR / reviewer reporting.
 *
 * TEMPORARY GUARD, closed by default. These routes are marked @Public only so the global AuthGuard lets them reach
 * the check below: a shared service key in `x-dsa-admin-key` (env DSA_ADMIN_API_KEY). With no key configured they
 * answer 404, so a deployment that does nothing exposes nothing.
 *
 * Why not `@RequirePermission('jobs.read')` yet: a DSA invitation does not carry a company (tenant) id, so a
 * session-based check could not stop one company's HR user from listing another company's flagged candidates
 * (`/flagged` has no tenant filter). Once the invitation carries `tenantId`, switch to @RequirePermission and filter
 * every query by the session's company (see docs/dsa-proctoring-implementation.md, "HR integration contract").
 * Records are addressed by `inviteRef`, a hash of the invitation token.
 */
function requireAdmin(header: string | undefined): void {
  const expected = process.env.DSA_ADMIN_API_KEY;
  if (!expected) throw dsaError(HttpStatus.NOT_FOUND, 'ADMIN_DISABLED', 'Not found.');
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw dsaError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Missing or invalid key.');
}

const clampInt = (v: string | undefined, fallback: number, max: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};

@Public() // see the note above: the shared-key check inside each handler is the real guard
@Controller('dsa-admin/proctoring')
export class ProctoringAdminController {
  constructor(@Inject(ProctoringService) private readonly proctoring: ProctoringService) {}

  /** GET /api/v1/dsa-admin/proctoring/flagged - attempts that need a person to look at them, worst first. */
  @Get('flagged')
  async flagged(@Headers('x-dsa-admin-key') key?: string): Promise<{ flagged: ProctoringSummary[] }> {
    requireAdmin(key);
    return { flagged: await this.proctoring.flagged() };
  }

  /** GET /api/v1/dsa-admin/proctoring/:inviteRef/summary */
  @Get(':inviteRef/summary')
  async summary(@Param('inviteRef') inviteRef: string, @Headers('x-dsa-admin-key') key?: string): Promise<ProctoringSummary> {
    requireAdmin(key);
    const s = await this.proctoring.summary(inviteRef);
    if (!s) throw dsaError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No proctoring record for this invitation.');
    return s;
  }

  /** GET /api/v1/dsa-admin/proctoring/:inviteRef/events?limit=100&offset=0 */
  @Get(':inviteRef/events')
  async events(
    @Param('inviteRef') inviteRef: string,
    @Headers('x-dsa-admin-key') key?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ total: number; events: ProctorEventView[] }> {
    requireAdmin(key);
    const page = await this.proctoring.events(inviteRef, clampInt(limit, 100, 500), clampInt(offset, 0, 100_000));
    if (!page) throw dsaError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'No proctoring record for this invitation.');
    return page;
  }
}
