/**
 * "Thanks for applying" email (M09 -> student). Plain text + simple HTML, built only from data we already
 * hold for this application. Never contains the OTP, the resume or any other student's data.
 * TODO(M24): move into packages/email-templates when the React Email setup exists there.
 */
export interface ConfirmationEmailInput {
  candidateName: string;
  companyName: string;
  jobTitle: string;
  applicationId: string;
  jobId: string;
  appliedAt: Date;
  /** The public job page (our careers site). */
  jobPageUrl: string;
  /** The company's own careers page, if it has one. */
  companyCareersUrl: string | null;
  /** careers-site /<company>/my-data: see or delete what the student shared. */
  myDataUrl: string;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

/** Short, human-friendly reference shown to the student ("HF-" + last 8 hex chars of the application id). */
export const applicationRef = (applicationId: string) => `HF-${applicationId.replace(/-/g, '').slice(-8).toUpperCase()}`;

const appliedOn = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d) + ' IST';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Keeps a single line: names typed by students must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

export function buildConfirmationEmail(i: ConfirmationEmailInput): EmailMessage {
  const name = oneLine(i.candidateName);
  const company = oneLine(i.companyName);
  const job = oneLine(i.jobTitle);
  const ref = applicationRef(i.applicationId);
  const when = appliedOn(i.appliedAt);

  const details: [string, string][] = [
    ['Job', job],
    ['Company', company],
    ['Application reference', ref],
    ['Application ID', i.applicationId],
    ['Job ID', i.jobId],
    ['Applied on', when],
  ];
  const next = [
    `${company} will review your application and resume.`,
    'If you are shortlisted, they will contact you on this email or your verified phone number.',
    `Keep your application reference (${ref}) handy if you contact ${company} about this job.`,
  ];

  const text = [
    `Hi ${name},`,
    '',
    `Thank you for applying for ${job} at ${company}. We have received your application and resume.`,
    '',
    ...details.map(([k, v]) => `${k}: ${v}`),
    '',
    'What happens next',
    ...next.map((n) => `- ${n}`),
    '',
    `View the job: ${i.jobPageUrl}`,
    ...(i.companyCareersUrl ? [`${company} careers page: ${i.companyCareersUrl}`] : []),
    `See or delete the data you shared: ${i.myDataUrl}`,
    '',
    'This is an automatic email, please do not reply to it.',
  ].join('\n');

  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
<p>Hi ${escapeHtml(name)},</p>
<p>Thank you for applying for <strong>${escapeHtml(job)}</strong> at <strong>${escapeHtml(company)}</strong>. We have received your application and resume.</p>
<table role="presentation" cellpadding="6" style="border-collapse:collapse;border:1px solid #d9e2ec;width:100%">
${details.map(([k, v]) => `<tr><td style="border:1px solid #d9e2ec;color:#52606d;width:42%">${escapeHtml(k)}</td><td style="border:1px solid #d9e2ec"><strong>${escapeHtml(v)}</strong></td></tr>`).join('\n')}
</table>
<h3 style="margin-bottom:4px">What happens next</h3>
<ul>${next.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
<p>${link(i.jobPageUrl, 'View the job')}${i.companyCareersUrl ? ` &middot; ${link(i.companyCareersUrl, `${company} careers page`)}` : ''} &middot; ${link(i.myDataUrl, 'See or delete your data')}</p>
<p style="color:#7b8794;font-size:12px">This is an automatic email, please do not reply to it.</p>
</body></html>`;

  return { subject: `Application received: ${job} at ${company} (${ref})`, text, html };
}
