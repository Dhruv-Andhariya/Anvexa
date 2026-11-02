import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { companyProfileSchema, type CompanyProfileRecord } from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { AuditService } from '../audit';
import { CompanyProfileRepository } from './company-profile.repository';
import { TenantContext } from './tenant-context';

@Injectable()
export class CompanyProfileService {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(CompanyProfileRepository) private readonly repo: CompanyProfileRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Step 1: the Company Admin saves the profile once; saving again updates it (jobs keep the snapshot they were written with). */
  async save(input: unknown): Promise<CompanyProfileRecord> {
    const profile = parseBody(companyProfileSchema, input, 'INVALID_COMPANY_PROFILE', 'The company profile is invalid.');
    const tenantId = await this.tenant.currentTenantId();
    const saved = await this.repo.save(tenantId, profile);
    const actor = await this.tenant.currentActor();
    await this.audit.record({ tenantId, actorUserId: actor.id, action: 'company_profile.saved', subjectType: 'company_profile', subjectId: saved.id });
    return saved;
  }

  async find(): Promise<CompanyProfileRecord | null> {
    return this.repo.find(await this.tenant.currentTenantId());
  }

  async get(): Promise<CompanyProfileRecord> {
    const profile = await this.find();
    if (!profile) {
      throw apiError(HttpStatus.NOT_FOUND, 'COMPANY_PROFILE_NOT_FOUND', 'No company profile has been saved yet.');
    }
    return profile;
  }

  /** Step 2: jobs cannot be created or generated before the company profile exists. */
  async require(): Promise<CompanyProfileRecord> {
    const profile = await this.find();
    if (!profile) {
      throw apiError(
        HttpStatus.CONFLICT,
        'COMPANY_PROFILE_REQUIRED',
        'Save your company profile before creating a job.',
      );
    }
    return profile;
  }
}
