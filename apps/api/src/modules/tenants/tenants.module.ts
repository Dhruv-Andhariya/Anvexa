import { Module } from '@nestjs/common';
import { AuthModule } from '../auth';
import { CompaniesController, CompanyRegistrationController } from './companies.controller';
import { CompaniesService } from './companies.service';
import { CompanyProfileController } from './company-profile.controller';
import { CompanyProfileRepository, PrismaCompanyProfileRepository } from './company-profile.repository';
import { CompanyProfileService } from './company-profile.service';
import { RequestTenantContext, TenantContext } from './tenant-context';

@Module({
  imports: [AuthModule],
  controllers: [CompanyProfileController, CompanyRegistrationController, CompaniesController],
  providers: [
    CompanyProfileService,
    CompaniesService,
    { provide: TenantContext, useClass: RequestTenantContext },
    { provide: CompanyProfileRepository, useClass: PrismaCompanyProfileRepository },
  ],
  exports: [CompanyProfileService, TenantContext],
})
export class TenantsModule {}
