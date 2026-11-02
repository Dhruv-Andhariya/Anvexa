import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  companyProfileSchema,
  updateCompanyRequestSchema,
  type CompanyDetail,
  type CompanySummary,
  type Session,
} from '@hireflow/contracts';
import { Prisma, type Tenant } from '@prisma/client';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import { SessionsService, TeamService, type AuthInfo } from '../auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTS = { _count: { select: { memberships: { where: { status: 'ACTIVE' } }, jobs: true } } } as const;

type TenantWithCounts = Tenant & { _count: { memberships: number; jobs: number } };

const toSummary = (t: TenantWithCounts): CompanySummary => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  status: t.status,
  memberCount: t._count.memberships,
  jobCount: t._count.jobs,
  createdAt: t.createdAt.toISOString(),
});

/** "Acme Analytics Pvt. Ltd." -> "acme-analytics-pvt-ltd" (internal id only, never typed by users). */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'company';

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Companies.
 * - Any logged-in user registers THEIR OWN company and becomes its Company Admin (self-service onboarding).
 * - The Platform Admin only lists, views and suspends/activates companies. It never reads jobs or JDs.
 */
@Injectable()
export class CompaniesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * POST /companies: body is the company profile (step 1 of the JD flow). In one transaction this creates the
   * company, its profile and the caller's COMPANY_ADMIN membership, then switches the session to the new company.
   */
  async register(auth: AuthInfo, input: unknown): Promise<Session> {
    const profile = parseBody(companyProfileSchema, input, 'INVALID_COMPANY_PROFILE', 'The company profile is invalid.');
    const tenant = await this.createWithUniqueSlug(profile.name, (slug) =>
      this.prisma.tenant.create({
        data: {
          name: profile.name,
          slug,
          companyProfile: { create: profile },
          memberships: { create: { userId: auth.user.id, role: 'COMPANY_ADMIN' } },
        },
      }),
    );
    await this.audit.record({ tenantId: tenant.id, actorUserId: auth.user.id, action: 'company.registered', subjectType: 'company', subjectId: tenant.id });

    const company = await this.sessions.switchCompany(auth.sessionId, auth.user.id, tenant.id);
    return this.sessions.describe({ ...auth, company });
  }

  async list(): Promise<CompanySummary[]> {
    const rows = await this.prisma.tenant.findMany({ orderBy: { createdAt: 'desc' }, include: COUNTS });
    return rows.map(toSummary);
  }

  async get(id: string): Promise<CompanyDetail> {
    const row = UUID.test(id) ? await this.prisma.tenant.findUnique({ where: { id }, include: COUNTS }) : null;
    if (!row) throw notFound();
    return { ...toSummary(row), ...(await this.team.team(id)) };
  }

  /** Suspend or re-activate. Suspended companies keep all data; their members get 403 COMPANY_SUSPENDED. */
  async update(actorId: string, id: string, input: unknown): Promise<CompanyDetail> {
    const { status } = parseBody(updateCompanyRequestSchema, input, 'INVALID_COMPANY', 'The company update is invalid.');
    const { count } = UUID.test(id) ? await this.prisma.tenant.updateMany({ where: { id }, data: { status } }) : { count: 0 };
    if (count !== 1) throw notFound();
    await this.audit.record({
      tenantId: id,
      actorUserId: actorId,
      action: status === 'SUSPENDED' ? 'company.suspended' : 'company.activated',
      subjectType: 'company',
      subjectId: id,
    });
    return this.get(id);
  }

  /** Two companies may share a name; the slug gets a short random suffix when the plain one is taken. */
  private async createWithUniqueSlug(name: string, create: (slug: string) => Promise<Tenant>): Promise<Tenant> {
    const base = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        return await create(slug);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw apiError(HttpStatus.CONFLICT, 'COMPANY_REGISTRATION_FAILED', 'Could not register the company. Please try again.');
  }
}

const notFound = () => apiError(HttpStatus.NOT_FOUND, 'COMPANY_NOT_FOUND', 'Company not found.');
