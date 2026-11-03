import { Inject, Injectable } from '@nestjs/common';
import { dsaProblemSpecSchema, type Difficulty, type DsaProblemSpec, type PassMode, type QuestionKind, type RoundType, type RoundsStatus } from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

export interface StoredQuestion {
  id: string;
  position: number;
  kind: QuestionKind;
  text: string;
  options: string[];
  correct: number[];
  modelAnswer: string | null;
  language: string | null;
  marks: number;
  difficulty: Difficulty | null;
  topics: string[];
  source: 'HR' | 'AI';
  /** HR's own DSA problem (coding questions only), round_questions.coding_spec. */
  coding: DsaProblemSpec | null;
}

/** The stored problem as the contract describes it; anything unreadable counts as no problem (the round is then run by HR). */
const parseCodingSpec = (raw: Prisma.JsonValue | null): DsaProblemSpec | null => {
  if (raw === null) return null;
  const parsed = dsaProblemSpecSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export interface StoredRound {
  id: string;
  position: number;
  type: RoundType;
  name: string;
  description: string;
  timeLimitMinutes: number | null;
  passMode: PassMode | null;
  passValue: number | null;
  passMaxScore: number | null;
  questions: StoredQuestion[];
}

export interface StoredConfig {
  jobId: string;
  tenantId: string;
  status: Exclude<RoundsStatus, 'NOT_STARTED'>;
  lockedAt: Date | null;
  updatedAt: Date;
  rounds: StoredRound[];
}

/** What the AI needs to write questions that fit the job. jd is the approved (else latest) version. */
export interface RoundsJob {
  id: string;
  title: string;
  form: Record<string, unknown>;
  jd: Record<string, unknown> | null;
}

/** The rounds were locked (students started) between reading and saving them. */
export class RoundsLockedError extends Error {
  constructor() {
    super('The rounds of this job are locked.');
    this.name = 'RoundsLockedError';
  }
}

/**
 * Data access of the rounds-config module. Every method takes the tenant id and filters by it: a job of another
 * company simply does not exist here.
 */
export abstract class RoundsConfigStore {
  abstract getJob(tenantId: string, jobId: string): Promise<RoundsJob | null>;
  abstract getConfig(tenantId: string, jobId: string): Promise<StoredConfig | null>;
  /** Configs of these jobs (no questions loaded beyond what the type says: all of them, small tables). */
  abstract listConfigs(tenantId: string, jobIds: string[]): Promise<StoredConfig[]>;
  /** Replaces every round + question of the job in one transaction. Throws RoundsLockedError when locked. */
  abstract replace(tenantId: string, jobId: string, status: StoredConfig['status'], rounds: StoredRound[], actorId: string | null): Promise<StoredConfig>;
  /** Sets locked_at once (keeps the first value). Returns it, or null when the job has no rounds. */
  abstract lock(tenantId: string, jobId: string, at: Date): Promise<Date | null>;
}

const CONFIG_INCLUDE = {
  rounds: { orderBy: { position: 'asc' }, include: { questions: { orderBy: { position: 'asc' } } } },
} satisfies Prisma.JobRoundConfigInclude;
type ConfigRow = Prisma.JobRoundConfigGetPayload<{ include: typeof CONFIG_INCLUDE }>;

@Injectable()
export class PrismaRoundsConfigStore extends RoundsConfigStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async getJob(tenantId: string, jobId: string): Promise<RoundsJob | null> {
    const job = await this.db.job.findFirst({
      where: { id: jobId, tenantId },
      select: {
        id: true,
        title: true,
        formData: true,
        currentJdVersionId: true,
        approvals: { orderBy: { approvedAt: 'desc' }, take: 1, select: { jdVersion: { select: { content: true } } } },
      },
    });
    if (!job) return null;
    let jd = job.approvals[0]?.jdVersion.content ?? null;
    if (!jd && job.currentJdVersionId) {
      jd = (await this.db.jdVersion.findFirst({ where: { id: job.currentJdVersionId, tenantId }, select: { content: true } }))?.content ?? null;
    }
    return { id: job.id, title: job.title, form: asObject(job.formData), jd: jd ? asObject(jd) : null };
  }

  async getConfig(tenantId: string, jobId: string) {
    const row = await this.db.jobRoundConfig.findFirst({ where: { tenantId, jobId }, include: CONFIG_INCLUDE });
    return row ? toConfig(row) : null;
  }

  async listConfigs(tenantId: string, jobIds: string[]) {
    if (!jobIds.length) return [];
    const rows = await this.db.jobRoundConfig.findMany({ where: { tenantId, jobId: { in: jobIds } }, include: CONFIG_INCLUDE });
    return rows.map(toConfig);
  }

  async replace(tenantId: string, jobId: string, status: StoredConfig['status'], rounds: StoredRound[], actorId: string | null) {
    const row = await this.db.$transaction(async (tx) => {
      const existing = await tx.jobRoundConfig.findFirst({ where: { tenantId, jobId }, select: { lockedAt: true } });
      if (existing?.lockedAt) throw new RoundsLockedError();
      if (existing) {
        // The lock check and the update are one statement: a lock taken in between makes count 0.
        const updated = await tx.jobRoundConfig.updateMany({ where: { tenantId, jobId, lockedAt: null }, data: { status, updatedById: actorId } });
        if (!updated.count) throw new RoundsLockedError();
      } else {
        await tx.jobRoundConfig.create({ data: { jobId, tenantId, status, updatedById: actorId } });
      }
      await tx.jobRound.deleteMany({ where: { tenantId, jobId } }); // questions go with them (cascade)
      if (rounds.length) {
        await tx.jobRound.createMany({
          data: rounds.map((r) => ({
            id: r.id,
            tenantId,
            jobId,
            position: r.position,
            type: r.type,
            name: r.name,
            description: r.description,
            timeLimitMinutes: r.timeLimitMinutes,
            passMode: r.passMode,
            passValue: r.passValue,
            passMaxScore: r.passMaxScore,
          })),
        });
        const questions = rounds.flatMap((r) =>
          r.questions.map(({ coding, ...q }) => ({
            ...q,
            codingSpec: coding ? (coding as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
            roundId: r.id,
            tenantId,
          })),
        );
        if (questions.length) await tx.roundQuestion.createMany({ data: questions });
      }
      return tx.jobRoundConfig.findFirstOrThrow({ where: { tenantId, jobId }, include: CONFIG_INCLUDE });
    });
    return toConfig(row);
  }

  async lock(tenantId: string, jobId: string, at: Date) {
    await this.db.jobRoundConfig.updateMany({ where: { tenantId, jobId, lockedAt: null }, data: { lockedAt: at } });
    return (await this.db.jobRoundConfig.findFirst({ where: { tenantId, jobId }, select: { lockedAt: true } }))?.lockedAt ?? null;
  }
}

function toConfig(row: ConfigRow): StoredConfig {
  return {
    jobId: row.jobId,
    tenantId: row.tenantId,
    status: row.status,
    lockedAt: row.lockedAt,
    updatedAt: row.updatedAt,
    rounds: row.rounds.map((r) => ({
      id: r.id,
      position: r.position,
      type: r.type,
      name: r.name,
      description: r.description,
      timeLimitMinutes: r.timeLimitMinutes,
      passMode: r.passMode,
      passValue: r.passValue,
      passMaxScore: r.passMaxScore,
      questions: r.questions.map((q) => ({
        id: q.id,
        position: q.position,
        kind: q.kind,
        text: q.text,
        options: q.options,
        correct: q.correct,
        modelAnswer: q.modelAnswer,
        language: q.language,
        marks: q.marks,
        difficulty: q.difficulty,
        topics: q.topics,
        source: q.source,
        coding: parseCodingSpec(q.codingSpec),
      })),
    })),
  };
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
