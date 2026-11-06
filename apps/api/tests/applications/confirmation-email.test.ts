import { describe, expect, it } from 'vitest';
import { applicationRef, buildConfirmationEmail } from '../../src/modules/applications/email/confirmation-email';
import { ApplicantOnlyMailer, DisabledMailer, MailError, SmtpMailer, isReservedAddress, mailErrorReason, mailerFromEnv as guardedMailerFromEnv, smtpResponseCode, smtpUrlOptions, type Mailer } from '../../src/modules/applications/email/mailer';

/** The SMTP mailer inside the applicant-only guard (the transport options live there). */
const mailerFromEnv = (env: NodeJS.ProcessEnv): Mailer => {
  const m = guardedMailerFromEnv(env);
  return m instanceof ApplicantOnlyMailer ? m.inner : m;
};

const input = {
  candidateName: 'Asha Patel',
  companyName: 'Acme Tech',
  jobTitle: 'Junior Backend Developer',
  applicationId: '0192f3a1-7c2e-7a10-8b2c-123456789abc',
  jobId: '0192f3a1-0000-7000-8000-00000000000j',
  appliedAt: new Date('2026-10-14T06:30:00Z'),
  jobPageUrl: 'https://careers.example/acme/jobs/junior-backend-developer-789abc',
  companyCareersUrl: 'https://acme.example/careers',
  myDataUrl: 'https://careers.example/acme/my-data',
};

describe('confirmation email', () => {
  it('thanks the student and carries the application id, job id, reference and links', () => {
    const mail = buildConfirmationEmail(input);
    expect(mail.subject).toBe('Application received: Junior Backend Developer at Acme Tech (HF-56789ABC)');
    for (const part of [
      'Hi Asha Patel,',
      'Thank you for applying for Junior Backend Developer at Acme Tech',
      `Application ID: ${input.applicationId}`,
      `Job ID: ${input.jobId}`,
      'Application reference: HF-56789ABC',
      'Applied on: 14 Oct 2026, 12:00 pm IST',
      input.jobPageUrl,
      input.companyCareersUrl,
      input.myDataUrl,
    ]) {
      expect(mail.text).toContain(part);
    }
    expect(mail.html).toContain(input.applicationId);
  });

  it('escapes HTML and keeps student-typed names on one line', () => {
    const mail = buildConfirmationEmail({ ...input, candidateName: '<b>Asha</b>\r\nBcc: evil@example.com' });
    expect(mail.html).toContain('&lt;b&gt;Asha&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>Asha</b>');
    expect(mail.text.split('\n')[0]).toBe('Hi <b>Asha</b> Bcc: evil@example.com,');
  });

  it('leaves out the company careers link when the company has none', () => {
    expect(buildConfirmationEmail({ ...input, companyCareersUrl: null }).text).not.toContain('careers page:');
  });

  it('short reference is stable and upper-case', () => expect(applicationRef('0192f3a1-7c2e-7a10-8b2c-123456789abc')).toBe('HF-56789ABC'));
});

describe('only real applicants get email (no demo or test address)', () => {
  it('every configured mailer is wrapped by the applicant-only guard', () => {
    expect(guardedMailerFromEnv({ SMTP_URL: 'smtp://localhost:1025' })).toBeInstanceOf(ApplicantOnlyMailer);
    expect(guardedMailerFromEnv({ GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' })).toBeInstanceOf(ApplicantOnlyMailer);
    expect(guardedMailerFromEnv({})).toBeInstanceOf(DisabledMailer);
  });

  it('recognises reserved demo / test domains, and nothing else', () => {
    for (const a of ['student.1791964478216@example.com', 'x@example.org', 'x@mail.example.net', 'demo.hr@hireflow.local', 'a@b.test', 'a@b.invalid', 'a@localhost', 'a@x.example', 'no-at-sign', 'a@'])
      expect(isReservedAddress(a), a).toBe(true);
    for (const a of ['asha@gmail.com', 'naina@joyride.city', 'student@college.ac.in', 'x@examples.com', 'x@example.com.au', 'x@testing.io'])
      expect(isReservedAddress(a), a).toBe(false);
  });

  it('refuses a reserved address permanently (SMTP 550, never retried) and never hands it to the server', async () => {
    const sent: string[] = [];
    const m = new ApplicantOnlyMailer({ enabled: true, send: async (to) => void sent.push(to) });
    const err = await m.send('student@example.com', { subject: 's', text: 't', html: 'h' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).responseCode).toBe(550);
    await m.send('asha@gmail.com', { subject: 's', text: 't', html: 'h' });
    expect(sent).toEqual(['asha@gmail.com']);
  });
});

describe('mailerFromEnv', () => {
  it('is switched off without SMTP_URL (applications still work)', () => {
    const m = mailerFromEnv({});
    expect(m).toBeInstanceOf(DisabledMailer);
    expect(m.enabled).toBe(false);
  });
  it('uses SMTP when SMTP_URL is set', () => {
    const m = mailerFromEnv({ SMTP_URL: 'smtp://localhost:1025' });
    expect(m).toBeInstanceOf(SmtpMailer);
    expect(m.enabled).toBe(true);
  });
  it('reuses pooled connections and applies the timeouts for SMTP_URL too', () => {
    const m = mailerFromEnv({ SMTP_URL: 'smtp://localhost:1025' });
    const options = (m as unknown as { transport: { options: Record<string, unknown> } }).transport.options;
    expect(options).toMatchObject({ host: 'localhost', port: 1025, secure: false, pool: true, maxConnections: 2, connectionTimeout: 10_000 });
  });
  it('reads host, port, TLS and login from SMTP_URL', () => {
    expect(smtpUrlOptions('smtps://user%40x.in:p%40ss@mail.x.in')).toEqual({
      host: 'mail.x.in',
      port: 465,
      secure: true,
      auth: { user: 'user@x.in', pass: 'p@ss' },
    });
    expect(smtpUrlOptions('smtp://mail.x.in')).toEqual({ host: 'mail.x.in', port: 587, secure: false });
    expect(() => smtpUrlOptions('http://mail.x.in')).toThrow(/smtp:\/\//);
  });
  it('keeps SMTP_URL query options (booleans, numbers, nested tls.*) like nodemailer does', () => {
    expect(smtpUrlOptions('smtp://u:p@mail.x.in:2525?requireTLS=true&ignoreTLS=false&tls.rejectUnauthorized=false&tls.servername=relay.x.in&name=hireflow.in&socketTimeout=30000')).toEqual({
      host: 'mail.x.in',
      port: 2525,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      requireTLS: true,
      ignoreTLS: false,
      name: 'hireflow.in',
      socketTimeout: 30000,
      tls: { rejectUnauthorized: false, servername: 'relay.x.in' },
    });
    expect(() => smtpUrlOptions('smtp://mail.x.in?requireTSL=true')).toThrow(/unknown option "requireTSL"/);
  });
  it('passes the query options to the transport, and they win over the defaults', () => {
    const m = mailerFromEnv({ SMTP_URL: 'smtp://localhost:1025?tls.rejectUnauthorized=false&connectionTimeout=30000' });
    const options = (m as unknown as { transport: { options: Record<string, unknown> } }).transport.options;
    expect(options).toMatchObject({ tls: { rejectUnauthorized: false }, connectionTimeout: 30000, socketTimeout: 10_000, pool: true });
  });
  it('keeps a password with a bare "%" as typed instead of crashing at startup', () => {
    expect(smtpUrlOptions('smtp://user:50%off@mail.x.in').auth).toEqual({ user: 'user', pass: '50%off' });
    expect(smtpUrlOptions('smtp://user:a%2Fb@mail.x.in').auth).toEqual({ user: 'user', pass: 'a/b' });
  });
});

describe('Gmail', () => {
  const opts = (m: unknown) => (m as { transport: { options: Record<string, unknown> } }).transport.options;
  const from = (m: unknown) => (m as { from: string }).from;

  it('uses Gmail SMTP (465, TLS) with the App Password, spaces removed, and sends from the Gmail address', () => {
    const m = mailerFromEnv({ GMAIL_USER: 'hr.team@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SMTP_URL: 'smtp://localhost:1025' });
    expect(m).toBeInstanceOf(SmtpMailer);
    expect(opts(m)).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'hr.team@gmail.com', pass: 'abcdefghijklmnop' } });
    expect(from(m)).toBe('Anvexa <hr.team@gmail.com>');
  });

  it('respects MAIL_FROM, and needs BOTH Gmail values (else falls back to SMTP_URL / off)', () => {
    expect(from(mailerFromEnv({ GMAIL_USER: 'a@gmail.com', GMAIL_APP_PASSWORD: 'x', MAIL_FROM: 'Acme Careers <a@gmail.com>' }))).toBe('Acme Careers <a@gmail.com>');
    expect(mailerFromEnv({ GMAIL_USER: 'a@gmail.com' })).toBeInstanceOf(DisabledMailer);
    expect(opts(mailerFromEnv({ GMAIL_USER: 'a@gmail.com', SMTP_URL: 'smtp://localhost:1025' }))).not.toHaveProperty('auth');
  });
});

describe('mail errors', () => {
  it('turns nodemailer codes into safe reasons (never the password or address)', () => {
    expect(mailErrorReason({ code: 'EAUTH', response: '535 bad password for secret@gmail.com' })).toMatch(/^EAUTH: SMTP login failed/);
    expect(mailErrorReason({ code: 'ETIMEDOUT' })).toBe('ETIMEDOUT: could not reach the mail server');
    expect(mailErrorReason(new Error('boom'))).toBe('unknown mail error');
  });

  it('adds the SMTP reply code (never the reply text), so temporary 4xx replies can be retried', () => {
    const greylisted = { code: 'EENVELOPE', responseCode: 450, response: '450 4.2.0 <student@example.com>: Greylisted' };
    expect(mailErrorReason(greylisted)).toBe('EENVELOPE: the recipient address was refused (SMTP 450)');
    expect(mailErrorReason(greylisted)).not.toContain('student@example.com');
    expect(smtpResponseCode(greylisted)).toBe(450);
    expect(smtpResponseCode({ code: 'ETIMEDOUT' })).toBeUndefined();
  });

  it('a mail server that cannot be reached becomes a MailError, not a crash', async () => {
    const mailer = new SmtpMailer('smtp://127.0.0.1:1', 'Anvexa <a@b.c>', 2_000);
    const err = await mailer.send('student@example.com', buildConfirmationEmail(input)).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.reason).toMatch(/could not reach the mail server/);
    expect(err.message).not.toContain('student@example.com');
  });
});
