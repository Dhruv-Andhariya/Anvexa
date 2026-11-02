import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ChannelTokens } from './channel-credentials';
import { linkedInPostAsFromEnv } from './channels/linkedin.adapter';

/**
 * LinkedIn OAuth 2.0 (3-legged, authorization code) so a Company Admin can connect the company's LinkedIn page
 * with a "Connect LinkedIn" button instead of pasting a token into the server env.
 *
 * VERIFY (owner) against https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
 * before going live:
 *  - authorize URL https://www.linkedin.com/oauth/v2/authorization (response_type, client_id, redirect_uri, state, scope)
 *  - token URL https://www.linkedin.com/oauth/v2/accessToken, form-encoded body with client_id + client_secret
 *  - response fields access_token, expires_in, refresh_token, refresh_token_expires_in, scope
 *  - redirect_uri must match one of the "Authorized redirect URLs" in the LinkedIn app EXACTLY
 */
export interface LinkedInOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  /** Must be listed in the LinkedIn app's Auth tab, character for character. */
  redirectUri: string;
  /**
   * Space separated. w_organization_social = post as the company page (Community Management API);
   * 'openid profile w_member_social' = post as the connecting member (LINKEDIN_POST_AS=member).
   */
  scopes: string;
  /** Where the browser lands after connecting (HR dashboard Publish page). */
  dashboardUrl: string;
  authBase: string;
  /** REST API host, for the OpenID userinfo lookup. */
  apiBase: string;
  /**
   * env LINKEDIN_ALLOWED_MEMBER_ID: the ONLY LinkedIn account (OpenID `sub`) that may be connected and post.
   * Empty = any account. The id is shown in the API log / channel_credentials.account_id after a connect.
   */
  allowedMemberId?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const LINKEDIN_OAUTH_CONFIG = Symbol('LINKEDIN_OAUTH_CONFIG');

export const linkedInOAuthConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): LinkedInOAuthConfig => ({
  clientId: env.LINKEDIN_CLIENT_ID || undefined,
  clientSecret: env.LINKEDIN_CLIENT_SECRET || undefined,
  redirectUri:
    env.LINKEDIN_REDIRECT_URI || `http://localhost:${env.API_PORT ?? 4000}/api/v1/publisher/linkedin/callback`,
  scopes: env.LINKEDIN_SCOPES || (linkedInPostAsFromEnv(env) === 'member' ? 'openid profile w_member_social' : 'w_organization_social'),
  dashboardUrl: (env.HR_DASHBOARD_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  authBase: 'https://www.linkedin.com/oauth/v2',
  apiBase: 'https://api.linkedin.com',
  allowedMemberId: env.LINKEDIN_ALLOWED_MEMBER_ID?.trim() || undefined,
  timeoutMs: 15_000,
});

/** Failure while talking to LinkedIn. `reason` is a short code for the dashboard; never contains secrets. */
export class LinkedInOAuthError extends Error {
  constructor(readonly reason: 'not_configured' | 'unreachable' | 'rejected' | 'bad_response') {
    super(`LinkedIn OAuth failed: ${reason}`);
    this.name = 'LinkedInOAuthError';
  }
}

export class LinkedInOAuthClient {
  constructor(private readonly config: LinkedInOAuthConfig) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  get dashboardUrl(): string {
    return this.config.dashboardUrl;
  }

  get allowedMemberId(): string | undefined {
    return this.config.allowedMemberId;
  }

  /**
   * The LinkedIn account a token belongs to: OpenID Connect userinfo (`sub` + `name`, needs `openid profile`).
   * Returns null when the token cannot read it (e.g. a page-only w_organization_social token).
   */
  async account(accessToken: string): Promise<{ id: string; name: string | null } | null> {
    let res: Response;
    try {
      res = await (this.config.fetch ?? fetch)(`${this.config.apiBase}/v2/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new LinkedInOAuthError('unreachable');
    }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new LinkedInOAuthError('bad_response');
    const body = (await res.json().catch(() => undefined)) as { sub?: unknown; name?: unknown } | undefined;
    if (typeof body?.sub !== 'string' || !/^[\w-]{1,100}$/.test(body.sub)) throw new LinkedInOAuthError('bad_response');
    return { id: body.sub, name: typeof body.name === 'string' ? body.name.slice(0, 200) : null };
  }

  authorizeUrl(state: string): string {
    if (!this.config.clientId) throw new LinkedInOAuthError('not_configured');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: this.config.scopes,
    });
    return `${this.config.authBase}/authorization?${q}`;
  }

  /** Swaps the one-time ?code= from the callback for tokens. */
  async exchangeCode(code: string, now = Date.now()): Promise<Omit<ChannelTokens, 'connectedBy'>> {
    if (!this.configured) throw new LinkedInOAuthError('not_configured');
    let res: Response;
    try {
      res = await (this.config.fetch ?? fetch)(`${this.config.authBase}/accessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId!,
          client_secret: this.config.clientSecret!,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      // Never pass the original error on: it could carry the request body (client secret, code).
      throw new LinkedInOAuthError('unreachable');
    }
    if (!res.ok) throw new LinkedInOAuthError('rejected');

    const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const accessToken = body?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) throw new LinkedInOAuthError('bad_response');
    const refreshToken = typeof body?.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
    return {
      accessToken,
      refreshToken,
      expiresAt: secondsFrom(now, body?.expires_in),
      refreshTokenExpiresAt: refreshToken ? secondsFrom(now, body?.refresh_token_expires_in) : null,
      scopes: typeof body?.scope === 'string' ? body.scope.replace(/,/g, ' ').trim() : '',
    };
  }
}

const secondsFrom = (now: number, s: unknown): Date | null =>
  typeof s === 'number' && Number.isFinite(s) && s > 0 ? new Date(now + s * 1000) : null;

// ---- state cookie: stops another site from finishing a connect flow in the admin's browser (login CSRF) ----

export const OAUTH_STATE_COOKIE = 'hireflow_linkedin_oauth';
const COOKIE_PATH = '/api/v1/publisher/linkedin';
const STATE_MAX_AGE_S = 600;

/** A fresh random `state` for LinkedIn, and the cookie that remembers it (plus the company) for 10 minutes. */
export function newOAuthState(tenantId: string) {
  const state = randomBytes(24).toString('base64url');
  return { state, cookie: stateCookie(`${state}.${tenantId}`, STATE_MAX_AGE_S) };
}

export const clearOAuthStateCookie = () => stateCookie('', 0);

/** True only when LinkedIn sent back the same state we stored, for the same company. */
export function checkOAuthState(cookieValue: string | undefined, state: string | undefined, tenantId: string): boolean {
  if (!cookieValue || !state) return false;
  const dot = cookieValue.indexOf('.');
  if (dot <= 0 || cookieValue.slice(dot + 1) !== tenantId) return false;
  const a = Buffer.from(cookieValue.slice(0, dot));
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** SameSite=Lax: still sent when LinkedIn redirects the browser back (a top-level GET). */
function stateCookie(value: string, maxAgeS: number): string {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  return [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
