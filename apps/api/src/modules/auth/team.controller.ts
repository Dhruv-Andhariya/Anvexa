import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { CreatedInvitation, Team } from '@hireflow/contracts';
import { RequirePermission, type AuthRequest } from './access';
import { TeamService } from './team.service';

/** The caller's own company only: the tenant comes from the verified session, never from the URL or body. */
const ctx = (req: AuthRequest) => ({ tenantId: req.auth!.company!.id, actorId: req.auth!.user.id });

@Controller('company')
@RequirePermission('team.manage') // Company Admin only
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  /** GET /api/v1/company/members - members and pending invitations */
  @Get('members')
  list(@Req() req: AuthRequest): Promise<Team> {
    return this.team.team(ctx(req).tenantId);
  }

  /** POST /api/v1/company/invitations - body: { email, role }. Returns the one-time invite link. */
  @Post('invitations')
  invite(@Req() req: AuthRequest, @Body() body: unknown): Promise<CreatedInvitation> {
    const { tenantId, actorId } = ctx(req);
    return this.team.invite(tenantId, actorId, body);
  }

  /** DELETE /api/v1/company/invitations/:id */
  @Delete('invitations/:id')
  @HttpCode(204)
  revoke(@Req() req: AuthRequest, @Param('id') id: string): Promise<void> {
    const { tenantId, actorId } = ctx(req);
    return this.team.revokeInvitation(tenantId, actorId, id);
  }

  /** PATCH /api/v1/company/members/:userId - body: { role?, status? } */
  @Patch('members/:userId')
  update(@Req() req: AuthRequest, @Param('userId') userId: string, @Body() body: unknown): Promise<Team> {
    const { tenantId, actorId } = ctx(req);
    return this.team.updateMember(tenantId, actorId, userId, body);
  }
}
