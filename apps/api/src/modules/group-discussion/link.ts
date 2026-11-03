import { createHash, randomBytes } from 'node:crypto';

/**
 * The student's personal GD link: careers site /gd/{token}. 32 random bytes; the database keeps its SHA-256 (lookup)
 * and the token sealed with ENCRYPTION_KEY (so the reminder can carry the same link). One link per student per group:
 * moving the student to another group makes a new one and the old one stops working.
 */
export const GD_TOKEN_HEADER = 'x-gd-token';

export function newGdToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashGdToken(token) };
}

export const hashGdToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A shape check only; the real check is the hash lookup. */
export const GD_TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/**
 * Base of the student link: GD_URL (with {token}), or `${CAREERS_SITE_URL}/gd/{token}` so it follows the careers
 * site's public address (tunnel or deployment). In production a localhost link is refused.
 */
export function gdBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.GD_URL ?? '').trim();
  const careers = (env.CAREERS_SITE_URL ?? '').trim().replace(/\/+$/, '');
  const raw = explicit || (careers ? `${careers}/gd/{token}` : '');
  if (!raw) return null;
  try {
    const url = new URL(raw.replace('{token}', 'x'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (env.NODE_ENV === 'production' && isLocalHost(url.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function isPublicGdLink(base: string): boolean {
  try {
    return !isLocalHost(new URL(base.replace('{token}', 'x')).hostname);
  } catch {
    return false;
  }
}

export function gdLink(base: string, token: string): string {
  if (base.includes('{token}')) return base.replace('{token}', encodeURIComponent(token));
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** HR's link to a group's live page on the HR dashboard (needs HR's normal login). */
export function hrLiveLink(env: NodeJS.ProcessEnv, batchId: string): string {
  const base = (env.HR_DASHBOARD_URL ?? 'http://localhost:3000').trim().replace(/\/+$/, '');
  return `${base}/group-discussion/live/${encodeURIComponent(batchId)}`;
}
