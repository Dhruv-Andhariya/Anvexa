import { createHash, randomBytes } from 'node:crypto';

/** The shortlist email's AI screening link is valid for 7 days from the moment the email was sent. */
export const SCREENING_LINK_DAYS = 7;

/**
 * Base URL of the AI screening page (M12: apps/careers-site /screening/[token]), from env AI_SCREENING_URL, or - when
 * that is empty - `${CAREERS_SITE_URL}/screening/{token}`, so the link follows the careers site's public address.
 * Neither set = shortlist emails cannot be sent yet (rejection emails can). The candidate's token is appended as
 * ?token=..., or replaces "{token}" when the URL contains it (e.g. https://screen.example/s/{token}).
 * In production a localhost link is refused: a student could never open it.
 */
export const screeningBaseUrlFromEnv = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const explicit = (env.AI_SCREENING_URL ?? '').trim();
  const careers = (env.CAREERS_SITE_URL ?? '').trim().replace(/\/+$/, '');
  const raw = explicit || (careers ? `${careers}/screening/{token}` : '');
  if (!raw) return null;
  try {
    const url = new URL(raw.replace('{token}', 'x'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (env.NODE_ENV === 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return raw;
  } catch {
    return null;
  }
};

/** A new unguessable token (sent only inside the email) and the SHA-256 we store instead of it. */
export function newScreeningToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashScreeningToken(token) };
}

export const hashScreeningToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function screeningLink(base: string, token: string): string {
  if (base.includes('{token}')) return base.replace('{token}', encodeURIComponent(token));
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}
