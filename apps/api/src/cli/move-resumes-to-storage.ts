import { PrismaClient } from '@prisma/client';
import { loadRootEnv } from '../common/env';
import { resumeKey, resumeStorageFromEnv, type ResumeStorage } from '../modules/applications/resume/resume-storage';

/**
 * One-off move of resumes saved before cloud storage: uploads every file still in resume_files to the bucket,
 * records its storage_key and deletes the database copy. Safe to run again (moved rows are skipped); a file is
 * only removed from the database after the upload succeeded.
 *
 *   RESUME_STORAGE=s3 (plus S3_* settings in .env)   pnpm --filter api resumes:to-storage
 */
export async function moveResumesToStorage(
  prisma: PrismaClient,
  storage: ResumeStorage,
  log: (line: string) => void = console.log,
  /** Only resumes saved before this moment (default: all). */
  createdBefore?: Date,
) {
  if (storage.kind !== 's3') throw new Error('Set RESUME_STORAGE=s3 (and the S3_* settings) first.');
  const pending = await prisma.resume.findMany({
    where: { storageKey: null, file: { isNot: null }, ...(createdBefore ? { createdAt: { lt: createdBefore } } : {}) },
    select: { id: true, tenantId: true, mimeType: true },
    orderBy: { createdAt: 'asc' },
  });
  let moved = 0;
  for (const r of pending) {
    const file = await prisma.resumeFile.findUnique({ where: { resumeId: r.id }, select: { content: true } });
    if (!file) continue;
    const key = resumeKey(r.tenantId, r.id, r.mimeType);
    await storage.put(key, Buffer.from(file.content), r.mimeType);
    await prisma.$transaction([
      prisma.resume.update({ where: { id: r.id }, data: { storageKey: key } }),
      prisma.resumeFile.delete({ where: { resumeId: r.id } }),
    ]);
    moved++;
    log(`moved resume ${r.id} -> ${key}`);
  }
  log(`${moved} of ${pending.length} resume(s) moved to cloud storage.`);
  return moved;
}

async function main() {
  loadRootEnv();
  const prisma = new PrismaClient();
  try {
    await moveResumesToStorage(prisma, resumeStorageFromEnv());
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
