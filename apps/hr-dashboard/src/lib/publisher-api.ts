import {
  channelInfoSchema,
  jobApplicationsSchema,
  publishableJobSchema,
  publishPreviewSchema,
  publishResultSchema,
  refreshLinksResultSchema,
  unpublishResultSchema,
  type ChannelInfo,
  type JobApplications,
  type PublishableJob,
  type PublishJobRequest,
  type PublishPreview,
  type PublishResult,
  type RefreshLinksResult,
  type UnpublishResult,
} from '@hireflow/contracts';
import { API_URL, ApiError, UNAUTHENTICATED_EVENT } from './api';

/**
 * M06 publisher calls. Same rules as lib/api.ts: session cookie (credentials: 'include') + the CSRF header,
 * and the company always comes from the session on the server - never from this code.
 */
export interface Options {
  fetch?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}

const FRIENDLY: Record<string, string> = {
  JOB_NOT_APPROVED: 'This job is not approved yet. Approve its job description first.',
  JOB_CLOSED: 'This job is closed. Reopen it first.',
  PUBLISH_IN_PROGRESS: 'This job is being published right now. Wait a moment and refresh.',
  FEATURE_DISABLED: 'Publishing is switched off on the server.',
  UNAUTHENTICATED: 'Your session has ended. Please log in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  CSRF_CHECK_FAILED: 'Request blocked. Reload the page and try again.',
};

/** Shared by lib/ats-api.ts. */
export async function call<T>(method: string, path: string, body: unknown, parse: (v: unknown) => T, opts: Options): Promise<T> {
  const fetchImpl = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${opts.baseUrl ?? API_URL}${path}`, {
      method,
      headers: {
        'x-requested-with': 'hireflow', // CSRF guard: the API rejects writes without it
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the ANVEXA API. Check that it is running and try again.');
  }
  if (res.status === 204) return undefined as T;
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const { code, message, errors } = (json ?? {}) as { code?: unknown; message?: unknown; errors?: unknown };
    const safeCode = typeof code === 'string' ? code : `HTTP_${res.status}`;
    if (res.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    const list = Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : [];
    const text = FRIENDLY[safeCode] ?? (typeof message === 'string' ? message : 'Something went wrong. Please try again.');
    throw new ApiError(res.status, safeCode, list.length ? `${text} ${list.join(' ')}` : text);
  }
  try {
    return parse(json);
  } catch {
    throw new ApiError(res.status, 'INVALID_RESPONSE', 'The server returned an unexpected response. Please try again.');
  }
}

const job = (id: string) => `/publisher/jobs/${encodeURIComponent(id)}`;

/** Every APPROVED job with its publish state. */
export const listPublishableJobs = (opts: Options = {}): Promise<PublishableJob[]> =>
  call('GET', '/publisher/jobs', undefined, (v) => publishableJobSchema.array().parse(v), opts);

export const listChannels = (opts: Options = {}): Promise<ChannelInfo[]> =>
  call('GET', '/publisher/channels', undefined, (v) => channelInfoSchema.array().parse(v), opts);

/** What every channel would post for the approved JD. Saves nothing. */
export const previewPublish = (jobId: string, req: PublishJobRequest, opts: Options = {}): Promise<PublishPreview> =>
  call('POST', `${job(jobId)}/preview`, req, (v) => publishPreviewSchema.parse(v), opts);

/** Publishes the approved JD on every enabled channel. Safe to call twice: a channel is never posted to twice. */
export const publishJob = (jobId: string, req: PublishJobRequest, opts: Options = {}): Promise<PublishResult> =>
  call('POST', `${job(jobId)}/publish`, req, (v) => publishResultSchema.parse(v), opts);

export const retryPublish = (jobId: string, opts: Options = {}): Promise<PublishResult> =>
  call('POST', `${job(jobId)}/retry`, undefined, (v) => publishResultSchema.parse(v), opts);

const jobStatus = (v: unknown) => {
  const status = (v as { status?: unknown })?.status;
  if (status !== 'LIVE' && status !== 'CLOSED') throw new Error('bad status');
  return status;
};

/** Stop taking applications (the careers page shows "closed"). */
export const closeJob = (jobId: string, opts: Options = {}) => call('POST', `${job(jobId)}/close`, undefined, jobStatus, opts);

/** Take applications again. */
export const reopenJob = (jobId: string, opts: Options = {}) => call('POST', `${job(jobId)}/reopen`, undefined, jobStatus, opts);

/**
 * "Delete": take the job off the careers page and every channel (LinkedIn post deleted too). The job stays approved
 * and shows as "Not published", so it can be published again later. Applications are kept.
 */
export const deleteJobPosts = (jobId: string, opts: Options = {}): Promise<UnpublishResult> =>
  call('DELETE', job(jobId), undefined, (v) => unpublishResultSchema.parse(v), opts);

/**
 * "Update apply links": edit the posts already made (same posts, likes kept) so they carry the current apply link,
 * e.g. after the public careers-site URL changed.
 */
export const refreshPostLinks = (jobId: string, opts: Options = {}): Promise<RefreshLinksResult> =>
  call('POST', `${job(jobId)}/refresh-links`, undefined, (v) => refreshLinksResultSchema.parse(v), opts);

/** Company Admin: switch a channel on/off and set its non-secret settings (e.g. LinkedIn organizationId). */
export const saveChannelSetting = (channel: string, setting: { enabled: boolean; config: Record<string, string> }, opts: Options = {}) =>
  call<void>('PUT', `/publisher/channels/${encodeURIComponent(channel)}/settings`, setting, () => undefined, opts);

/**
 * Company Admin: start "Connect LinkedIn". This is a page navigation, not a fetch: the API redirects the browser
 * to LinkedIn and LinkedIn redirects it back to /publish?linkedin=<result>.
 */
export const linkedInConnectUrl = (baseUrl: string = API_URL) => `${baseUrl}/publisher/linkedin/connect`;

/** Company Admin: forget the stored LinkedIn token. */
export const disconnectLinkedIn = (opts: Options = {}) =>
  call<void>('DELETE', '/publisher/linkedin/connection', undefined, () => undefined, opts);

/** Every application of one job (student details + resume info), newest first. */
export const listJobApplications = (jobId: string, opts: Options = {}): Promise<JobApplications> =>
  call('GET', `/applications/jobs/${encodeURIComponent(jobId)}`, undefined, (v) => jobApplicationsSchema.parse(v), opts);

/** Resume download: a plain link (GET with the session cookie); the API answers with Content-Disposition: attachment. */
export const resumeDownloadUrl = (applicationId: string, baseUrl: string = API_URL) =>
  `${baseUrl}/applications/${encodeURIComponent(applicationId)}/resume`;
