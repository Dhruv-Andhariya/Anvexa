import type { ScreenedCandidate } from '@hireflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { canEmail, emailKindFor, VIEWS } from '../src/app/shortlisted/shortlisted';
import { listCandidates, sendDecisionEmails, setDecision } from '../src/lib/ats-api';

const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
const APP = '0192f3a1-7c2e-7a10-8b2c-1234567890aa';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const candidate = (over: Partial<ScreenedCandidate> = {}): ScreenedCandidate => ({
  applicationId: APP,
  name: 'Asha Patel',
  email: 'asha@example.com',
  phone: '+919800000000',
  city: null,
  college: 'LDCE',
  degree: 'B.E.',
  branch: 'Computer',
  graduationYear: 2026,
  appliedAt: '2026-10-20T10:00:00.000Z',
  links: { linkedinUrl: null, githubUrl: null, portfolioUrl: null, projectUrl: null },
  resume: { fileName: 'resume.pdf', mimeType: 'application/pdf', sizeBytes: 1000 },
  status: 'SCORED',
  lastError: null,
  score: 82,
  minAtsScore: 70,
  breakdown: null,
  matchedSkills: [],
  missingSkills: [],
  profile: null,
  systemDecision: 'SHORTLISTED',
  hrDecision: null,
  decision: 'SHORTLISTED',
  hrDecidedAt: null,
  scoredAt: null,
  decisionEmail: null,
  screeningLinkExpiresAt: null,
  ...over,
});

describe('who can get a decision email', () => {
  it('follows the decision (HR’s, else the ATS suggestion)', () => {
    expect(emailKindFor(candidate())).toBe('SHORTLIST');
    expect(emailKindFor(candidate({ decision: 'NOT_SHORTLISTED' }))).toBe('REJECTION');
    expect(emailKindFor(candidate({ decision: null }))).toBeNull();
  });

  it('never after a technical failure, never twice; a failed email can be sent again', () => {
    expect(canEmail(candidate())).toBe(true);
    expect(canEmail(candidate({ status: 'NEEDS_REVIEW', decision: null, score: null }))).toBe(false);
    expect(canEmail(candidate({ status: 'PENDING', decision: null }))).toBe(false);
    expect(canEmail(candidate({ decision: null }))).toBe(false);
    for (const status of ['QUEUED', 'SENDING', 'SENT'] as const) {
      expect(canEmail(candidate({ decisionEmail: { kind: 'SHORTLIST', status, sentAt: null, error: null } }))).toBe(false);
    }
    expect(canEmail(candidate({ decisionEmail: { kind: 'SHORTLIST', status: 'FAILED', sentAt: null, error: 'x' } }))).toBe(true);
  });

  it('emails the server sends automatically are not offered by hand (a failed one can still be resent)', () => {
    const auto = { shortlist: true, rejection: true };
    expect(canEmail(candidate(), auto)).toBe(false);
    expect(canEmail(candidate({ decision: 'NOT_SHORTLISTED' }), auto)).toBe(false);
    expect(canEmail(candidate({ decisionEmail: { kind: 'SHORTLIST', status: 'FAILED', sentAt: null, error: 'x' } }), auto)).toBe(true);
    // only rejections automatic: HR still sends shortlist emails by hand
    expect(canEmail(candidate(), { shortlist: false, rejection: true })).toBe(true);
  });

  it('the page opens on the shortlisted list', () => expect(VIEWS[0]!.key).toBe('shortlisted'));
});

describe('ats api client (lists, decisions, emails)', () => {
  it('asks the server for one list (the server filters, not the browser)', async () => {
    const body = { jobId: JOB, jobTitle: 'Dev', view: 'shortlisted', minAtsScore: 70, shortlistEmailsReady: false, counts: { total: 0, shortlisted: 0, notShortlisted: 0, undecided: 0, needsReview: 0, pending: 0 }, candidates: [] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(200, body));
    await listCandidates(JOB, undefined, { fetch, baseUrl: 'http://api.test' });
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://api.test/ats/jobs/${JOB}/candidates?view=shortlisted`);
  });

  it('sends HR decisions and email requests with the CSRF header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => json(200, { queued: [APP], skipped: [] }));
    await setDecision(APP, 'NOT_SHORTLISTED', { fetch, baseUrl: 'http://api.test' });
    expect(await sendDecisionEmails('REJECTION', [APP], { fetch, baseUrl: 'http://api.test' })).toEqual({ queued: [APP], skipped: [] });
    const [[u1, i1], [u2, i2]] = fetch.mock.calls as [string, RequestInit][];
    expect([String(u1), i1.method, JSON.parse(String(i1.body))]).toEqual([`http://api.test/ats/applications/${APP}/decision`, 'PUT', { decision: 'NOT_SHORTLISTED' }]);
    expect([String(u2), i2.method, JSON.parse(String(i2.body))]).toEqual(['http://api.test/ats/emails', 'POST', { kind: 'REJECTION', applicationIds: [APP] }]);
    expect((i2.headers as Record<string, string>)['x-requested-with']).toBe('hireflow');
  });
});
