import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants';
import { SqlBankService } from './bank/sql-bank.service';
import { PrismaSqlBankStore, SqlBankStore } from './bank/sql-bank.store';
import { SQL_SANDBOX, SqlSandbox, sqlSandboxOptionsFromEnv } from './engine/sql-sandbox';
import { SqlHrController } from './sql-hr.controller';

/**
 * SQL rounds (README.md): the company's SQL question bank (HR) and the SQL sandbox that runs queries. A SQL round is
 * run by the round engine on the candidate app's coding page like a DSA round; the dsa module imports this one for
 * the sandbox (SQL_SANDBOX). Imports nothing but tenants, so it never creates a cycle.
 */
@Module({
  imports: [TenantsModule],
  controllers: [SqlHrController],
  providers: [
    SqlBankService,
    { provide: SqlBankStore, useClass: PrismaSqlBankStore },
    { provide: SQL_SANDBOX, useFactory: () => new SqlSandbox(sqlSandboxOptionsFromEnv()) },
  ],
  exports: [SQL_SANDBOX, SqlBankService],
})
export class SqlModule {}
