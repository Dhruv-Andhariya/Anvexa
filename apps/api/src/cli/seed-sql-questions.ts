import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';
import { loadRootEnv } from '../common/env';
import { PrismaAuditService } from '../modules/audit/audit.service';
import { SqlBankService } from '../modules/sql/bank/sql-bank.service';
import { PrismaSqlBankStore } from '../modules/sql/bank/sql-bank.store';
import { SqlSandbox } from '../modules/sql/engine/sql-sandbox';

/**
 * Adds the 15 starter SQL questions (5 easy, 5 medium, 5 hard) to a company's SQL question bank - the same as the
 * "Add the 15 starter questions" button on the HR SQL questions page. Every question is run in the SQL sandbox first
 * (expected results are computed, never typed). Questions the company already has are skipped, so it is safe to run
 * again. Needs the sql_round migration (pnpm --filter api db:deploy).
 *
 *   COMPANY_SLUG=default pnpm --filter api sql:seed       (one company)
 *   COMPANY_SLUG=all     pnpm --filter api sql:seed       (every company)
 */
async function main() {
  loadRootEnv();
  const slug = process.env.COMPANY_SLUG?.trim();
  if (!slug) throw new Error('Set COMPANY_SLUG (a company slug, or "all").');

  const prisma = new PrismaClient();
  try {
    const tenants = slug === 'all' ? await prisma.tenant.findMany({ select: { id: true, name: true } }) : await prisma.tenant.findMany({ where: { slug }, select: { id: true, name: true } });
    if (!tenants.length) throw new Error(`No company with slug "${slug}".`);
    const db = prisma as unknown as PrismaService;
    const bank = new SqlBankService(new PrismaSqlBankStore(db), new SqlSandbox(), new PrismaAuditService(db));
    for (const t of tenants) {
      const r = await bank.importStarter(t.id, null);
      console.log(`${t.name}: ${r.added} added, ${r.skipped} already there.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
