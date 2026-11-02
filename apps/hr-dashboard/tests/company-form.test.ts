import { describe, expect, it } from 'vitest';
import {
  emptyCompanyDraft,
  profileToDraft,
  readSnapshot,
  sameCompany,
  validateCompanyDraft,
  type CompanyDraft,
} from '../src/lib/company-form';

const valid = (): CompanyDraft => ({
  ...emptyCompanyDraft(),
  name: 'Acme Analytics',
  industry: 'B2B SaaS',
  description: 'Acme builds analytics dashboards for mid-sized retailers across India.',
});

describe('validateCompanyDraft (shared companyProfileSchema)', () => {
  it('converts a valid draft and drops empty optional fields', () => {
    const result = validateCompanyDraft({ ...valid(), headquarters: '  ', foundedYear: '2018' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.headquarters).toBeUndefined();
    expect(result.profile.foundedYear).toBe(2018);
  });

  it('adds https:// to a bare website', () => {
    const result = validateCompanyDraft({ ...valid(), website: 'acme.dev' });
    expect(result.ok && result.profile.website).toBe('https://acme.dev');
  });

  it('handles the optional careers page link like the website', () => {
    const empty = validateCompanyDraft(valid());
    expect(empty.ok && empty.profile.careersUrl).toBeUndefined();
    const bare = validateCompanyDraft({ ...valid(), careersUrl: 'acme.dev/careers' });
    expect(bare.ok && bare.profile.careersUrl).toBe('https://acme.dev/careers');
    const bad = validateCompanyDraft({ ...valid(), careersUrl: 'not a link' });
    expect(!bad.ok && bad.errors.careersUrl).toMatch(/valid link/);
    const profile = { name: 'Acme', industry: 'SaaS', description: 'x'.repeat(30), benefits: [], careersUrl: 'https://acme.dev/jobs' };
    expect(profileToDraft(profile).careersUrl).toBe('https://acme.dev/jobs');
  });

  it('reports friendly errors for an empty form', () => {
    const result = validateCompanyDraft(emptyCompanyDraft());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toMatchObject({
      name: 'Enter at least 2 characters.',
      industry: 'Enter at least 2 characters.',
      description: 'Describe the company in at least 30 characters.',
    });
  });

  it('rejects a bad founding year', () => {
    const result = validateCompanyDraft({ ...valid(), foundedYear: '20' });
    expect(!result.ok && result.errors.foundedYear).toBe('Enter a year between 1800 and 2100.');
  });

  it('round-trips a saved profile through the draft', () => {
    const result = validateCompanyDraft({ ...valid(), benefits: ['Health insurance'], companySize: '51-200' });
    if (!result.ok) throw new Error('expected valid');
    expect(validateCompanyDraft(profileToDraft(result.profile))).toEqual(result);
  });
});

describe('company snapshot helpers', () => {
  const profile = { name: 'Acme', industry: 'SaaS', description: 'x'.repeat(30), benefits: ['Gym'] };

  it('compares facts only, ignoring record fields and key order', () => {
    const record = { id: 'c1', updatedAt: 'now', benefits: ['Gym'], description: 'x'.repeat(30), industry: 'SaaS', name: 'Acme' };
    expect(sameCompany(profile, record)).toBe(true);
    expect(sameCompany(profile, { ...record, industry: 'Retail' })).toBe(false);
  });

  it('reads valid snapshots and ignores malformed ones', () => {
    expect(readSnapshot(profile)).toMatchObject({ name: 'Acme' });
    expect(readSnapshot({ name: 'A' })).toBeNull();
    expect(readSnapshot(null)).toBeNull();
  });
});
