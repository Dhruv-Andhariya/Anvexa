/** Minimal cookie helpers (avoids adding cookie-parser for one cookie). */

export const SESSION_COOKIE = 'hireflow_session';

/**
 * Secure (sent only over HTTPS) whenever the request itself came over HTTPS, always in production, and when
 * COOKIE_SECURE=true. COOKIE_SECURE=false cannot switch it off for HTTPS or production - only plain-HTTP local dev
 * (http://localhost) goes without it.
 */
const secure = (httpsRequest: boolean) =>
  httpsRequest || process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** httpOnly (JS cannot read it), SameSite=Lax (not sent on cross-site POSTs). */
export function sessionCookie(token: string, maxAgeMs: number, httpsRequest = false): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure(httpsRequest) ? ['Secure'] : []),
  ].join('; ');
}

export const clearSessionCookie = (httpsRequest = false) => sessionCookie('', 0, httpsRequest);

/** The response methods we use (express and the test server both have it). */
export interface CookieResponse {
  setHeader(name: string, value: string | string[]): unknown;
}
