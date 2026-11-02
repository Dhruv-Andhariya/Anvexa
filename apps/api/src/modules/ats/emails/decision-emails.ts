/**
 * Decision emails to a candidate after resume screening (sent only when HR asks). The wording is the company's
 * agreed template; only the {{placeholders}} are filled. Plain text + simple HTML, like the confirmation email.
 * Never contains the ATS score, the minimum score or anything about other candidates.
 * TODO(M24): move into packages/email-templates when the React Email setup exists there.
 */
import type { EmailMessage } from '../../applications/email/confirmation-email';

export interface DecisionEmailInput {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  /** Company website (or careers page) from the company profile; left out when the company has none. */
  companyWebsite: string | null;
}

/** {{Recruitment_Team}}: who signs the email. */
export const recruitmentTeam = (companyName: string) => `${oneLine(companyName)} Recruitment Team`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Names typed by students or HR must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

export function buildShortlistEmail(i: DecisionEmailInput & { screeningLink: string }): EmailMessage {
  const v = values(i);
  const subject = `Congratulations! You've Been Shortlisted for ${v.job} – Next Step: AI Screening`;
  const paragraphs = [
    `Dear ${v.name},`,
    'Congratulations!',
    `We are pleased to inform you that your application for the ${v.job} position at ${v.company} has successfully passed our initial resume screening process. Based on your resume, skills, experience, and project relevance to the job requirements, you have been shortlisted for the next stage of our recruitment process.`,
    `Please complete your AI screening round using this link: ${i.screeningLink}`,
    'You must complete the screening within seven days of receiving this email to remain eligible for the next stage. Your performance in this round will help us evaluate your suitability for the role.',
    'If you have any questions, please reply to this email.',
    'We wish you the very best for the next stage!',
  ];
  return render(subject, paragraphs, v, 'This is an automated recruitment email. Please do not share your screening link with others.', i.screeningLink);
}

export function buildRejectionEmail(i: DecisionEmailInput): EmailMessage {
  const v = values(i);
  const subject = `Application Update – ${v.job} at ${v.company}`;
  const paragraphs = [
    `Dear ${v.name},`,
    `Thank you for your interest in the ${v.job} position at ${v.company} and for taking the time to submit your application.`,
    'After carefully reviewing your application and evaluating your qualifications against the requirements of the role, we regret to inform you that you have not been shortlisted for the next round of our recruitment process.',
    `We received applications from many qualified candidates, and this decision was not an easy one. We sincerely appreciate your interest in joining ${v.company} and encourage you to apply for future opportunities that align with your skills and experience.`,
    'We wish you success in your future career endeavors.',
  ];
  return render(subject, paragraphs, v, 'This is an automated notification regarding your job application.');
}

function values(i: DecisionEmailInput) {
  return {
    name: oneLine(i.candidateName),
    job: oneLine(i.jobTitle),
    company: oneLine(i.companyName),
    team: recruitmentTeam(i.companyName),
    // only real web links are printed (and linked); anything else is left out
    website: i.companyWebsite && /^https?:\/\//i.test(i.companyWebsite.trim()) ? oneLine(i.companyWebsite) : null,
  };
}

function render(subject: string, paragraphs: string[], v: ReturnType<typeof values>, footer: string, link?: string): EmailMessage {
  const signature = ['Best regards,', v.team, v.company, ...(v.website ? [v.website] : [])];
  const text = [...paragraphs.flatMap((p) => [p, '']), ...signature, '', footer].join('\n');

  const linkify = (escaped: string) =>
    link ? escaped.replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`) : escaped;
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
${paragraphs.map((p) => `<p>${linkify(escapeHtml(p))}</p>`).join('\n')}
<p>${signature
    .map((line, n) => (n === signature.length - 1 && v.website ? `<a href="${escapeHtml(v.website)}">${escapeHtml(line)}</a>` : escapeHtml(line)))
    .join('<br>')}</p>
<p style="color:#6b7280;font-size:12px">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject: oneLine(subject), text, html };
}
