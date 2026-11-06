import { describe, expect, it } from 'vitest';
import {
  checkResumeFile,
  emptyApplyDraft,
  validateApplyDraft,
  type ApplyDraft,
} from '../src/lib/apply-form';

const filled: ApplyDraft = {
  ...emptyApplyDraft,
  name: 'Asha Patel',
  email: 'asha@example.com',
  phone: '9876543210',
  city: 'Ahmedabad',
  college: 'LD College of Engineering',
  degree: 'B.E.',
  branch: 'Computer',
  graduationYear: '2026',
  scoreValue: '8.4',
  experienceYears: '2',
  consentDataProcessing: true,
  consentAiEvaluation: true,
};

describe('validateApplyDraft', () => {
  it('accepts a complete, verified form', () => {
    const r = validateApplyDraft(filled, 'signed-token-123', 'linkedin');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.form).toMatchObject({
        phone: '+919876543210',
        source: 'linkedin',
        graduationYear: 2026,
        experienceYears: 2,
      });
  });

  it('asks for years of experience: 0 for a fresher, half years allowed, never blank', () => {
    const ok = (v: string) => validateApplyDraft({ ...filled, experienceYears: v }, 'signed-token-123');
    expect(ok('0')).toMatchObject({ ok: true, form: { experienceYears: 0 } });
    expect(ok('1.5')).toMatchObject({ ok: true, form: { experienceYears: 1.5 } });
    expect(ok('')).toEqual({ ok: false, errors: { experienceYears: 'Enter your years of experience (0 if you are a fresher)' } });
    expect(ok('two')).toEqual({ ok: false, errors: { experienceYears: 'Enter a number' } });
    expect(ok('-1')).toEqual({ ok: false, errors: { experienceYears: 'Enter 0 or more' } });
    expect(ok('1.25')).toEqual({ ok: false, errors: { experienceYears: 'Use whole or half years, e.g. 2 or 2.5' } });
    expect(ok('51')).toEqual({ ok: false, errors: { experienceYears: 'Enter at most 50 years' } });
  });

  it('asks to verify the phone first', () => {
    const r = validateApplyDraft(filled, null);
    expect(r).toEqual({ ok: false, errors: { phone: 'Verify your mobile number first.' } });
  });

  it('points consent and field errors at the right inputs', () => {
    const r = validateApplyDraft(
      { ...filled, consentAiEvaluation: false, name: '', scoreValue: '42' },
      'signed-token-123',
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual(['consentAiEvaluation', 'name', 'scoreValue']);
  });

  it('does not accept an empty score as 0', () => {
    expect(validateApplyDraft({ ...filled, scoreValue: '' }, 'signed-token-123')).toEqual({
      ok: false,
      errors: { scoreValue: 'Required' },
    });
    expect(validateApplyDraft({ ...filled, scoreValue: 'eight' }, 'signed-token-123')).toEqual({
      ok: false,
      errors: { scoreValue: 'Enter a number' },
    });
  });

  it('drops a weird source instead of failing', () => {
    const r = validateApplyDraft(filled, 'signed-token-123', '<script>');
    expect(r.ok && r.form.source).toBeUndefined();
  });
});

describe('checkResumeFile', () => {
  it.each([
    [{ name: 'cv.pdf', size: 1000 }, undefined],
    [{ name: 'CV.DOCX', size: 1000 }, undefined],
    [{ name: 'cv.doc', size: 1000 }, 'Upload a PDF or Word (.docx) file.'],
    [
      { name: 'cv.pdf', size: 6 * 1024 * 1024 },
      'The file is bigger than 5 MB. Please upload a smaller file.',
    ],
    [null, 'Please attach your resume.'],
  ])('%j', (file, expected) => expect(checkResumeFile(file)).toBe(expected));
});
