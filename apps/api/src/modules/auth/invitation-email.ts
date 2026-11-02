// Leaf file with no Nest imports (going through ../applications/index would create an import cycle with auth).
import type { CompanyRole } from '@hireflow/contracts';
import type { EmailMessage } from '../applications/email/confirmation-email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Keeps a single line: a name must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

const ROLE_LABEL: Record<CompanyRole, string> = { COMPANY_ADMIN: 'Company Admin', HR_MEMBER: 'HR Member' };

/** "Join <company> on HireFlow" email. Contains only the company, the inviter, the role and the one-time link. */
export function buildInvitationEmail(i: {
  companyName: string;
  inviterName: string | null;
  role: CompanyRole;
  link: string;
  expiresAt: Date;
}): EmailMessage {
  const company = oneLine(i.companyName);
  const inviter = i.inviterName ? oneLine(i.inviterName) : null;
  const role = ROLE_LABEL[i.role];
  const expires = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(i.expiresAt);
  const who = inviter ? `${inviter} invited you` : 'You are invited';
  const text = [
    'Hi,',
    '',
    `${who} to join ${company} on HireFlow as ${role}. To accept, open this link:`,
    '',
    i.link,
    '',
    `The link works once and expires on ${expires} (IST).`,
    'If you were not expecting this, ignore this email - nothing happens without you opening the link.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi,</p>
<p>${escapeHtml(who)} to join <strong>${escapeHtml(company)}</strong> on HireFlow as <strong>${role}</strong>.</p>
<p><a href="${escapeHtml(i.link)}" style="display:inline-block;background:#4f6bed;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p style="font-size:13px;color:#52606d">Or open this link: ${escapeHtml(i.link)}</p>
<p>The link works once and expires on ${escapeHtml(expires)} (IST).</p>
<p>If you were not expecting this, ignore this email - nothing happens without you opening the link.</p>
</body></html>`;
  return { subject: `Join ${company} on HireFlow`, text, html };
}
