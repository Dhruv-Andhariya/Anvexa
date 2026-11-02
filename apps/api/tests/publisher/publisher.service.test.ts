import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CareersSiteAdapter, ChannelError, LinkedInAdapter, type ChannelAdapter, type ChannelContext } from '../../src/modules/publisher/channels';
import { PublicJobsReader } from '../../src/modules/publisher/public-jobs.reader';
import { toApproved, type ApprovalRow } from '../../src/modules/publisher/publisher.store';
import { JdValidatorClient } from '../../src/modules/publisher/jd-checks';
import { PublisherEvents } from '../../src/modules/publisher/publisher.events';
import { PublisherService, makeJobSlug } from '../../src/modules/publisher/publisher.service';
import { ACTOR, COMPANY, FORM, JD, JOB_ID, MemoryAudit, MemoryChannelCredentials, MemoryPublisherStore, OTHER_TENANT, TENANT, approvedJd, request } from './fixtures';

class FakeAdapter implements ChannelAdapter {
  readonly label: string;
  calls = 0;
  lastText = '';
  constructor(
    readonly key: string,
    private readonly behaviour: () => Promise<void> = async () => {},
  ) {
    this.label = key;
  }
  render(ctx: ChannelContext) {
    return `${ctx.source.jd.title} ${ctx.links.apply}`;
  }
  blockers() {
    return [];
  }
  async publish(ctx: ChannelContext) {
    this.calls++;
    this.lastText = this.render(ctx);
    await this.behaviour();
    return { externalId: `${this.key}-1`, url: ctx.jobPageUrl };
  }
}

const validator = (errors: string[] = [], reachable = true) =>
  ({
    validate: vi.fn().mockResolvedValue(reachable ? { errors, warnings: [] } : { errors: [], warnings: ['unreachable'] }),
  }) as unknown as JdValidatorClient;

let store: MemoryPublisherStore;
let audit: MemoryAudit;
let credentials: MemoryChannelCredentials;
const events = { published: vi.fn(), failed: vi.fn() } as unknown as PublisherEvents;
const make = (adapters: ChannelAdapter[], v = validator(), careersSiteUrl = 'https://careers.example') =>
  new PublisherService(store, adapters, v, events, audit.asService(), {
    careersSiteUrl,
    attempts: 3,
    baseDelayMs: 1,
    sleep: async () => {},
  }, credentials);

beforeEach(() => {
  store = new MemoryPublisherStore();
  audit = new MemoryAudit();
  credentials = new MemoryChannelCredentials();
  store.companies.set(TENANT, COMPANY);
  store.approve(approvedJd());
});

describe('PublisherService.publish', () => {
  it('publishes the APPROVED version from the database on every enabled channel', async () => {
    const res = await make([new CareersSiteAdapter(), new FakeAdapter('linkedin')]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(res.version).toBe(1);
    expect(res.slug).toBe(makeJobSlug(JD.title, JOB_ID));
    expect(res.applyUrl).toBe(`https://careers.example/acme/jobs/${res.slug}`);
    expect(res.posts.map((p) => [p.channel, p.status])).toEqual([
      ['careers', 'PUBLISHED'],
      ['linkedin', 'PUBLISHED'],
    ]);
    expect(store.posts.every((p) => p.jdVersionId === 'jdv-1')).toBe(true);
  });

  it('ignores any JD the client sends: the approved version is always what goes out', async () => {
    const li = new FakeAdapter('linkedin');
    await make([li]).publish(TENANT, JOB_ID, request({ jd: { ...JD, title: 'Hacked title' } }), ACTOR);
    expect(li.lastText).toContain(JD.title);
    expect(li.lastText).not.toContain('Hacked');
  });

  it('refuses a job that is not approved (draft) with 404 JOB_NOT_APPROVED', async () => {
    const err = await make([new CareersSiteAdapter()]).publish(TENANT, '0192f3a1-7c2e-7a10-8b2c-000000000000', request(), ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(404);
    expect(err.getResponse()).toMatchObject({ code: 'JOB_NOT_APPROVED' });
  });

  it('keeps publishing other channels when one fails', async () => {
    const broken = new FakeAdapter('linkedin', async () => {
      throw new ChannelError('LinkedIn rejected the post (403): not an admin', false);
    });
    const crash = new FakeAdapter('weird', async () => {
      throw new Error('boom with secret');
    });
    const res = await make([new CareersSiteAdapter(), broken, crash]).publish(TENANT, JOB_ID, request(), ACTOR);
    const byChannel = Object.fromEntries(res.posts.map((p) => [p.channel, p]));
    expect(byChannel.careers!.status).toBe('PUBLISHED');
    expect(byChannel.linkedin).toMatchObject({ status: 'FAILED', error: 'LinkedIn rejected the post (403): not an admin' });
    expect(byChannel.weird).toMatchObject({ status: 'FAILED', error: 'Unexpected error while publishing.' });
  });

  it('never posts the same job twice (double click / publish again)', async () => {
    const li = new FakeAdapter('linkedin');
    const service = make([li]);
    await Promise.all([service.publish(TENANT, JOB_ID, request(), ACTOR), service.publish(TENANT, JOB_ID, request(), ACTOR)]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect(li.calls).toBe(1);
    expect(store.listings.size).toBe(1);
  });

  it('retries retryable failures with backoff, then succeeds', async () => {
    let n = 0;
    const flaky = new FakeAdapter('linkedin', async () => {
      if (++n < 3) throw new ChannelError('Could not reach LinkedIn.', true);
    });
    const res = await make([flaky]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(flaky.calls).toBe(3);
    expect(res.posts[0]!.status).toBe('PUBLISHED');
  });

  it('retry() publishes only the channels that failed before', async () => {
    let fail = true;
    const li = new FakeAdapter('linkedin', async () => {
      if (fail) throw new ChannelError('down', false);
    });
    const careers = new FakeAdapter('careers');
    const service = make([careers, li]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    fail = false;
    const res = await service.retry(TENANT, JOB_ID, ACTOR);
    expect(res.posts.every((p) => p.status === 'PUBLISHED')).toBe(true);
    expect(careers.calls).toBe(1);
    expect(li.calls).toBe(2);
  });

  it('skips channels switched off for the company', async () => {
    await store.setChannelSetting(TENANT, 'linkedin', { enabled: false, config: {} });
    const li = new FakeAdapter('linkedin');
    const res = await make([new CareersSiteAdapter(), li]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(res.posts.map((p) => p.channel)).toEqual(['careers']);
    expect(li.calls).toBe(0);
  });

  it('refuses to publish when the JD validator reports errors', async () => {
    const li = new FakeAdapter('linkedin');
    const err = await make([li], validator(['Biased wording: "young"'])).publish(TENANT, JOB_ID, request(), ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_READY_TO_PUBLISH', errors: ['Biased wording: "young"'] });
    expect(li.calls).toBe(0);
    expect(store.listings.size).toBe(0);
  });

  it('refuses when the company has neither a website nor a careers page link (every post needs one)', async () => {
    store.companies.set(TENANT, { ...COMPANY, careersPageUrl: null, websiteUrl: null });
    const err = await make([new FakeAdapter('linkedin')]).publish(TENANT, JOB_ID, request(), ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(JSON.stringify(err.getResponse())).toContain('website link');
  });

  it('links the company website in posts, and the careers page only when there is no website', async () => {
    store.companies.set(TENANT, { ...COMPANY, websiteUrl: 'https://acme.example' });
    const withSite = await make([new CareersSiteAdapter()]).preview(TENANT, JOB_ID, request());
    expect(withSite.channels[0]!.links?.careers).toBe('https://acme.example');
    expect(withSite.channels[0]!.text).toContain('Company website: https://acme.example');

    store.companies.set(TENANT, { ...COMPANY, websiteUrl: null });
    const noSite = await make([new CareersSiteAdapter()]).preview(TENANT, JOB_ID, request());
    expect(noSite.channels[0]!.links?.careers).toBe(COMPANY.careersPageUrl);
  });

  it('does not let another company publish (or see) a job it does not own', async () => {
    const service = make([new FakeAdapter('linkedin')]);
    store.companies.set(OTHER_TENANT, { ...COMPANY, tenantId: OTHER_TENANT, slug: 'other' });
    expect((await service.publish(OTHER_TENANT, JOB_ID, request(), ACTOR).catch((e) => e)).getStatus()).toBe(404);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect((await service.retry(OTHER_TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
  });

  it('rejects a malformed selection process with 400', async () => {
    const err = await make([]).publish(TENANT, JOB_ID, { selectionProcess: 'not a list' }, ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(400);
  });

  it('a newly approved version moves the listing to it and keeps the same link', async () => {
    const service = make([new CareersSiteAdapter()]);
    const first = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.approve(approvedJd({ version: 2, jd: { ...JD, summary: 'Updated summary.' } }));
    const second = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect(second.slug).toBe(first.slug);
    expect(second.version).toBe(2);
    expect((await store.getListing(TENANT, JOB_ID))!.approved.jd.summary).toBe('Updated summary.');
  });
});

describe('PublisherService.listJobs', () => {
  it('lists approved jobs with their listing, posts and application count', async () => {
    const service = make([new CareersSiteAdapter()]);
    expect((await service.listJobs(TENANT))[0]).toMatchObject({ jobId: JOB_ID, listing: null, posts: [], applications: 0 });
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.applicationCounts.set(JOB_ID, 4);
    const [job] = await service.listJobs(TENANT);
    expect(job).toMatchObject({ version: 1, applications: 4, listing: { status: 'LIVE', outdated: false } });
    expect(job!.posts).toEqual([{ channel: 'careers', status: 'PUBLISHED', url: job!.listing!.applyUrl, error: null }]);
    expect(await service.listJobs(OTHER_TENANT)).toEqual([]);
  });

  it('flags a listing that shows an older version than the latest approval', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.approve(approvedJd({ version: 2 }));
    expect((await service.listJobs(TENANT))[0]!.listing!.outdated).toBe(true);
  });
});

describe('PublisherService.preview', () => {
  it('shows each live channel post plus coming-soon channels, and saves nothing', async () => {
    const preview = await make([new CareersSiteAdapter(), new FakeAdapter('linkedin')]).preview(TENANT, JOB_ID, request());
    expect(preview.errors).toEqual([]);
    const live = preview.channels.filter((c) => c.availability === 'live');
    expect(live.map((c) => c.channel)).toEqual(['careers', 'linkedin']);
    expect(live[0]!.text).toContain('Apply here');
    expect(preview.channels.some((c) => c.channel === 'naukri' && c.availability === 'coming_soon')).toBe(true);
    expect(store.listings.size).toBe(0);
    expect(store.posts).toHaveLength(0);
  });

  it('passes validator warnings through', async () => {
    const preview = await make([new CareersSiteAdapter()], validator([], false)).preview(TENANT, JOB_ID, request());
    expect(preview.warnings).toEqual(['unreachable']);
  });

  it('every preview parses with the shared schema (what the HR dashboard does)', async () => {
    const { publishPreviewSchema } = await import('@hireflow/contracts');
    const { COMING_SOON_CHANNELS } = await import('../../src/modules/publisher/channels');
    const preview = await make([new CareersSiteAdapter(), new FakeAdapter('linkedin')]).preview(TENANT, JOB_ID, request());
    expect(publishPreviewSchema.safeParse(preview).success).toBe(true);
    expect(preview.channels.filter((c) => c.availability === 'coming_soon')).toHaveLength(COMING_SOON_CHANNELS.length);
  });
});

describe('PublisherService close / reopen / audit', () => {
  it('closing stops the job, takes posts down where the adapter can, and is audited with the HR user', async () => {
    const li = new FakeAdapter('linkedin');
    const closed: string[] = [];
    (li as ChannelAdapter).close = async (_ctx, post) => {
      closed.push(post.externalId ?? '');
    };
    const service = make([new CareersSiteAdapter(), li]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);

    expect(await service.close(TENANT, JOB_ID, ACTOR)).toEqual({ jobId: JOB_ID, status: 'CLOSED' });
    expect(store.listings.get(JOB_ID)!.status).toBe('CLOSED');
    expect(closed).toEqual(['linkedin-1']);
    expect((await service.retry(TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(409);
    expect(audit.entries.map((a) => a.action)).toEqual(['job.published', 'job.closed']);

    await service.reopen(TENANT, JOB_ID, ACTOR);
    expect(store.listings.get(JOB_ID)!.status).toBe('LIVE');
    expect(audit.entries.at(-1)).toMatchObject({ action: 'job.reopened', actorUserId: ACTOR.id, subjectId: JOB_ID, tenantId: TENANT });
  });

  it('a failing take-down never blocks closing', async () => {
    const li = new FakeAdapter('linkedin');
    (li as ChannelAdapter).close = async () => {
      throw new Error('platform down');
    };
    const service = make([li]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect((await service.close(TENANT, JOB_ID, ACTOR)).status).toBe('CLOSED');
  });

  it('another company cannot close the job', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.companies.set(OTHER_TENANT, { ...COMPANY, tenantId: OTHER_TENANT, slug: 'other' });
    expect((await service.close(OTHER_TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
    expect(store.listings.get(JOB_ID)!.status).toBe('LIVE');
  });

  it('delete takes the job off every channel, keeps it approved, and publishing again makes fresh posts', async () => {
    const li = new FakeAdapter('linkedin');
    const removedIds: string[] = [];
    (li as ChannelAdapter).remove = async (_ctx, post) => {
      removedIds.push(post.externalId ?? '');
    };
    const service = make([new CareersSiteAdapter(), li]);
    const first = await service.publish(TENANT, JOB_ID, request(), ACTOR);

    expect(await service.unpublish(TENANT, JOB_ID, ACTOR)).toEqual({ jobId: JOB_ID, removed: ['careers', 'linkedin'], notRemoved: [] });
    expect(removedIds).toEqual(['linkedin-1']);
    expect(store.listings.has(JOB_ID)).toBe(false);
    expect(store.posts).toHaveLength(0);
    const [row] = await service.listJobs(TENANT);
    expect(row).toMatchObject({ jobId: JOB_ID, listing: null, posts: [] });
    expect(audit.entries.at(-1)).toMatchObject({ action: 'job.unpublished', subjectId: JOB_ID, actorUserId: ACTOR.id });

    const again = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect(li.calls).toBe(2); // a brand-new LinkedIn post, not "unchanged"
    expect(again.posts.find((p) => p.channel === 'linkedin')).toMatchObject({ status: 'PUBLISHED' });
    expect(again.applyUrl).toBe(first.applyUrl); // same link as before
  });

  it('a post a channel cannot remove is reported with its link and never blocks the delete', async () => {
    const li = new FakeAdapter('linkedin');
    (li as ChannelAdapter).remove = async () => {
      throw new ChannelError('LinkedIn could not remove the post (400).', false);
    };
    const service = make([new CareersSiteAdapter(), li, new FakeAdapter('other')]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);

    const result = await service.unpublish(TENANT, JOB_ID, ACTOR);
    expect(result.removed).toEqual(['careers']);
    expect(result.notRemoved).toEqual(
      expect.arrayContaining([
        { channel: 'linkedin', url: expect.any(String), error: 'LinkedIn could not remove the post (400).' },
        { channel: 'other', url: expect.any(String), error: expect.stringContaining('by hand') },
      ]),
    );
    expect(store.listings.has(JOB_ID)).toBe(false);
  });

  it('delete refuses while a channel is still posting, and leaves the job live', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.posts[0]!.status = 'PUBLISHING';
    expect((await service.unpublish(TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(409);
    expect(store.listings.get(JOB_ID)!.status).toBe('LIVE');
  });

  it('another company cannot delete the job; an unpublished job is a 404', async () => {
    const service = make([new CareersSiteAdapter()]);
    expect((await service.unpublish(TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.companies.set(OTHER_TENANT, { ...COMPANY, tenantId: OTHER_TENANT, slug: 'other' });
    expect((await service.unpublish(OTHER_TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
    expect(store.listings.get(JOB_ID)!.status).toBe('LIVE');
  });

  it('audit entries never contain the JD or company text', async () => {
    await make([new CareersSiteAdapter()]).publish(TENANT, JOB_ID, request(), ACTOR);
    const json = JSON.stringify(audit.entries);
    expect(json).not.toContain(JD.summary);
    expect(json).not.toContain(COMPANY.about!);
  });
});

describe('PublisherService channel connections', () => {
  const tokens = (expiresAt: Date | null) => ({ accessToken: 'CO-TOKEN', refreshToken: null, expiresAt, refreshTokenExpiresAt: null, scopes: '', connectedBy: ACTOR.id });

  it("hands the company's connected token to the adapter and shows the connection (never the token)", async () => {
    await credentials.save(TENANT, 'linkedin', tokens(new Date(Date.now() + 60_000)));
    let seen: string | undefined;
    const linkedin = new FakeAdapter('linkedin');
    linkedin.publish = async (ctx: ChannelContext) => ((seen = ctx.accessToken), { externalId: 'x', url: null });
    await make([new CareersSiteAdapter(), linkedin]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(seen).toBe('CO-TOKEN');

    const channels = await make([new CareersSiteAdapter(), linkedin]).channels(TENANT);
    expect(channels.find((c) => c.channel === 'linkedin')!.connection).toMatchObject({ connected: true, expired: false });
    expect(channels.find((c) => c.channel === 'careers')?.connection ?? null).toBeNull();
    expect(JSON.stringify(channels)).not.toContain('CO-TOKEN');
  });

  it('does not use an expired token', async () => {
    await credentials.save(TENANT, 'linkedin', tokens(new Date(Date.now() - 1000)));
    let seen: string | undefined = 'unset';
    const linkedin = new FakeAdapter('linkedin');
    linkedin.publish = async (ctx: ChannelContext) => ((seen = ctx.accessToken), { externalId: 'x', url: null });
    await make([linkedin]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(seen).toBeUndefined();
    expect((await make([linkedin]).channels(TENANT))[0]!.connection).toMatchObject({ connected: false, expired: true });
  });
});

const PAST = '2020-01-31T18:29:59.000Z';
const OTHER_JOB = '0192f3a1-7c2e-7a10-8b2c-000000789abc'; // same last 6 hex characters as JOB_ID
const CONFIG = { careersSiteUrl: 'https://careers.example', attempts: 3, baseDelayMs: 1, sleep: async () => {} };
const setDeadline = (deadline: string) => {
  for (const a of store.approvals.get(JOB_ID)!) a.form = { ...a.form, deadline };
};

describe('deadline passed', () => {
  it('the careers listing leaves out LIVE jobs whose deadline has passed', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    const reader = new PublicJobsReader(store, CONFIG);
    expect((await reader.liveJobs('acme'))!.map((j) => j.jobId)).toEqual([JOB_ID]);
    setDeadline(PAST);
    expect(await reader.liveJobs('acme')).toEqual([]);
    expect((await reader.job('acme', makeJobSlug(JD.title, JOB_ID)))!.view.status).toBe('CLOSED');
  });

  it('reopen() refuses a job whose deadline has passed', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    await service.close(TENANT, JOB_ID, ACTOR);
    setDeadline(PAST);
    const err = await service.reopen(TENANT, JOB_ID, ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'DEADLINE_PASSED' });
    expect(store.listings.get(JOB_ID)!.status).toBe('CLOSED');
  });

  it('retry() runs the basic publish checks and posts nothing when they fail', async () => {
    const li = new FakeAdapter('linkedin', async () => {
      throw new ChannelError('down', false);
    });
    const service = make([li]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    setDeadline(PAST);
    const err = await service.retry(TENANT, JOB_ID, ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(err.getResponse()).toMatchObject({ code: 'NOT_READY_TO_PUBLISH', errors: ['The last date to apply is already in the past.'] });
    expect(li.calls).toBe(1);
  });
});

describe('LinkedIn token fallback and duplicate posts', () => {
  const linkedin = (fetch: typeof globalThis.fetch, fallbackTenantId?: string) =>
    new LinkedInAdapter({ accessToken: 'ENV-TOKEN', fallbackTenantId, apiVersion: '202501', fetch });
  beforeEach(async () => {
    await store.setChannelSetting(TENANT, 'linkedin', { enabled: true, config: { organizationId: '12345678' } });
  });

  it('a company with an expired own connection never posts with the server token', async () => {
    await credentials.save(TENANT, 'linkedin', {
      accessToken: 'OLD',
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: null,
      scopes: '',
      connectedBy: ACTOR.id,
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = make([linkedin(fetch, TENANT)]);
    const preview = await service.preview(TENANT, JOB_ID, request());
    expect(preview.channels[0]!.blockers.join(' ')).toContain('reconnect');
    const res = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect(res.posts[0]).toMatchObject({ channel: 'linkedin', status: 'NOT_CONFIGURED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the server token is not used for a company that is not the opted-in tenant', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const res = await make([linkedin(fetch, OTHER_TENANT)]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(res.posts[0]!.status).toBe('NOT_CONFIGURED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a LinkedIn timeout is not retried automatically (the post may exist) and asks HR to check', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    const res = await make([linkedin(fetch, TENANT)]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.posts[0]!.status).toBe('FAILED');
    expect(res.posts[0]!.error).toContain('Check the LinkedIn page before retrying');
  });
});

describe('close vs publish race', () => {
  it('a close that lands before a channel is claimed stops that channel from posting', async () => {
    const li = new FakeAdapter('linkedin');
    const claim = store.claimPost.bind(store);
    store.claimPost = async (...args) => {
      store.listings.get(JOB_ID)!.status = 'CLOSED'; // a concurrent close() committed first
      return claim(...args);
    };
    const res = await make([li]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(li.calls).toBe(0);
    expect(res.posts[0]).toMatchObject({ status: 'PENDING', error: 'The job was closed, so nothing was posted.' });
  });
});

describe('job slugs', () => {
  it('a slug already used by another job gets the full job id, and published slugs never change', async () => {
    store.approve(approvedJd({ jobId: OTHER_JOB }));
    const service = make([new CareersSiteAdapter()]);
    const first = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    const second = await service.publish(TENANT, OTHER_JOB, request(), ACTOR);
    expect(first.slug).toBe(makeJobSlug(JD.title, JOB_ID));
    expect(second.slug).toBe(makeJobSlug(JD.title, OTHER_JOB, true));
    expect(second.slug).not.toBe(first.slug);
    expect((await service.publish(TENANT, OTHER_JOB, request(), ACTOR)).slug).toBe(second.slug);
    expect((await service.publish(TENANT, JOB_ID, request(), ACTOR)).slug).toBe(first.slug);
  });
});

describe('listing lookups and bad rows', () => {
  it('the HR board looks listings up by the jobs it shows', async () => {
    const service = make([new CareersSiteAdapter()]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    const spy = vi.spyOn(store, 'listListingsForJobs');
    const [job] = await service.listJobs(TENANT);
    expect(spy).toHaveBeenCalledWith(TENANT, [JOB_ID]);
    expect(job!.listing).not.toBeNull();
  });

  it('an approval whose stored JD no longer parses is skipped, not thrown', () => {
    const row = {
      id: 'appr-1',
      jobId: JOB_ID,
      tenantId: TENANT,
      approvedAt: new Date(),
      approvedBy: ACTOR.name,
      jdVersion: { id: 'jdv-1', version: 1, content: { title: 42 } },
      job: { formData: FORM, status: 'APPROVED' },
    } as unknown as ApprovalRow;
    expect(toApproved(row)).toBeNull();
    expect(toApproved({ ...row, jdVersion: { ...row.jdVersion, content: JD } } as ApprovalRow)).toMatchObject({ jobId: JOB_ID });
  });
});

describe('republish', () => {
  it('marks posts made earlier as unchanged; the careers page is not', async () => {
    const li = new FakeAdapter('linkedin');
    const service = make([new CareersSiteAdapter(), li]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    store.approve(approvedJd({ version: 2 }));
    const res = await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect(li.calls).toBe(1);
    expect(res.posts.find((p) => p.channel === 'linkedin')).toMatchObject({ status: 'PUBLISHED', unchanged: true });
    expect(res.posts.find((p) => p.channel === 'careers')!.unchanged).toBeUndefined();
  });
});

describe('update apply links', () => {
  // The careers site moved (temporary tunnel restarted): same jobs, new public base URL.
  const NEW_SITE = 'https://new-tunnel.example';
  const editable = () => {
    const li = new FakeAdapter('linkedin');
    const edits: { externalId: string | null; text: string }[] = [];
    (li as ChannelAdapter).update = async (ctx, post) => {
      edits.push({ externalId: post.externalId, text: li.render(ctx) });
    };
    return { li, edits };
  };

  it('edits the SAME posts so they carry the new apply link, and moves the careers page link', async () => {
    const { li, edits } = editable();
    await make([new CareersSiteAdapter(), li]).publish(TENANT, JOB_ID, request(), ACTOR);

    const res = await make([new CareersSiteAdapter(), li], validator(), NEW_SITE).refreshLinks(TENANT, JOB_ID, ACTOR);
    const slug = makeJobSlug(JD.title, JOB_ID);
    expect(res).toEqual({ jobId: JOB_ID, applyUrl: `${NEW_SITE}/acme/jobs/${slug}`, updated: ['linkedin'], notUpdated: [] });
    expect(edits).toEqual([{ externalId: 'linkedin-1', text: `${JD.title} ${NEW_SITE}/acme/jobs/${slug}?src=linkedin` }]);
    expect(li.calls).toBe(1); // no new post
    expect(store.posts.find((p) => p.channel === 'careers')!.url).toBe(`${NEW_SITE}/acme/jobs/${slug}`);
    expect(store.posts.find((p) => p.channel === 'linkedin')!.url).toBe('https://careers.example/acme/jobs/' + slug); // post link unchanged
    expect(audit.entries.at(-1)).toMatchObject({ action: 'job.links_refreshed', subjectId: JOB_ID, actorUserId: ACTOR.id });
  });

  it('reports posts it cannot edit (with their link) and skips posts that were never published', async () => {
    const li = new FakeAdapter('linkedin');
    (li as ChannelAdapter).update = async () => {
      throw new ChannelError('This post no longer exists on LinkedIn. Delete the job here and publish it again.', false);
    };
    const failing = new FakeAdapter('broken', async () => {
      throw new ChannelError('down', false);
    });
    const service = make([new CareersSiteAdapter(), li, new FakeAdapter('other'), failing]);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);

    const res = await service.refreshLinks(TENANT, JOB_ID, ACTOR);
    expect(res.updated).toEqual([]);
    expect(res.notUpdated).toEqual(
      expect.arrayContaining([
        { channel: 'linkedin', url: expect.any(String), error: expect.stringContaining('no longer exists') },
        { channel: 'other', url: expect.any(String), error: expect.stringContaining('by hand') },
      ]),
    );
    expect(res.notUpdated.map((n) => n.channel)).not.toContain('broken');
  });

  it('retries a LinkedIn hiccup, and another company or an unpublished job is a 404', async () => {
    const { li, edits } = editable();
    let fails = 1;
    const update = li.update!.bind(li);
    (li as ChannelAdapter).update = async (ctx, post) => {
      if (fails-- > 0) throw new ChannelError('Could not reach LinkedIn to edit the post.', true);
      await update(ctx, post);
    };
    const service = make([new CareersSiteAdapter(), li]);
    expect((await service.refreshLinks(TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
    await service.publish(TENANT, JOB_ID, request(), ACTOR);
    expect((await service.refreshLinks(TENANT, JOB_ID, ACTOR)).updated).toEqual(['linkedin']);
    expect(edits).toHaveLength(1);

    store.companies.set(OTHER_TENANT, { ...COMPANY, tenantId: OTHER_TENANT, slug: 'other' });
    expect((await service.refreshLinks(OTHER_TENANT, JOB_ID, ACTOR).catch((e) => e)).getStatus()).toBe(404);
  });
});

describe('automatic apply link update at API start', () => {
  const NEW_SITE = 'https://new-tunnel.example';
  const linkedIn = (fail = false) => {
    const li = new FakeAdapter('linkedin');
    const edited: string[] = [];
    (li as ChannelAdapter).update = async (ctx) => {
      if (fail) throw new ChannelError('LinkedIn is not connected, so the post could not be edited. Reconnect LinkedIn and try again.', false);
      edited.push(ctx.links.apply);
    };
    return { li, edited };
  };

  it('edits only the jobs posted under the old URL, once, with no user (system), and the HR board is clean after', async () => {
    const { li, edited } = linkedIn();
    await make([new CareersSiteAdapter(), li]).publish(TENANT, JOB_ID, request(), ACTOR);
    const moved = make([new CareersSiteAdapter(), li], validator(), NEW_SITE);

    expect((await moved.listJobs(TENANT))[0]!.listing!.linksOutdated).toBe(true);
    expect(await moved.refreshOldLinks()).toEqual({ jobs: 1, failed: 0 });
    expect(edited).toEqual([`${NEW_SITE}/acme/jobs/${makeJobSlug(JD.title, JOB_ID)}?src=linkedin`]);
    expect(audit.entries.at(-1)).toMatchObject({ action: 'job.links_refreshed', actorUserId: null });
    expect((await moved.listJobs(TENANT))[0]!.listing!.linksOutdated).toBe(false);

    // Next start with the same URL: nothing to do.
    expect(await moved.refreshOldLinks()).toEqual({ jobs: 0, failed: 0 });
    expect(edited).toHaveLength(1);
  });

  it('a post it could not edit stays marked on the HR board and is tried again at the next start', async () => {
    const broken = linkedIn(true);
    await make([new CareersSiteAdapter(), broken.li]).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(await make([new CareersSiteAdapter(), broken.li], validator(), NEW_SITE).refreshOldLinks()).toEqual({ jobs: 1, failed: 1 });

    const fixed = linkedIn();
    const service = make([new CareersSiteAdapter(), fixed.li], validator(), NEW_SITE);
    expect((await service.listJobs(TENANT))[0]!.listing!.linksOutdated).toBe(true);
    expect(await service.refreshOldLinks()).toEqual({ jobs: 1, failed: 0 });
    expect(fixed.edited).toHaveLength(1);
    expect((await service.listJobs(TENANT))[0]!.listing!.linksOutdated).toBe(false);
  });

  it('runs at API start only when switched on', async () => {
    const fresh = (autoRefreshLinks?: boolean) =>
      new PublisherService(store, [], validator(), events, audit.asService(), { careersSiteUrl: NEW_SITE, attempts: 1, baseDelayMs: 1, sleep: async () => {}, autoRefreshLinks }, credentials);
    const spy = vi.spyOn(store, 'listJobsWithOldLinks');
    fresh(false).onApplicationBootstrap();
    fresh().onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    fresh(true).onApplicationBootstrap();
    expect(spy).toHaveBeenCalledWith(NEW_SITE);
  });
});

describe('minimum ATS score before publishing', () => {
  const withScreening = (isSet: boolean) =>
    new PublisherService(
      store,
      [new CareersSiteAdapter()],
      validator(),
      events,
      audit.asService(),
      { careersSiteUrl: 'https://careers.example', attempts: 1, baseDelayMs: 1, sleep: async () => {} },
      credentials,
      { isSet: vi.fn().mockResolvedValue(isSet) } as never,
    );

  it('a job without its private minimum ATS score cannot be published, and the preview says why', async () => {
    const service = withScreening(false);
    const preview = await service.preview(TENANT, JOB_ID, request());
    expect(preview.errors.join(' ')).toContain('minimum ATS score');
    const err = await service.publish(TENANT, JOB_ID, request(), ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(store.listings.has(JOB_ID)).toBe(false);
  });

  it('publishes once the score is set; the score never appears in the posts', async () => {
    const res = await withScreening(true).publish(TENANT, JOB_ID, request(), ACTOR);
    expect(res.posts[0]).toMatchObject({ channel: 'careers', status: 'PUBLISHED' });
    expect(JSON.stringify(res)).not.toMatch(/ats/i);
  });
});

describe('assessment rounds before publishing (M05)', () => {
  const withRounds = (steps: { complete: boolean; steps: string[] } | null) =>
    new PublisherService(
      store,
      [new CareersSiteAdapter()],
      validator(),
      events,
      audit.asService(),
      { careersSiteUrl: 'https://careers.example', attempts: 1, baseDelayMs: 1, sleep: async () => {} },
      credentials,
      undefined,
      { publicSteps: vi.fn().mockResolvedValue(steps) } as never,
    );

  it('a job whose rounds are not complete cannot be published, and the preview says why', async () => {
    const service = withRounds({ complete: false, steps: ['Coding'] });
    expect((await service.preview(TENANT, JOB_ID, request())).errors.join(' ')).toContain('Finish the assessment rounds');
    const err = await service.publish(TENANT, JOB_ID, request(), ACTOR).catch((e) => e);
    expect(err.getStatus()).toBe(422);
    expect(store.listings.has(JOB_ID)).toBe(false);
  });

  it('the selection process is the saved round names in order, never what the browser sent', async () => {
    const service = withRounds({ complete: true, steps: ['Online Aptitude Exam', 'SQL Round', 'Personal Interview'] });
    const preview = await service.preview(TENANT, JOB_ID, request({ selectionProcess: ['Typed by hand'] }));
    expect(preview.channels[0]!.text).toContain('Online Aptitude Exam → SQL Round → Personal Interview');
    expect(preview.channels[0]!.text).not.toContain('Typed by hand');

    await service.publish(TENANT, JOB_ID, request({ selectionProcess: ['Typed by hand'] }), ACTOR);
    expect(store.listings.get(JOB_ID)!.selectionProcess).toEqual(['Online Aptitude Exam', 'SQL Round', 'Personal Interview']);
    const page = await new PublicJobsReader(store, { careersSiteUrl: 'https://careers.example', attempts: 1, baseDelayMs: 1, sleep: async () => {} }).job(
      'acme',
      makeJobSlug(JD.title, JOB_ID),
    );
    // the public job page carries the names and nothing else about the rounds
    expect(page!.view.selectionProcess).toEqual(['Online Aptitude Exam', 'SQL Round', 'Personal Interview']);
    expect(JSON.stringify(page!.view)).not.toMatch(/passRule|passMark|question|timeLimit|correct/i);
  });

  it('without the rounds migration, publishing works exactly as before (typed steps)', async () => {
    await withRounds(null).publish(TENANT, JOB_ID, request({ selectionProcess: ['Interview'] }), ACTOR);
    expect(store.listings.get(JOB_ID)!.selectionProcess).toEqual(['Interview']);
  });
});
