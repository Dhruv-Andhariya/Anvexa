import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  sqlQuestionInputSchema,
  type SqlBankListItem,
  type SqlBankQuestion,
  type SqlCheckResult,
  type SqlQuestionDraft,
  type SqlStarterImportResult,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../../common/api-error';
import { uuidv7 } from '../../../common/uuidv7';
import { AuditService } from '../../audit';
import type { Actor } from '../../tenants';
import { SQL_SANDBOX, type SqlSandbox } from '../engine/sql-sandbox';
import { buildProblem } from './build-problem';
import { SqlBankStore, type StoredSqlQuestion } from './sql-bank.store';
import { STARTER_SQL_QUESTIONS } from './starter-questions';

const notFound = () => apiError(HttpStatus.NOT_FOUND, 'SQL_QUESTION_NOT_FOUND', 'This SQL question does not exist.');

/** 422 with the problems found by running the question (schema, datasets, reference query). */
function notRunnable(problems: string[]): HttpException {
  const err = apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'SQL_QUESTION_NOT_RUNNABLE', problems[0] ?? 'This question does not run.');
  (err.getResponse() as Record<string, unknown>).issues = problems.map((message) => ({ path: 'problem', message }));
  return err;
}

export function toBankQuestion(q: StoredSqlQuestion): SqlBankQuestion {
  return {
    id: q.id,
    title: q.title,
    description: q.description,
    difficulty: q.difficulty,
    marks: q.marks,
    topics: q.topics,
    active: q.active,
    seedKey: q.seedKey,
    problem: q.problem,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

/**
 * The company's SQL question bank (HR only). Every question is checked by RUNNING it before it is stored: a question
 * that is saved always loads and always has real expected results. Rounds take a copy of a question (rounds editor),
 * so the changes here affect only rounds set up afterwards.
 */
@Injectable()
export class SqlBankService {
  constructor(
    @Inject(SqlBankStore) private readonly store: SqlBankStore,
    @Inject(SQL_SANDBOX) private readonly sandbox: SqlSandbox,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(tenantId: string): Promise<SqlBankListItem[]> {
    return (await this.store.list(tenantId)).map((q) => ({
      id: q.id,
      title: q.title,
      difficulty: q.difficulty,
      marks: q.marks,
      topics: q.topics,
      active: q.active,
      tests: { sample: q.problem.tests.filter((t) => !t.hidden).length, hidden: q.problem.tests.filter((t) => t.hidden).length },
      updatedAt: q.updatedAt.toISOString(),
    }));
  }

  async get(tenantId: string, id: string): Promise<SqlBankQuestion> {
    const q = await this.store.get(tenantId, id);
    if (!q) throw notFound();
    return toBankQuestion(q);
  }

  /** Runs HR's question without storing anything: the tables, sample rows and expected results, or what fails. */
  async check(input: unknown): Promise<SqlCheckResult> {
    const draft = this.parse(input);
    const { problems, problem } = await buildProblem(this.sandbox, draft, null);
    return { ok: problems.length === 0, problems, problem };
  }

  async create(tenantId: string, input: unknown, actor: Actor | null): Promise<SqlBankQuestion> {
    const draft = this.parse(input);
    const id = uuidv7();
    const saved = await this.store.create(tenantId, id, { ...(await this.runnable(draft, id)), seedKey: null }, actor?.id ?? null);
    await this.record(tenantId, actor, 'sql.question_created', id, { title: saved.title });
    return toBankQuestion(saved);
  }

  async update(tenantId: string, id: string, input: unknown, actor: Actor | null): Promise<SqlBankQuestion> {
    if (!(await this.store.get(tenantId, id))) throw notFound();
    const draft = this.parse(input);
    const saved = await this.store.update(tenantId, id, await this.runnable(draft, id), actor?.id ?? null);
    if (!saved) throw notFound();
    await this.record(tenantId, actor, 'sql.question_updated', id, { title: saved.title });
    return toBankQuestion(saved);
  }

  /** Inactive questions stay in the bank (and in rounds that already use them) but cannot be picked again. */
  async setActive(tenantId: string, id: string, active: boolean, actor: Actor | null): Promise<SqlBankQuestion> {
    const saved = await this.store.update(tenantId, id, { active }, actor?.id ?? null);
    if (!saved) throw notFound();
    await this.record(tenantId, actor, active ? 'sql.question_activated' : 'sql.question_deactivated', id, {});
    return toBankQuestion(saved);
  }

  /** Rounds that use the question keep their copy, so deleting never breaks a round. */
  async remove(tenantId: string, id: string, actor: Actor | null): Promise<void> {
    if (!(await this.store.remove(tenantId, id))) throw notFound();
    await this.record(tenantId, actor, 'sql.question_deleted', id, {});
  }

  /** Adds the starter questions this company does not have yet (by seed key): safe to call many times. */
  async importStarter(tenantId: string, actor: Actor | null): Promise<SqlStarterImportResult> {
    const have = await this.store.seedKeys(tenantId);
    let added = 0;
    for (const starter of STARTER_SQL_QUESTIONS) {
      if (have.has(starter.seedKey)) continue;
      const { seedKey, ...input } = starter;
      const id = uuidv7();
      await this.store.create(tenantId, id, { ...(await this.runnable(this.parse(input), id)), seedKey }, actor?.id ?? null);
      added += 1;
    }
    if (added) await this.record(tenantId, actor, 'sql.starter_questions_added', null, { added });
    return { added, skipped: STARTER_SQL_QUESTIONS.length - added };
  }

  private parse(input: unknown): SqlQuestionDraft {
    return parseBody(sqlQuestionInputSchema, input, 'INVALID_SQL_QUESTION', 'Some fields of the SQL question are not filled in correctly.');
  }

  private async runnable(draft: SqlQuestionDraft, id: string) {
    const { problems, problem } = await buildProblem(this.sandbox, draft, id);
    if (!problem) throw notRunnable(problems);
    return {
      title: draft.title,
      description: draft.description,
      difficulty: draft.difficulty,
      marks: draft.marks,
      topics: draft.topics,
      active: draft.active,
      problem,
    };
  }

  private record(tenantId: string, actor: Actor | null, action: string, subjectId: string | null, metadata: Record<string, unknown>) {
    return this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action, subjectType: 'sql_question', subjectId: subjectId ?? undefined, metadata });
  }
}
