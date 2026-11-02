import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RESUME_LIMITS } from '@hireflow/contracts';

/**
 * Where resume FILES live. The database only keeps the record (name, size, sha256, scan result, storage key).
 *
 *  - `s3` (RESUME_STORAGE=s3): AWS S3 bucket, or any S3-compatible service through S3_ENDPOINT.
 *    Object key: <tenantId>/resumes/<resumeId>.pdf|.docx - never the student's own file name.
 *  - `database` (default when RESUME_STORAGE is not set): the old resume_files table. Local dev only;
 *    refused in production.
 */
export interface ResumeStorage {
  readonly kind: 's3' | 'database';
  /** Stores the file under `key`. Throws ResumeStorageError when the storage cannot be reached. */
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  /** Reads a stored file back (HR resume download). Throws ResumeStorageError when it cannot be read. */
  get(key: string): Promise<Buffer>;
  /** Removes files (missing keys are fine). Throws ResumeStorageError on failure. */
  delete(keys: string[]): Promise<void>;
}

export const RESUME_STORAGE = Symbol('RESUME_STORAGE');

export class ResumeStorageError extends Error {
  constructor(reason: string) {
    super(`resume storage failed: ${reason}`);
    this.name = 'ResumeStorageError';
  }
}

const EXTENSION: Record<string, string> = {
  [RESUME_LIMITS.mimeTypes[0]]: '.pdf',
  [RESUME_LIMITS.mimeTypes[1]]: '.docx',
};

/** Tenant prefix first (doc: "files in S3 are stored under tenant_id/ prefixes"), so a company's data is one prefix. */
export const resumeKey = (tenantId: string, resumeId: string, mimeType: string) =>
  `${tenantId}/resumes/${resumeId}${EXTENSION[mimeType] ?? ''}`;

/** Only the error name (e.g. NoSuchBucket, AccessDenied, TimeoutError) for logs - never the request or credentials. */
const reasonOf = (err: unknown) => (err instanceof Error ? err.name : 'unknown');

export class S3ResumeStorage implements ResumeStorage {
  readonly kind = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    /** AES256 = S3-managed encryption at rest. Off for S3-compatible services that do not support it. */
    private readonly serverSideEncryption: boolean,
  ) {}

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: mimeType,
          ...(this.serverSideEncryption ? { ServerSideEncryption: 'AES256' as const } : {}),
        }),
      );
    } catch (err) {
      throw new ResumeStorageError(reasonOf(err));
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new ResumeStorageError('empty body');
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      throw err instanceof ResumeStorageError ? err : new ResumeStorageError(reasonOf(err));
    }
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000); // S3 deletes at most 1000 keys per call
      try {
        const res = await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
        );
        if (res.Errors?.length) throw new ResumeStorageError(`${res.Errors.length} not deleted (${res.Errors[0]?.Code ?? 'unknown'})`);
      } catch (err) {
        throw err instanceof ResumeStorageError ? err : new ResumeStorageError(reasonOf(err));
      }
    }
  }
}

/** Marker for the old behaviour: the bytes are written to resume_files inside the intake transaction. */
export class DatabaseResumeStorage implements ResumeStorage {
  readonly kind = 'database' as const;
  async put(): Promise<void> {}
  /** Never called: resumes without a storage key are read from resume_files directly. */
  async get(): Promise<Buffer> {
    throw new ResumeStorageError('no file storage configured');
  }
  async delete(): Promise<void> {}
}

/**
 * RESUME_STORAGE=s3 needs S3_BUCKET and S3_REGION (or AWS_REGION). Credentials: S3_ACCESS_KEY + S3_SECRET_KEY, or the
 * standard AWS chain (AWS_ACCESS_KEY_ID / instance role) when those are empty. S3_ENDPOINT only for S3-compatible
 * services (MinIO, R2, a local mock); leave it empty for AWS.
 */
export function resumeStorageFromEnv(env: NodeJS.ProcessEnv = process.env): ResumeStorage {
  const mode = (env.RESUME_STORAGE ?? '').trim().toLowerCase() || 'database';
  if (mode === 'database') {
    if (env.NODE_ENV === 'production') {
      throw new Error('RESUME_STORAGE=s3 is required in production (resumes must not be stored in the database).');
    }
    return new DatabaseResumeStorage();
  }
  if (mode !== 's3') throw new Error(`RESUME_STORAGE must be "s3" or "database", got "${mode}".`);

  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim() || env.AWS_REGION?.trim();
  if (!bucket || !region) throw new Error('RESUME_STORAGE=s3 needs S3_BUCKET and S3_REGION.');
  const endpoint = env.S3_ENDPOINT?.trim() || undefined;
  const accessKeyId = env.S3_ACCESS_KEY?.trim();
  const secretAccessKey = env.S3_SECRET_KEY?.trim();
  const client = new S3Client({
    region,
    endpoint,
    // custom endpoints (MinIO, mocks) usually need path-style URLs; AWS itself uses virtual-hosted style
    forcePathStyle: !!endpoint,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
    maxAttempts: 3,
  });
  return new S3ResumeStorage(client, bucket, !endpoint);
}
