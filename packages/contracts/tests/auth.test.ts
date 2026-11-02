import { describe, expect, it } from 'vitest';
import {
  acceptInvitationRequestSchema,
  forgotPasswordRequestSchema,
  inviteMemberRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
  signupRequestSchema,
  updateMemberRequestSchema,
} from '../src';

describe('auth contracts', () => {
  it('password reset: normalised email, a long-enough new password and a real token', () => {
    expect(forgotPasswordRequestSchema.parse({ email: ' Priya@Acme.DEV' }).email).toBe('priya@acme.dev');
    const token = 'x'.repeat(43);
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'long enough pass' }).success).toBe(true);
    expect(resetPasswordRequestSchema.safeParse({ token, password: 'short' }).success).toBe(false);
    expect(resetPasswordRequestSchema.safeParse({ token: 'abc', password: 'long enough pass' }).success).toBe(false);
  });

  it('normalises emails so one person cannot get two accounts', () => {
    expect(loginRequestSchema.parse({ email: '  Priya@Acme.DEV ', password: 'x' }).email).toBe('priya@acme.dev');
  });

  it('only offers company-level roles to invite (no platform admin)', () => {
    expect(inviteMemberRequestSchema.safeParse({ email: 'a@b.dev', role: 'HR_MEMBER' }).success).toBe(true);
    expect(inviteMemberRequestSchema.safeParse({ email: 'a@b.dev', role: 'PLATFORM_ADMIN' }).success).toBe(false);
  });

  it('requires a strong-enough password when accepting an invitation', () => {
    const token = 'x'.repeat(43);
    expect(acceptInvitationRequestSchema.safeParse({ token, password: 'short' }).success).toBe(false);
    expect(acceptInvitationRequestSchema.safeParse({ token, password: 'long enough pass' }).success).toBe(true);
  });

  it('sign-up takes only name, email and password (no role, no platform admin)', () => {
    const parsed = signupRequestSchema.parse({
      name: ' Priya Shah ',
      email: 'Priya@Acme.dev',
      password: 'long enough pass',
      isPlatformAdmin: true,
      role: 'COMPANY_ADMIN',
    });
    expect(parsed).toEqual({ name: 'Priya Shah', email: 'priya@acme.dev', password: 'long enough pass' });
    expect(signupRequestSchema.safeParse({ name: 'Priya', email: 'p@a.dev', password: 'short' }).success).toBe(false);
  });

  it('rejects an empty member update', () => {
    expect(updateMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMemberRequestSchema.safeParse({ status: 'DISABLED' }).success).toBe(true);
  });
});
