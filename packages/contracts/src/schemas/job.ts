import { z } from 'zod';

/** Input limits shared by the form, the API and the AI worker (mirrored in ai_worker/schemas.py). */
export const JOB_FORM_LIMITS = {
  titleMax: 120,
  departmentMax: 100,
  experienceMax: 50,
  skillMax: 60,
  skillsMax: 25,
  locationMax: 100,
  locationsMax: 10,
  openingsMax: 1000,
  shortDescriptionMax: 2000,
} as const;

const skill = z.string().trim().min(1).max(JOB_FORM_LIMITS.skillMax);

/** M01 job input form. Used by BOTH the HR dashboard form and the API, so validation never disagrees. */
export const jobFormSchema = z
  .object({
    title: z.string().trim().min(2).max(JOB_FORM_LIMITS.titleMax),
    department: z.string().trim().max(JOB_FORM_LIMITS.departmentMax).optional(),
    experienceMin: z.number().min(0).max(JOB_FORM_LIMITS.experienceMax),
    experienceMax: z.number().min(0).max(JOB_FORM_LIMITS.experienceMax),
    mustHaveSkills: z
      .array(skill)
      .min(3, 'Add at least 3 must-have skills')
      .max(JOB_FORM_LIMITS.skillsMax),
    niceToHaveSkills: z.array(skill).max(JOB_FORM_LIMITS.skillsMax).default([]),
    salaryMin: z.number().nonnegative().optional(), // optional: M03 warns, does not error
    salaryMax: z.number().nonnegative().optional(),
    currency: z.string().default('INR'),
    salaryType: z.enum(['CTC', 'IN_HAND']).default('CTC'),
    locations: z
      .array(z.string().trim().min(1).max(JOB_FORM_LIMITS.locationMax))
      .min(1)
      .max(JOB_FORM_LIMITS.locationsMax),
    workMode: z.enum(['ONSITE', 'HYBRID', 'REMOTE']),
    employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT']),
    openings: z.number().int().positive().max(JOB_FORM_LIMITS.openingsMax).default(1),
    shortDescription: z.string().trim().max(JOB_FORM_LIMITS.shortDescriptionMax).optional(),
    deadline: z.string().datetime().optional(),
  })
  .refine((v) => v.experienceMin <= v.experienceMax, {
    message: 'experienceMin must be <= experienceMax',
    path: ['experienceMax'],
  })
  .refine((v) => v.salaryMin === undefined || v.salaryMax === undefined || v.salaryMin <= v.salaryMax, {
    message: 'salaryMin must be <= salaryMax',
    path: ['salaryMax'],
  });
export type JobForm = z.infer<typeof jobFormSchema>;

/** M02 output: the AI must return this JSON shape (never free text). */
export const jdContentSchema = z.object({
  title: z.string(),
  summary: z.string(),
  aboutCompany: z.string().default(''), // written only from the saved company profile; '' when there is none
  responsibilities: z.array(z.string()).min(1),
  requirements: z.array(z.string()).min(1),
  niceToHave: z.array(z.string()).default([]),
  benefits: z.array(z.string()).default([]),
  /**
   * "Company Website" link. Never written by the AI: the API copies it from the company profile's website after
   * generation (and keeps the version's own link on HR edits). Absent when the profile has no website.
   */
  companyUrl: z.string().url().optional(),
  /** Legacy, read-only: versions generated for a short time used the careers page link. No longer written. */
  careersUrl: z.string().url().optional(),
});
export type JdContent = z.infer<typeof jdContentSchema>;

/** M04: an HR-edited JD must still be complete (title and summary cannot be blank). */
export const editedJdSchema = jdContentSchema.extend({
  title: z.string().trim().min(1).max(JOB_FORM_LIMITS.titleMax),
  summary: z.string().trim().min(1),
  aboutCompany: z.string().trim().default(''),
  responsibilities: z.array(z.string().trim().min(1)).min(1),
  requirements: z.array(z.string().trim().min(1)).min(1),
  niceToHave: z.array(z.string().trim().min(1)).default([]),
  benefits: z.array(z.string().trim().min(1)).default([]),
});

/** Job lifecycle for steps 2-4: created -> AI draft (and HR edits) -> approved and locked. */
export const JOB_STATUSES = ['DRAFT', 'JD_GENERATED', 'APPROVED'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Every generation or HR edit is a NEW version; versions are never overwritten (doc M02). */
export const jdVersionSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  source: z.enum(['AI', 'HR_EDIT']),
  content: jdContentSchema,
  /** The company profile exactly as it was when this version was written, so HR can verify it. */
  companySnapshot: z.record(z.unknown()).nullable(),
  promptVersion: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export type JdVersion = z.infer<typeof jdVersionSchema>;

export const jobApprovalSchema = z.object({
  id: z.string(),
  jdVersionId: z.string(),
  approvedBy: z.string(), // display name of the approver
  approvedById: z.string().nullable(), // null for approvals made before login existed
  companyDetailsVerified: z.boolean(),
  note: z.string().nullable(),
  approvedAt: z.string(),
});
export type JobApproval = z.infer<typeof jobApprovalSchema>;

export const jobSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: jobStatusSchema,
  versionCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobDetailSchema = jobSummarySchema.extend({
  form: jobFormSchema,
  currentJdVersionId: z.string().nullable(),
  versions: z.array(jdVersionSchema), // newest first
  approval: jobApprovalSchema.nullable(),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

/**
 * PATCH /jobs/:id/jd - baseVersionId guards against overwriting a newer draft.
 * basedOnVersionId: set when restoring an older version, so the new version keeps THAT version's company details.
 */
export const editJdRequestSchema = z.object({
  baseVersionId: z.string().min(1),
  basedOnVersionId: z.string().min(1).optional(),
  content: editedJdSchema,
});
export type EditJdRequest = z.infer<typeof editJdRequestSchema>;

/**
 * POST /jobs/:id/approve - HR must confirm the company details before approving.
 * The approver is the logged-in user (taken from the session, never from the body).
 */
export const approveJobRequestSchema = z.object({
  jdVersionId: z.string().min(1),
  companyDetailsVerified: z.literal(true, {
    errorMap: () => ({ message: 'Confirm that the company details are correct' }),
  }),
  note: z.string().trim().max(500).optional(),
});
export type ApproveJobRequest = z.infer<typeof approveJobRequestSchema>;

/** M03 output */
export const jdValidationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ severity: z.enum(['error', 'warning']), code: z.string(), message: z.string() })),
});
export type JdValidation = z.infer<typeof jdValidationSchema>;
