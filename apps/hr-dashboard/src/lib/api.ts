import {
  companyDetailSchema,
  companyProfileRecordSchema,
  companySummarySchema,
  createdInvitationSchema,
  deleteJobResultSchema,
  invitationPreviewSchema,
  jobDetailSchema,
  jobSummarySchema,
  loginResponseSchema,
  sessionSchema,
  signupResponseSchema,
  teamSchema,
  type AcceptInvitationRequest,
  type ApproveJobRequest,
  type CompanyProfile,
  type CompanyProfileRecord,
  type CompanyStatus,
  type DeleteJobResult,
  type EditJdRequest,
  type ForgotPasswordRequest,
  type InviteMemberRequest,
  type JobDetail,
  type JobForm,
  type JobSummary,
  type LoginRequest,
  type VerifyLoginCodeRequest,
  type VerifySignupCodeRequest,
  type ResetPasswordRequest,
  type Session,
  type SignupRequest,
  type UpdateMemberRequest,
  type ScreeningSettings,
} from '@hireflow/contracts';

/** Any contract schema (only safeParse is needed). */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

const providersSchema: Schema<{ google: boolean }> = {
  safeParse: (d) =>
    d && typeof (d as { google?: unknown }).google === 'boolean'
      ? { success: true, data: { google: (d as { google: boolean }).google } }
      : { success: false },
};

/** For 204 responses. */
const noBody: Schema<void> = { safeParse: () => ({ success: true, data: undefined }) };

// Browser talks ONLY to the ANVEXA API. Gemini credentials live in the AI worker, never here.
// Auth is an httpOnly session cookie set by the API: this code never sees or stores a token.
// Same-origin by default: next.config.ts forwards /api/v1 to the API (works on localhost and through a tunnel).
export const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

/** Dispatched on window when the API answers 401, so the session provider can send the user to /login. */
export const UNAUTHENTICATED_EVENT = 'hireflow:unauthenticated';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Friendlier wording for the error codes the API can return. Unknown codes fall back to the server message. */
const FRIENDLY: Record<string, string> = {
  LLM_RATE_LIMITED: 'The AI service is busy or its usage quota was reached. Wait a minute and try again.',
  LLM_TIMEOUT: 'The AI service took too long to respond. Please try again.',
  AI_WORKER_TIMEOUT: 'Generating the job description took too long. Please try again.',
  LLM_UNAVAILABLE: 'The AI service is temporarily unavailable. Please try again shortly.',
  LLM_NOT_CONFIGURED: 'AI generation is not configured on the server. Contact your administrator.',
  LLM_AUTH_FAILED: 'The AI service rejected the server credentials. Contact your administrator.',
  AI_WORKER_UNAVAILABLE: 'The AI service is not reachable right now. Please try again shortly.',
  LLM_INVALID_OUTPUT: 'The AI returned an unusable draft. Please try generating again.',
  AI_WORKER_INVALID_RESPONSE: 'The AI returned an unusable draft. Please try generating again.',
  LLM_BLOCKED: 'The AI declined to write this job description. Review the additional requirements and try again.',
  COMPANY_PROFILE_REQUIRED: 'Your Company Admin must save the company profile before jobs can be created.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  EMAIL_TAKEN: 'An account with this email already exists. Log in instead.',
  PASSWORD_RESET_INVALID: 'This reset link is invalid, expired, or was already used. Ask for a new one.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a few minutes and try again.',
  UNAUTHENTICATED: 'Your session has ended. Please log in again.',
  FORBIDDEN: 'You do not have permission to do this.',
  COMPANY_SUSPENDED: 'This company account is suspended. Contact ANVEXA support.',
  CSRF_CHECK_FAILED: 'Request blocked. Reload the page and try again.',
  STALE_JD_VERSION: 'This job description was changed in another tab or window. Reload to see the latest version.',
  JOB_APPROVED: 'This job is already approved and locked.',
  INVALID_RESPONSE: 'The server returned an unexpected response. Please try again.',
};

export interface Options {
  fetch?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  schema: Schema<T>,
  body: unknown,
  opts: Options,
): Promise<T> {
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
      credentials: 'include', // send the session cookie to the API origin
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the ANVEXA API. Check that it is running and try again.');
  }

  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const { code, message } = (data ?? {}) as { code?: unknown; message?: unknown };
    const safeCode = typeof code === 'string' ? code : `HTTP_${res.status}`;
    if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }
    const serverMessage = typeof message === 'string' ? message : 'Something went wrong. Please try again.';
    throw new ApiError(res.status, safeCode, FRIENDLY[safeCode] ?? serverMessage);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(res.status, 'INVALID_RESPONSE', FRIENDLY.INVALID_RESPONSE!);
  return parsed.data;
}

// ---- Session (M28) ----

/** The logged-in user, or null when not logged in. */
export async function getSession(opts: Options = {}): Promise<Session | null> {
  try {
    return await request('GET', '/auth/me', sessionSchema, undefined, opts);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** A session, or (login 2FA on) { codeRequired, challenge, emailHint } - then call verifyLoginCode. */
export const login = (credentials: LoginRequest, opts: Options = {}) =>
  request('POST', '/auth/login', loginResponseSchema, credentials, opts);

/** Second login step: the 6-digit code from the email. Starts the session. */
export const verifyLoginCode = (input: VerifyLoginCodeRequest, opts: Options = {}) =>
  request('POST', '/auth/login/verify', sessionSchema, input, opts);

/** Which "Continue with ..." buttons to show. Fails closed: no buttons when the API cannot say. */
export async function getAuthProviders(opts: Options = {}): Promise<{ google: boolean }> {
  try {
    return await request('GET', '/auth/providers', providersSchema, undefined, opts);
  } catch {
    return { google: false };
  }
}

/** Browser navigation (not fetch) to Google's account chooser; the API redirects back to the dashboard. */
export const googleSignInUrl = (next?: string) => `${API_URL}/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}`;

/**
 * New HR person: creates the account and logs in (no company yet) - or, with sign-up email verification on,
 * answers { codeRequired, challenge, emailHint } and nothing exists until verifySignupCode.
 */
export const signup = (input: SignupRequest, opts: Options = {}) => request('POST', '/auth/signup', signupResponseSchema, input, opts);

/** Second sign-up step: the 6-digit code emailed to the new address. Creates the account, logged in. */
export const verifySignupCode = (input: VerifySignupCodeRequest, opts: Options = {}) =>
  request('POST', '/auth/signup/verify', sessionSchema, input, opts);

/** Register the user's own company from its profile; they become its Company Admin. */
export const registerCompany = (profile: CompanyProfile, opts: Options = {}) =>
  request('POST', '/companies', sessionSchema, profile, opts);

/** Emails a reset link if an account has this email. Same answer either way (204). */
export const forgotPassword = (input: ForgotPasswordRequest, opts: Options = {}) =>
  request<void>('POST', '/auth/password/forgot', noBody, input, opts);

/** Sets a new password from the emailed link; logs the account out on every device. */
export const resetPassword = (input: ResetPasswordRequest, opts: Options = {}) =>
  request<void>('POST', '/auth/password/reset', noBody, input, opts);

export const logout = (opts: Options = {}) => request<void>('POST', '/auth/logout', noBody, undefined, opts);

export const switchCompany = (companyId: string, opts: Options = {}) =>
  request('POST', '/auth/company', sessionSchema, { companyId }, opts);

export const getInvitation = (token: string, opts: Options = {}) =>
  request('GET', `/auth/invitations/${encodeURIComponent(token)}`, invitationPreviewSchema, undefined, opts);

export const acceptInvitation = (input: AcceptInvitationRequest, opts: Options = {}) =>
  request('POST', '/auth/invitations/accept', sessionSchema, input, opts);

// ---- Team (Company Admin) ----

export const getTeam = (opts: Options = {}) => request('GET', '/company/members', teamSchema, undefined, opts);

export const inviteMember = (input: InviteMemberRequest, opts: Options = {}) =>
  request('POST', '/company/invitations', createdInvitationSchema, input, opts);

export const revokeInvitation = (id: string, opts: Options = {}) =>
  request<void>('DELETE', `/company/invitations/${encodeURIComponent(id)}`, noBody, undefined, opts);

export const updateMember = (userId: string, change: UpdateMemberRequest, opts: Options = {}) =>
  request('PATCH', `/company/members/${encodeURIComponent(userId)}`, teamSchema, change, opts);

// ---- Platform Admin ----

export const listCompanies = (opts: Options = {}) => request('GET', '/admin/companies', companySummarySchema.array(), undefined, opts);

export const getCompany = (id: string, opts: Options = {}) =>
  request('GET', `/admin/companies/${encodeURIComponent(id)}`, companyDetailSchema, undefined, opts);

export const setCompanyStatus = (id: string, status: CompanyStatus, opts: Options = {}) =>
  request('PATCH', `/admin/companies/${encodeURIComponent(id)}`, companyDetailSchema, { status }, opts);

// ---- Step 1: company profile ----

/** The saved profile, or null when HR has not done step 1 yet. */
export async function getCompanyProfile(opts: Options = {}): Promise<CompanyProfileRecord | null> {
  try {
    return await request('GET', '/company-profile', companyProfileRecordSchema, undefined, opts);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'COMPANY_PROFILE_NOT_FOUND') return null;
    throw err;
  }
}

export const saveCompanyProfile = (profile: CompanyProfile, opts: Options = {}) =>
  request('PUT', '/company-profile', companyProfileRecordSchema, profile, opts);

// ---- Step 2: jobs ----

export const listJobs = (opts: Options = {}): Promise<JobSummary[]> =>
  request('GET', '/jobs', jobSummarySchema.array(), undefined, opts);

export const getJob = (id: string, opts: Options = {}): Promise<JobDetail> =>
  request('GET', `/jobs/${encodeURIComponent(id)}`, jobDetailSchema, undefined, opts);

/**
 * screening: HR's private minimum ATS score. Sent next to the form fields and stored apart from the form by the API
 * (the form is public on the careers site, this never is).
 */
export const createJob = (form: JobForm, opts: Options = {}, screening?: ScreeningSettings): Promise<JobDetail> =>
  request('POST', '/jobs', jobDetailSchema, screening ? { ...form, screening } : form, opts);

export const updateJobForm = (id: string, form: JobForm, opts: Options = {}): Promise<JobDetail> =>
  request('PATCH', `/jobs/${encodeURIComponent(id)}`, jobDetailSchema, form, opts);

/** Deletes the job for good: posts (LinkedIn too), careers page, applications, JD versions. */
export const deleteJob = (id: string, opts: Options = {}): Promise<DeleteJobResult> =>
  request('DELETE', `/jobs/${encodeURIComponent(id)}`, deleteJobResultSchema, undefined, opts);

// ---- Step 3: AI generation (job form + company profile, combined by the API) ----

export const generateJobJd = (id: string, opts: Options = {}): Promise<JobDetail> =>
  request('POST', `/jobs/${encodeURIComponent(id)}/jd/generate`, jobDetailSchema, undefined, opts);

// ---- Step 4: review, edit, approve ----

export const editJobJd = (id: string, edit: EditJdRequest, opts: Options = {}): Promise<JobDetail> =>
  request('PATCH', `/jobs/${encodeURIComponent(id)}/jd`, jobDetailSchema, edit, opts);

export const approveJob = (id: string, approval: ApproveJobRequest, opts: Options = {}): Promise<JobDetail> =>
  request('POST', `/jobs/${encodeURIComponent(id)}/approve`, jobDetailSchema, approval, opts);
