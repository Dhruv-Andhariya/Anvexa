import { z } from 'zod';

/** M28: company-level roles. Platform Admin is a separate, platform-level flag (never granted through the API). */
export const COMPANY_ROLES = ['COMPANY_ADMIN', 'HR_MEMBER'] as const;
export const companyRoleSchema = z.enum(COMPANY_ROLES);
export type CompanyRole = z.infer<typeof companyRoleSchema>;

export const COMPANY_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const companyStatusSchema = z.enum(COMPANY_STATUSES);
export type CompanyStatus = z.infer<typeof companyStatusSchema>;

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const membershipStatusSchema = z.enum(MEMBERSHIP_STATUSES);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

export const PASSWORD_LIMITS = { min: 10, max: 128 } as const;

const email = z.string().trim().toLowerCase().email().max(254);
const personName = z.string().trim().min(2).max(100);
const newPassword = z
  .string()
  .min(PASSWORD_LIMITS.min, `Use at least ${PASSWORD_LIMITS.min} characters`)
  .max(PASSWORD_LIMITS.max);

// ---- session ----

/** POST /auth/login */
export const loginRequestSchema = z.object({
  email,
  password: z.string().min(1).max(PASSWORD_LIMITS.max),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * POST /auth/signup - a new HR person creates their own account (no company yet, never Platform Admin).
 * Next step: POST /companies to register their company.
 */
export const signupRequestSchema = z.object({ name: personName, email, password: newPassword });
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const sessionCompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: companyStatusSchema,
  role: companyRoleSchema,
});
export type SessionCompany = z.infer<typeof sessionCompanySchema>;

/** GET /auth/me - who is logged in, and which company the session is working in. */
export const sessionSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), isPlatformAdmin: z.boolean() }),
  /** null until the user registers a company (or after all their memberships were disabled) */
  company: sessionCompanySchema.nullable(),
  /** every company the user has an ACTIVE membership in (for switching) */
  companies: z.array(sessionCompanySchema),
});
export type Session = z.infer<typeof sessionSchema>;

// ---- login 2FA (email code) ----

/** POST /auth/login answer when 2FA is on: no cookie yet, a 6-digit code was emailed. */
export const loginCodeRequiredSchema = z.object({
  codeRequired: z.literal(true),
  /** Opaque, single-use; send it back with the code. Only its hash is stored. */
  challenge: z.string(),
  /** Masked address the code went to, e.g. "d***@company.com". */
  emailHint: z.string(),
  expiresAt: z.string(),
});
export type LoginCodeRequired = z.infer<typeof loginCodeRequiredSchema>;

/** POST /auth/login: a session (2FA off) or "enter the emailed code". */
export const loginResponseSchema = z.union([sessionSchema, loginCodeRequiredSchema]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** POST /auth/login/verify - the challenge from /auth/login and the emailed code. Sets the session cookie. */
export const verifyLoginCodeRequestSchema = z.object({
  challenge: z.string().min(20).max(200),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'),
});
export type VerifyLoginCodeRequest = z.infer<typeof verifyLoginCodeRequestSchema>;

// ---- sign-up email verification (same 6-digit email code) ----

/** POST /auth/signup: a session (verification off) or "enter the code emailed to that address" (no account yet). */
export const signupResponseSchema = loginResponseSchema;
export type SignupResponse = LoginResponse;

/** POST /auth/signup/verify - the challenge from /auth/signup and the emailed code. Creates the account, logged in. */
export const verifySignupCodeRequestSchema = verifyLoginCodeRequestSchema;
export type VerifySignupCodeRequest = VerifyLoginCodeRequest;

// ---- password reset ----

/** POST /auth/password/forgot - always answers 204, whether or not an account has this email. */
export const forgotPasswordRequestSchema = z.object({ email });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/** POST /auth/password/reset - the token from the emailed link and the new password. Logs out every session. */
export const resetPasswordRequestSchema = z.object({ token: z.string().min(20).max(200), password: newPassword });
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** POST /auth/company - switch the session to another company the user belongs to. */
export const switchCompanyRequestSchema = z.object({ companyId: z.string().uuid() });

// ---- invitations ----

/** POST /company/invitations (Company Admin) */
export const inviteMemberRequestSchema = z.object({ email, role: companyRoleSchema });
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: companyRoleSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** Returned ONCE when an invitation is created. The link is the only copy of the token (only its hash is stored). */
export const createdInvitationSchema = invitationSchema.extend({ inviteUrl: z.string() });
export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

/** GET /auth/invitations/:token - what the invite page shows before accepting. */
export const invitationPreviewSchema = z.object({
  email: z.string(),
  companyName: z.string(),
  role: companyRoleSchema,
  expiresAt: z.string(),
  /** true: the invitee already has an account and must confirm with its password */
  existingUser: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** POST /auth/invitations/accept - `name` is required only for a new account. */
export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(20).max(200),
  name: personName.optional(),
  password: newPassword,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

// ---- team (Company Admin) ----

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: companyRoleSchema,
  status: membershipStatusSchema,
  joinedAt: z.string(),
});
export type Member = z.infer<typeof memberSchema>;

export const teamSchema = z.object({ members: z.array(memberSchema), invitations: z.array(invitationSchema) });
export type Team = z.infer<typeof teamSchema>;

/** PATCH /company/members/:userId */
export const updateMemberRequestSchema = z
  .object({ role: companyRoleSchema.optional(), status: membershipStatusSchema.optional() })
  .refine((v) => v.role !== undefined || v.status !== undefined, { message: 'Change the role or the status' });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

// ---- platform admin ----
// Companies are registered by their own HR (POST /companies with a CompanyProfile body), not by the Platform Admin.

/** PATCH /admin/companies/:id */
export const updateCompanyRequestSchema = z.object({ status: companyStatusSchema });
export type UpdateCompanyRequest = z.infer<typeof updateCompanyRequestSchema>;

export const companySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: companyStatusSchema,
  memberCount: z.number().int().nonnegative(),
  jobCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

export const companyDetailSchema = companySummarySchema.extend(teamSchema.shape);
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

