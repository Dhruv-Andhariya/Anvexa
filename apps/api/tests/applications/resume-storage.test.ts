import { randomUUID } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { moveResumesToStorage } from '../../src/cli/move-resumes-to-storage';
import {
  DatabaseResumeStorage,
  ResumeStorageError,
  S3ResumeStorage,
  resumeKey,
  resumeStorageFromEnv,
} from '../../src/modules/applications/resume/resume-storage';
import { PDF } from './fixtures';

const TENANT = '0192f3a1-0000-7000-8000-000000000001';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('resumeStorageFromEnv', () => {
  it('keeps files in the database only when nothing is configured, and never in production', () => {
    expect(resumeStorageFromEnv({}).kind).toBe('database');
    expect(() => resumeStorageFromEnv({ NODE_ENV: 'production' })).toThrow(/RESUME_STORAGE=s3 is required in production/);
  });

  it('needs a bucket and a region for S3, and refuses unknown modes', () => {
    expect(() => resumeStorageFromEnv({ RESUME_STORAGE: 's3', S3_BUCKET: 'b' })).toThrow(/S3_BUCKET and S3_REGION/);
    expect(() => resumeStorageFromEnv({ RESUME_STORAGE: 'ftp' })).toThrow(/"s3" or "database"/);
    expect(resumeStorageFromEnv({ RESUME_STORAGE: 'S3', S3_BUCKET: 'b', AWS_REGION: 'ap-south-1' }).kind).toBe('s3');
  });

  it('names files by company and resume id only (never the student file name)', () => {
    expect(resumeKey(TENANT, 'r1', 'application/pdf')).toBe(`${TENANT}/resumes/r1.pdf`);
    expect(resumeKey(TENANT, 'r1', DOCX)).toBe(`${TENANT}/resumes/r1.docx`);
  });
});

/**
 * Against a real S3-compatible server, e.g. the S3 mock:
 *   docker run -d -p 9090:9090 -e initialBuckets=hireflow-test adobe/s3mock:3.12.0
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9090 pnpm --filter api test
 * The "move old resumes" part also needs TEST_DATABASE_URL.
 */
const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const BUCKET = process.env.S3_TEST_BUCKET || 'hireflow-test';

describe.skipIf(!ENDPOINT)('S3ResumeStorage (real S3 API)', () => {
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const storage = new S3ResumeStorage(client, BUCKET, false);
  const exists = (Key: string) =>
    client.send(new HeadObjectCommand({ Bucket: BUCKET, Key })).then(
      () => true,
      () => false,
    );

  it('stores, reads back and deletes a resume', async () => {
    const key = resumeKey(TENANT, randomUUID(), 'application/pdf');
    await storage.put(key, PDF, 'application/pdf');
    const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(got.ContentType).toBe('application/pdf');
    expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(PDF);

    await storage.delete([key, `${TENANT}/resumes/never-existed.pdf`]); // a missing key is fine
    expect(await exists(key)).toBe(false);
  });

  it('reports a missing bucket as a ResumeStorageError', async () => {
    const wrong = new S3ResumeStorage(client, `no-such-bucket-${Date.now()}`, false);
    await expect(wrong.put('k.pdf', PDF, 'application/pdf')).rejects.toBeInstanceOf(ResumeStorageError);
  });

  const DB = process.env.TEST_DATABASE_URL;
  it.skipIf(!DB)('moves resumes saved in the database to the bucket and removes the database copy', async () => {
    const prisma = new PrismaClient({ datasourceUrl: DB });
    try {
      // a resume still kept in resume_files (flow.db.test.ts saves them that way: no RESUME_STORAGE set)
      // older than 5 minutes: never a row flow.db.test.ts (running in parallel) is still checking
      const before = new Date(Date.now() - 5 * 60_000);
      const old = await prisma.resume.findFirst({
        where: { storageKey: null, file: { isNot: null }, createdAt: { lt: before } },
        include: { file: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!old) return; // nothing left to move in this test database
      const bytes = Buffer.from(old.file!.content);

      expect(await moveResumesToStorage(prisma, storage, () => {}, before)).toBeGreaterThanOrEqual(1);
      const moved = await prisma.resume.findUniqueOrThrow({ where: { id: old.id }, include: { file: true } });
      expect(moved.storageKey).toBe(resumeKey(old.tenantId, old.id, old.mimeType));
      expect(moved.file).toBeNull();
      const got = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: moved.storageKey! }));
      expect(Buffer.from(await got.Body!.transformToByteArray())).toEqual(bytes);
      expect(await moveResumesToStorage(prisma, storage, () => {}, before)).toBe(0); // safe to run again
      await expect(moveResumesToStorage(prisma, new DatabaseResumeStorage(), () => {})).rejects.toThrow(/RESUME_STORAGE=s3/);
    } finally {
      await prisma.$disconnect();
    }
  });
});
