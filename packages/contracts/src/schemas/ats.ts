import { z } from 'zod';

/**
 * M10/M11 ATS screening contracts. Owner: ats module (apps/api/src/modules/ats).
 * Everything here is HR-only: none of it is ever part of a public API, the JD, or a post.
 */

/** HR's private screening rules for one job (stored apart from the job form, which is public). */
export const screeningSettingsSchema = z.object({
  /** Candidates scoring at least this (out of 100) are shortlisted for HR's review. */
  minAtsScore: z
    .number({ invalid_type_error: 'Enter a number from 0 to 100' })
    .int('Use a whole number')
    .min(0, 'Use a number from 0 to 100')
    .max(100, 'Use a number from 0 to 100'),
});
export type ScreeningSettings = z.infer<typeof screeningSettingsSchema>;

/** GET /api/v1/ats/jobs/:jobId/settings. settings null = HR has not set the minimum ATS score yet. */
export const jobScreeningSettingsSchema = z.object({
  jobId: z.string(),
  settings: screeningSettingsSchema.nullable(),
  updatedAt: z.string().nullable(),
});
export type JobScreeningSettings = z.infer<typeof jobScreeningSettingsSchema>;

/** What the ATS suggests for a candidate, and HR's own (final) decision. */
export const screeningDecisionSchema = z.enum(['SHORTLISTED', 'NOT_SHORTLISTED']);
export type ScreeningDecision = z.infer<typeof screeningDecisionSchema>;

/** One part of the explainable ATS score. The five parts always add up to the score (max 40+20+20+10+10). */
export const atsPartSchema = z.object({
  key: z.enum(['skills', 'experience', 'projects', 'achievements', 'qualifications']),
  label: z.string(),
  points: z.number().min(0),
  max: z.number().int().positive(),
  reason: z.string(),
});
export type AtsPart = z.infer<typeof atsPartSchema>;

/** What the resume says (M10), as HR sees it. Contact details are not repeated: the application has them. */
export const parsedResumeSchema = z.object({
  summary: z.string(),
  skills: z.array(z.string()),
  experience: z.array(
    z.object({
      organization: z.string(),
      role: z.string(),
      kind: z.enum(['job', 'internship', 'freelance', 'other']),
      months: z.number().int().min(0),
      relevant: z.boolean(),
      summary: z.string(),
    }),
  ),
  projects: z.array(z.object({ title: z.string(), technologies: z.array(z.string()), relevant: z.boolean(), summary: z.string() })),
  achievements: z.array(z.string()),
  certifications: z.array(z.string()),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), field: z.string(), year: z.string() })),
});
export type ParsedResume = z.infer<typeof parsedResumeSchema>;

/** AI worker POST /v1/resume/screen answer (M10 + M11). Internal: API <-> worker only. */
export const resumeScreenResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  breakdown: z.array(atsPartSchema).length(5),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  profile: parsedResumeSchema,
  model: z.string(),
  promptVersion: z.string(),
});
export type ResumeScreenResult = z.infer<typeof resumeScreenResultSchema>;

export const atsStatusSchema = z.enum(['PENDING', 'PROCESSING', 'SCORED', 'NEEDS_REVIEW']);
export type AtsStatus = z.infer<typeof atsStatusSchema>;

export const candidateEmailKindSchema = z.enum(['SHORTLIST', 'REJECTION']);
export type CandidateEmailKind = z.infer<typeof candidateEmailKindSchema>;

export const emailDeliveryStatusSchema = z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED']);
export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;

/** PUT /api/v1/ats/applications/:applicationId/decision. null = back to the ATS suggestion. */
export const setDecisionRequestSchema = z.object({ decision: screeningDecisionSchema.nullable() });
export type SetDecisionRequest = z.infer<typeof setDecisionRequestSchema>;

/**
 * POST /api/v1/ats/emails - HR sends the decision email to these candidates (emails are never automatic).
 * SHORTLIST goes only to candidates whose decision is SHORTLISTED, REJECTION only to NOT_SHORTLISTED ones whose
 * resume was screened successfully. A candidate gets at most one decision email.
 */
export const sendDecisionEmailsRequestSchema = z.object({
  kind: candidateEmailKindSchema,
  applicationIds: z.array(z.string().uuid()).min(1).max(500),
});
export type SendDecisionEmailsRequest = z.infer<typeof sendDecisionEmailsRequestSchema>;

export const sendDecisionEmailsResultSchema = z.object({
  /** Queued now; the email goes out in the background (see each candidate's email status). */
  queued: z.array(z.string()),
  skipped: z.array(z.object({ applicationId: z.string(), reason: z.string() })),
});
export type SendDecisionEmailsResult = z.infer<typeof sendDecisionEmailsResultSchema>;

/** Which candidates of a job a screening list shows. The HR page opens on `shortlisted`. */
export const candidateViewSchema = z.enum(['shortlisted', 'not_shortlisted', 'needs_review', 'pending', 'all']);
export type CandidateView = z.infer<typeof candidateViewSchema>;

export const screeningCountsSchema = z.object({
  total: z.number().int(),
  shortlisted: z.number().int(),
  notShortlisted: z.number().int(),
  /** Screened, but the job has no minimum ATS score yet and HR has not decided. */
  undecided: z.number().int(),
  needsReview: z.number().int(),
  /** Waiting for (or in) screening. */
  pending: z.number().int(),
});
export type ScreeningCounts = z.infer<typeof screeningCountsSchema>;

/**
 * Why the system rejected an application without screening its resume:
 * EXPERIENCE_BELOW_REQUIRED = the years of experience the student entered are below the job's minimum.
 */
export const AUTO_REJECTION_REASONS = ['EXPERIENCE_BELOW_REQUIRED'] as const;
export const autoRejectionReasonSchema = z.enum(AUTO_REJECTION_REASONS);
export type AutoRejectionReason = z.infer<typeof autoRejectionReasonSchema>;

/** The automatic experience rule: years entered below the job's minimum = rejected. Older applications (null) are not checked. */
export const isBelowRequiredExperience = (experienceYears: number | null | undefined, experienceMin: number) =>
  typeof experienceYears === 'number' && experienceYears < experienceMin;

/** One candidate on the HR "Shortlisted Students" page. HR only (same company). */
export const screenedCandidateSchema = z.object({
  applicationId: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  city: z.string().nullable(),
  college: z.string(),
  degree: z.string(),
  branch: z.string(),
  graduationYear: z.number().int(),
  /** Years of work experience the student entered (null = applied before the field existed). */
  experienceYears: z.number().nullable().default(null),
  appliedAt: z.string(),
  links: z.object({ linkedinUrl: z.string().nullable(), githubUrl: z.string().nullable(), portfolioUrl: z.string().nullable(), projectUrl: z.string().nullable() }),
  resume: z.object({ fileName: z.string(), mimeType: z.string(), sizeBytes: z.number().int() }).nullable(),
  status: atsStatusSchema,
  /** Why screening has not worked yet (retrying, or waiting for HR review). */
  lastError: z.string().nullable(),
  score: z.number().int().nullable(),
  /** The threshold this candidate was sorted with. */
  minAtsScore: z.number().int().nullable(),
  breakdown: z.array(atsPartSchema).nullable(),
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  profile: parsedResumeSchema.nullable(),
  systemDecision: screeningDecisionSchema.nullable(),
  hrDecision: screeningDecisionSchema.nullable(),
  /** What counts: HR's decision, else the ATS suggestion. */
  decision: screeningDecisionSchema.nullable(),
  /** Set when the system rejected without AI screening (no score then). */
  autoRejectionReason: autoRejectionReasonSchema.nullable().default(null),
  /** The job's minimum experience in years, shown next to an experience rejection. */
  requiredExperienceMin: z.number().nullable().default(null),
  hrDecidedAt: z.string().nullable(),
  scoredAt: z.string().nullable(),
  /** The one decision email (null = none sent or asked for). */
  decisionEmail: z
    .object({ kind: candidateEmailKindSchema, status: emailDeliveryStatusSchema, sentAt: z.string().nullable(), error: z.string().nullable() })
    .nullable(),
  /** Shortlist email sent: until when the AI screening link works. */
  screeningLinkExpiresAt: z.string().nullable(),
});
export type ScreenedCandidate = z.infer<typeof screenedCandidateSchema>;

/** GET /api/v1/ats/jobs/:jobId/candidates?view=... */
export const jobCandidatesSchema = z.object({
  jobId: z.string(),
  jobTitle: z.string(),
  view: candidateViewSchema,
  minAtsScore: z.number().int().nullable(),
  /** false until the AI screening page's link is configured (shortlist emails wait for it). */
  shortlistEmailsReady: z.boolean(),
  /** true = screened candidates who are not shortlisted get the rejection email automatically, right away. */
  autoRejectionEmails: z.boolean().default(true),
  /** true = screened, shortlisted candidates get the shortlist email (AI screening link) automatically, right away. */
  autoShortlistEmails: z.boolean().default(false),
  counts: screeningCountsSchema,
  candidates: z.array(screenedCandidateSchema),
});
export type JobCandidates = z.infer<typeof jobCandidatesSchema>;

/** GET /api/v1/ats/jobs - every approved job of the company with its screening counts (job picker). */
export const screeningJobSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  minAtsScore: z.number().int().nullable(),
  counts: screeningCountsSchema,
});
export type ScreeningJob = z.infer<typeof screeningJobSchema>;
