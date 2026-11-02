import { describe, expect, it } from 'vitest';
import { JOB_FORM_LIMITS, editJdRequestSchema, editedJdSchema, jdContentSchema, jobFormSchema } from '../src';

const base = {
  title: 'Junior Backend Developer', experienceMin: 0, experienceMax: 2,
  mustHaveSkills: ['Node.js', 'SQL', 'REST'], locations: ['Ahmedabad'],
  workMode: 'HYBRID', employmentType: 'FULL_TIME',
} as const;

describe('jobFormSchema', () => {
  it('accepts a valid form', () => expect(jobFormSchema.safeParse(base).success).toBe(true));
  it('rejects fewer than 3 must-have skills', () =>
    expect(jobFormSchema.safeParse({ ...base, mustHaveSkills: ['a', 'b'] }).success).toBe(false));
  it('rejects salaryMin > salaryMax', () =>
    expect(jobFormSchema.safeParse({ ...base, salaryMin: 9, salaryMax: 5 }).success).toBe(false));
  it('rejects blank must-have skills', () =>
    expect(jobFormSchema.safeParse({ ...base, mustHaveSkills: ['Node.js', 'SQL', '  '] }).success).toBe(false));
  it('rejects over-long additional requirements', () =>
    expect(
      jobFormSchema.safeParse({ ...base, shortDescription: 'x'.repeat(JOB_FORM_LIMITS.shortDescriptionMax + 1) })
        .success,
    ).toBe(false));
  it('trims text fields', () => {
    const parsed = jobFormSchema.parse({ ...base, title: '  Junior Backend Developer  ' });
    expect(parsed.title).toBe('Junior Backend Developer');
  });
});

describe('jdContentSchema', () => {
  it('requires at least one responsibility and requirement', () =>
    expect(jdContentSchema.safeParse({ title: 't', summary: 's', responsibilities: [], requirements: ['x'] }).success)
      .toBe(false));
});

describe('editedJdSchema', () => {
  const jd = { title: 'Backend Developer', summary: 'Build APIs.', responsibilities: ['a'], requirements: ['b'] };
  it('rejects a blank summary that jdContentSchema would accept', () => {
    expect(jdContentSchema.safeParse({ ...jd, summary: '  ' }).success).toBe(true);
    expect(editedJdSchema.safeParse({ ...jd, summary: '  ' }).success).toBe(false);
  });
  it('limits the title length', () =>
    expect(editedJdSchema.safeParse({ ...jd, title: 'x'.repeat(JOB_FORM_LIMITS.titleMax + 1) }).success).toBe(false));
});

describe('editJdRequestSchema', () => {
  const content = { title: 'Backend Developer', summary: 'Build APIs.', responsibilities: ['a'], requirements: ['b'] };
  it('accepts an optional basedOnVersionId for restores', () => {
    expect(editJdRequestSchema.parse({ baseVersionId: 'v3', content }).basedOnVersionId).toBeUndefined();
    expect(editJdRequestSchema.parse({ baseVersionId: 'v3', basedOnVersionId: 'v1', content }).basedOnVersionId).toBe('v1');
    expect(editJdRequestSchema.safeParse({ baseVersionId: 'v3', basedOnVersionId: '', content }).success).toBe(false);
  });
});
