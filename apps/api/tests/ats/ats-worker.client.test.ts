import { describe, expect, it, vi } from 'vitest';
import { AtsWorkerClient, AtsWorkerError } from '../../src/modules/ats/ats-worker.client';
import { FORM, JD } from '../publisher/fixtures';
import { screenResult } from './seed';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const INPUT = { resume: { fileName: 'resume.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 hi') }, form: FORM, jd: JD };
const client = (fetch: typeof globalThis.fetch) => new AtsWorkerClient({ baseUrl: 'http://worker.test', timeoutMs: 1000, fetch });
const errorOf = (res: Response | Error) =>
  client(vi.fn<typeof globalThis.fetch>().mockImplementation(async () => (res instanceof Error ? Promise.reject(res) : res)))
    .screen(INPUT)
    .catch((e: AtsWorkerError) => e);

describe('AtsWorkerClient', () => {
  it('sends the resume as base64 with only the job fields screening needs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(200, screenResult(77)));
    expect((await client(fetch).screen(INPUT)).score).toBe(77);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('http://worker.test/v1/resume/screen');
    const body = JSON.parse(String(init!.body));
    expect(Buffer.from(body.resume.contentBase64, 'base64').toString()).toBe('%PDF-1.4 hi');
    expect(body.job).toEqual({
      title: FORM.title,
      experienceMin: FORM.experienceMin,
      experienceMax: FORM.experienceMax,
      mustHaveSkills: FORM.mustHaveSkills,
      niceToHaveSkills: FORM.niceToHaveSkills,
      employmentType: FORM.employmentType,
    }); // no salary, locations or anything else
    expect(body.jd).toEqual({ title: JD.title, summary: JD.summary, responsibilities: JD.responsibilities, requirements: JD.requirements, niceToHave: JD.niceToHave });
  });

  it('an unreadable resume is for HR review, not a retry', async () => {
    const err = await errorOf(json(422, { detail: { code: 'RESUME_UNREADABLE', message: 'The resume has no readable text.' } }));
    expect(err).toBeInstanceOf(AtsWorkerError);
    expect(err).toMatchObject({ retryable: false, code: 'RESUME_UNREADABLE', message: 'The resume has no readable text.' });
  });

  it.each([
    ['quota', json(429, { detail: { code: 'LLM_RATE_LIMITED', message: 'x' } }, { 'retry-after': '40' }), 40],
    ['provider down', json(503, { detail: { code: 'LLM_UNAVAILABLE', message: 'x' } }), undefined],
    ['bad model output', json(502, { detail: { code: 'LLM_INVALID_OUTPUT', message: 'x' } }), undefined],
    ['worker not running', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), undefined],
    ['timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' }), undefined],
    ['an old AI worker without the endpoint', json(404, { detail: 'Not Found' }), undefined],
  ])('%s is retried later', async (_name, res, after) => {
    const err = await errorOf(res as Response | Error);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(after);
  });

  it('an unexpected answer is retried; a refused input goes to HR review', async () => {
    expect((await errorOf(json(200, { score: 'high' }))).retryable).toBe(true);
    expect(await errorOf(json(422, { detail: { code: 'LLM_BLOCKED', message: 'declined' } }))).toMatchObject({ retryable: false, code: 'LLM_BLOCKED' });
  });
});
