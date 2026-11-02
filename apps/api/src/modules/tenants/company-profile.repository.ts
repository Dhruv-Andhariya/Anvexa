import { Inject, Injectable } from '@nestjs/common';
import type { CompanyProfile as CompanyProfileRow } from '@prisma/client';
import type { CompanyProfile, CompanyProfileRecord } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';

/** Storage for the one company profile each tenant has. */
export abstract class CompanyProfileRepository {
  abstract find(tenantId: string): Promise<CompanyProfileRecord | null>;
  abstract save(tenantId: string, profile: CompanyProfile): Promise<CompanyProfileRecord>;
}

@Injectable()
export class PrismaCompanyProfileRepository extends CompanyProfileRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async find(tenantId: string) {
    const row = await this.prisma.companyProfile.findUnique({ where: { tenantId } });
    return row ? toRecord(row) : null;
  }

  async save(tenantId: string, profile: CompanyProfile) {
    // optional fields the user cleared must become NULL, not "unchanged"
    const data = {
      name: profile.name,
      industry: profile.industry,
      description: profile.description,
      productsServices: profile.productsServices ?? null,
      website: profile.website ?? null,
      careersUrl: profile.careersUrl ?? null,
      headquarters: profile.headquarters ?? null,
      companySize: profile.companySize ?? null,
      foundedYear: profile.foundedYear ?? null,
      culture: profile.culture ?? null,
      benefits: profile.benefits,
    };
    const [row] = await this.prisma.$transaction([
      this.prisma.companyProfile.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data }),
      this.prisma.tenant.update({ where: { id: tenantId }, data: { name: profile.name } }),
    ]);
    return toRecord(row);
  }
}

function toRecord(row: CompanyProfileRow): CompanyProfileRecord {
  const optional = <T>(v: T | null) => v ?? undefined;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    description: row.description,
    productsServices: optional(row.productsServices),
    website: optional(row.website),
    careersUrl: optional(row.careersUrl),
    headquarters: optional(row.headquarters),
    companySize: optional(row.companySize) as CompanyProfile['companySize'],
    foundedYear: optional(row.foundedYear),
    culture: optional(row.culture),
    benefits: row.benefits,
    updatedAt: row.updatedAt.toISOString(),
  };
}
