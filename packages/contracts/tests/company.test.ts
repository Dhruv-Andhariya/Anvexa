import { describe, expect, it } from 'vitest';
import { approveJobRequestSchema, companyProfileSchema, editedJdSchema, jdContentSchema } from '../src';

const profile = {
  name: 'Acme Analytics',
  industry: 'B2B SaaS',
  description: 'Acme builds analytics dashboards for mid-sized retailers across India.',
};

describe('companyProfileSchema', () => {
  it('accepts the minimum profile and defaults benefits', () => {
    expect(companyProfileSchema.parse(profile).benefits).toEqual([]);
  });
  it('requires a meaningful description', () =>
    expect(companyProfileSchema.safeParse({ ...profile, description: 'Too short' }).success).toBe(false));
  it('accepts an optional careers page link, but only http(s)', () => {
    expect(companyProfileSchema.parse(profile).careersUrl).toBeUndefined();
    expect(companyProfileSchema.safeParse({ ...profile, careersUrl: 'https://acme.dev/careers' }).success).toBe(true);
    expect(companyProfileSchema.safeParse({ ...profile, careersUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(companyProfileSchema.safeParse({ ...profile, careersUrl: 'careers' }).success).toBe(false);
  });

  it('rejects a website without http(s)', () => {
    expect(companyProfileSchema.safeParse({ ...profile, website: 'ftp://acme.dev' }).success).toBe(false);
    expect(companyProfileSchema.safeParse({ ...profile, website: 'https://acme.dev' }).success).toBe(true);
  });
  it('rejects an unknown company size', () =>
    expect(companyProfileSchema.safeParse({ ...profile, companySize: 'huge' }).success).toBe(false));
});

describe('JD approval contracts', () => {
  const jd = { title: 't', summary: 's', responsibilities: ['r'], requirements: ['q'] };

  it('defaults aboutCompany so older JDs stay valid', () =>
    expect(jdContentSchema.parse(jd).aboutCompany).toBe(''));
  it('does not allow an HR edit to blank the summary or leave empty bullets', () => {
    expect(editedJdSchema.safeParse({ ...jd, summary: '   ' }).success).toBe(false);
    expect(editedJdSchema.safeParse({ ...jd, requirements: [' '] }).success).toBe(false);
  });
  it('requires HR to confirm the company details', () => {
    const base = { jdVersionId: 'v1' };
    expect(approveJobRequestSchema.safeParse({ ...base, companyDetailsVerified: false }).success).toBe(false);
    expect(approveJobRequestSchema.safeParse({ ...base, companyDetailsVerified: true }).success).toBe(true);
  });
  it('never takes the approver from the request body', () => {
    const parsed = approveJobRequestSchema.parse({ jdVersionId: 'v1', approvedBy: 'Someone Else', companyDetailsVerified: true });
    expect(parsed).not.toHaveProperty('approvedBy');
  });
});
