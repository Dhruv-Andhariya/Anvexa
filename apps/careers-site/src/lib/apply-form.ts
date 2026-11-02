import { applyFormSchema, RESUME_LIMITS, type ApplyForm } from '@hireflow/contracts';
import { CONTENT } from '@/content';

/** What the inputs hold while the student types (everything is a string until validated). */
export interface ApplyDraft {
  name: string;
  email: string;
  phone: string;
  city: string;
  college: string;
  degree: string;
  branch: string;
  graduationYear: string;
  scoreType: 'CGPA' | 'PERCENTAGE';
  scoreValue: string;
  linkedinUrl: string;
  githubUrl: string;
  portfolioUrl: string;
  projectUrl: string;
  consentDataProcessing: boolean;
  consentAiEvaluation: boolean;
  consentRecordings: boolean;
}

export const emptyApplyDraft: ApplyDraft = {
  name: '',
  email: '',
  phone: '',
  city: '',
  college: '',
  degree: '',
  branch: '',
  graduationYear: '',
  scoreType: 'CGPA',
  scoreValue: '',
  linkedinUrl: '',
  githubUrl: '',
  portfolioUrl: '',
  projectUrl: '',
  consentDataProcessing: false,
  consentAiEvaluation: false,
  consentRecordings: false,
};

/** Field errors keyed by the input id (draft key, or 'resume'). */
export type ApplyErrors = Partial<Record<keyof ApplyDraft | 'resume', string>>;

const ISSUE_TO_FIELD: Record<string, keyof ApplyDraft> = {
  'consents.dataProcessing': 'consentDataProcessing',
  'consents.aiEvaluation': 'consentAiEvaluation',
  'consents.recordings': 'consentRecordings',
  otpToken: 'phone',
};

/** Maps an API/zod issue path to the input that should show it. */
export function fieldForPath(path: string): keyof ApplyDraft | undefined {
  if (path in ISSUE_TO_FIELD) return ISSUE_TO_FIELD[path];
  return path in emptyApplyDraft ? (path as keyof ApplyDraft) : undefined;
}

export function checkResumeFile(file: { name: string; size: number } | null | undefined): string | undefined {
  const e = CONTENT.form.errors;
  if (!file) return e.resumeMissing;
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (!(RESUME_LIMITS.extensions as readonly string[]).includes(ext)) return e.resumeType;
  if (file.size > RESUME_LIMITS.maxBytes) return e.resumeSize;
  return undefined;
}

/** Same shared contract the API uses, so the browser and the server never disagree. */
export function validateApplyDraft(
  draft: ApplyDraft,
  otpToken: string | null,
  source?: string,
): { ok: true; form: ApplyForm } | { ok: false; errors: ApplyErrors } {
  const parsed = applyFormSchema.safeParse({
    name: draft.name,
    email: draft.email,
    phone: draft.phone,
    city: draft.city,
    college: draft.college,
    degree: draft.degree,
    branch: draft.branch,
    graduationYear: draft.graduationYear,
    scoreType: draft.scoreType,
    scoreValue: draft.scoreValue,
    linkedinUrl: draft.linkedinUrl,
    githubUrl: draft.githubUrl,
    portfolioUrl: draft.portfolioUrl,
    projectUrl: draft.projectUrl,
    consents: {
      dataProcessing: draft.consentDataProcessing,
      aiEvaluation: draft.consentAiEvaluation,
      recordings: draft.consentRecordings,
    },
    otpToken: otpToken ?? '',
    source: source && /^[a-z0-9_-]{1,32}$/.test(source) ? source : undefined,
  });
  if (parsed.success) return { ok: true, form: parsed.data };

  const errors: ApplyErrors = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.');
    const field = fieldForPath(path);
    if (!field || errors[field]) continue;
    errors[field] = path === 'otpToken' ? CONTENT.form.otp.needed : friendly(field, issue.message);
  }
  // zod runs the cross-field score check only once every other field is valid; show it together with the rest.
  const score = Number(draft.scoreValue);
  if (!errors.scoreValue && draft.scoreValue.trim() && Number.isFinite(score) && score > (draft.scoreType === 'CGPA' ? 10 : 100)) {
    errors.scoreValue = 'CGPA must be 0-10, percentage must be 0-100';
  }
  return { ok: false, errors };
}

function friendly(field: keyof ApplyDraft, message: string): string {
  if (field === 'graduationYear') return 'Enter the year you graduate, e.g. 2026';
  if (field === 'scoreValue' && /number/i.test(message)) return 'Enter a number';
  if (/expected|invalid_type|required/i.test(message) && !/consent/i.test(message)) return 'Required';
  return message;
}

/** Multipart body for POST /public/applications. */
export function buildApplicationFormData(companySlug: string, jobSlug: string, form: ApplyForm, resume: File): FormData {
  const fd = new FormData();
  fd.set('companySlug', companySlug);
  fd.set('jobSlug', jobSlug);
  fd.set('application', JSON.stringify(form));
  fd.set('resume', resume, resume.name);
  return fd;
}
