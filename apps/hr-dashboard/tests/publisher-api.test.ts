import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api';
import { listPublishableJobs, previewPublish, publishJob, refreshPostLinks } from '../src/lib/publisher-api';

const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('publisher api client', () => {
  it('sends only the selection process, with the session cookie and CSRF header (never a tenant id or JD)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, { errors: [], warnings: [], channels: [] }));
    await previewPublish(JOB, { selectionProcess: ['Interview'] }, { fetch, baseUrl: 'http://api.test' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://api.test/publisher/jobs/${JOB}/preview`);
    expect(init!.credentials).toBe('include');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-requested-with']).toBe('hireflow');
    expect(headers['x-tenant-id']).toBeUndefined();
    expect(JSON.parse(String(init!.body))).toEqual({ selectionProcess: ['Interview'] });
  });

  it('turns NOT_READY_TO_PUBLISH into one readable message', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      json(422, { code: 'NOT_READY_TO_PUBLISH', message: 'Fix these problems before publishing.', errors: ['The JD has no summary.'] }),
    );
    const err = await publishJob(JOB, { selectionProcess: [] }, { fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Fix these problems before publishing. The JD has no summary.');
  });

  it('asks the API to edit the posts of one job with the new apply link (no body)', async () => {
    const result = { jobId: JOB, applyUrl: 'https://new.example/acme/jobs/dev-123456', updated: ['linkedin'], notUpdated: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, result));
    expect(await refreshPostLinks(JOB, { fetch, baseUrl: 'http://api.test' })).toEqual(result);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`http://api.test/publisher/jobs/${JOB}/refresh-links`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: undefined });
  });

  it('rejects a response that does not match the contract', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, [{ nope: true }]));
    expect((await listPublishableJobs({ fetch }).catch((e) => e)).code).toBe('INVALID_RESPONSE');
  });
});
