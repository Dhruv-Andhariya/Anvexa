import { Inject, Injectable } from '@nestjs/common';
import { sqlProblemSpecSchema, type SqlProblemSpec } from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';

export interface StoredSqlQuestion {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  marks: number;
  topics: string[];
  active: boolean;
  problem: SqlProblemSpec;
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SqlQuestionData = Omit<StoredSqlQuestion, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>;

/** The company's SQL question bank (sql_questions). Every method is scoped to one company. */
export abstract class SqlBankStore {
  abstract list(tenantId: string): Promise<StoredSqlQuestion[]>;
  abstract get(tenantId: string, id: string): Promise<StoredSqlQuestion | null>;
  abstract create(tenantId: string, id: string, data: SqlQuestionData, actorId: string | null): Promise<StoredSqlQuestion>;
  /** null = no such question in this company. */
  abstract update(tenantId: string, id: string, data: Partial<SqlQuestionData>, actorId: string | null): Promise<StoredSqlQuestion | null>;
  abstract remove(tenantId: string, id: string): Promise<boolean>;
  /** The starter questions this company already has (their seed keys). */
  abstract seedKeys(tenantId: string): Promise<Set<string>>;
}

type Row = Prisma.SqlQuestionGetPayload<object>;

/** A stored problem that no longer reads as the contract says is dropped to an empty one (never trusted). */
function toStored(r: Row): StoredSqlQuestion {
  const parsed = sqlProblemSpecSchema.safeParse(r.problem);
  return {
    id: r.id,
    tenantId: r.tenantId,
    title: r.title,
    description: r.description,
    difficulty: r.difficulty,
    marks: r.marks,
    topics: r.topics,
    active: r.active,
    problem: parsed.success
      ? parsed.data
      : { bankId: r.id, title: r.title, schemaSql: '-- unreadable', starterQuery: '', referenceQuery: 'SELECT 1', orderMatters: false, timeLimitMs: 2000, tables: [], tests: [] },
    seedKey: r.seedKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const json = (p: SqlProblemSpec) => p as unknown as Prisma.InputJsonObject;

@Injectable()
export class PrismaSqlBankStore extends SqlBankStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async list(tenantId: string) {
    const rows = await this.db.sqlQuestion.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows.map(toStored);
  }

  async get(tenantId: string, id: string) {
    const row = await this.db.sqlQuestion.findFirst({ where: { tenantId, id } });
    return row ? toStored(row) : null;
  }

  async create(tenantId: string, id: string, data: SqlQuestionData, actorId: string | null) {
    const row = await this.db.sqlQuestion.create({ data: { ...data, id, tenantId, problem: json(data.problem), createdById: actorId, updatedById: actorId } });
    return toStored(row);
  }

  async update(tenantId: string, id: string, data: Partial<SqlQuestionData>, actorId: string | null) {
    const { problem, ...rest } = data;
    // tenant_id in the WHERE: another company's id updates nothing
    const r = await this.db.sqlQuestion.updateMany({
      where: { tenantId, id },
      data: { ...rest, ...(problem ? { problem: json(problem) } : {}), updatedById: actorId },
    });
    return r.count ? this.get(tenantId, id) : null;
  }

  async remove(tenantId: string, id: string) {
    return (await this.db.sqlQuestion.deleteMany({ where: { tenantId, id } })).count > 0;
  }

  async seedKeys(tenantId: string) {
    const rows = await this.db.sqlQuestion.findMany({ where: { tenantId, seedKey: { not: null } }, select: { seedKey: true } });
    return new Set(rows.map((r) => r.seedKey!));
  }
}
