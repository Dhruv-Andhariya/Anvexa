import { describe, expect, it } from 'vitest';
import { renderPost, salaryInWords, shorten, stripLinks, whoCanApply, type PostSource } from '../../src/modules/publisher/post-formatter';
import { COMPANY, FORM, JD } from './fixtures';

const SRC: PostSource = {
  company: { name: COMPANY.name, about: COMPANY.about },
  form: FORM,
  jd: JD,
  selectionProcess: ['AI screening', 'Coding round', 'Interview'],
};
const LINKS = { apply: 'https://careers.example/acme/jobs/junior-backend-developer-456789?src=linkedin', careers: 'https://acme.example/careers' };
const urls = (text: string) => text.match(/https?:\/\/\S+|www\.\S+/g) ?? [];

describe('renderPost', () => {
  it('has every section the student needs, in order', () => {
    const text = renderPost(SRC, LINKS);
    const order = ['Acme Tech is hiring', 'Location', 'Salary', 'Who can apply', 'What the job is', 'What you will do', 'Skills needed', 'Selection process', 'About Acme Tech', 'Last date to apply', 'Apply here', 'Company website'];
    let last = -1;
    for (const label of order) {
      const at = text.indexOf(label);
      expect(at, label).toBeGreaterThan(last);
      last = at;
    }
    expect(text).toContain('₹4 – 6 LPA (CTC)');
    expect(text).toContain('Freshers and candidates with up to 2 years of experience');
    expect(text).toContain('Ahmedabad (Hybrid)');
    expect(text).toContain('AI screening → Coding round → Interview');
    expect(text).toContain('Good to have: Docker');
  });

  it('contains exactly the two links, even when the JD text has its own links', () => {
    const sneaky: PostSource = {
      ...SRC,
      jd: { ...JD, summary: 'Visit https://evil.example/phish or www.spam.example for more.' },
      company: { ...SRC.company, about: 'See http://other.example' },
    };
    expect(urls(renderPost(sneaky, LINKS)).sort()).toEqual([LINKS.apply, LINKS.careers].sort());
  });

  it('never invents data: missing salary, deadline, selection process and about are left out', () => {
    const bare: PostSource = {
      company: { name: 'Acme Tech', about: null },
      form: { ...FORM, salaryMin: undefined, salaryMax: undefined, deadline: undefined },
      jd: JD,
      selectionProcess: [],
    };
    const text = renderPost(bare, LINKS);
    for (const label of ['Salary', 'Last date to apply', 'Selection process', 'About Acme Tech']) expect(text).not.toContain(label);
  });
});

describe('helpers', () => {
  it.each([
    [{ salaryMin: 400000, salaryMax: 600000 }, '₹4 – 6 LPA (CTC)'],
    [{ salaryMin: 450000, salaryMax: undefined }, 'From ₹4.5 LPA (CTC)'],
    [{ salaryMin: 15000, salaryMax: 20000, salaryType: 'IN_HAND' as const }, '₹15,000 – 20,000 (in-hand)'],
  ])('salaryInWords %j', (salary, expected) => expect(salaryInWords({ ...FORM, ...salary })).toBe(expected));

  it.each([
    [0, 0, 'Freshers'],
    [1, 3, 'Candidates with 1–3 years of experience'],
    [2, 2, 'Candidates with 2 years of experience'],
  ])('whoCanApply %i-%i', (min, max, expected) => expect(whoCanApply({ ...FORM, experienceMin: min, experienceMax: max })).toBe(expected));

  it('stripLinks removes urls', () => expect(stripLinks('a https://x.y/z b')).toBe('a b'));
});

describe('shorten', () => {
  it('keeps text that fits', () => expect(shorten('Short text.', 50)).toBe('Short text.'));
  it('cuts at a sentence end when close', () => expect(shorten('First sentence here. Second one is longer and goes on.', 36)).toBe('First sentence here.'));
  it('else cuts at a word and adds an ellipsis', () => {
    const out = shorten('alpha beta gamma delta epsilon zeta eta theta', 20);
    expect(out).toBe('alpha beta gamma…');
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
