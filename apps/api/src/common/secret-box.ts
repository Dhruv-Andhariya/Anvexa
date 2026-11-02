import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets we must store (e.g. channel OAuth tokens).
 * Key: ENCRYPTION_KEY = 32 random bytes as base64 (44 chars) or hex (64 chars).
 * Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Stored format: v1.<iv>.<tag>.<ciphertext> (base64url parts). Changing the key makes old values unreadable.
 */
export class SecretBox {
  private constructor(private readonly key: Buffer) {}

  /** null when ENCRYPTION_KEY is missing or not 32 bytes (callers turn that into a clear "not configured" message). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox | null {
    const key = parseKey(env.ENCRYPTION_KEY);
    return key ? new SecretBox(key) : null;
  }

  static fromKey(key: Buffer): SecretBox {
    if (key.length !== 32) throw new Error('SecretBox key must be 32 bytes');
    return new SecretBox(key);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  /** Throws when the value was changed or encrypted with another key. */
  decrypt(sealed: string): string {
    const [v, iv, tag, data] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unknown secret format');
    const authTag = Buffer.from(tag, 'base64url');
    // GCM accepts shortened tags, which are much easier to forge; ours are always the full 16 bytes.
    if (authTag.length !== 16) throw new Error('Unknown secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}

function parseKey(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  return key.length === 32 ? key : null;
}
