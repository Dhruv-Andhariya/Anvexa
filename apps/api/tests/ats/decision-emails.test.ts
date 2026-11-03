import { describe, expect, it } from 'vitest';
import { buildRejectionEmail, buildShortlistEmail } from '../../src/modules/ats/emails/decision-emails';
import { hashScreeningToken, newScreeningToken, screeningBaseUrlFromEnv, screeningLink } from '../../src/modules/ats/screening-link';

const INPUT = { candidateName: 'Asha Patel', jobTitle: 'Backend Developer', companyName: 'Acme Analytics', companyWebsite: 'https://acme.dev' };
const LINK = 'https://screen.example/s/abc123';

describe('shortlist email', () => {
  const m = buildShortlistEmail({ ...INPUT, screeningLink: LINK });

  it('uses the agreed template, filled in', () => {
    expect(m.subject).toBe("Congratulations! You've Been Shortlisted for Backend Developer – Next Step: AI Screening");
    for (const line of [
      'Dear Asha Patel,',
      'Congratulations!',
      'We are pleased to inform you that your application for the Backend Developer position at Acme Analytics has successfully passed our initial resume screening process.',
      'Based on your resume, skills, experience, and project relevance to the job requirements, you have been shortlisted for the next stage of our recruitment process.',
      `Please complete your AI screening round using this link: ${LINK}`,
      'You must complete the screening within seven days of receiving this email to remain eligible for the next stage.',
      'Your performance in this round will help us evaluate your suitability for the role.',
      'If you have any questions, please reply to this email.',
      'We wish you the very best for the next stage!',
      'Best regards,\nAcme Analytics Recruitment Team\nAcme Analytics\nhttps://acme.dev',
      'This is an automated recruitment email. Please do not share your screening link with others.',
    ]) {
      expect(m.text).toContain(line);
    }
    expect(m.html).toContain(`<a href="${LINK}">${LINK}</a>`);
    expect(m.html).toContain('<a href="https://acme.dev">https://acme.dev</a>');
  });

  it('never mentions scores', () => expect(`${m.subject} ${m.text} ${m.html}`).not.toMatch(/score|ats|\d+%/i));

  it('a replaced link says the earlier one no longer works', () => {
    const again = buildShortlistEmail({ ...INPUT, screeningLink: LINK, linkReplaced: true });
    expect(again.subject).toBe("New Link – Congratulations! You've Been Shortlisted for Backend Developer – Next Step: AI Screening");
    expect(again.text).toContain('The AI screening link in our earlier email no longer works.');
    expect(again.html).toContain(`<a href="${LINK}">${LINK}</a>`);
    expect(m.text).not.toContain('earlier email');
  });
});

describe('rejection email', () => {
  const m = buildRejectionEmail(INPUT);

  it('uses the agreed template, filled in', () => {
    expect(m.subject).toBe('Application Update – Backend Developer at Acme Analytics');
    for (const line of [
      'Dear Asha Patel,',
      'Thank you for your interest in the Backend Developer position at Acme Analytics and for taking the time to submit your application.',
      'After carefully reviewing your application and evaluating your qualifications against the requirements of the role, we regret to inform you that you have not been shortlisted for the next round of our recruitment process.',
      'We received applications from many qualified candidates, and this decision was not an easy one.',
      'We sincerely appreciate your interest in joining Acme Analytics and encourage you to apply for future opportunities that align with your skills and experience.',
      'We wish you success in your future career endeavors.',
      'Best regards,\nAcme Analytics Recruitment Team\nAcme Analytics\nhttps://acme.dev',
      'This is an automated notification regarding your job application.',
    ]) {
      expect(m.text).toContain(line);
    }
    expect(m.text).not.toContain('screening link');
    expect(`${m.text}`).not.toMatch(/score|ats/i);
  });

  it('keeps names on one line and escapes them in HTML; drops a website that is not a web link', () => {
    const evil = buildRejectionEmail({ ...INPUT, candidateName: '<b>Asha</b>\r\nBcc: x@evil.test', companyWebsite: 'javascript:alert(1)' });
    expect(evil.text).toContain('Dear <b>Asha</b> Bcc: x@evil.test,');
    expect(evil.html).toContain('Dear &lt;b&gt;Asha&lt;/b&gt; Bcc: x@evil.test,');
    expect(evil.html).not.toContain('javascript:');
    expect(evil.text).not.toContain('javascript:');
    const noSite = buildRejectionEmail({ ...INPUT, companyWebsite: null });
    expect(noSite.text).toContain('Acme Analytics Recruitment Team\nAcme Analytics\n\nThis is an automated');
  });
});

describe('screening link', () => {
  it('is an unguessable token; only its hash is stored', () => {
    const a = newScreeningToken();
    const b = newScreeningToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.tokenHash).toBe(hashScreeningToken(a.token));
    expect(a.tokenHash).not.toContain(a.token);
  });

  it('adds the token to the configured page link', () => {
    expect(screeningLink('https://screen.example/start', 'T0k')).toBe('https://screen.example/start?token=T0k');
    expect(screeningLink('https://screen.example/start?lang=en', 'T0k')).toBe('https://screen.example/start?lang=en&token=T0k');
    expect(screeningLink('https://screen.example/s/{token}', 'a/b')).toBe('https://screen.example/s/a%2Fb');
  });

  it('is off until AI_SCREENING_URL is a real web link', () => {
    expect(screeningBaseUrlFromEnv({})).toBeNull();
    expect(screeningBaseUrlFromEnv({ AI_SCREENING_URL: '  ' })).toBeNull();
    expect(screeningBaseUrlFromEnv({ AI_SCREENING_URL: 'javascript:alert(1)' })).toBeNull();
    expect(screeningBaseUrlFromEnv({ AI_SCREENING_URL: 'not a url' })).toBeNull();
    expect(screeningBaseUrlFromEnv({ AI_SCREENING_URL: 'https://screen.example/s/{token}' })).toBe('https://screen.example/s/{token}');
  });

  it('defaults to the careers site screening page (M12), never localhost in production', () => {
    expect(screeningBaseUrlFromEnv({ CAREERS_SITE_URL: 'https://jobs.example/' })).toBe('https://jobs.example/screening/{token}');
    expect(screeningBaseUrlFromEnv({ CAREERS_SITE_URL: 'https://jobs.example', AI_SCREENING_URL: 'https://x.example/{token}' })).toBe('https://x.example/{token}');
    expect(screeningLink('https://jobs.example/screening/{token}', 'abc_-1')).toBe('https://jobs.example/screening/abc_-1');
    expect(screeningBaseUrlFromEnv({ CAREERS_SITE_URL: 'http://localhost:3300' })).toBe('http://localhost:3300/screening/{token}');
    expect(screeningBaseUrlFromEnv({ CAREERS_SITE_URL: 'http://localhost:3300', NODE_ENV: 'production' })).toBeNull();
  });
});
