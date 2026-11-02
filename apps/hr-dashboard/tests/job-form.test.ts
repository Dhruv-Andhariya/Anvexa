import { describe, expect, it } from 'vitest';
import { emptyDraft, formToDraft, validateDraft, type JobFormDraft } from '../src/lib/job-form';

const valid = (): JobFormDraft => ({
  ...emptyDraft(),
  title: 'Junior Backend Developer',
  experienceMin: '0',
  experienceMax: '2',
  mustHaveSkills: ['Node.js', 'SQL', 'REST'],
  locations: ['Ahmedabad'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
});

describe('validateDraft (shared jobFormSchema)', () => {
  it('converts a valid draft into a JobForm', () => {
    const result = validateDraft({ ...valid(), department: '  ', salaryMin: '400000', salaryMax: '600000' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form).toMatchObject({ experienceMin: 0, experienceMax: 2, salaryMin: 400000, openings: 1 });
    expect(result.form.department).toBeUndefined();
  });

  it('leaves salary out when not provided', () => {
    const result = validateDraft(valid());
    expect(result.ok && result.form.salaryMin === undefined && result.form.salaryMax === undefined).toBe(true);
  });

  it('reports friendly per-field errors for an empty form', () => {
    const result = validateDraft(emptyDraft());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toMatchObject({
      title: 'Enter at least 2 characters.',
      experienceMin: 'This field is required.',
      mustHaveSkills: 'Add at least 3 must-have skills.',
      locations: 'Add at least 1 location.',
      workMode: 'Choose an option.',
      employmentType: 'Choose an option.',
    });
  });

  it('attaches cross-field range errors to the max fields', () => {
    const result = validateDraft({ ...valid(), experienceMin: '5', experienceMax: '2', salaryMin: '9', salaryMax: '5' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.experienceMax).toBe('Maximum must be at least the minimum.');
    expect(result.errors.salaryMax).toBe('Maximum salary must be at least the minimum.');
  });

  it('rejects non-integer openings', () => {
    const result = validateDraft({ ...valid(), openings: '1.5' });
    expect(result.ok).toBe(false);
  });
});

describe('deadline', () => {
  const form = (deadline?: string) => {
    const result = validateDraft({ ...valid(), deadline: deadline ?? '' });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.form;
  };

  it('is optional', () => expect(form().deadline).toBeUndefined());

  it('turns the picked date into the end of that day (local time) as an ISO datetime', () => {
    const iso = form('2099-10-31').deadline!;
    expect(iso).toBe(new Date('2099-10-31T23:59:59').toISOString());
    expect(formToDraft(form('2099-10-31')).deadline).toBe('2099-10-31');
  });

  it('round-trips a saved deadline unchanged, so editing other fields never wipes or moves it', () => {
    const saved = { ...form(), deadline: '2099-10-31T18:29:59.000Z' };
    const draft = formToDraft(saved);
    expect(draft.deadline).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const again = validateDraft({ ...draft, title: 'Senior Backend Developer' });
    expect(again.ok && again.form.deadline).toBe('2099-10-31T18:29:59.000Z');
  });

  it('can be cleared or changed', () => {
    const draft = formToDraft({ ...form(), deadline: '2099-10-31T18:29:59.000Z' });
    const cleared = validateDraft({ ...draft, deadline: '' });
    expect(cleared.ok && cleared.form.deadline).toBeUndefined();
    const moved = validateDraft({ ...draft, deadline: '2099-12-01' });
    expect(moved.ok && moved.form.deadline).toBe(new Date('2099-12-01T23:59:59').toISOString());
  });

  it('reports an unparseable date on the deadline field', () => {
    const result = validateDraft({ ...valid(), deadline: 'not-a-date' });
    expect(!result.ok && result.errors.deadline).toBe('Enter a valid date.');
  });
});
