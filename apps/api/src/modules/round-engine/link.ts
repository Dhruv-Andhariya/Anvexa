import { createHash, randomBytes } from 'node:crypto';

/** An assessment link works this many days from the moment its email was sent (ASSESSMENT_LINK_DAYS). */
export const DEFAULT_LINK_DAYS = 7;

/**
 * Base URL of the assessment page (careers site /assessment/[token]): ASSESSMENT_URL, or - when that is empty -
 * `${CAREERS_SITE_URL}/assessment/{token}`, so it follows the careers site's public address (tunnel or deployment)
 * without a code change. The token replaces "{token}", or is added as ?token=... In production a localhost link is
 * refused (a candidate could never open it).
 */
export function assessmentBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return baseUrlFrom(env.ASSESSMENT_URL, env.CAREERS_SITE_URL, '/assessment/{token}', env);
}

/**
 * Base URL of the DSA coding page (candidate-app /dsa/[token]): DSA_ASSESSMENT_URL, or - when that is empty -
 * `${CANDIDATE_APP_URL}/dsa/{token}`. Same rules as the assessment link: http(s) only, and in production never localhost.
 */
export function dsaBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return baseUrlFrom(env.DSA_ASSESSMENT_URL, env.CANDIDATE_APP_URL, '/dsa/{token}', env);
}

function baseUrlFrom(explicitRaw: string | undefined, rootRaw: string | undefined, path: string, env: NodeJS.ProcessEnv): string | null {
  const explicit = (explicitRaw ?? '').trim();
  const root = (rootRaw ?? '').trim().replace(/\/+$/, '');
  const raw = explicit || (root ? `${root}${path}` : '');
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

const isLocalHost = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** A link a candidate can open from their own device (not this machine's localhost). */
export function isPublicLink(base: string): boolean {
  try {
    return !isLocalHost(new URL(base.replace('{token}', 'x')).hostname);
  } catch {
    return false;
  }
}

/** A new unguessable token (it only ever exists inside the email) and the SHA-256 that is stored instead. */
export function newAssessmentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashAssessmentToken(token) };
}

export const hashAssessmentToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** 43 chars base64url = 32 random bytes. A shape check only; the real check is the hash lookup. */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export function assessmentLink(base: string, token: string): string {
  if (base.includes('{token}')) return base.replace('{token}', encodeURIComponent(token));
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}
