import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * "Continue with Google" (OpenID Connect, authorization code flow + PKCE) for HR login and sign-up.
 *
 * Setup (Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID, type "Web application"):
 *  - Authorized redirect URI: GOOGLE_REDIRECT_URI, character for character
 *    (default http://localhost:4000/api/v1/auth/google/callback)
 *  - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the root .env. Without them the Google buttons are hidden.
 *
 * The ID token comes straight from Google's token endpoint over TLS, so (OpenID Connect Core 3.1.3.7) its claims are
 * checked - issuer, audience, expiry, verified email - without fetching Google's signing keys.
 */
export interface GoogleOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  /** HR dashboard: where the browser lands afterwards. */
  dashboardUrl: string;
  authUrl: string;
  tokenUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const GOOGLE_OAUTH_CONFIG = Symbol('GOOGLE_OAUTH_CONFIG');

export const googleOAuthConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig => ({
  clientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
  clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
  redirectUri: env.GOOGLE_REDIRECT_URI || `http://localhost:${env.API_PORT ?? 4000}/api/v1/auth/google/callback`,
  dashboardUrl: (env.HR_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  timeoutMs: 15_000,
});

/** Short reason codes; the dashboard turns them into messages. Never contain secrets. */
export type GoogleOAuthFailure = 'not_configured' | 'cancelled' | 'expired' | 'unreachable' | 'rejected' | 'unverified_email' | 'account_disabled' | 'account_mismatch';

export class GoogleOAuthError extends Error {
  constructor(readonly reason: GoogleOAuthFailure) {
    super(`Google sign-in failed: ${reason}`);
    this.name = 'GoogleOAuthError';
  }
}

/** What we use from Google's ID token. */
export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
}

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export class GoogleOAuthClient {
  constructor(private readonly config: GoogleOAuthConfig) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  get dashboardUrl(): string {
    return this.config.dashboardUrl;
  }

  authorizeUrl(state: string, codeVerifier: string): string {
    if (!this.configured) throw new GoogleOAuthError('not_configured');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId!,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${this.config.authUrl}?${q}`;
  }

  /** Swaps the one-time ?code= for an ID token and returns the checked identity in it. */
  async identity(code: string, codeVerifier: string, now = Date.now()): Promise<GoogleIdentity> {
    if (!this.configured) throw new GoogleOAuthError('not_configured');
    let res: Response;
    try {
      res = await (this.config.fetch ?? fetch)(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId!,
          client_secret: this.config.clientSecret!,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      // Never pass the original error on: it could carry the request body (client secret, code).
      throw new GoogleOAuthError('unreachable');
    }
    if (!res.ok) throw new GoogleOAuthError('rejected');
    const body = (await res.json().catch(() => undefined)) as { id_token?: unknown } | undefined;
    if (typeof body?.id_token !== 'string') throw new GoogleOAuthError('rejected');
    return this.checkIdToken(body.id_token, now);
  }

  private checkIdToken(idToken: string, now: number): GoogleIdentity {
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new GoogleOAuthError('rejected');
    }
    const { iss, aud, exp, sub, email, email_verified: verified, name } = claims;
    if (typeof iss !== 'string' || !ISSUERS.has(iss) || aud !== this.config.clientId) throw new GoogleOAuthError('rejected');
    if (typeof exp !== 'number' || exp * 1000 <= now) throw new GoogleOAuthError('rejected');
    if (typeof sub !== 'string' || !/^\d{1,64}$/.test(sub) || typeof email !== 'string') throw new GoogleOAuthError('rejected');
    if (verified !== true) throw new GoogleOAuthError('unverified_email');
    const lower = email.trim().toLowerCase();
    const display = typeof name === 'string' && name.trim().length >= 2 ? name.trim().slice(0, 100) : lower.split('@')[0]!.slice(0, 100);
    return { sub, email: lower, name: display.length >= 2 ? display : 'HireFlow user' };
  }
}

// ---- state cookie: binds the callback to THIS browser (login CSRF) and carries the PKCE verifier ----

export const GOOGLE_STATE_COOKIE = 'hireflow_google_oauth';
const COOKIE_PATH = '/api/v1/auth/google';
const STATE_MAX_AGE_S = 600;

/** A fresh state + PKCE verifier, and the cookie that remembers them (and where to go afterwards) for 10 minutes. */
export function newGoogleState(next: string | undefined, httpsRequest: boolean) {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const value = [state, verifier, Buffer.from(next ?? '').toString('base64url')].join('.');
  return { state, verifier, cookie: stateCookie(value, STATE_MAX_AGE_S, httpsRequest) };
}

export const clearGoogleStateCookie = (httpsRequest: boolean) => stateCookie('', 0, httpsRequest);

/** The verifier and next path when Google sent back the state we stored in this browser; null otherwise. */
export function readGoogleState(cookieValue: string | undefined, state: string | undefined): { verifier: string; next?: string } | null {
  if (!cookieValue || !state) return null;
  const [stored, verifier, next] = cookieValue.split('.');
  if (!stored || !verifier) return null;
  const a = Buffer.from(stored);
  const b = Buffer.from(state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { verifier, next: safeNextPath(Buffer.from(next ?? '', 'base64url').toString('utf8')) };
}

/** Only same-site dashboard paths (no open redirect). */
export const safeNextPath = (v: unknown) =>
  typeof v === 'string' && v.length <= 200 && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : undefined;

/** SameSite=Lax: still sent when Google redirects the browser back (a top-level GET). */
function stateCookie(value: string, maxAgeS: number, httpsRequest: boolean): string {
  const secure = httpsRequest || process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return [
    `${GOOGLE_STATE_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
