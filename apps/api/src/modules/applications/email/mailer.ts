import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { EmailMessage } from './confirmation-email';

/**
 * Sends one email. Implementations must never log the recipient address, the message body or credentials.
 *
 * Configured from the root .env (first match wins):
 *  - Gmail:  GMAIL_USER=you@gmail.com + GMAIL_APP_PASSWORD=<16-letter Google App Password>
 *            (needs 2-Step Verification on the Google account; a normal Gmail password does not work)
 *  - Any SMTP: SMTP_URL, e.g. smtp://localhost:1025 = Mailpit (web inbox http://localhost:8025)
 *  - neither: emails are switched off; applications still work.
 * MAIL_FROM sets the sender name/address. With Gmail it must be the Gmail address itself (Gmail rewrites others).
 */
export interface Mailer {
  /** false when no SMTP is configured (emails are skipped, nothing else breaks). */
  readonly enabled: boolean;
  send(to: string, message: EmailMessage): Promise<void>;
}

export const MAILER = Symbol('MAILER');

const TIMEOUT_MS = 10_000;

export class SmtpMailer implements Mailer {
  readonly enabled = true;
  private readonly transport;

  /** `smtp` is either an SMTP URL or nodemailer SMTP options (used for Gmail so the password never sits in a URL). */
  constructor(
    smtp: string | SMTPTransport.Options,
    private readonly from: string,
    timeoutMs = TIMEOUT_MS,
  ) {
    const timeouts = { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs };
    // Pooled: reuses a couple of logged-in connections instead of a new TLS handshake + login per email
    // (measured ~9x faster against Mailpit; Gmail also dislikes many fresh logins in a burst).
    const pool = { pool: true, maxConnections: 2 } as const;
    const options = typeof smtp === 'string' ? smtpUrlOptions(smtp) : smtp;
    // SMTP_URL query options (e.g. ?connectionTimeout=30000) win over the defaults.
    this.transport = createTransport({ ...timeouts, ...pool, ...options });
  }

  async send(to: string, message: EmailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, to, subject: message.subject, text: message.text, html: message.html });
    } catch (err) {
      throw new MailError(mailErrorReason(err), smtpResponseCode(err));
    }
  }
}

/** SMTP_URL query options passed on to nodemailer (anything else is a typo and fails startup). */
const URL_OPTIONS = new Set([
  'secure', 'requireTLS', 'ignoreTLS', 'opportunisticTLS', 'name', 'localAddress', 'authMethod',
  'connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout', 'pool', 'maxConnections', 'maxMessages',
]);

/**
 * smtp://[user:pass@]host[:port][?option=value&tls.option=value] or smtps://... as nodemailer options. Done here
 * because nodemailer ignores extra transport options (timeouts, pool) when it is given a URL string.
 * Query options work like nodemailer's own URL parsing: "true"/"false" and numbers are converted, `tls.*` goes
 * into `tls` (e.g. ?requireTLS=true&tls.rejectUnauthorized=false&tls.servername=mail.x.in).
 */
export function smtpUrlOptions(url: string): SMTPTransport.Options {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const secure = u.protocol === 'smtps:';
  const options: Record<string, unknown> & { tls?: Record<string, unknown> } = {
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    secure,
    ...(u.username ? { auth: { user: safeDecode(u.username), pass: safeDecode(u.password) } } : {}),
  };
  for (const [key, raw] of u.searchParams) {
    const value = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
    if (key.startsWith('tls.') && key.length > 4) options.tls = { ...options.tls, [key.slice(4)]: value };
    else if (URL_OPTIONS.has(key)) options[key] = value;
    else throw new Error(`SMTP_URL: unknown option "${key}"`);
  }
  return options as SMTPTransport.Options;
}

/** Percent-decodes a URL user/password, keeping it as typed when it is not valid encoding (e.g. a bare "%"). */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class DisabledMailer implements Mailer {
  readonly enabled = false;
  async send(): Promise<void> {}
}

/** A send failure with a short, safe reason (no address, no password, no server reply text). */
export class MailError extends Error {
  constructor(
    readonly reason: string,
    /** The SMTP reply code (e.g. 451), when the server answered. 4xx = temporary, worth retrying. */
    readonly responseCode?: number,
  ) {
    super(reason);
    this.name = 'MailError';
  }
}

/** nodemailer's `responseCode` (the 3-digit SMTP reply), if any. */
export function smtpResponseCode(err: unknown): number | undefined {
  const code = (err as { responseCode?: unknown })?.responseCode;
  return typeof code === 'number' && code >= 100 && code < 600 ? code : undefined;
}

/** Maps nodemailer error codes to a reason that is safe to log and tells the owner what to fix. */
export function mailErrorReason(err: unknown): string {
  const reason = mailErrorText(err);
  const reply = smtpResponseCode(err);
  return reply ? `${reason} (SMTP ${reply})` : reason; // the reply code only, never the server's reply text
}

function mailErrorText(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  switch (code) {
    case 'EAUTH':
      return 'EAUTH: SMTP login failed (for Gmail: check GMAIL_USER and that GMAIL_APP_PASSWORD is an App Password)';
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'ETIMEDOUT':
    case 'EDNS':
      return `${code}: could not reach the mail server`;
    case 'EENVELOPE':
      return 'EENVELOPE: the recipient address was refused';
    case 'EMESSAGE':
      return 'EMESSAGE: the mail server refused the message';
    default:
      return typeof code === 'string' ? code : 'unknown mail error';
  }
}

/**
 * Domains that can never belong to a real applicant: the reserved example / test names (RFC 2606, RFC 6761) and local
 * names. Demo scripts, seeds and tests use them, so mail to them is refused before it leaves: no demo or test
 * address ever gets a link. The refusal is permanent (SMTP 550), so it is never retried.
 */
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost|local)$/i;

export function isReservedAddress(to: string): boolean {
  const domain = to.trim().split('@').pop() ?? '';
  return !domain || !to.includes('@') || RESERVED_DOMAIN.test(domain.replace(/\.$/, ''));
}

/** Wraps the real mailer: refuses reserved demo / test addresses (see isReservedAddress). */
export class ApplicantOnlyMailer implements Mailer {
  constructor(readonly inner: Mailer) {}
  get enabled() {
    return this.inner.enabled;
  }
  async send(to: string, message: EmailMessage): Promise<void> {
    if (isReservedAddress(to)) throw new MailError('EENVELOPE: demo or test address (reserved domain), not sent', 550);
    return this.inner.send(to, message);
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const inner = rawMailerFromEnv(env);
  return inner.enabled ? new ApplicantOnlyMailer(inner) : inner;
}

function rawMailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  const gmailUser = env.GMAIL_USER?.trim();
  // Google shows App Passwords in groups of 4 ("abcd efgh ijkl mnop"); the spaces are not part of it.
  const gmailPass = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (gmailUser && gmailPass) {
    return new SmtpMailer(
      { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: gmailUser, pass: gmailPass } },
      env.MAIL_FROM?.trim() || `HireFlow <${gmailUser}>`,
    );
  }
  const url = env.SMTP_URL?.trim();
  if (!url) return new DisabledMailer();
  return new SmtpMailer(url, env.MAIL_FROM?.trim() || 'HireFlow <no-reply@hireflow.local>');
}
