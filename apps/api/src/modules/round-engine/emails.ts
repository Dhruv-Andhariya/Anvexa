/**
 * Emails of the online test rounds: the invitation (with the personal link) and the outcome after a round. Plain
 * text + simple HTML, same look as the resume screening decision emails (ats/emails/decision-emails.ts). Never
 * contains a score, the pass mark, proctoring events or anything about other candidates.
 * TODO(M24): move into packages/email-templates when the React Email setup exists there.
 */
import type { EmailMessage } from '../applications/email/confirmation-email';

export interface CandidateEmailBase {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  /** Company website (or careers page) from the company profile; left out when there is none. */
  companyWebsite: string | null;
}

export interface InviteEmailInput extends CandidateEmailBase {
  roundName: string;
  /** The step the candidate just cleared ("AI screening" for the first round), shown as the reason for the email. */
  clearedStep: string;
  timeLimitMinutes: number | null;
  questionCount: number;
  /** The round description HR wrote. */
  instructions: string;
  link: string;
  linkExpiresAt: Date;
  cameraRequired: boolean;
  /** A DSA coding round (candidate-app page) instead of a multiple-choice test: the wording changes, nothing else. */
  coding?: boolean;
  /** Online test protection: warnings allowed before the test ends (null / missing = protection off). */
  maxWarnings?: number | null;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Names typed by students or HR must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

const dateText = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d) + ' IST';

export function buildRoundInviteEmail(i: InviteEmailInput): EmailMessage {
  const v = values(i);
  const round = oneLine(i.roundName);
  const duration = i.timeLimitMinutes ? `${i.timeLimitMinutes} minutes` : 'no fixed time limit';
  const instructions = i.instructions.trim().replace(/\s+/g, ' ').slice(0, 1000);
  const subject = `Next Step: ${round} for ${v.job} at ${v.company}`;
  const paragraphs = [
    `Dear ${v.name},`,
    `Thank you for completing the ${oneLine(i.clearedStep)} for the ${v.job} position at ${v.company}. We are pleased to invite you to the next stage of our recruitment process: the ${round}.`,
    i.coding
      ? `Assessment: ${round} · ${i.questionCount} coding problem${i.questionCount === 1 ? '' : 's'} · ${duration}.`
      : `Assessment: ${round} · ${i.questionCount} question${i.questionCount === 1 ? '' : 's'} · ${duration}.`,
    ...(instructions ? [`Instructions from the hiring team: ${instructions}`] : []),
    `Please take the assessment using this personal link: ${i.link}`,
    `The link works until ${dateText(i.linkExpiresAt)}. Once you start, the timer keeps running even if you close the page, so please begin when you can finish in one sitting.`,
    i.coding
      ? 'This is a proctored coding test. Take it on a laptop or desktop; it runs in full-screen mode, and the page records events such as leaving full screen, switching tabs or copy and paste for the hiring team to review. You may write each solution in Python, Java or C++. Nothing needs to be installed because your code runs on our servers. No camera, microphone or screen recording is used.'
      : i.cameraRequired
      ? 'The assessment is monitored: you will need a laptop or phone with a working webcam, and the page records events such as leaving the test tab or the camera turning off for the hiring team to review. No video is recorded.'
      : 'The assessment page records events such as leaving the test tab for the hiring team to review.',
    ...(!i.coding && i.maxWarnings
      ? [
          `Please stay on the test page: leaving the test tab or full screen, switching to another app${i.cameraRequired ? ', or more than one person in your camera' : ''} gives a warning. After ${i.maxWarnings} warning${i.maxWarnings === 1 ? '' : 's'}, the next one ends the test automatically; the hiring team then reviews what happened.`,
        ]
      : []),
    i.coding
      ? 'Use a recent version of Chrome, Edge or Firefox and a stable internet connection. The best submission for each problem counts, so you may submit as often as you like before the time is over.'
      : 'Use a recent version of Chrome, Edge, Firefox or Safari and a stable internet connection. Your answers are saved as you go.',
    'If you have any questions, please reply to this email.',
    'We wish you the very best!',
  ];
  return render(subject, paragraphs, v, 'This is an automated recruitment email. Please do not share your assessment link with others.', i.link);
}

export function buildRoundRejectionEmail(i: CandidateEmailBase & { roundName: string }): EmailMessage {
  const v = values(i);
  const subject = `Application Update – ${v.job} at ${v.company}`;
  const paragraphs = [
    `Dear ${v.name},`,
    `Thank you for taking the ${oneLine(i.roundName)} for the ${v.job} position at ${v.company}.`,
    'After evaluating the assessment results, we regret to inform you that you have not been selected to move forward in our recruitment process for this role.',
    `We appreciate the time and effort you put into your application and encourage you to apply for future opportunities at ${v.company} that match your skills and experience.`,
    'We wish you success in your future career endeavors.',
  ];
  return render(subject, paragraphs, v, 'This is an automated notification regarding your job application.');
}

/** Passed: the next round is run by the HR team (nextRoundName), or this was the last round (null). */
export function buildRoundClearedEmail(i: CandidateEmailBase & { roundName: string; nextRoundName: string | null }): EmailMessage {
  const v = values(i);
  const round = oneLine(i.roundName);
  const subject = `Congratulations! You Cleared the ${round} – ${v.job}`;
  const next = i.nextRoundName
    ? `The next stage is the ${oneLine(i.nextRoundName)}. Our HR team will contact you shortly with the details and schedule.`
    : 'You have completed all assessment rounds for this role. Our HR team will review your application and contact you about the final decision.';
  const paragraphs = [
    `Dear ${v.name},`,
    'Congratulations!',
    `We are pleased to inform you that you have successfully cleared the ${round} for the ${v.job} position at ${v.company}.`,
    next,
    'If you have any questions, please reply to this email.',
    'We wish you the very best for the next stage!',
  ];
  return render(subject, paragraphs, v, 'This is an automated recruitment email.');
}

function values(i: CandidateEmailBase) {
  const company = oneLine(i.companyName);
  return {
    name: oneLine(i.candidateName),
    job: oneLine(i.jobTitle),
    company,
    team: `${company} Recruitment Team`,
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
