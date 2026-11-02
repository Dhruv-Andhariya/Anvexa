import { randomUUID } from 'node:crypto';
import type { CompanyProfile, CompanyProfileRecord, JobDetail, JobForm } from '@hireflow/contracts';
import { CompanyProfileRepository } from '../src/modules/tenants/company-profile.repository';
import { AuditService, type AuditEntry } from '../src/modules/audit';
import { TenantContext } from '../src/modules/tenants/tenant-context';
import { JobsRepository, type NewApproval, type NewJdVersion } from '../src/modules/jobs/jobs.repository';

/** Database-free stand-ins with the same compare-and-set rules as the Prisma repositories. */

export class FixedTenant extends TenantContext {
  constructor(
    readonly id = randomUUID(),
    readonly actor = { id: randomUUID(), name: 'Priya Shah' },
  ) {
    super();
  }
  async currentTenantId() {
    return this.id;
  }
  async currentActor() {
    return this.actor;
  }
}

export class MemoryAudit extends AuditService {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry) {
    this.entries.push(entry);
  }
}

export class InMemoryCompanyProfiles extends CompanyProfileRepository {
  readonly rows = new Map<string, CompanyProfileRecord>();

  async find(tenantId: string) {
    return this.rows.get(tenantId) ?? null;
  }
  async save(tenantId: string, profile: CompanyProfile) {
    const record = { ...profile, id: this.rows.get(tenantId)?.id ?? randomUUID(), updatedAt: new Date().toISOString() };
    this.rows.set(tenantId, record);
    return record;
  }
}

export class InMemoryJobs extends JobsRepository {
  readonly jobs = new Map<string, JobDetail & { tenantId: string }>();
  readonly createdBy = new Map<string, string>();

  async create(tenantId: string, form: JobForm, createdById: string) {
    const now = new Date().toISOString();
    const job = {
      tenantId,
      id: randomUUID(),
      title: form.title,
      status: 'DRAFT' as const,
      versionCount: 0,
      createdAt: now,
      updatedAt: now,
      form,
      currentJdVersionId: null,
      versions: [],
      approval: null,
    };
    this.jobs.set(job.id, job);
    this.createdBy.set(job.id, createdById);
    return this.strip(job);
  }
  async list(tenantId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.tenantId === tenantId)
      .reverse()
      .map(({ id, title, status, versionCount, createdAt, updatedAt }) => ({ id, title, status, versionCount, createdAt, updatedAt }));
  }
  async get(tenantId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    return job && job.tenantId === tenantId ? this.strip(job) : null;
  }
  async updateForm(tenantId: string, jobId: string, form: JobForm) {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId || job.status === 'APPROVED') return false;
    // A new form means the current JD no longer matches it (like PrismaJobsRepository.updateForm).
    Object.assign(job, { form, title: form.title, currentJdVersionId: null, status: 'DRAFT' });
    return true;
  }
  async appendVersion(tenantId: string, jobId: string, expectedCurrent: string | null, v: NewJdVersion) {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId || job.status === 'APPROVED' || job.currentJdVersionId !== expectedCurrent) return false;
    const { createdBy: _by, ...rest } = v;
    const version = {
      id: randomUUID(),
      version: job.versions.length + 1,
      ...rest,
      companySnapshot: v.companySnapshot as Record<string, unknown> | null,
      createdAt: new Date().toISOString(),
    };
    job.versions = [version, ...job.versions];
    Object.assign(job, { currentJdVersionId: version.id, status: 'JD_GENERATED', versionCount: job.versions.length });
    return true;
  }
  async approve(tenantId: string, jobId: string, a: NewApproval) {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId || job.status === 'APPROVED' || job.currentJdVersionId !== a.jdVersionId) return false;
    Object.assign(job, { status: 'APPROVED', approval: { id: randomUUID(), ...a, approvedAt: new Date().toISOString() } });
    return true;
  }

  async delete(tenantId: string, jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.tenantId !== tenantId) return false;
    this.jobs.delete(jobId);
    return true;
  }

  private strip({ tenantId: _t, ...job }: JobDetail & { tenantId: string }): JobDetail {
    return structuredClone(job);
  }
}
