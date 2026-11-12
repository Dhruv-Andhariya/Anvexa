import type { EmailMessage } from '../email/confirmation-email';

/** The "your verification code" email for the apply form and the "my data" page. Only the code, nothing else. */
export function buildOtpEmail(code: string, validMinutes: number): EmailMessage {
  const subject = `${code} is your Anvexa verification code`;
  const text = [
    'Hi,',
    '',
    `Your verification code is: ${code}`,
    '',
    `Enter it on the application page. It is valid for ${validMinutes} minutes.`,
    'If you did not ask for this code, you can ignore this email.',
    '',
    'This is an automatic email, please do not reply to it.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi,</p>
<p>Your verification code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:8px 0">${code}</p>
<p>Enter it on the application page. It is valid for ${validMinutes} minutes.</p>
<p style="color:#6b7280;font-size:13px">If you did not ask for this code, you can ignore this email. This is an automatic email, please do not reply to it.</p>
</body></html>`;
  return { subject, text, html };
}
