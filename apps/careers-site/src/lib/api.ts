import { applicationReceiptSchema, myDataSchema, publicJobSchema, type ApplicationReceipt, type MyData, type PublicJob } from '@hireflow/contracts';

/**
 * The browser and the server both talk ONLY to the ANVEXA API.
 * - Server (page rendering): straight to the API (API_INTERNAL_URL, default localhost:4000).
 * - Browser (apply form, OTP, my-data): same-origin /api/v1/public/*, proxied to the API by next.config.ts, so the
 *   careers site works from its public URL without the API's HR routes being reachable through it.
 *   NEXT_PUBLIC_CAREERS_API_URL overrides this when the API has its own public URL.
 */
export const API_URL =
  typeof window === 'undefined'
    ? process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'
    : process.env.NEXT_PUBLIC_CAREERS_API_URL || '/api/v1';

/** The API's CSRF check: every write must carry this header (a cross-site form cannot set it). */
const CSRF_HEADER = { 'x-requested-with': 'hireflow' } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Server-side: one live job, or null when it does not exist. */
export async function getJob(companySlug: string, jobSlug: string): Promise<PublicJob | null> {
  // Always fresh: when HR closes or reopens a job, students must see it at once.
  const res = await fetch(`${API_URL}/public/${encodeURIComponent(companySlug)}/jobs/${encodeURIComponent(jobSlug)}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}`);
  return publicJobSchema.parse(await res.json());
}

/** Server-side: live jobs of a company, or null when the company does not exist. */
export async function getJobs(companySlug: string): Promise<PublicJob[] | null> {
  const res = await fetch(`${API_URL}/public/${encodeURIComponent(companySlug)}/jobs`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API ${res.status}`);
  return publicJobSchema.array().parse(await res.json());
}

async function readError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown; issues?: unknown };
  return new ApiError(
    res.status,
    typeof body.code === 'string' ? body.code : `HTTP_${res.status}`,
    typeof body.message === 'string' ? body.message : 'Something went wrong. Please try again.',
    Array.isArray(body.issues) ? (body.issues as { path: string; message: string }[]) : [],
  );
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...CSRF_HEADER }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your internet and try again.');
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

export const sendOtp = (companySlug: string, phone: string, captchaToken?: string) =>
  postJson<{ expiresInSeconds: number; devCode?: string }>('/public/otp/send', { companySlug, phone, captchaToken });

export const verifyOtp = (companySlug: string, phone: string, code: string) =>
  postJson<{ otpToken: string }>('/public/otp/verify', { companySlug, phone, code });

/** Uploads with XMLHttpRequest so slow connections get a real progress bar. */
export function submitApplication(form: FormData, onProgress: (pct: number) => void): Promise<ApplicationReceipt> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/public/applications`);
    for (const [k, v] of Object.entries(CSRF_HEADER)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your internet and try again.'));
    xhr.onload = async () => {
      const res = new Response(xhr.responseText, { status: xhr.status, headers: { 'content-type': 'application/json' } });
      if (!res.ok) return reject(await readError(res));
      const parsed = applicationReceiptSchema.safeParse(await res.json().catch(() => undefined));
      if (parsed.success) resolve(parsed.data);
      else reject(new ApiError(res.status, 'INVALID_RESPONSE', 'Something went wrong. Please try again.'));
    };
    xhr.send(form);
  });
}

/** DPDP: the student's own data at this company (needs a fresh phone OTP proof). */
export const viewMyData = async (companySlug: string, phone: string, otpToken: string): Promise<MyData> =>
  myDataSchema.parse(await postJson<unknown>('/public/my-data', { companySlug, phone, otpToken }));

export const deleteMyData = (companySlug: string, phone: string, otpToken: string) =>
  postJson<{ deletedApplications: number }>('/public/my-data/delete', { companySlug, phone, otpToken, confirm: true });
