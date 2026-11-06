// Leaf file with no Nest imports (going through ../applications/index would create an import cycle with auth).
import type { EmailMessage } from '../applications/email/confirmation-email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Keeps a single line: a name must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

/** "Reset your password" email. Contains only the user's name and the one-time link. */
export function buildPasswordResetEmail(i: { name: string; link: string; validMinutes: number }): EmailMessage {
  const name = oneLine(i.name);
  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to reset the password of your Anvexa account. To choose a new password, open this link:',
    '',
    i.link,
    '',
    `The link works once and expires in ${i.validMinutes} minutes. Using it logs you out on every device.`,
    'If you did not ask for this, ignore this email - your password stays the same.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi ${escapeHtml(name)},</p>
<p>Someone asked to reset the password of your Anvexa account. To choose a new password, click the button below.</p>
<p><a href="${escapeHtml(i.link)}" style="display:inline-block;background:#4f6bed;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Reset password</a></p>
<p style="font-size:13px;color:#52606d">Or open this link: ${escapeHtml(i.link)}</p>
<p>The link works once and expires in ${i.validMinutes} minutes. Using it logs you out on every device.</p>
<p>If you did not ask for this, ignore this email - your password stays the same.</p>
</body></html>`;
  return { subject: 'Reset your Anvexa password', text, html };
}
