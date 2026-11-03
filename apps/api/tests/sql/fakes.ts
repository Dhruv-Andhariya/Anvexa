import { SqlBankStore, type SqlQuestionData, type StoredSqlQuestion } from '../../src/modules/sql/bank/sql-bank.store';
import { SqlSandbox } from '../../src/modules/sql/engine/sql-sandbox';

/** The SQL bank in memory (same rules as the Prisma store: every call scoped to one company). */
export class MemorySqlBankStore extends SqlBankStore {
  readonly rows: StoredSqlQuestion[] = [];
  private clock = Date.parse('2026-11-04T09:00:00Z');

  async list(tenantId: string) {
    return this.rows.filter((r) => r.tenantId === tenantId).map((r) => structuredClone(r));
  }
  async get(tenantId: string, id: string) {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    return r ? structuredClone(r) : null;
  }
  async create(tenantId: string, id: string, data: SqlQuestionData) {
    if (data.seedKey && this.rows.some((r) => r.tenantId === tenantId && r.seedKey === data.seedKey)) throw new Error('unique seed key');
    const at = new Date((this.clock += 1000));
    const row: StoredSqlQuestion = { ...structuredClone(data), id, tenantId, createdAt: at, updatedAt: at };
    this.rows.push(row);
    return structuredClone(row);
  }
  async update(tenantId: string, id: string, data: Partial<SqlQuestionData>) {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id);
    if (!r) return null;
    Object.assign(r, structuredClone(data), { updatedAt: new Date((this.clock += 1000)) });
    return structuredClone(r);
  }
  async remove(tenantId: string, id: string) {
    const i = this.rows.findIndex((x) => x.tenantId === tenantId && x.id === id);
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
  async seedKeys(tenantId: string) {
    return new Set(this.rows.filter((r) => r.tenantId === tenantId && r.seedKey).map((r) => r.seedKey!));
  }
}

/** One sandbox for the SQL tests (a separate process per run, so parallel test files never share a database). */
export const testSandbox = () => new SqlSandbox({ concurrency: 4, maxQueue: 100, queueTimeoutMs: 60_000, heapBytes: 64 * 1024 * 1024, startupMs: 8000 });
