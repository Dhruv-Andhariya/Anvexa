import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * "Continue with Google" (OpenID Connect, authorization code flow + PKCE) for HR login and sign-up.
 *
 * Setup (Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID, type "Web application"):
 *  - Authorized redirect URIs, character for character:
 *      GOOGLE_REDIRECT_URI (default http://localhost:4000/api/v1/auth/google/callback) - used on this computer
 *      <HR_DASHBOARD_URL>/api/v1/auth/google/callback - used when HR opens the dashboard on its public address
 *  - Signing in from a public address returns through THAT address (the dashboard's /api/v1 proxy), so the cookies stay
 *    on the domain HR is using. Only addresses the API knows are used (HR_DASHBOARD_URL, localhost:3000,
 *    GOOGLE_EXTRA_DASHBOARD_URLS): a request can never send the browser anywhere else.
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
  /** Every address the dashboard is opened on (HR_DASHBOARD_URL, localhost:3000, GOOGLE_EXTRA_DASHBOARD_URLS). */
  dashboardOrigins?: string[];
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
  dashboardOrigins: [
    ...new Set(
      [env.HR_DASHBOARD_URL || 'http://localhost:3000', 'http://localhost:3000', ...(env.GOOGLE_EXTRA_DASHBOARD_URLS ?? '').split(',')]
        .map(originOf)
        .filter((o): o is string => !!o),
    ),
  ],
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  timeoutMs: 15_000,
});

/** Short reason codes; the dashboard turns them into messages. Never contain secrets. */
export type GoogleOAuthFailure =
  | 'not_configured'
  | 'cancelled'
  | 'expired'
  | 'unreachable'
  | 'rejected'
  | 'unverified_email'
  | 'account_disabled'
  | 'account_mismatch'
  /** "Log in with Google" by a Google account that has no Anvexa account: nothing is created, the browser goes to sign-up. */
  | 'no_account';

/** Which page started the Google sign-in: only "signup" may create a new account. */
export type GoogleMode = 'login' | 'signup';
/** Anything but an explicit "signup" is a login (also old state cookies without a mode): never creates an account. */
export const googleMode = (v: unknown): GoogleMode => (v === 'signup' ? 'signup' : 'login');

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

function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

const isLocal = (origin: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);

/** Where one sign-in runs: the dashboard address HR is on, and Google's return address for it. */
export interface GoogleFlow {
  dashboardUrl: string;
  redirectUri: string;
}

export class GoogleOAuthClient {
  constructor(private readonly config: GoogleOAuthConfig) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  get dashboardUrl(): string {
    return this.config.dashboardUrl;
  }

  /**
   * The flow for the dashboard address the browser is on (the Host the dashboard's proxy forwarded). A public address
   * returns through itself; this computer (localhost) keeps GOOGLE_REDIRECT_URI. Unknown hosts: the configured default.
   */
  flowFor(forwardedHost: string | undefined): GoogleFlow {
    const host = (forwardedHost ?? '').split(',')[0]!.trim().toLowerCase();
    const origin = host ? (this.config.dashboardOrigins ?? []).find((o) => new URL(o).host === host) : undefined;
    if (!origin) return { dashboardUrl: this.config.dashboardUrl, redirectUri: this.config.redirectUri };
    if (isLocal(origin)) return { dashboardUrl: origin, redirectUri: this.config.redirectUri };
    return { dashboardUrl: origin, redirectUri: `${origin}/api/v1/auth/google/callback` };
  }

  /** A flow read back from the state cookie, accepted only for addresses this API knows. */
  knownFlow(f: Partial<GoogleFlow> | undefined): GoogleFlow | null {
    if (!f?.dashboardUrl || !f.redirectUri) return null;
    const origins = this.config.dashboardOrigins ?? [this.config.dashboardUrl];
    if (!origins.includes(f.dashboardUrl)) return null;
    if (f.redirectUri !== this.config.redirectUri && f.redirectUri !== `${f.dashboardUrl}/api/v1/auth/google/callback`) return null;
    return { dashboardUrl: f.dashboardUrl, redirectUri: f.redirectUri };
  }

  authorizeUrl(state: string, codeVerifier: string, redirectUri: string = this.config.redirectUri): string {
    if (!this.configured) throw new GoogleOAuthError('not_configured');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId!,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${this.config.authUrl}?${q}`;
  }

  /** Swaps the one-time ?code= for an ID token and returns the checked identity in it. */
  async identity(code: string, codeVerifier: string, now = Date.now(), redirectUri: string = this.config.redirectUri): Promise<GoogleIdentity> {
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
          redirect_uri: redirectUri,
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
    return { sub, email: lower, name: display.length >= 2 ? display : 'Anvexa user' };
  }
}

// ---- state cookie: binds the callback to THIS browser (login CSRF) and carries the PKCE verifier ----

export const GOOGLE_STATE_COOKIE = 'hireflow_google_oauth';
const COOKIE_PATH = '/api/v1/auth/google';
const STATE_MAX_AGE_S = 600;

/**
 * A fresh state + PKCE verifier, and the cookie that remembers them (where to go afterwards, the dashboard address and
 * whether this is a login or a sign-up) for 10 minutes.
 */
export function newGoogleState(next: string | undefined, httpsRequest: boolean, flow?: GoogleFlow, mode: GoogleMode = 'login') {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  // fixed positions: state.verifier.next.dashboard.redirect.mode (dashboard / redirect empty when there is no flow)
  const value = [state, verifier, b64(next ?? ''), flow ? b64(flow.dashboardUrl) : '', flow ? b64(flow.redirectUri) : '', mode].join('.');
  return { state, verifier, cookie: stateCookie(value, STATE_MAX_AGE_S, httpsRequest) };
}

export const clearGoogleStateCookie = (httpsRequest: boolean) => stateCookie('', 0, httpsRequest);

/** The verifier and next path when Google sent back the state we stored in this browser; null otherwise. */
export function readGoogleState(
  cookieValue: string | undefined,
  state: string | undefined,
): { verifier: string; next?: string; flow?: Partial<GoogleFlow>; mode: GoogleMode } | null {
  if (!cookieValue || !state) return null;
  const [stored, verifier, next, dash, redirect, mode] = cookieValue.split('.');
  if (!stored || !verifier) return null;
  const a = Buffer.from(stored);
  const b = Buffer.from(state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const text = (s: string | undefined) => (s ? Buffer.from(s, 'base64url').toString('utf8') : undefined);
  return {
    verifier,
    next: safeNextPath(text(next)),
    flow: dash && redirect ? { dashboardUrl: text(dash), redirectUri: text(redirect) } : undefined,
    mode: googleMode(mode),
  };
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
