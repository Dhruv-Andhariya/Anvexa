import { PrismaClient } from '@prisma/client';
import { loginRequestSchema, PASSWORD_LIMITS } from '@hireflow/contracts';
import { loadRootEnv } from '../common/env';
import { hashPassword } from '../modules/auth/password';

/**
 * The ONLY way to create a Platform Admin (the API never grants this role).
 *   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_NAME=... PLATFORM_ADMIN_PASSWORD=... pnpm --filter api admin:create
 * Promotes the account if the email already exists, and resets its password when one is given.
 */
async function main() {
  loadRootEnv();
  const { PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME, PLATFORM_ADMIN_PASSWORD } = process.env;
  const email = loginRequestSchema.shape.email.safeParse(PLATFORM_ADMIN_EMAIL ?? '');
  if (!email.success) throw new Error('Set PLATFORM_ADMIN_EMAIL to a valid email address.');
  const password = PLATFORM_ADMIN_PASSWORD ?? '';
  if (password && (password.length < PASSWORD_LIMITS.min || password.length > PASSWORD_LIMITS.max)) {
    throw new Error(`PLATFORM_ADMIN_PASSWORD must be ${PASSWORD_LIMITS.min}-${PASSWORD_LIMITS.max} characters.`);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email: email.data } });
    if (!existing && !password) throw new Error('Set PLATFORM_ADMIN_PASSWORD to create a new account.');
    const passwordHash = password ? await hashPassword(password) : undefined;
    const name = PLATFORM_ADMIN_NAME?.trim() || existing?.name || 'Platform Admin';
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { isPlatformAdmin: true, isActive: true, name, ...(passwordHash ? { passwordHash } : {}) },
        })
      : await prisma.user.create({ data: { email: email.data, name, passwordHash: passwordHash!, isPlatformAdmin: true } });
    await prisma.auditLog.create({
      data: { action: 'platform_admin.granted', subjectType: 'user', subjectId: user.id, metadata: { via: 'cli', email: user.email } },
    });
    console.log(`${existing ? 'Updated' : 'Created'} Platform Admin ${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
