import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  inviteMemberRequestSchema,
  updateMemberRequestSchema,
  type CompanyRole,
  type CreatedInvitation,
  type Invitation,
  type Member,
  type Team,
} from '@hireflow/contracts';
import { Prisma, type Invitation as InvitationRow } from '@prisma/client';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import type { Mailer } from '../applications/email/mailer'; // leaf file; the module index would be an import cycle
import { AuditService } from '../audit';
import { buildInvitationEmail } from './invitation-email';
import { AUTH_MAILER } from './password-reset.service';
import { appUrl, hashToken, invitationTtlMs, newToken } from './tokens';

const toInvitation = (row: InvitationRow): Invitation => ({
  id: row.id,
  email: row.email,
  role: row.role,
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

/** Company membership and invitations. Every method takes the tenant id from the CALLER's verified context. */
@Injectable()
export class TeamService {
  private readonly logger = new Logger('Team');

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH_MAILER) private readonly mailer: Mailer,
  ) {}

  async team(tenantId: string): Promise<Team> {
    const [members, invitations] = await Promise.all([
      this.prisma.membership.findMany({ where: { tenantId }, include: { user: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.invitation.findMany({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      members: members.map(
        (m): Member => ({
          userId: m.userId,
          email: m.user.email,
          name: m.user.name,
          role: m.role,
          status: m.status,
          joinedAt: m.createdAt.toISOString(),
        }),
      ),
      invitations: invitations.map(toInvitation),
    };
  }

  /** Company Admin invites a member (POST /company/invitations). */
  invite(tenantId: string, actorId: string, input: unknown): Promise<CreatedInvitation> {
    const req = parseBody(inviteMemberRequestSchema, input, 'INVALID_INVITATION', 'The invitation is invalid.');
    return this.createInvitation(tenantId, actorId, req.email, req.role);
  }

  /**
   * One live invitation per (company, email): older pending ones are revoked.
   * The link is emailed to the invitee and also returned (the only other copy of the token) so it can be shared by hand.
   */
  async createInvitation(tenantId: string, actorId: string, email: string, role: CompanyRole): Promise<CreatedInvitation> {
    const db = this.prisma;
    const member = await db.membership.findFirst({ where: { tenantId, status: 'ACTIVE', user: { email } } });
    if (member) throw apiError(HttpStatus.CONFLICT, 'ALREADY_MEMBER', 'This person is already a member of the company.');

    const token = newToken();
    await db.invitation.updateMany({
      where: { tenantId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const row = await db.invitation.create({
      data: { tenantId, email, role, tokenHash: hashToken(token), invitedById: actorId, expiresAt: new Date(Date.now() + invitationTtlMs()) },
    });
    await this.audit.record({
      tenantId,
      actorUserId: actorId,
      action: 'invitation.created',
      subjectType: 'invitation',
      subjectId: row.id,
      metadata: { email, role },
    });
    const inviteUrl = `${appUrl()}/invite/${token}`;
    // in the background, so creating the invitation never waits for (or fails on) the mail server
    void this.sendInvitation(tenantId, actorId, row.email, role, inviteUrl, row.expiresAt);
    return { ...toInvitation(row), inviteUrl };
  }

  private async sendInvitation(tenantId: string, actorId: string, to: string, role: CompanyRole, link: string, expiresAt: Date) {
    if (!this.mailer.enabled) {
      if (process.env.NODE_ENV === 'production') this.logger.error('email is not configured: invitation NOT emailed');
      // local dev without SMTP: the dashboard still shows the link to copy
      else this.logger.warn('email is off - invitation not emailed, share the link from the dashboard');
      return;
    }
    try {
      const [tenant, inviter] = await Promise.all([
        this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { companyProfile: true } }),
        this.prisma.user.findUnique({ where: { id: actorId } }),
      ]);
      const companyName = tenant?.companyProfile?.name || tenant?.name || 'your company';
      await this.mailer.send(to, buildInvitationEmail({ companyName, inviterName: inviter?.name ?? null, role, link, expiresAt }));
    } catch (err) {
      this.logger.warn(`invitation email not sent (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }

  async revokeInvitation(tenantId: string, actorId: string, invitationId: string): Promise<void> {
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, tenantId, acceptedAt: null, revokedAt: null }, // tenant-scoped: other companies' ids miss
      data: { revokedAt: new Date() },
    });
    if (count !== 1) throw apiError(HttpStatus.NOT_FOUND, 'INVITATION_NOT_FOUND', 'Invitation not found.');
    await this.audit.record({ tenantId, actorUserId: actorId, action: 'invitation.revoked', subjectType: 'invitation', subjectId: invitationId });
  }

  /** Change a member's role or (de)activate them. A company can never be left without an active Company Admin. */
  async updateMember(tenantId: string, actorId: string, userId: string, input: unknown): Promise<Team> {
    const change = parseBody(updateMemberRequestSchema, input, 'INVALID_MEMBER_UPDATE', 'The member update is invalid.');
    const notFound = () => apiError(HttpStatus.NOT_FOUND, 'MEMBER_NOT_FOUND', 'Member not found.');
    if (!UUID.test(userId)) throw notFound();

    await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.membership.updateMany({ where: { tenantId, userId }, data: change });
        if (count !== 1) throw notFound();
        const admins = await tx.membership.count({ where: { tenantId, role: 'COMPANY_ADMIN', status: 'ACTIVE' } });
        if (admins === 0) {
          throw apiError(HttpStatus.CONFLICT, 'LAST_COMPANY_ADMIN', 'The company must keep at least one active Company Admin.');
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }, // two admins demoting each other at once
    );
    await this.audit.record({
      tenantId,
      actorUserId: actorId,
      action: 'membership.updated',
      subjectType: 'user',
      subjectId: userId,
      metadata: change,
    });
    return this.team(tenantId);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
