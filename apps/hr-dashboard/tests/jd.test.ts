import { describe, expect, it } from 'vitest';
import { jdProblems, jdToText, jobMeta, tidyJd, versionLabel } from '../src/lib/jd';

const JD = {
  title: 'Junior Backend Developer',
  summary: 'You will build backend services.',
  aboutCompany: '',
  responsibilities: ['Build REST APIs.', '  '],
  requirements: ['Node.js'],
  niceToHave: [],
  benefits: [],
};

describe('jd helpers', () => {
  it('formats plain text for the clipboard and skips empty optional sections', () => {
    expect(jdToText(JD)).toBe(
      [
        'Junior Backend Developer',
        'About the Role\nYou will build backend services.',
        'Key Responsibilities\n- Build REST APIs.',
        'What We’re Looking For\n- Node.js',
      ].join('\n\n'),
    );
  });

  it('puts the job facts from the form under the title', () => {
    const form = {
      title: 'Junior Backend Developer', experienceMin: 0, experienceMax: 2, mustHaveSkills: ['Node.js', 'SQL', 'REST'],
      niceToHaveSkills: [], currency: 'INR', salaryType: 'CTC' as const, locations: ['Pune', 'Remote India'],
      workMode: 'HYBRID' as const, employmentType: 'FULL_TIME' as const, openings: 3,
    };
    expect(jdToText(JD, form).split('\n\n')[0]).toBe('Junior Backend Developer\nPune, Remote India · Hybrid · Full-time · 0–2 years · 3 openings');
    expect(jobMeta({ ...form, experienceMax: 0, openings: 1 })).toEqual(['Pune, Remote India', 'Hybrid', 'Full-time', 'Freshers']);
  });

  it('puts the company section right after the summary', () => {
    const text = jdToText({ ...JD, aboutCompany: ' Acme builds dashboards. ' });
    expect(text.split('\n\n').slice(1, 3)).toEqual(['About the Role\nYou will build backend services.', 'About the Company\nAcme builds dashboards.']);
  });

  it('ends with the company website when the JD has one, and keeps it when tidying', () => {
    const withLink = { ...JD, companyUrl: 'https://acme.dev' };
    expect(jdToText(withLink).split('\n\n').at(-1)).toBe('Company Website\nLearn more about us at https://acme.dev');
    expect(tidyJd(withLink).companyUrl).toBe('https://acme.dev');
    expect(tidyJd(JD)).not.toHaveProperty('companyUrl');
  });

  it('still shows the careers link of older versions that have one', () => {
    const legacy = { ...JD, careersUrl: 'https://acme.dev/careers' };
    expect(jdToText(legacy).split('\n\n').at(-1)).toBe('How to Apply\nSee all our openings and apply at https://acme.dev/careers');
    expect(tidyJd(legacy).careersUrl).toBe('https://acme.dev/careers');
  });

  it('tidies blank items left by editing', () => {
    expect(tidyJd(JD).responsibilities).toEqual(['Build REST APIs.']);
  });

  it('flags edits that break the JD contract', () => {
    expect(jdProblems(JD)).toEqual([]);
    expect(jdProblems({ ...JD, summary: ' ', requirements: [' '] })).toEqual([
      'Add a job summary.',
      'Add at least one item under “What We’re Looking For”.',
    ]);
  });

  it('uses the same rules as the API for edited JDs (e.g. the title length limit)', () => {
    expect(jdProblems({ ...JD, title: 'x'.repeat(121) })).toEqual(['Keep the job title under 120 characters.']);
    expect(jdProblems({ ...JD, title: '  ', summary: '' })).toEqual(['Add a job title.', 'Add a job summary.']);
    expect(jdProblems({ ...JD, responsibilities: [' '] })).toEqual(['Add at least one item under “Key Responsibilities”.']);
  });

  it('labels versions by origin', () => {
    expect(versionLabel({ version: 1, source: 'AI', promptVersion: 'jd_generate.v3' })).toBe('Version 1 · AI draft (jd_generate.v3)');
    expect(versionLabel({ version: 2, source: 'HR_EDIT', promptVersion: null })).toBe('Version 2 · edited by HR');
  });
});
