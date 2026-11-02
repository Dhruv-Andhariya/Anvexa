// Leaf file with no Nest imports (going through ../applications/index would create an import cycle with auth).
import type { EmailMessage } from '../applications/email/confirmation-email';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Keeps a single line: a name must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

/** "Your login code" email (2FA). Contains only the user's name, the code and when it expires. */
export function buildLoginCodeEmail(i: { name: string; code: string; validMinutes: number }): EmailMessage {
  const name = oneLine(i.name);
  const text = [
    `Hi ${name},`,
    '',
    `Your HireFlow login code is: ${i.code}`,
    '',
    `It works once and expires in ${i.validMinutes} minutes.`,
    'If you did not just try to log in, someone knows your password: change it now with "Forgot password?" on the login page.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi ${escapeHtml(name)},</p>
<p>Your HireFlow login code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:Consolas,monospace">${escapeHtml(i.code)}</p>
<p>It works once and expires in ${i.validMinutes} minutes.</p>
<p>If you did not just try to log in, someone knows your password: change it now with "Forgot password?" on the login page.</p>
</body></html>`;
  return { subject: `${i.code} is your HireFlow login code`, text, html };
}

/** "Verify your email" (sign-up). Contains only the name typed on the form, the code and when it expires. */
export function buildSignupCodeEmail(i: { name: string; code: string; validMinutes: number }): EmailMessage {
  const name = oneLine(i.name);
  const text = [
    `Hi ${name},`,
    '',
    `Your code to create your HireFlow account is: ${i.code}`,
    '',
    `It works once and expires in ${i.validMinutes} minutes.`,
    'If you did not try to create a HireFlow account, ignore this email - no account is created without this code.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi ${escapeHtml(name)},</p>
<p>Your code to create your HireFlow account is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:Consolas,monospace">${escapeHtml(i.code)}</p>
<p>It works once and expires in ${i.validMinutes} minutes.</p>
<p>If you did not try to create a HireFlow account, ignore this email - no account is created without this code.</p>
</body></html>`;
  return { subject: `${i.code} is your HireFlow sign-up code`, text, html };
}
