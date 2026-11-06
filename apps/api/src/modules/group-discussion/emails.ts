/**
 * Emails of the GD round: the student's invitation (personal link), the reminder 15 minutes before, HR's link to the
 * live page, and the result (selected / not selected). Plain text + simple HTML, same look as the round engine's
 * emails. Never contains a score, another student's name, or the topic.
 */
import type { EmailMessage } from '../applications/email/confirmation-email';

export interface GdEmailBase {
  candidateName: string;
  jobTitle: string;
  companyName: string;
  companyWebsite: string | null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Names typed by students or HR must not be able to add headers or extra lines. */
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

export const istText = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(d) + ' IST';

const values = (i: GdEmailBase) => {
  const company = oneLine(i.companyName);
  return {
    name: oneLine(i.candidateName),
    job: oneLine(i.jobTitle),
    company,
    team: `${company} Recruitment Team`,
    website: i.companyWebsite && /^https?:\/\//i.test(i.companyWebsite.trim()) ? oneLine(i.companyWebsite) : null,
  };
};

const RULES = [
  'Before the discussion starts, the page checks your camera and microphone; please keep both on for the whole discussion.',
  'The discussion is moderated by an AI moderator and observed by the hiring team. Your audio is recorded and transcribed to evaluate the discussion; the recording is deleted after the retention period. You will be asked for your consent before you join.',
  'Use a laptop or phone with a camera and microphone, a recent Chrome, Edge, Firefox or Safari, earphones if you can, a quiet place, and a stable internet connection.',
];

export function buildGdInviteEmail(i: GdEmailBase & { roundName: string; startsAt: Date; graceMinutes: number; durationMinutes: number; link: string }): EmailMessage {
  const v = values(i);
  const round = oneLine(i.roundName);
  const subject = `Invitation: ${round} for ${v.job} at ${v.company}`;
  return render(
    subject,
    [
      `Dear ${v.name},`,
      `Congratulations on clearing the previous round for the ${v.job} position at ${v.company}. We are pleased to invite you to the ${round}, an online group discussion with other candidates.`,
      `Date and time: ${istText(i.startsAt)}. The room opens at this time and closes ${i.graceMinutes} minutes later; you cannot join after that, so please be on time. The discussion takes about ${i.durationMinutes} minutes.`,
      `Join with this personal link: ${i.link}`,
      ...RULES,
      'If you lose your connection during the discussion, open the same link again to rejoin.',
      'We wish you the very best!',
    ],
    v,
    'This is an automated recruitment email. Please do not share your personal link with others.',
    i.link,
  );
}

export function buildGdReminderEmail(i: GdEmailBase & { roundName: string; startsAt: Date; graceMinutes: number; link: string }): EmailMessage {
  const v = values(i);
  const round = oneLine(i.roundName);
  return render(
    `Reminder: your ${round} starts at ${istText(i.startsAt)}`,
    [
      `Dear ${v.name},`,
      `This is a reminder that your ${round} for the ${v.job} position at ${v.company} starts at ${istText(i.startsAt)}.`,
      `Open your personal link a few minutes early to check your camera and microphone: ${i.link}`,
      `The room closes ${i.graceMinutes} minutes after the start time.`,
      'Good luck!',
    ],
    v,
    'This is an automated recruitment email. Please do not share your personal link with others.',
    i.link,
  );
}

export function buildGdHrLinkEmail(i: { hrName: string; companyName: string; jobTitle: string; roundName: string; groupNumber: number; students: number; startsAt: Date; link: string }): EmailMessage {
  const company = oneLine(i.companyName);
  const v = { name: oneLine(i.hrName), job: oneLine(i.jobTitle), company, team: 'Anvexa', website: null };
  return render(
    `HR link: ${oneLine(i.roundName)} group ${i.groupNumber} - ${v.job} (${istText(i.startsAt)})`,
    [
      `Dear ${v.name},`,
      `Group ${i.groupNumber} of the ${oneLine(i.roundName)} for ${v.job} starts at ${istText(i.startsAt)} with ${i.students} student${i.students === 1 ? '' : 's'}.`,
      `Open the live page (log in with your Anvexa account): ${i.link}`,
      'You join with your camera and mic off; students see your HR tile. Turn them on any time, or use "Speak to group" to talk to everyone (the discussion timer pauses while you speak), "Talk privately" on a student\'s tile for a one-to-one talk, and admit or move students who missed the start.',
    ],
    v,
    'This is an automated Anvexa email.',
    i.link,
  );
}

export function buildGdResultEmail(i: GdEmailBase & { roundName: string; selected: boolean }): EmailMessage {
  const v = values(i);
  const round = oneLine(i.roundName);
  if (i.selected) {
    return render(
      `Congratulations! You cleared the ${round} – ${v.job}`,
      [
        `Dear ${v.name},`,
        'Congratulations!',
        `We are pleased to inform you that you have been selected in the ${round} for the ${v.job} position at ${v.company}, and you move on to the next round.`,
        'Our HR team will contact you shortly with the details of the next round.',
        'If you have any questions, please reply to this email.',
      ],
      v,
      'This is an automated recruitment email.',
    );
  }
  return render(
    `Application Update – ${v.job} at ${v.company}`,
    [
      `Dear ${v.name},`,
      `Thank you for taking part in the ${round} for the ${v.job} position at ${v.company}.`,
      'After careful evaluation, we regret to inform you that you have not been selected to move forward for this role.',
      `We appreciate your time and effort and encourage you to apply for future opportunities at ${v.company}.`,
      'We wish you success in your career.',
    ],
    v,
    'This is an automated notification regarding your job application.',
  );
}

function render(subject: string, paragraphs: string[], v: ReturnType<typeof values>, footer: string, link?: string): EmailMessage {
  const signature = ['Best regards,', v.team, ...(v.team === 'Anvexa' ? [] : [v.company]), ...(v.website ? [v.website] : [])];
  const text = [...paragraphs.flatMap((p) => [p, '']), ...signature, '', footer].join('\n');
  const linkify = (escaped: string) => (link ? escaped.replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`) : escaped);
  const html = `<!doctype html>
<html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">
${paragraphs.map((p) => `<p>${linkify(escapeHtml(p))}</p>`).join('\n')}
<p>${signature.map((line) => escapeHtml(line)).join('<br>')}</p>
<p style="color:#6b7280;font-size:12px">${escapeHtml(footer)}</p>
</body></html>`;
  return { subject: oneLine(subject), text, html };
}
