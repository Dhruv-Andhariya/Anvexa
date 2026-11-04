import { createHash, randomBytes } from 'node:crypto';

/**
 * The student's personal interview link: careers site /interview/{token}. 32 random bytes; only the SHA-256 is stored
 * (the token itself exists only inside the email). It travels to the API in a header, never in API URLs.
 */
export const INTERVIEW_TOKEN_HEADER = 'x-interview-token';

/** A link works this many days from the moment its email was sent (AI_INTERVIEW_LINK_DAYS). */
export const DEFAULT_LINK_DAYS = 7;

export function newInterviewToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInterviewToken(token) };
}

export const hashInterviewToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A shape check only (43 chars base64url = 32 random bytes); the real check is the hash lookup. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/**
 * Base of the link: AI_INTERVIEW_URL (with {token}), or `${CAREERS_SITE_URL}/interview/{token}` so it follows the
 * careers site's public address (tunnel or deployment). http(s) only; in production never localhost.
 */
export function interviewBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = (env.AI_INTERVIEW_URL ?? '').trim();
  const careers = (env.CAREERS_SITE_URL ?? '').trim().replace(/\/+$/, '');
  const raw = explicit || (careers ? `${careers}/interview/{token}` : '');
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

/** A link a candidate can open from their own device (not this machine's localhost). */
export function isPublicLink(base: string): boolean {
  try {
    return !isLocalHost(new URL(base.replace('{token}', 'x')).hostname);
  } catch {
    return false;
  }
}

export function interviewLink(base: string, token: string): string {
  if (base.includes('{token}')) return base.replace('{token}', encodeURIComponent(token));
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}
