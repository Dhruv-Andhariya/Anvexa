import { describe, expect, it, vi } from 'vitest';
import { createJob } from '../src/lib/api';
import { getScreeningSettings, parseMinAtsScore, saveScreeningSettings } from '../src/lib/ats-api';

const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FORM = {
  title: 'Junior Backend Developer',
  experienceMin: 0,
  experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  niceToHaveSkills: [],
  locations: ['Ahmedabad'],
  workMode: 'HYBRID' as const,
  employmentType: 'FULL_TIME' as const,
  currency: 'INR',
  salaryType: 'CTC' as const,
  openings: 1,
};

describe('parseMinAtsScore', () => {
  it.each([['75', 75], [' 0 ', 0], ['100', 100], ['75%', 75]])('accepts %j', (text, value) =>
    expect(parseMinAtsScore(text)).toEqual({ ok: true, value: { minAtsScore: value } }));

  it.each([[''], ['abc'], ['74.5'], ['-1'], ['101'], ['1e2']])('refuses %j with a message', (text) => {
    const r = parseMinAtsScore(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0|number|minimum/i);
  });
});

describe('ats api client', () => {
  it('reads and saves the private settings of one job (session cookie + CSRF header)', async () => {
    const value = { jobId: JOB, settings: { minAtsScore: 70 }, updatedAt: '2026-10-26T10:00:00.000Z' };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(200, value));
    expect(await getScreeningSettings(JOB, { fetch, baseUrl: 'http://api.test' })).toEqual(value);
    expect(await saveScreeningSettings(JOB, { minAtsScore: 70 }, { fetch, baseUrl: 'http://api.test' })).toEqual(value);
    const [url, init] = fetch.mock.calls[1]!;
    expect(String(url)).toBe(`http://api.test/ats/jobs/${JOB}/settings`);
    expect(init).toMatchObject({ method: 'PUT', credentials: 'include' });
    expect((init!.headers as Record<string, string>)['x-requested-with']).toBe('hireflow');
    expect(JSON.parse(String(init!.body))).toEqual({ minAtsScore: 70 });
  });

  it('creating a job sends the score next to the form (the API keeps it out of the form)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(500, {}));
    await createJob(FORM, { fetch, baseUrl: 'http://api.test' }, { minAtsScore: 75 }).catch(() => undefined);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ ...FORM, screening: { minAtsScore: 75 } });
    await createJob(FORM, { fetch, baseUrl: 'http://api.test' }).catch(() => undefined);
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toEqual(FORM);
  });
});
