import { PrismaClient } from '@prisma/client';
import { loadRootEnv } from '../common/env';

/**
 * Server-side recovery tool: make an EXISTING (signed-up) user Company Admin of an EXISTING company.
 * Needed for the company that existed before login (slug "default", e.g. TechFlitter), which has no members,
 * or when a company lost all its admins. Not exposed through the API.
 *
 *   COMPANY_SLUG=default USER_EMAIL=hr@techflitter.com pnpm --filter api company:assign-admin
 */
async function main() {
  loadRootEnv();
  const slug = process.env.COMPANY_SLUG?.trim();
  const email = process.env.USER_EMAIL?.trim().toLowerCase();
  if (!slug || !email) throw new Error('Set COMPANY_SLUG and USER_EMAIL.');

  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new Error(`No company with slug "${slug}".`);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`No account for ${email}. Sign up in the dashboard first, then run this again.`);

    await prisma.membership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      create: { tenantId: tenant.id, userId: user.id, role: 'COMPANY_ADMIN' },
      update: { role: 'COMPANY_ADMIN', status: 'ACTIVE' },
    });
    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: 'membership.assigned_by_cli',
        subjectType: 'user',
        subjectId: user.id,
        metadata: { role: 'COMPANY_ADMIN', email },
      },
    });
    console.log(`${email} is now Company Admin of ${tenant.name} (${slug}). They may need to log out and in, or switch company.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
