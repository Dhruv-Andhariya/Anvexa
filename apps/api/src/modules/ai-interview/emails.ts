/**
 * The invitation to the AI technical interview (the "shortlisted for the next round" email with the personal link).
 * Plain text + simple HTML, same look as the round engine's emails. Never contains a score, the pass mark or anything
 * about other candidates. The outcome emails after HR's decision are the round engine's (rejection / cleared).
 */
import type { EmailMessage } from '../applications/email/confirmation-email';

export interface InterviewInviteEmailInput {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  companyWebsite: string | null;
  roundName: string;
  /** The round the candidate just cleared ("AI screening" when the interview is the first round). */
  clearedStep: string;
  minutes: number;
  /** The round description HR wrote. */
  instructions: string;
  link: string;
  linkExpiresAt: Date;
  /** Sent again because the earlier link stopped working (the public address changed): say so, so the old email is ignored. */
  linkReplaced?: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Names typed by students or HR must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

const dateText = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d) + ' IST';

export function buildInterviewInviteEmail(i: InterviewInviteEmailInput): EmailMessage {
  const name = oneLine(i.candidateName);
  const job = oneLine(i.jobTitle);
  const company = oneLine(i.companyName);
  const round = oneLine(i.roundName);
  const website = i.companyWebsite && /^https?:\/\//i.test(i.companyWebsite.trim()) ? oneLine(i.companyWebsite) : null;
  const instructions = i.instructions.trim().replace(/\s+/g, ' ').slice(0, 1000);
  const subject = i.linkReplaced ? `New link: ${round} for ${job} at ${company}` : `Shortlisted: ${round} for ${job} at ${company}`;
  const paragraphs = [
    `Dear ${name},`,
    ...(i.linkReplaced
      ? ['The link in our earlier email no longer works, so here is a new personal link. Please use only this one. If you already started, you continue where you left off.']
      : []),
    `Congratulations! You have cleared the ${oneLine(i.clearedStep)} for the ${job} position at ${company}, and you are shortlisted for the next stage: the ${round}.`,
    `This is a spoken technical interview with an AI interviewer, about ${i.minutes} minutes long. It asks about the projects and skills in your resume, the technical skills of this role, and a few practical problems. You answer out loud; the interviewer listens and asks follow-up questions.`,
    ...(instructions ? [`Instructions from the hiring team: ${instructions}`] : []),
    `Please take the interview using this personal link: ${i.link}`,
    `The link works until ${dateText(i.linkExpiresAt)}. Please start when you can finish in one sitting.`,
    'You will need a laptop or desktop (or a phone) with a working camera and microphone, a quiet place, and a stable internet connection. Your camera must stay on during the interview; it is shown only to you and is not recorded. Your spoken answers are turned into text, and the text is saved for the hiring team. The audio is not stored.',
    'Use a recent version of Chrome or Edge for the best experience (Firefox and Safari also work).',
    'If you have any questions, please reply to this email.',
    'We wish you the very best!',
  ];
  const signature = ['Best regards,', `${company} Recruitment Team`, company, ...(website ? [website] : [])];
  const footer = 'This is an automated recruitment email. Please do not share your interview link with others.';
  const text = [...paragraphs.flatMap((p) => [p, '']), ...signature, '', footer].join('\n');
  const linkify = (escaped: string) => escaped.replace(escapeHtml(i.link), `<a href="${escapeHtml(i.link)}">${escapeHtml(i.link)}</a>`);
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
${paragraphs.map((p) => `<p>${linkify(escapeHtml(p))}</p>`).join('\n')}
<p>${signature
    .map((line, n) => (n === signature.length - 1 && website ? `<a href="${escapeHtml(website)}">${escapeHtml(line)}</a>` : escapeHtml(line)))
    .join('<br>')}</p>
<p style="color:#6b7280;font-size:12px">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject: oneLine(subject), text, html };
}
