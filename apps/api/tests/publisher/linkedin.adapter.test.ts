import { describe, expect, it, vi } from 'vitest';
import { ChannelError, LinkedInAdapter, type ChannelContext } from '../../src/modules/publisher/channels';
import { escapeLittleText, LINKEDIN_TEXT_MAX } from '../../src/modules/publisher/channels/linkedin.adapter';
import { COMPANY, FORM, JD, JOB_ID, OTHER_TENANT, TENANT } from './fixtures';

const TOKEN = 'AQV-SECRET-TOKEN';
const OPTS = { accessToken: TOKEN, fallbackTenantId: TENANT, apiVersion: '202501' };
const ctx = (settings: Record<string, unknown> = { organizationId: '12345678' }, jd = JD): ChannelContext => ({
  tenantId: TENANT,
  jobId: JOB_ID,
  slug: 'junior-backend-developer-456789',
  jobPageUrl: 'https://careers.example/acme/jobs/junior-backend-developer-456789',
  links: { apply: 'https://careers.example/acme/jobs/junior-backend-developer-456789?src=linkedin', careers: 'https://acme.example/careers_page' },
  source: { company: { name: COMPANY.name, about: COMPANY.about }, form: FORM, jd, selectionProcess: ['AI screening (online)'] },
  settings,
});
const created = (urn: string | null) =>
  new Response(null, { status: 201, headers: urn ? { 'x-restli-id': urn } : {} });

describe('LinkedInAdapter', () => {
  it('lists every missing setting as a blocker', () => {
    expect(new LinkedInAdapter({}).blockers(ctx({}))).toEqual([
      'LinkedIn is not connected. A Company Admin can connect it on the Publish page.',
      'LINKEDIN_API_VERSION (YYYYMM) is not set on the server.',
      'No LinkedIn page set for this company (channel settings: organizationId).',
    ]);
    expect(new LinkedInAdapter(OPTS).blockers(ctx({ organizationId: 'urn:li:organization:1' }))).toHaveLength(1);
    expect(new LinkedInAdapter(OPTS).blockers(ctx())).toEqual([]);
  });

  it('creates one organization post and returns its URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(created('urn:li:share:7000000000000000001'));
    const ref = await new LinkedInAdapter({ ...OPTS, fetch }).publish(ctx());
    expect(ref).toEqual({ externalId: 'urn:li:share:7000000000000000001', url: 'https://www.linkedin.com/feed/update/urn:li:share:7000000000000000001/' });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://api.linkedin.com/rest/posts');
    const headers = init!.headers as Record<string, string>;
    expect(headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'linkedin-version': '202501', 'x-restli-protocol-version': '2.0.0' });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ author: 'urn:li:organization:12345678', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    // Reserved characters escaped in words, but both links stay intact and clickable.
    expect(body.commentary).toContain('AI screening \\(online\\)');
    expect(body.commentary).toContain('https://acme.example/careers_page');
    expect(body.commentary).toContain('?src=linkedin');
  });

  it('remove() deletes the post by its urn; a post already gone counts as removed', async () => {
    const urn = 'urn:li:share:7000000000000000001';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const adapter = new LinkedInAdapter({ ...OPTS, fetch });
    await adapter.remove(ctx(), { externalId: urn, url: null });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}`);
    expect(init).toMatchObject({ method: 'DELETE' });
    expect(init!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'linkedin-version': '202501', 'x-restli-protocol-version': '2.0.0' });

    fetch.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(adapter.remove(ctx(), { externalId: urn, url: null })).resolves.toBeUndefined();
  });

  it('remove() reports a refusal or a missing id safely, without the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const adapter = new LinkedInAdapter({ ...OPTS, fetch });
    const err = await adapter.remove(ctx(), { externalId: 'urn:li:share:1', url: null }).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain('SECRET');
    expect(await adapter.remove(ctx(), { externalId: null, url: null }).catch((e) => e)).toBeInstanceOf(ChannelError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('update() edits the same post in place with the current text and links', async () => {
    const urn = 'urn:li:share:7000000000000000001';
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await new LinkedInAdapter({ ...OPTS, fetch }).update(ctx(), { externalId: urn, url: null });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.linkedin.com/rest/posts/${encodeURIComponent(urn)}`);
    expect(init).toMatchObject({ method: 'POST' });
    expect(init!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'linkedin-version': '202501',
      'x-restli-protocol-version': '2.0.0',
      'x-restli-method': 'PARTIAL_UPDATE',
    });
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body.patch.$set)).toEqual(['commentary']);
    expect(body.patch.$set.commentary).toBe(escapeLittleText(new LinkedInAdapter(OPTS).render(ctx())));
    expect(body.patch.$set.commentary).toContain('?src=linkedin');
  });

  it('update() reports a deleted post, a refusal or a missing id safely; only LinkedIn errors it can retry are retryable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    const adapter = new LinkedInAdapter({ ...OPTS, fetch });
    const post = { externalId: 'urn:li:share:1', url: null };
    const gone = await adapter.update(ctx(), post).catch((e) => e);
    expect(gone).toBeInstanceOf(ChannelError);
    expect(gone.message).toContain('no longer exists');
    expect(gone.retryable).toBe(false);

    fetch.mockResolvedValue(new Response(null, { status: 403 }));
    const refused = await adapter.update(ctx(), post).catch((e) => e);
    expect(refused.retryable).toBe(false);
    expect(refused.message).not.toContain('SECRET');

    fetch.mockResolvedValue(new Response('{}', { status: 503 }));
    expect((await adapter.update(ctx(), post).catch((e) => e)).retryable).toBe(true);
    fetch.mockRejectedValue(Object.assign(new Error(`timeout Bearer ${TOKEN}`), { name: 'TimeoutError' }));
    const down = await adapter.update(ctx(), post).catch((e) => e);
    expect(down.retryable).toBe(true); // editing to the same text twice is harmless
    expect(down.message).not.toContain('SECRET');

    fetch.mockClear();
    expect(await adapter.update(ctx(), { externalId: null, url: null }).catch((e) => e)).toBeInstanceOf(ChannelError);
    expect(await adapter.update({ ...ctx(), reconnectNeeded: true }, post).catch((e) => e)).toBeInstanceOf(ChannelError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps a rejection to a safe, non-retryable error without the token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Not enough permissions to access: partnerApiPostsExternal.CREATE' }), { status: 403 }),
    );
    const err = await new LinkedInAdapter({ ...OPTS, fetch }).publish(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/^LinkedIn rejected the post \(403\): Not enough permissions/);
    expect(err.message).not.toContain('SECRET');
  });

  it('retries only when the post surely was not created (connection refused, 429)', async () => {
    const refused = new TypeError(`fetch failed Bearer ${TOKEN}`, { cause: { code: 'ECONNREFUSED' } });
    const down = vi.fn<typeof globalThis.fetch>().mockRejectedValue(refused);
    const e1 = await new LinkedInAdapter({ ...OPTS, fetch: down }).publish(ctx()).catch((e) => e);
    expect(e1.retryable).toBe(true);
    expect(e1.message).not.toContain('SECRET');
    const f = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    expect((await new LinkedInAdapter({ ...OPTS, fetch: f }).publish(ctx()).catch((e) => e)).retryable).toBe(true);
  });

  it('never re-posts automatically when the outcome is unknown (timeout, reset, 5xx)', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    for (const err of [timeout, reset]) {
      const f = vi.fn<typeof globalThis.fetch>().mockRejectedValue(err);
      const e = await new LinkedInAdapter({ ...OPTS, fetch: f }).publish(ctx()).catch((x) => x);
      expect(e).toBeInstanceOf(ChannelError);
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('Check the LinkedIn page before retrying');
    }
    const f = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 503 }));
    const e = await new LinkedInAdapter({ ...OPTS, fetch: f }).publish(ctx()).catch((x) => x);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('may or may not have been created');
  });

  it('uses the server-wide token only for the one opted-in company', () => {
    const other = { ...ctx(), tenantId: OTHER_TENANT };
    expect(new LinkedInAdapter(OPTS).blockers(other)).toEqual(['LinkedIn is not connected. A Company Admin can connect it on the Publish page.']);
    expect(new LinkedInAdapter({ accessToken: TOKEN, apiVersion: '202501' }).blockers(ctx())).toHaveLength(1);
    expect(new LinkedInAdapter(OPTS).blockers({ ...other, accessToken: 'OWN' })).toEqual([]);
  });

  it('never falls back to the server token when the company connection expired or broke', async () => {
    const broken = { ...ctx(), reconnectNeeded: true };
    expect(new LinkedInAdapter(OPTS).blockers(broken)).toEqual([
      'The LinkedIn connection expired or cannot be read. A Company Admin must reconnect it on the Publish page.',
    ]);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const err = await new LinkedInAdapter({ ...OPTS, fetch }).publish(broken).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shortens long JDs to fit the post limit', () => {
    const long = { ...JD, responsibilities: Array.from({ length: 30 }, (_, i) => `Responsibility ${i} ${'x'.repeat(150)}`) };
    expect(new LinkedInAdapter(OPTS).render(ctx(undefined, long)).length).toBeLessThanOrEqual(LINKEDIN_TEXT_MAX);
  });

  it('fits a company "About" that alone is almost 3000 characters (real case) - no "too long" blocker', () => {
    const c = ctx();
    const about = Array.from({ length: 30 }, (_, i) => `Sentence ${i} about what the company does for its customers.`).join(' ').padEnd(2993, 'x');
    const big = { ...c, source: { ...c.source, company: { ...c.source.company, about } } };
    const adapter = new LinkedInAdapter(OPTS);
    const text = adapter.render(big);
    expect(text.length).toBeLessThanOrEqual(LINKEDIN_TEXT_MAX);
    expect(text).toContain(c.links.apply);
    expect(text).toContain(c.links.careers);
    expect(adapter.blockers(big)).toEqual([]);
  });

  it('stays within the limit after LinkedIn escaping, whatever the JD contains', () => {
    const c = ctx();
    const noisy = { ...JD, summary: '(C#) @team [x] *y* _z_ '.repeat(400), responsibilities: Array.from({ length: 40 }, () => '<b>{a}|b#c</b>'.repeat(30)) };
    const big = { ...c, source: { ...c.source, jd: noisy, company: { ...c.source.company, about: '(about) '.repeat(800) } } };
    const text = new LinkedInAdapter(OPTS).render(big);
    expect(escapeLittleText(text).length).toBeLessThanOrEqual(LINKEDIN_TEXT_MAX);
    expect(text.endsWith(`Apply here: ${c.links.apply}\nCompany website: ${c.links.careers}`)).toBe(true);
  });
});

describe('escapeLittleText', () => {
  it('escapes reserved characters outside links only', () =>
    expect(escapeLittleText('C# (core) @team https://x.example/a_b#top')).toBe('C\\# \\(core\\) \\@team https://x.example/a_b#top'));
});
