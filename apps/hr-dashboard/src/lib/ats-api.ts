import {
  jobCandidatesSchema,
  jobScreeningSettingsSchema,
  screeningJobSchema,
  screeningSettingsSchema,
  sendDecisionEmailsResultSchema,
  type CandidateEmailKind,
  type CandidateView,
  type JobCandidates,
  type JobScreeningSettings,
  type ScreeningDecision,
  type ScreeningJob,
  type ScreeningSettings,
  type SendDecisionEmailsResult,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';
import { call, resumeDownloadUrl, type Options } from './publisher-api';

/**
 * M10/M11 ATS calls (HR only). Same rules as the other clients: session cookie + CSRF header, the company always comes
 * from the session on the server.
 */
const settingsPath = (jobId: string) => `/ats/jobs/${encodeURIComponent(jobId)}/settings`;
const appPath = (applicationId: string) => `/ats/applications/${encodeURIComponent(applicationId)}`;

/** The job's private minimum ATS score (settings null = not set yet). */
export const getScreeningSettings = (jobId: string, opts: Options = {}): Promise<JobScreeningSettings> =>
  call('GET', settingsPath(jobId), undefined, (v) => jobScreeningSettingsSchema.parse(v), opts);

export const saveScreeningSettings = (jobId: string, settings: ScreeningSettings, opts: Options = {}): Promise<JobScreeningSettings> =>
  call('PUT', settingsPath(jobId), settings, (v) => jobScreeningSettingsSchema.parse(v), opts);

/** Approved jobs with their screening counts. */
export const listScreeningJobs = (opts: Options = {}): Promise<ScreeningJob[]> =>
  call('GET', '/ats/jobs', undefined, (v) => screeningJobSchema.array().parse(v), opts);

/** Candidates of one job; the server shows only shortlisted ones unless another view is asked for. */
export const listCandidates = (jobId: string, view: CandidateView = 'shortlisted', opts: Options = {}): Promise<JobCandidates> =>
  call('GET', `/ats/jobs/${encodeURIComponent(jobId)}/candidates?view=${view}`, undefined, (v) => jobCandidatesSchema.parse(v), opts);

/** HR's own decision (null = back to the ATS suggestion). */
export const setDecision = (applicationId: string, decision: ScreeningDecision | null, opts: Options = {}) =>
  call('PUT', `${appPath(applicationId)}/decision`, { decision }, (v) => v, opts);

export const retryScreening = (applicationId: string, opts: Options = {}) =>
  call('POST', `${appPath(applicationId)}/retry`, undefined, (v) => v, opts);

/** HR sends the decision email to these candidates (never automatic). */
export const sendDecisionEmails = (kind: CandidateEmailKind, applicationIds: string[], opts: Options = {}): Promise<SendDecisionEmailsResult> =>
  call('POST', '/ats/emails', { kind, applicationIds }, (v) => sendDecisionEmailsResultSchema.parse(v), opts);

/**
 * The resume as a Blob for the in-page preview (the API only ever serves it as a download, so the PDF is shown
 * from memory, never from a public URL). Uses the session cookie, like the download link.
 */
export async function fetchResumeBlob(applicationId: string, opts: Options = {}): Promise<Blob> {
  const fetchImpl = opts.fetch ?? fetch;
  const res = await fetchImpl(resumeDownloadUrl(applicationId, opts.baseUrl ?? API_URL), { credentials: 'include', signal: opts.signal }).catch(() => {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the ANVEXA API.');
  });
  if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, 'The resume could not be loaded.');
  return res.blob();
}

/** The text of the "Minimum ATS score" box -> a valid score, or a message for HR. */
export function parseMinAtsScore(text: string): { ok: true; value: ScreeningSettings } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (!trimmed) return { ok: false, error: 'Enter the minimum ATS score (0–100).' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: 'Use a whole number from 0 to 100.' };
  const parsed = screeningSettingsSchema.safeParse({ minAtsScore: Number(trimmed) });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? 'Use a number from 0 to 100.' };
}
