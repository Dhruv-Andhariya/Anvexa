import { z } from 'zod';
import { atsStatusSchema, candidateEmailKindSchema, emailDeliveryStatusSchema, screeningDecisionSchema } from './ats';

/** M08/M09 apply form + intake contracts. Owner: applications module (apps/api/src/modules/applications). */

export const RESUME_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  /** PDF and Word (.docx). Old binary .doc is not accepted: the resume parser cannot read it. */
  extensions: ['.pdf', '.docx'],
  mimeTypes: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
} as const;

export const APPLY_FORM_LIMITS = { nameMax: 100, textMax: 120, urlMax: 300, experienceMax: 50 } as const;

/** Current consent policy version. Bump when the consent text on the apply page changes. */
export const CONSENT_POLICY_VERSION = '2026-10-v1';

/**
 * Indian mobile numbers only for now (10 digits starting 6-9, optional +91 / 91 / 0 prefix).
 * Normalised to E.164 (+91XXXXXXXXXX) so dedupe and OTP always compare the same string.
 */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(?:\+91|91|0)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit Indian mobile number')
  .transform((v) => `+91${v.slice(-10)}`);

const text = (max: number) => z.string().trim().min(1, 'Required').max(max);
const optionalUrl = z
  .string()
  .trim()
  .max(APPLY_FORM_LIMITS.urlMax)
  .url('Enter a full link starting with https://')
  .refine((v) => /^https?:\/\//i.test(v), 'Enter a full link starting with https://')
  .optional()
  .or(z.literal('').transform(() => undefined));

const thisYear = new Date().getUTCFullYear();

/** Everything on the apply form except the resume file. Shared by the careers site and the API. */
export const applyFormSchema = z
  .object({
    name: text(APPLY_FORM_LIMITS.nameMax),
    email: z.string().trim().toLowerCase().email('Enter a valid email'),
    phone: phoneSchema,
    city: text(APPLY_FORM_LIMITS.textMax),
    college: text(APPLY_FORM_LIMITS.textMax),
    degree: text(APPLY_FORM_LIMITS.textMax),
    branch: text(APPLY_FORM_LIMITS.textMax),
    graduationYear: z.coerce.number().int().min(1980).max(thisYear + 6),
    scoreType: z.enum(['CGPA', 'PERCENTAGE']),
    // Not z.coerce: it turns a blank field into 0, so an empty score would be saved as "CGPA 0".
    scoreValue: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
      z.number({ required_error: 'Required', invalid_type_error: 'Enter a number' }).min(0),
    ),
    /**
     * Total work experience in years (0 for a fresher; halves allowed, e.g. 1.5). Below the job's minimum experience
     * the application is rejected automatically (AtsProcessor), before any AI screening.
     */
    experienceYears: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : Number(v)) : v),
      z
        .number({ required_error: 'Required', invalid_type_error: 'Enter a number' })
        .min(0, 'Enter 0 or more')
        .max(APPLY_FORM_LIMITS.experienceMax, `Enter at most ${APPLY_FORM_LIMITS.experienceMax} years`)
        .refine((n) => Number.isInteger(n * 2), 'Use whole or half years, e.g. 2 or 2.5'),
    ),
    linkedinUrl: optionalUrl,
    githubUrl: optionalUrl,
    portfolioUrl: optionalUrl,
    /** A project the student built (live site, repo, demo video). */
    projectUrl: optionalUrl,
    consents: z.object({
      dataProcessing: z.literal(true, { errorMap: () => ({ message: 'This consent is required to apply' }) }),
      aiEvaluation: z.literal(true, { errorMap: () => ({ message: 'This consent is required to apply' }) }),
      recordings: z.boolean().default(false),
    }),
    /** Proof that the phone was verified (returned by POST /public/otp/verify). */
    otpToken: z.string().min(10),
    /** Where the student came from (UTM src on the apply link). */
    source: z.string().trim().max(32).regex(/^[a-z0-9_-]*$/).optional(),
  })
  .refine((v) => (v.scoreType === 'CGPA' ? v.scoreValue <= 10 : v.scoreValue <= 100), {
    message: 'CGPA must be 0-10, percentage must be 0-100',
    path: ['scoreValue'],
  });
export type ApplyForm = z.infer<typeof applyFormSchema>;
export type ApplyFormInput = z.input<typeof applyFormSchema>;

export const otpSendRequestSchema = z.object({
  companySlug: z.string().min(1),
  phone: phoneSchema,
  /** Cloudflare Turnstile token. Required only when the server has CAPTCHA turned on. */
  captchaToken: z.string().max(2048).optional(),
});
export const otpVerifyRequestSchema = z.object({
  companySlug: z.string().min(1),
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const applicationReceiptSchema = z.object({
  applicationId: z.string(),
  jobId: z.string(),
  jobTitle: z.string(),
  companyName: z.string(),
  appliedAt: z.string(),
  /**
   * true = the "thanks for applying" email is queued (sent in the background, with retries);
   * false = email is switched off. The application is saved either way.
   */
  confirmationEmailSent: z.boolean(),
});
export type ApplicationReceipt = z.infer<typeof applicationReceiptSchema>;

/** DPDP: a student sees / deletes their own data, proven by a fresh phone OTP (no account needed). */
export const myDataRequestSchema = z.object({ companySlug: z.string().min(1), phone: phoneSchema, otpToken: z.string().min(10) });
export const myDataDeleteRequestSchema = myDataRequestSchema.extend({ confirm: z.literal(true) });

export const myDataSchema = z.object({
  candidate: z.object({ name: z.string(), email: z.string(), phone: z.string(), city: z.string().nullable() }).nullable(),
  applications: z.array(
    z.object({ applicationId: z.string(), jobTitle: z.string(), appliedAt: z.string(), state: z.string(), resumeFileName: z.string().nullable() }),
  ),
  consents: z.array(z.object({ purpose: z.string(), policyVersion: z.string(), grantedAt: z.string(), withdrawnAt: z.string().nullable() })),
});
export type MyData = z.infer<typeof myDataSchema>;

/** HR view: one application of a job, with the student's details and resume info (the file itself is a separate download). */
export const hrApplicationSchema = z.object({
  applicationId: z.string(),
  appliedAt: z.string(),
  state: z.string(),
  source: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string().nullable(),
  college: z.string(),
  degree: z.string(),
  branch: z.string(),
  graduationYear: z.number(),
  scoreType: z.enum(['CGPA', 'PERCENTAGE']),
  scoreValue: z.number(),
  /** Years of work experience the student entered. null = applied before the field existed. */
  experienceYears: z.number().nullable().default(null),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  portfolioUrl: z.string().nullable(),
  projectUrl: z.string().nullable(),
  resume: z.object({ fileName: z.string(), mimeType: z.string(), sizeBytes: z.number() }).nullable(),
  /** M10/M11 resume screening at a glance (null = not screened yet, or screening is not set up on the server). */
  screening: z
    .object({
      status: atsStatusSchema,
      score: z.number().int().nullable(),
      decision: screeningDecisionSchema.nullable(),
      decisionEmail: z.object({ kind: candidateEmailKindSchema, status: emailDeliveryStatusSchema }).nullable(),
    })
    .nullable()
    .default(null),
});
export type HrApplication = z.infer<typeof hrApplicationSchema>;

/** GET /applications/jobs/:jobId - every application of one job, newest first. */
export const jobApplicationsSchema = z.object({
  jobId: z.string(),
  jobTitle: z.string(),
  applications: z.array(hrApplicationSchema),
});
export type JobApplications = z.infer<typeof jobApplicationsSchema>;
