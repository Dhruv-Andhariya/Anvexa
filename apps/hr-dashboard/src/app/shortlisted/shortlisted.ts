import type { CandidateEmailKind, CandidateView, ScreenedCandidate, ScreeningCounts } from '@hireflow/contracts';

/** The lists on the Shortlisted Students page. It opens on "Shortlisted"; the others are for HR's review. */
export const VIEWS: { key: CandidateView; label: string; count: (c: ScreeningCounts) => number; empty: string }[] = [
  { key: 'shortlisted', label: 'Shortlisted', count: (c) => c.shortlisted, empty: 'No shortlisted students for this job yet.' },
  { key: 'not_shortlisted', label: 'Not shortlisted', count: (c) => c.notShortlisted, empty: 'Nobody here.' },
  { key: 'needs_review', label: 'Needs HR review', count: (c) => c.needsReview, empty: 'No resumes waiting for your review.' },
  { key: 'pending', label: 'Being screened', count: (c) => c.pending, empty: 'No resumes waiting for screening.' },
  { key: 'all', label: 'All', count: (c) => c.total, empty: 'No applications for this job yet.' },
];

/** The decision email this candidate would get (from HR's decision, else the ATS suggestion). */
export const emailKindFor = (c: ScreenedCandidate): CandidateEmailKind | null =>
  c.decision === 'SHORTLISTED' ? 'SHORTLIST' : c.decision === 'NOT_SHORTLISTED' ? 'REJECTION' : null;

/** Which decision emails the server sends by itself (no HR click needed). */
export interface AutoEmails {
  shortlist: boolean;
  rejection: boolean;
}

export const NO_AUTO: AutoEmails = { shortlist: false, rejection: false };

/**
 * Whether HR can send this candidate a decision email now: screened successfully (never after a technical
 * failure), decided, and no email sent or on its way (a FAILED one can be sent again). Emails the server sends
 * automatically are never offered by hand - except a FAILED one, which HR can send again.
 */
export const canEmail = (c: ScreenedCandidate, auto: AutoEmails = NO_AUTO): boolean => {
  const kind = emailKindFor(c);
  if (c.status !== 'SCORED' || kind === null) return false;
  if (c.decisionEmail) return c.decisionEmail.status === 'FAILED';
  return !(kind === 'SHORTLIST' ? auto.shortlist : auto.rejection);
};
