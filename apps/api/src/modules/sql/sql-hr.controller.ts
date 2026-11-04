import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import type { SqlBankListItem, SqlBankQuestion, SqlCheckResult, SqlStarterImportResult } from '@hireflow/contracts';
import { apiError } from '../../common/api-error';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission } from '../auth';
import { TenantContext } from '../tenants';
import { SqlBankService } from './bank/sql-bank.service';

/**
 * HR: the company's SQL question bank. Company from the session; another company's question id is a 404. Never
 * public: candidates only ever see a round's copy of a question through the coding page (without hidden datasets or
 * the reference query). Off with FEATURE_SQL=off.
 */
@Controller('sql-hr/questions')
@UseGuards(featureFlag('sql'))
export class SqlHrController {
  constructor(
    @Inject(SqlBankService) private readonly bank: SqlBankService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/sql-hr/questions - the bank (without datasets). */
  @RequirePermission('jobs.read')
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(): Promise<SqlBankListItem[]> {
    return this.bank.list(await this.tenant.currentTenantId());
  }

  /** GET /api/v1/sql-hr/questions/:id - one question with its datasets, expected results and reference query. */
  @RequirePermission('jobs.read')
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<SqlBankQuestion> {
    return this.bank.get(await this.tenant.currentTenantId(), id);
  }

  /** POST /api/v1/sql-hr/questions/check - runs a question without saving (tables, sample rows, expected results). */
  @RequirePermission('jobs.write')
  @Post('check')
  @HttpCode(200)
  async check(@Body() body: unknown): Promise<SqlCheckResult> {
    return this.bank.check(body);
  }

  /** POST /api/v1/sql-hr/questions/starter - adds the 15 starter questions the company does not have yet. */
  @RequirePermission('jobs.write')
  @Post('starter')
  @HttpCode(200)
  async starter(): Promise<SqlStarterImportResult> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.bank.importStarter(tenantId, actor);
  }

  /** POST /api/v1/sql-hr/questions - 422 SQL_QUESTION_NOT_RUNNABLE when the schema, a dataset or the reference query fails. */
  @RequirePermission('jobs.write')
  @Post()
  async create(@Body() body: unknown): Promise<SqlBankQuestion> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.bank.create(tenantId, body, actor);
  }

  /** PUT /api/v1/sql-hr/questions/:id - replaces the question (rounds that use it keep their copy). */
  @RequirePermission('jobs.write')
  @Put(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<SqlBankQuestion> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.bank.update(tenantId, id, body, actor);
  }

  /** PATCH /api/v1/sql-hr/questions/:id/active - body { active: boolean }. */
  @RequirePermission('jobs.write')
  @Patch(':id/active')
  async setActive(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<SqlBankQuestion> {
    const active = (body as { active?: unknown } | null)?.active;
    if (typeof active !== 'boolean') throw apiError(400, 'INVALID_REQUEST', 'active must be true or false.');
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    return this.bank.setActive(tenantId, id, active, actor);
  }

  /** DELETE /api/v1/sql-hr/questions/:id - rounds that use the question keep their copy. */
  @RequirePermission('jobs.write')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    await this.bank.remove(tenantId, id, actor);
  }
}
