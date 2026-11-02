import { Inject, Injectable } from '@nestjs/common';
import type { Session, SessionCompany } from '@hireflow/contracts';
import type { Membership, Tenant } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import type { AuthInfo } from './access';
import { hashToken, newToken, sessionTtlMs } from './tokens';

type MembershipWithTenant = Membership & { tenant: Tenant };

const toCompany = (m: MembershipWithTenant): SessionCompany => ({
  id: m.tenant.id,
  name: m.tenant.name,
  slug: m.tenant.slug,
  status: m.tenant.status,
  role: m.role,
});

/** Server-side sessions: the cookie holds a random token, the database holds its hash, user and company. */
@Injectable()
export class SessionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Start a session in `tenantId`, or in the user's first company (active companies first). */
  async create(userId: string, tenantId?: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + sessionTtlMs());
    const company = tenantId ?? (await this.activeMemberships(userId))[0]?.tenant.id ?? null;
    await this.prisma.$transaction([
      this.prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } }), // housekeeping
      this.prisma.session.create({ data: { tokenHash: hashToken(token), userId, tenantId: company, expiresAt } }),
    ]);
    return { token, expiresAt };
  }

  /**
   * The session behind a cookie token, or null if unknown/expired/user disabled.
   * The company is re-checked on EVERY request, so disabling a member or changing a role applies immediately.
   */
  async resolve(token: string): Promise<AuthInfo | null> {
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date() || !session.user.isActive) return null;
    const { user } = session;
    let company: SessionCompany | null = null;
    if (session.tenantId) {
      const membership = await this.prisma.membership.findUnique({
        where: { tenantId_userId: { tenantId: session.tenantId, userId: user.id } },
        include: { tenant: true },
      });
      if (membership?.status === 'ACTIVE') company = toCompany(membership);
    }
    return {
      sessionId: session.id,
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin },
      company,
    };
  }

  async destroy(token: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  /** Move the session to another company; null unless the user has an ACTIVE membership there. */
  async switchCompany(sessionId: string, userId: string, tenantId: string): Promise<SessionCompany | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { tenant: true },
    });
    if (membership?.status !== 'ACTIVE') return null;
    await this.prisma.session.update({ where: { id: sessionId }, data: { tenantId } });
    return toCompany(membership);
  }

  /** GET /auth/me body. */
  async describe(auth: AuthInfo): Promise<Session> {
    const companies = (await this.activeMemberships(auth.user.id)).map(toCompany);
    return { user: auth.user, company: auth.company, companies };
  }

  private activeMemberships(userId: string): Promise<MembershipWithTenant[]> {
    return this.prisma.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { tenant: true },
      orderBy: [{ tenant: { status: 'asc' } }, { createdAt: 'asc' }], // ACTIVE companies before SUSPENDED
    });
  }
}
