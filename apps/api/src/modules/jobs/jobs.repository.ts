import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type JdVersion as JdVersionRow, type Job as JobRow, type JobApproval as ApprovalRow } from '@prisma/client';
import type { CompanyProfile, JdContent, JdVersion, JobApproval, JobDetail, JobForm, JobSummary } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';

export interface NewJdVersion {
  source: JdVersion['source'];
  content: JdContent;
  companySnapshot: CompanyProfile | null;
  promptVersion: string | null;
  model: string | null;
  createdBy: string; // user id
}

export interface NewApproval {
  jdVersionId: string;
  approvedBy: string; // display name
  approvedById: string;
  companyDetailsVerified: boolean;
  note: string | null;
}

/**
 * Storage for jobs, their JD versions and approvals. Every method is scoped by tenantId.
 * Write methods return false when the job changed underneath the caller (approved, or a newer version exists),
 * so two tabs can never overwrite each other or approve a stale draft.
 */
export abstract class JobsRepository {
  abstract create(tenantId: string, form: JobForm, createdById: string): Promise<JobDetail>;
  abstract list(tenantId: string): Promise<JobSummary[]>;
  abstract get(tenantId: string, jobId: string): Promise<JobDetail | null>;
  /**
   * Replace the job form while the job is not approved. The current JD was written from the old form, so it stops
   * being current (currentJdVersionId = null, status DRAFT) and cannot be approved; its versions stay in the history.
   */
  abstract updateForm(tenantId: string, jobId: string, form: JobForm): Promise<boolean>;
  /** Append a version and make it current, if the job is not approved and its current version is still `expectedCurrent`. */
  abstract appendVersion(tenantId: string, jobId: string, expectedCurrent: string | null, version: NewJdVersion): Promise<boolean>;
  /** Approve `approval.jdVersionId` and lock the job, if that version is still current and the job is not approved. */
  abstract approve(tenantId: string, jobId: string, approval: NewApproval): Promise<boolean>;
  /** Delete the job with its JD versions, approvals and screening settings. false if it does not exist. */
  abstract delete(tenantId: string, jobId: string): Promise<boolean>;
}

const DETAIL_INCLUDE = {
  versions: { orderBy: { version: 'desc' } },
  approvals: { orderBy: { approvedAt: 'desc' }, take: 1 },
} satisfies Prisma.JobInclude;

@Injectable()
export class PrismaJobsRepository extends JobsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(tenantId: string, form: JobForm, createdById: string) {
    const row = await this.prisma.job.create({
      data: { tenantId, createdById, ...formColumns(form) },
      include: DETAIL_INCLUDE,
    });
    return toDetail(row);
  }

  async list(tenantId: string) {
    const rows = await this.prisma.job.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { versions: true } } },
    });
    return rows.map((r) => toSummary(r, r._count.versions));
  }

  async get(tenantId: string, jobId: string) {
    const row = await this.prisma.job.findFirst({ where: { id: jobId, tenantId }, include: DETAIL_INCLUDE });
    return row ? toDetail(row) : null;
  }

  async updateForm(tenantId: string, jobId: string, form: JobForm) {
    const { count } = await this.prisma.job.updateMany({
      where: { id: jobId, tenantId, status: { not: 'APPROVED' } },
      data: { ...formColumns(form), currentJdVersionId: null, status: 'DRAFT' },
    });
    return count === 1;
  }

  async appendVersion(tenantId: string, jobId: string, expectedCurrent: string | null, v: NewJdVersion) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const last = await tx.jdVersion.aggregate({ where: { jobId, tenantId }, _max: { version: true } });
        const created = await tx.jdVersion.create({
          data: {
            tenantId,
            jobId,
            version: (last._max.version ?? 0) + 1,
            source: v.source,
            content: v.content,
            companySnapshot: v.companySnapshot ?? Prisma.DbNull,
            promptVersion: v.promptVersion,
            model: v.model,
            createdBy: v.createdBy,
          },
        });
        // compare-and-set: only succeeds if nobody else changed the job since the caller read it
        const { count } = await tx.job.updateMany({
          where: { id: jobId, tenantId, status: { not: 'APPROVED' }, currentJdVersionId: expectedCurrent },
          data: { currentJdVersionId: created.id, status: 'JD_GENERATED' },
        });
        if (count !== 1) throw new StaleWrite();
        return true;
      });
    } catch (err) {
      // StaleWrite, or two concurrent writers picked the same version number
      if (err instanceof StaleWrite || isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async approve(tenantId: string, jobId: string, a: NewApproval) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.job.updateMany({
          where: { id: jobId, tenantId, status: { not: 'APPROVED' }, currentJdVersionId: a.jdVersionId },
          data: { status: 'APPROVED' },
        });
        if (count !== 1) throw new StaleWrite();
        await tx.jobApproval.create({ data: { tenantId, jobId, ...a } });
        return true;
      });
    } catch (err) {
      if (err instanceof StaleWrite) return false;
      throw err;
    }
  }

  async delete(tenantId: string, jobId: string) {
    return this.prisma.$transaction(async (tx) => {
      // approvals point at jd_versions with ON DELETE RESTRICT, so they go before the job's cascade removes versions
      await tx.jobApproval.deleteMany({ where: { tenantId, jobId } });
      const { count } = await tx.job.deleteMany({ where: { id: jobId, tenantId } });
      return count === 1;
    });
  }
}

class StaleWrite extends Error {}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

function formColumns(form: JobForm) {
  return {
    title: form.title,
    formData: form as Prisma.InputJsonObject,
    openings: form.openings,
    deadline: form.deadline ? new Date(form.deadline) : null,
  };
}

function toSummary(row: JobRow, versionCount: number): JobSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    versionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: JobRow & { versions: JdVersionRow[]; approvals: ApprovalRow[] }): JobDetail {
  const approval = row.approvals[0];
  return {
    ...toSummary(row, row.versions.length),
    form: row.formData as JobForm,
    currentJdVersionId: row.currentJdVersionId,
    versions: row.versions.map(toVersion),
    approval: approval ? toApproval(approval) : null,
  };
}

function toVersion(row: JdVersionRow): JdVersion {
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    content: row.content as JdContent,
    companySnapshot: (row.companySnapshot as Record<string, unknown> | null) ?? null,
    promptVersion: row.promptVersion,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

function toApproval(row: ApprovalRow): JobApproval {
  return {
    id: row.id,
    jdVersionId: row.jdVersionId,
    approvedBy: row.approvedBy,
    approvedById: row.approvedById,
    companyDetailsVerified: row.companyDetailsVerified,
    note: row.note,
    approvedAt: row.approvedAt.toISOString(),
  };
}
