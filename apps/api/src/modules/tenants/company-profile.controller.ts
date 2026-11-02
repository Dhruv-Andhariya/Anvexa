import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { CompanyProfileRecord } from '@hireflow/contracts';
import { RequirePermission } from '../auth';
import { CompanyProfileService } from './company-profile.service';

// The company is always the caller's own (from the session); there is no company id in these routes.
@Controller('company-profile')
export class CompanyProfileController {
  constructor(@Inject(CompanyProfileService) private readonly service: CompanyProfileService) {}

  /** GET /api/v1/company-profile - 404 COMPANY_PROFILE_NOT_FOUND until step 1 is done */
  @Get()
  @RequirePermission('company.read')
  get(): Promise<CompanyProfileRecord> {
    return this.service.get();
  }

  /** PUT /api/v1/company-profile - body: CompanyProfile. Creates the profile or replaces it. Company Admin only. */
  @Put()
  @RequirePermission('company.update')
  save(@Body() body: unknown): Promise<CompanyProfileRecord> {
    return this.service.save(body);
  }
}
