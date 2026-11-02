import { Inject, Injectable } from '@nestjs/common';
import type { AtsPart, PassMode, RoundAnswer, ScreeningDecision } from '@hireflow/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

export interface StudentRow {
  applicationId: string;
  jobId: string;
  name: string;
  email: string;
  phone: string;
  college: string;
  degree: string;
  branch: string;
  graduationYear: number;
  ats: {
    score: number | null;
    minAtsScore: number | null;
    decision: ScreeningDecision | null;
    breakdown: AtsPart[] | null;
    matchedSkills: string[];
    missingSkills: string[];
  } | null;
  hasVoiceScreening: boolean;
}

export interface ResultRow {
  id: string;
  applicationId: string;
  jobId: string;
  roundId: string;
  passMode: PassMode;
  correctCount: number | null;
  marks: number | null;
  interviewerScore: number | null;
  score: number;
  maxScore: number;
  passMark: number;
  systemPassed: boolean;
  answers: RoundAnswer[];
  notes: string | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  override: { passed: boolean; reason: string; byId: string | null; byName: string | null; at: Date } | null;
}

export type ResultWrite = Omit<ResultRow, 'id' | 'override'>;

/** Data access of the assessments module. Every method filters by the tenant id. */
export abstract class AssessmentsStore {
  /** Approved jobs of the company, newest first (job picker). */
  abstract listJobs(tenantId: string): Promise<{ id: string; title: string }[]>;
  abstract getJob(tenantId: string, jobId: string): Promise<{ id: string; title: string } | null>;
  /** Students who reached the rounds: shortlisted after resume screening, or with any round result. */
  abstract listStudents(tenantId: string, jobId: string): Promise<StudentRow[]>;
  /** Per job: students who reached the rounds, and round results received. */
  abstract countByJob(tenantId: string, jobIds: string[]): Promise<Map<string, { students: number; results: number }>>;
  abstract getStudent(tenantId: string, applicationId: string): Promise<StudentRow | null>;
  abstract listResults(tenantId: string, where: { jobId: string } | { applicationId: string }): Promise<ResultRow[]>;
  /** Creates the result or replaces the round engine's values; an HR override is kept. */
  abstract upsertResult(tenantId: string, id: string, data: ResultWrite): Promise<ResultRow>;
  /** Sets (or with null removes) HR's override. null when there is no result for that round. */
  abstract setOverride(
    tenantId: string,
    applicationId: string,
    roundId: string,
    override: { passed: boolean; reason: string; byId: string | null; byName: string | null; at: Date } | null,
  ): Promise<ResultRow | null>;
}

const SHORTLISTED: Prisma.ApplicationWhereInput = {
  atsEvaluation: {
    is: {
      status: 'SCORED',
      OR: [{ hrDecision: 'SHORTLISTED' }, { hrDecision: null, systemDecision: 'SHORTLISTED' }],
    },
  },
};

const STUDENT_SELECT = {
  id: true,
  jobId: true,
  email: true,
  college: true,
  degree: true,
  branch: true,
  graduationYear: true,
  candidate: { select: { name: true, email: true, phone: true } },
  atsEvaluation: {
    select: { status: true, score: true, minAtsScore: true, systemDecision: true, hrDecision: true, breakdown: true, matchedSkills: true, missingSkills: true },
  },
  screeningSession: { select: { id: true } },
} satisfies Prisma.ApplicationSelect;
type StudentDbRow = Prisma.ApplicationGetPayload<{ select: typeof STUDENT_SELECT }>;

@Injectable()
export class PrismaAssessmentsStore extends AssessmentsStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  listJobs(tenantId: string) {
    return this.db.job.findMany({ where: { tenantId, status: 'APPROVED' }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true } });
  }

  getJob(tenantId: string, jobId: string) {
    return this.db.job.findFirst({ where: { id: jobId, tenantId }, select: { id: true, title: true } });
  }

  async listStudents(tenantId: string, jobId: string) {
    const rows = await this.db.application.findMany({
      where: { tenantId, jobId, OR: [SHORTLISTED, { roundResults: { some: {} } }] },
      orderBy: { createdAt: 'asc' },
      select: STUDENT_SELECT,
    });
    return rows.map(toStudent);
  }

  async countByJob(tenantId: string, jobIds: string[]) {
    const out = new Map<string, { students: number; results: number }>();
    if (!jobIds.length) return out;
    const [students, results] = await Promise.all([
      this.db.application.groupBy({
        by: ['jobId'],
        where: { tenantId, jobId: { in: jobIds }, OR: [SHORTLISTED, { roundResults: { some: {} } }] },
        _count: { _all: true },
      }),
      this.db.roundResult.groupBy({ by: ['jobId'], where: { tenantId, jobId: { in: jobIds } }, _count: { _all: true } }),
    ]);
    for (const id of jobIds) out.set(id, { students: 0, results: 0 });
    for (const s of students) out.get(s.jobId)!.students = s._count._all;
    for (const r of results) out.get(r.jobId)!.results = r._count._all;
    return out;
  }

  async getStudent(tenantId: string, applicationId: string) {
    const row = await this.db.application.findFirst({ where: { id: applicationId, tenantId }, select: STUDENT_SELECT });
    return row ? toStudent(row) : null;
  }

  async listResults(tenantId: string, where: { jobId: string } | { applicationId: string }) {
    const rows = await this.db.roundResult.findMany({ where: { tenantId, ...where }, orderBy: { createdAt: 'asc' } });
    return rows.map(toResult);
  }

  async upsertResult(tenantId: string, id: string, data: ResultWrite) {
    const values = { ...data, answers: data.answers as unknown as Prisma.InputJsonValue };
    const row = await this.db.roundResult.upsert({
      where: { applicationId_roundId: { applicationId: data.applicationId, roundId: data.roundId } },
      create: { id, tenantId, ...values },
      update: values,
    });
    return toResult(row);
  }

  async setOverride(
    tenantId: string,
    applicationId: string,
    roundId: string,
    override: { passed: boolean; reason: string; byId: string | null; byName: string | null; at: Date } | null,
  ) {
    const updated = await this.db.roundResult.updateMany({
      where: { tenantId, applicationId, roundId },
      data: {
        overridePassed: override?.passed ?? null,
        overrideReason: override?.reason ?? null,
        overriddenById: override?.byId ?? null,
        overriddenByName: override?.byName ?? null,
        overriddenAt: override?.at ?? null,
      },
    });
    if (!updated.count) return null;
    const row = await this.db.roundResult.findFirst({ where: { tenantId, applicationId, roundId } });
    return row ? toResult(row) : null;
  }
}

function toStudent(r: StudentDbRow): StudentRow {
  const e = r.atsEvaluation;
  return {
    applicationId: r.id,
    jobId: r.jobId,
    name: r.candidate.name,
    email: r.email ?? r.candidate.email,
    phone: r.candidate.phone,
    college: r.college,
    degree: r.degree,
    branch: r.branch,
    graduationYear: r.graduationYear,
    ats: e
      ? {
          score: e.status === 'SCORED' ? e.score : null,
          minAtsScore: e.minAtsScore,
          decision: e.hrDecision ?? e.systemDecision,
          breakdown: Array.isArray(e.breakdown) ? (e.breakdown as unknown as AtsPart[]) : null,
          matchedSkills: e.matchedSkills,
          missingSkills: e.missingSkills,
        }
      : null,
    hasVoiceScreening: !!r.screeningSession,
  };
}

function toResult(r: Prisma.RoundResultGetPayload<object>): ResultRow {
  return {
    id: r.id,
    applicationId: r.applicationId,
    jobId: r.jobId,
    roundId: r.roundId,
    passMode: r.passMode,
    correctCount: r.correctCount,
    marks: r.marks,
    interviewerScore: r.interviewerScore,
    score: r.score,
    maxScore: r.maxScore,
    passMark: r.passMark,
    systemPassed: r.systemPassed,
    answers: Array.isArray(r.answers) ? (r.answers as unknown as RoundAnswer[]) : [],
    notes: r.notes,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    override:
      r.overridePassed === null || !r.overriddenAt
        ? null
        : { passed: r.overridePassed, reason: r.overrideReason ?? '', byId: r.overriddenById, byName: r.overriddenByName, at: r.overriddenAt },
  };
}
