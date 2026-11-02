import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretBox } from '../../src/common/secret-box';
import { LinkedInAdapter, type ChannelContext } from '../../src/modules/publisher/channels';
import { LinkedInConnectService } from '../../src/modules/publisher/linkedin-connect.service';
import {
  checkOAuthState,
  LinkedInOAuthClient,
  LinkedInOAuthError,
  newOAuthState,
  OAUTH_STATE_COOKIE,
  type LinkedInOAuthConfig,
} from '../../src/modules/publisher/linkedin-oauth';
import { ACTOR, COMPANY, FORM, JD, JOB_ID, MemoryAudit, MemoryChannelCredentials, OTHER_TENANT, TENANT } from './fixtures';

const CONFIG: LinkedInOAuthConfig = {
  clientId: 'client-123',
  clientSecret: 'CLIENT-SECRET',
  redirectUri: 'http://localhost:4000/api/v1/publisher/linkedin/callback',
  scopes: 'w_organization_social',
  dashboardUrl: 'http://localhost:3000',
  authBase: 'https://www.linkedin.com/oauth/v2',
  apiBase: 'https://api.linkedin.com',
  timeoutMs: 1000,
};
const tokenResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** "name=value; Path=..." -> value, as the browser would send it back. */
const cookieValue = (setCookie: string) => decodeURIComponent(setCookie.split(';')[0]!.slice(OAUTH_STATE_COOKIE.length + 1));

describe('SecretBox', () => {
  const box = SecretBox.fromKey(randomBytes(32));

  it('encrypts so the stored value never contains the token, and decrypts it back', () => {
    const sealed = box.encrypt('AQV-SECRET-TOKEN');
    expect(sealed).not.toContain('SECRET');
    expect(box.encrypt('AQV-SECRET-TOKEN')).not.toBe(sealed); // fresh IV every time
    expect(box.decrypt(sealed)).toBe('AQV-SECRET-TOKEN');
  });

  it('refuses a changed value or another key', () => {
    const sealed = box.encrypt('token');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
    expect(() => SecretBox.fromKey(randomBytes(32)).decrypt(sealed)).toThrow();
  });

  it('reads ENCRYPTION_KEY as base64 or hex, and ignores a wrong length', () => {
    const key = randomBytes(32);
    expect(SecretBox.fromEnv({ ENCRYPTION_KEY: key.toString('base64') })).not.toBeNull();
    expect(SecretBox.fromEnv({ ENCRYPTION_KEY: key.toString('hex') })).not.toBeNull();
    expect(SecretBox.fromEnv({ ENCRYPTION_KEY: 'too-short' })).toBeNull();
    expect(SecretBox.fromEnv({})).toBeNull();
  });
});

describe('OAuth state', () => {
  it('accepts only the same state for the same company', () => {
    const { state, cookie } = newOAuthState(TENANT);
    expect(cookie).toMatch(/HttpOnly; SameSite=Lax; Max-Age=600/);
    expect(cookie).toContain('Path=/api/v1/publisher/linkedin');
    const stored = cookieValue(cookie);
    expect(checkOAuthState(stored, state, TENANT)).toBe(true);
    expect(checkOAuthState(stored, `${state}x`, TENANT)).toBe(false);
    expect(checkOAuthState(stored, state, OTHER_TENANT)).toBe(false);
    expect(checkOAuthState(undefined, state, TENANT)).toBe(false);
    expect(checkOAuthState(stored, undefined, TENANT)).toBe(false);
  });
});

describe('LinkedInOAuthClient', () => {
  it('builds the consent URL with our redirect URI and scope', () => {
    const url = new URL(new LinkedInOAuthClient(CONFIG).authorizeUrl('abc'));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: CONFIG.redirectUri,
      state: 'abc',
      scope: 'w_organization_social',
    });
  });

  it('exchanges the code for tokens with expiry times', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      tokenResponse({ access_token: 'AT', expires_in: 5_184_000, refresh_token: 'RT', refresh_token_expires_in: 31_536_000, scope: 'w_organization_social' }),
    );
    const t = await new LinkedInOAuthClient({ ...CONFIG, fetch }).exchangeCode('the-code', 0);
    expect(t).toEqual({
      accessToken: 'AT',
      refreshToken: 'RT',
      expiresAt: new Date(5_184_000_000),
      refreshTokenExpiresAt: new Date(31_536_000_000),
      scopes: 'w_organization_social',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://www.linkedin.com/oauth/v2/accessToken');
    expect(Object.fromEntries(init!.body as URLSearchParams)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: CONFIG.redirectUri,
      client_id: 'client-123',
      client_secret: 'CLIENT-SECRET',
    });
  });

  it('maps failures to short reasons without secrets', async () => {
    const rejected = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, 400));
    const down = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('fetch failed CLIENT-SECRET'));
    const empty = vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse({}));
    for (const [fetch, reason] of [[rejected, 'rejected'], [down, 'unreachable'], [empty, 'bad_response']] as const) {
      const err = await new LinkedInOAuthClient({ ...CONFIG, fetch }).exchangeCode('c').catch((e) => e);
      expect(err).toBeInstanceOf(LinkedInOAuthError);
      expect(err.reason).toBe(reason);
      expect(err.message).not.toContain('SECRET');
    }
    expect(await new LinkedInOAuthClient({ ...CONFIG, clientSecret: undefined }).exchangeCode('c').catch((e) => e.reason)).toBe('not_configured');
  });
});

describe('LinkedInConnectService', () => {
  let credentials: MemoryChannelCredentials;
  let audit: MemoryAudit;
  const service = (fetch?: typeof globalThis.fetch, config: Partial<LinkedInOAuthConfig> = {}) =>
    new LinkedInConnectService(new LinkedInOAuthClient({ ...CONFIG, ...config, fetch }), credentials, audit.asService());
  /** LinkedIn: token exchange, then /v2/userinfo of the account that logged in. */
  const goodFetch = (sub = 'naina-123') =>
    vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) =>
      String(url).endsWith('/v2/userinfo')
        ? tokenResponse({ sub, name: 'Naina Chauhan' })
        : tokenResponse({ access_token: 'AT', expires_in: 3600 }),
    );
  const connect = async (s: LinkedInConnectService) => {
    const step = s.start(TENANT);
    const state = new URL(step.redirectTo).searchParams.get('state')!;
    return s.finish(TENANT, ACTOR, { code: 'c1', state }, cookieValue(step.cookie!));
  };

  beforeEach(() => {
    credentials = new MemoryChannelCredentials();
    audit = new MemoryAudit();
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('runs the full flow: consent redirect, callback, token saved for this company only', async () => {
    const fetch = goodFetch();
    const s = service(fetch);
    const step = s.start(TENANT);
    const state = new URL(step.redirectTo).searchParams.get('state')!;

    const result = await s.finish(TENANT, ACTOR, { code: 'c1', state }, cookieValue(step.cookie!));
    expect(result).toBe('connected');
    expect((await credentials.accessTokens(TENANT)).get('linkedin')).toBe('AT');
    expect((await credentials.accessTokens(OTHER_TENANT)).size).toBe(0);
    expect(s.back(result)).toBe('http://localhost:3000/publish?linkedin=connected');

    const entry = audit.entries.at(-1)!;
    expect(entry).toMatchObject({ tenantId: TENANT, action: 'publisher.channel_connected', subjectId: 'linkedin' });
    expect(JSON.stringify(entry)).not.toContain('"AT"');
  });

  it('refuses a callback without the matching state cookie (no token exchange at all)', async () => {
    const fetch = goodFetch();
    const s = service(fetch);
    const step = s.start(TENANT);
    const state = new URL(step.redirectTo).searchParams.get('state')!;
    expect(await s.finish(TENANT, ACTOR, { code: 'c', state }, undefined)).toBe('invalid_state');
    expect(await s.finish(OTHER_TENANT, ACTOR, { code: 'c', state }, cookieValue(step.cookie!))).toBe('invalid_state');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a cancelled consent and a LinkedIn failure', async () => {
    expect(await service(goodFetch()).finish(TENANT, ACTOR, { error: 'user_cancelled_authorize' }, undefined)).toBe('denied');
    const s = service(vi.fn<typeof globalThis.fetch>().mockResolvedValue(tokenResponse({}, 401)));
    const step = s.start(TENANT);
    const state = new URL(step.redirectTo).searchParams.get('state')!;
    expect(await s.finish(TENANT, ACTOR, { code: 'c', state }, cookieValue(step.cookie!))).toBe('failed');
    expect(credentials.rows.size).toBe(0);
  });

  it('does not start when the LinkedIn app or ENCRYPTION_KEY is missing', () => {
    expect(service(undefined, { clientId: undefined }).start(TENANT)).toEqual({ redirectTo: 'http://localhost:3000/publish?linkedin=not_configured' });
    vi.stubEnv('ENCRYPTION_KEY', '');
    expect(service().start(TENANT).redirectTo).toContain('linkedin=not_configured');
  });

  it('records which LinkedIn account was connected (shown as "Connected as ...")', async () => {
    expect(await connect(service(goodFetch()))).toBe('connected');
    expect(credentials.rows.get(`${TENANT}:linkedin`)).toMatchObject({ accountId: 'naina-123', accountName: 'Naina Chauhan' });
    expect((await credentials.statuses(TENANT)).get('linkedin')!.accountName).toBe('Naina Chauhan');
    expect(audit.entries.at(-1)!.metadata).toMatchObject({ accountId: 'naina-123' });
  });

  it('with LINKEDIN_ALLOWED_MEMBER_ID, refuses any other LinkedIn account and stores nothing', async () => {
    expect(await connect(service(goodFetch('someone-else'), { allowedMemberId: 'naina-123' }))).toBe('wrong_account');
    expect(credentials.rows.size).toBe(0);
    expect(audit.entries.at(-1)!.action).toBe('publisher.channel_connect_refused');

    expect(await connect(service(goodFetch('naina-123'), { allowedMemberId: 'naina-123' }))).toBe('connected');
    expect(credentials.rows.size).toBe(1);
  });

  it('disconnect forgets the token', async () => {
    await credentials.save(TENANT, 'linkedin', { accessToken: 'AT', refreshToken: null, expiresAt: null, refreshTokenExpiresAt: null, scopes: '', connectedBy: null });
    await service().disconnect(TENANT, ACTOR);
    expect((await credentials.statuses(TENANT)).size).toBe(0);
    expect(audit.entries.at(-1)!.action).toBe('publisher.channel_disconnected');
  });
});

describe('LinkedInAdapter with a connected company', () => {
  const ctx = (accessToken?: string): ChannelContext => ({
    tenantId: TENANT,
    jobId: JOB_ID,
    slug: 's',
    jobPageUrl: 'https://careers.example/acme/jobs/s',
    links: { apply: 'https://careers.example/acme/jobs/s?src=linkedin', careers: 'https://acme.example/careers' },
    source: { company: { name: COMPANY.name, about: COMPANY.about }, form: FORM, jd: JD, selectionProcess: [] },
    settings: { organizationId: '12345678' },
    accessToken,
  });

  it("uses the company's own token before the env fallback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }));
    const adapter = new LinkedInAdapter({ accessToken: 'ENV-TOKEN', apiVersion: '202501', fetch });
    await adapter.publish(ctx('COMPANY-TOKEN'));
    expect((fetch.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer COMPANY-TOKEN');
    expect(new LinkedInAdapter({ apiVersion: '202501' }).blockers(ctx('COMPANY-TOKEN'))).toEqual([]);
  });
});

describe('LinkedInAdapter in member mode (personal profile)', () => {
  const ctx = (accessToken?: string): ChannelContext => ({
    tenantId: TENANT,
    jobId: JOB_ID,
    slug: 's',
    jobPageUrl: 'https://careers.example/acme/jobs/s',
    links: { apply: 'https://careers.example/acme/jobs/s?src=linkedin', careers: 'https://acme.example/careers' },
    source: { company: { name: COMPANY.name, about: COMPANY.about }, form: FORM, jd: JD, selectionProcess: [] },
    settings: {}, // no organizationId needed
    accessToken,
  });

  it('needs no page id and posts as the member from /v2/userinfo', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sub: 'abc-123_X' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } }));
    const adapter = new LinkedInAdapter({ postAs: 'member', apiVersion: '202609', fetch });
    expect(adapter.label).toBe('LinkedIn (personal profile)');
    expect(adapter.blockers(ctx('T'))).toEqual([]);

    const ref = await adapter.publish(ctx('T'));
    expect(ref.externalId).toBe('urn:li:share:9');
    expect(String(fetch.mock.calls[0]![0])).toBe('https://api.linkedin.com/v2/userinfo');
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body)).author).toBe('urn:li:person:abc-123_X');
  });

  it('with LINKEDIN_ALLOWED_MEMBER_ID, never posts as another account', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ sub: 'someone-else' }), { status: 200 }));
    const adapter = new LinkedInAdapter({ postAs: 'member', apiVersion: '202609', allowedMemberId: 'naina-123', fetch });
    const err = await adapter.publish(ctx('T')).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/not the one allowed to post/);
    expect(fetch).toHaveBeenCalledTimes(1); // only the profile lookup, no post
  });

  it('asks to reconnect when the token cannot read the profile id', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 403 }));
    const err = await new LinkedInAdapter({ postAs: 'member', apiVersion: '202609', fetch }).publish(ctx('T')).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/Connect LinkedIn/);
    expect(fetch).toHaveBeenCalledTimes(1); // never posts without a known author
  });
});
