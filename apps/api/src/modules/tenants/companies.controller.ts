import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { CompanyDetail, CompanySummary, Session } from '@hireflow/contracts';
import { Authenticated, PlatformAdminOnly, type AuthInfo, type AuthRequest } from '../auth';
import { CompaniesService } from './companies.service';

/** Self-service onboarding: a logged-in HR person registers their company and becomes its Company Admin. */
@Controller('companies')
export class CompanyRegistrationController {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  /** POST /api/v1/companies - body: CompanyProfile. Returns the Session, now working in the new company. */
  @Authenticated()
  @Post()
  register(@Req() req: AuthRequest, @Body() body: unknown): Promise<Session> {
    return this.companies.register(req.auth as AuthInfo, body);
  }
}

/** Platform-level company oversight. Platform Admin only; returns no jobs, JDs or profiles. */
@Controller('admin/companies')
@PlatformAdminOnly()
export class CompaniesController {
  constructor(@Inject(CompaniesService) private readonly companies: CompaniesService) {}

  /** GET /api/v1/admin/companies */
  @Get()
  list(): Promise<CompanySummary[]> {
    return this.companies.list();
  }

  /** GET /api/v1/admin/companies/:id - company, members and pending invitations */
  @Get(':id')
  get(@Param('id') id: string): Promise<CompanyDetail> {
    return this.companies.get(id);
  }

  /** PATCH /api/v1/admin/companies/:id - body: { status: 'ACTIVE' | 'SUSPENDED' } */
  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown): Promise<CompanyDetail> {
    return this.companies.update(req.auth!.user.id, id, body);
  }
}
