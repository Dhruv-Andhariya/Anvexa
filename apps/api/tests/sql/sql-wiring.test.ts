import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/modules/audit';
import { AuthGuard } from '../../src/modules/auth/auth.guard';
import { SESSION_COOKIE } from '../../src/modules/auth/cookies';
import { SessionsService } from '../../src/modules/auth/sessions.service';
import { DsaService } from '../../src/modules/dsa/dsa.service';
import { SqlBankService } from '../../src/modules/sql/bank/sql-bank.service';
import { SqlBankStore } from '../../src/modules/sql/bank/sql-bank.store';
import { SQL_SANDBOX, SqlSandbox } from '../../src/modules/sql/engine/sql-sandbox';
import { SqlHrController } from '../../src/modules/sql/sql-hr.controller';
import { TenantContext } from '../../src/modules/tenants';
import { FixedTenant, MemoryAudit } from '../in-memory';
import { MemorySqlBankStore, testSandbox } from './fakes';

describe('the SQL module is part of the API', () => {
  let app: INestApplication;
  // every provider of the real AppModule is built; init() is NOT called, so nothing connects or starts a worker
  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  }, 60_000);

  it('builds the SQL bank, the sandbox, and the coding page service that uses it', () => {
    expect(app.get(SqlBankService)).toBeInstanceOf(SqlBankService);
    expect(app.get(SQL_SANDBOX)).toBeInstanceOf(SqlSandbox);
    expect(app.get(DsaService)).toBeInstanceOf(DsaService);
  });
});

/** The HR routes behind the real auth guard: a session cookie "hr" is an HR member of the company, nothing else is. */
@Module({
  controllers: [SqlHrController],
  providers: [
    SqlBankService,
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: SessionsService,
      useValue: {
        resolve: async (token: string) =>
          token === 'hr'
            ? {
                sessionId: 's1',
                user: { id: 'u1', email: 'hr@x.in', name: 'Hina', isPlatformAdmin: false },
                company: { id: 'c1', name: 'Pattern Labs', slug: 'pattern', status: 'ACTIVE', role: 'HR_MEMBER' },
              }
            : null,
      },
    },
    { provide: TenantContext, useValue: new FixedTenant('0192f3a1-0000-7000-8000-000000000001') },
    { provide: SqlBankStore, useValue: new MemorySqlBankStore() },
    { provide: SQL_SANDBOX, useValue: testSandbox() },
    { provide: AuditService, useValue: new MemoryAudit() },
  ],
})
class SqlHttpModule {}

describe('HR routes /api/v1/sql-hr/questions', () => {
  let app: NestExpressApplication;
  let root = '';
  const call = async (method: string, path: string, opts: { hr?: boolean; body?: unknown } = {}) => {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        'x-requested-with': 'hireflow',
        ...(opts.hr ? { cookie: `${SESSION_COOKIE}=hr` } : {}),
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown> & unknown[]) : null };
  };

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(SqlHttpModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    root = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('are closed to anyone not logged in as HR of the company', async () => {
    expect((await call('GET', '/sql-hr/questions')).status).toBe(401);
    expect((await call('POST', '/sql-hr/questions/starter')).status).toBe(401);
  });

  it('let HR add the starter questions, list, read, check, create, deactivate and delete', async () => {
    expect(await call('POST', '/sql-hr/questions/starter', { hr: true })).toMatchObject({ status: 200, body: { added: 15, skipped: 0 } });
    const list = await call('GET', '/sql-hr/questions', { hr: true });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(15);
    const first = (list.body as unknown as { id: string }[])[0]!;
    const one = await call('GET', `/sql-hr/questions/${first.id}`, { hr: true });
    expect(one).toMatchObject({ status: 200, body: { id: first.id, problem: { tests: expect.any(Array) } } });

    const input = {
      title: 'Count employees',
      description: 'How many employees are there? Column: n.',
      difficulty: 'EASY',
      marks: 2,
      schemaSql: 'CREATE TABLE employees (id INTEGER);',
      referenceQuery: 'SELECT COUNT(*) AS n FROM employees',
      tests: [{ name: 'Sample', dataSql: 'INSERT INTO employees VALUES (1), (2);' }, { dataSql: '', hidden: true }],
    };
    expect(await call('POST', '/sql-hr/questions/check', { hr: true, body: input })).toMatchObject({ status: 200, body: { ok: true, problems: [] } });
    const created = await call('POST', '/sql-hr/questions', { hr: true, body: input });
    expect(created).toMatchObject({ status: 201, body: { title: 'Count employees', problem: { tests: [{ expected: { rows: [[2]] } }, { expected: { rows: [[0]] } }] } } });
    const id = (created.body as unknown as { id: string }).id;
    expect(await call('POST', '/sql-hr/questions', { hr: true, body: { ...input, referenceQuery: 'SELECT nope FROM employees' } })).toMatchObject({
      status: 422,
      body: { code: 'SQL_QUESTION_NOT_RUNNABLE' },
    });
    expect(await call('PATCH', `/sql-hr/questions/${id}/active`, { hr: true, body: { active: false } })).toMatchObject({ status: 200, body: { active: false } });
    expect((await call('DELETE', `/sql-hr/questions/${id}`, { hr: true })).status).toBe(204);
    expect((await call('GET', `/sql-hr/questions/${id}`, { hr: true })).status).toBe(404);
  }, 120_000);
});
