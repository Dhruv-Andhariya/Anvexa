import type { JdContent, JobForm, PostLinks } from '@hireflow/contracts';

/** Everything a post may contain. Built ONLY from the approved JD version, the job form and the company profile. */
export interface PostSource {
  company: { name: string; about: string | null };
  form: JobForm;
  jd: JdContent;
  selectionProcess: string[];
}

export interface PostSection {
  label: string;
  lines: string[];
  bullets?: boolean;
}

export interface FormatOptions {
  /** Max responsibilities to list (short channels show fewer; the apply page has the full JD). */
  maxResponsibilities?: number;
  /** Shorten the JD summary to about this many characters. */
  maxSummaryChars?: number;
  /** Shorten the company "About" text to about this many characters; 0 leaves the section out. */
  maxAboutChars?: number;
}

/**
 * Cuts text to at most `max` characters, at a sentence end when one is close, else at a word, and adds "…".
 * Text that already fits is returned as it is.
 */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return '';
  const cut = text.slice(0, max - 1);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ');
  return `${(word >= max * 0.5 ? cut.slice(0, word) : cut).replace(/[\s,;:–-]+$/, '')}…`;
}

const WORK_MODE: Record<JobForm['workMode'], string> = { ONSITE: 'On-site', HYBRID: 'Hybrid', REMOTE: 'Remote' };
const EMPLOYMENT: Record<JobForm['employmentType'], string> = {
  FULL_TIME: 'Full-time job',
  PART_TIME: 'Part-time job',
  INTERNSHIP: 'Internship',
  CONTRACT: 'Contract job',
};

/**
 * Removes links from free text so every post carries exactly the two links we add
 * (apply + company website). AI-written JD text must never smuggle in extra URLs.
 */
export function stripLinks(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const clean = (items: string[]) => items.map(stripLinks).filter(Boolean);

/** Indian-style plain words: 400000-600000 INR -> "₹4 – 6 LPA". Returns undefined when HR gave no salary. */
export function salaryInWords(form: JobForm): string | undefined {
  const { salaryMin: min, salaryMax: max, currency, salaryType } = form;
  if (min === undefined && max === undefined) return undefined;
  const suffix = salaryType === 'IN_HAND' ? ' (in-hand)' : ' (CTC)';

  if (currency === 'INR') {
    const big = (min ?? max!) >= 100_000;
    const fmt = (n: number) =>
      big ? `${Number((n / 100_000).toFixed(2))}` : new Intl.NumberFormat('en-IN').format(n);
    const unit = big ? ' LPA' : '';
    const range =
      min !== undefined && max !== undefined
        ? min === max
          ? `₹${fmt(min)}${unit}`
          : `₹${fmt(min)} – ${fmt(max)}${unit}`
        : min !== undefined
          ? `From ₹${fmt(min)}${unit}`
          : `Up to ₹${fmt(max!)}${unit}`;
    return range + suffix;
  }

  const fmt = (n: number) => new Intl.NumberFormat('en-IN').format(n);
  const range =
    min !== undefined && max !== undefined
      ? `${currency} ${fmt(min)} – ${fmt(max)}`
      : min !== undefined
        ? `From ${currency} ${fmt(min)}`
        : `Up to ${currency} ${fmt(max!)}`;
  return range + suffix;
}

/** "Who can apply" from the experience range only - no assumptions about degree, batch, etc. */
export function whoCanApply(form: JobForm): string {
  const { experienceMin: min, experienceMax: max } = form;
  const years = (n: number) => `${n} year${n === 1 ? '' : 's'}`;
  if (max === 0) return 'Freshers';
  if (min === 0) return `Freshers and candidates with up to ${years(max)} of experience`;
  if (min === max) return `Candidates with ${years(min)} of experience`;
  return `Candidates with ${min}–${years(max)} of experience`;
}

export function locationInWords(form: JobForm): string {
  return `${form.locations.join(', ')} (${WORK_MODE[form.workMode]})`;
}

export function deadlineInWords(form: JobForm): string | undefined {
  if (!form.deadline) return undefined;
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(form.deadline));
}

/** The student-friendly post as ordered sections. A section is skipped when its data is missing. */
export function buildPostSections(src: PostSource, opts: FormatOptions = {}): { headline: string; sections: PostSection[] } {
  const { form, jd, company } = src;
  const sections: PostSection[] = [];
  const add = (label: string, lines: (string | undefined)[], bullets = false) => {
    const kept = clean(lines.filter((l): l is string => !!l));
    if (kept.length) sections.push({ label, lines: kept, bullets });
  };

  const openings = form.openings > 1 ? `${form.openings} openings` : undefined;
  add('Role', [[jd.title, EMPLOYMENT[form.employmentType], openings].filter(Boolean).join(' · ')]);
  add('Location', [locationInWords(form)]);
  add('Salary', [salaryInWords(form)]);
  add('Who can apply', [whoCanApply(form)]);
  add('What the job is', [opts.maxSummaryChars ? shorten(stripLinks(jd.summary), opts.maxSummaryChars) : jd.summary]);
  const resp = opts.maxResponsibilities ? jd.responsibilities.slice(0, opts.maxResponsibilities) : jd.responsibilities;
  add('What you will do', resp, true);
  add('Skills needed', [
    form.mustHaveSkills.join(', '),
    form.niceToHaveSkills.length ? `Good to have: ${form.niceToHaveSkills.join(', ')}` : undefined,
  ]);
  add('Selection process', [src.selectionProcess.length ? src.selectionProcess.join(' → ') : undefined]);
  const about = company.about && opts.maxAboutChars !== undefined ? shorten(stripLinks(company.about), opts.maxAboutChars) : company.about;
  add(`About ${stripLinks(company.name)}`, [about || undefined]);
  add('Last date to apply', [deadlineInWords(form)]);

  return { headline: stripLinks(`${company.name} is hiring: ${jd.title}`), sections };
}

/**
 * Renders the post as plain text (channel adapters escape it for their platform when sending).
 * The two links are appended last and are the only links in the text.
 */
export function renderPost(src: PostSource, links: PostLinks, opts: FormatOptions = {}): string {
  const { headline, sections } = buildPostSections(src, opts);
  return [headline, renderBody(sections), linksBlock(links)].join('\n\n');
}

const renderBody = (sections: PostSection[]) =>
  sections.map(({ label, lines, bullets }) => `${label}\n${(bullets ? lines.map((l) => `• ${l}`) : lines).join('\n')}`).join('\n\n');
const linksBlock = (links: PostLinks) => `Apply here: ${links.apply}\nCompany website: ${links.careers}`;

/** Shortening steps for a length-limited channel: each gives up a bit more detail (the apply page has it all). */
const FIT_STEPS: FormatOptions[] = [
  { maxResponsibilities: 6, maxAboutChars: 500 },
  { maxResponsibilities: 3, maxAboutChars: 300, maxSummaryChars: 600 },
  { maxResponsibilities: 1, maxAboutChars: 0, maxSummaryChars: 300 },
];

/**
 * The post for a channel with a character limit. Shortens step by step and, as a last resort, cuts the middle
 * text - the headline and both links are always kept whole, so the result is never longer than `limit`.
 */
export function fitPost(src: PostSource, links: PostLinks, limit: number): string {
  for (const opts of FIT_STEPS) {
    const text = renderPost(src, links, opts);
    if (text.length <= limit) return text;
  }
  const { headline, sections } = buildPostSections(src, FIT_STEPS.at(-1)!);
  const ending = `\n\nFull details: open the apply link.\n\n${linksBlock(links)}`;
  const room = limit - headline.length - ending.length - 2;
  if (room < 20) return `${headline}\n\n${linksBlock(links)}`;
  return `${headline}\n\n${shorten(renderBody(sections), room)}${ending}`;
}
