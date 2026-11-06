import { describe, expect, it } from 'vitest';
import { applyFormSchema, isBelowRequiredExperience, phoneSchema, publishJobRequestSchema } from '../src';

const base = {
  name: 'Asha Patel',
  email: 'Asha@Example.com ',
  phone: '98765 43210',
  city: 'Ahmedabad',
  college: 'LD College of Engineering',
  degree: 'B.E.',
  branch: 'Computer',
  graduationYear: '2026',
  scoreType: 'CGPA',
  scoreValue: '8.4',
  experienceYears: '2',
  linkedinUrl: '',
  consents: { dataProcessing: true, aiEvaluation: true },
  otpToken: 'signed-token-123',
};

describe('phoneSchema', () => {
  it.each(['9876543210', '+919876543210', '919876543210', '09876543210', '98765-43210'])('normalises %s', (v) =>
    expect(phoneSchema.parse(v)).toBe('+919876543210'));
  it.each(['12345', '5876543210', '+1 415 555 0100'])('rejects %s', (v) => expect(phoneSchema.safeParse(v).success).toBe(false));
});

describe('applyFormSchema', () => {
  it('accepts a valid form and normalises values', () => {
    const v = applyFormSchema.parse(base);
    expect(v.email).toBe('asha@example.com');
    expect(v.phone).toBe('+919876543210');
    expect(v.graduationYear).toBe(2026);
    expect(v.linkedinUrl).toBeUndefined();
    expect(v.consents.recordings).toBe(false);
  });
  it('requires the data processing and AI evaluation consents', () =>
    expect(applyFormSchema.safeParse({ ...base, consents: { dataProcessing: true, aiEvaluation: false } }).success).toBe(false));
  it('rejects CGPA above 10', () => expect(applyFormSchema.safeParse({ ...base, scoreValue: '85' }).success).toBe(false));
  it('accepts percentage up to 100', () =>
    expect(applyFormSchema.safeParse({ ...base, scoreType: 'PERCENTAGE', scoreValue: '85' }).success).toBe(true));
  it.each([['0', 0], ['2', 2], ['1.5', 1.5], [3, 3]] as const)('accepts experience %j', (experienceYears, parsed) =>
    expect(applyFormSchema.parse({ ...base, experienceYears }).experienceYears).toBe(parsed));
  it.each(['', '  ', 'abc', '-1', '1.25', '51', undefined])('rejects experience %j (required, 0-50, whole or half years)', (experienceYears) =>
    expect(applyFormSchema.safeParse({ ...base, experienceYears }).success).toBe(false));
  it.each(['', '   ', 'abc'])('rejects score %j instead of saving it as 0', (scoreValue) =>
    expect(applyFormSchema.safeParse({ ...base, scoreValue }).success).toBe(false));
  it('accepts a numeric score sent as a number', () => expect(applyFormSchema.parse({ ...base, scoreValue: 8.4 }).scoreValue).toBe(8.4));
  it('rejects non-http links', () =>
    expect(applyFormSchema.safeParse({ ...base, githubUrl: 'javascript:alert(1)' }).success).toBe(false));
});

describe('publishJobRequestSchema', () => {
  it('defaults selectionProcess to empty', () => expect(publishJobRequestSchema.parse({}).selectionProcess).toEqual([]));
  it('trims steps and rejects blank ones', () => {
    expect(publishJobRequestSchema.parse({ selectionProcess: [' Aptitude test '] }).selectionProcess).toEqual(['Aptitude test']);
    expect(publishJobRequestSchema.safeParse({ selectionProcess: ['  '] }).success).toBe(false);
  });
  it('ignores a client-sent JD: only the approved version from the database is published', () =>
    expect(publishJobRequestSchema.parse({ jd: { title: 'x' } })).not.toHaveProperty('jd'));
});

describe('isBelowRequiredExperience (automatic rejection rule)', () => {
  it.each([
    [1.5, 2, true],
    [2, 2, false],
    [6, 2, false], // more than the range is never a rejection
    [0, 0, false], // fresher job
    [null, 4, false], // applied before the field existed
  ] as const)('%s years vs minimum %s -> %s', (years, min, rejected) => expect(isBelowRequiredExperience(years, min)).toBe(rejected));
});
