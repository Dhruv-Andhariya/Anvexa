import { JOB_FORM_LIMITS, editedJdSchema, type JdContent, type JdVersion, type JobForm } from '@hireflow/contracts';

/** "Version 2 · edited by HR" / "Version 1 · AI draft (jd_generate.v3)" */
export function versionLabel(v: Pick<JdVersion, 'version' | 'source' | 'promptVersion'>): string {
  const origin = v.source === 'HR_EDIT' ? 'edited by HR' : `AI draft${v.promptVersion ? ` (${v.promptVersion})` : ''}`;
  return `Version ${v.version} · ${origin}`;
}

export type JdListField = 'responsibilities' | 'requirements' | 'niceToHave' | 'benefits';

export const JD_SECTIONS: { field: JdListField; heading: string; optional: boolean }[] = [
  { field: 'responsibilities', heading: 'Key Responsibilities', optional: false },
  { field: 'requirements', heading: 'What We’re Looking For', optional: false },
  { field: 'niceToHave', heading: 'Good to Have', optional: true },
  { field: 'benefits', heading: 'Benefits', optional: true },
];

export const ABOUT_ROLE_HEADING = 'About the Role';

/** "Pune · Hybrid · Full-time · 4–6 years" - straight from HR's form, never from the AI. */
export function jobMeta(form: Pick<JobForm, 'locations' | 'workMode' | 'employmentType' | 'experienceMin' | 'experienceMax' | 'openings'>): string[] {
  const years =
    form.experienceMax === 0
      ? 'Freshers'
      : form.experienceMin === form.experienceMax
        ? `${form.experienceMin} years`
        : `${form.experienceMin}–${form.experienceMax} years`;
  return [
    form.locations.join(', '),
    WORK_MODE_LABELS[form.workMode],
    EMPLOYMENT_TYPE_LABELS[form.employmentType],
    years,
    ...(form.openings > 1 ? [`${form.openings} openings`] : []),
  ];
}

const WORK_MODE_LABELS: Record<JobForm['workMode'], string> = { ONSITE: 'On-site', HYBRID: 'Hybrid', REMOTE: 'Remote' };
const EMPLOYMENT_TYPE_LABELS: Record<JobForm['employmentType'], string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  INTERNSHIP: 'Internship',
  CONTRACT: 'Contract',
};

/** Trim text and drop blank list items left behind while editing. */
export function tidyJd(jd: JdContent): JdContent {
  const list = (items: string[]) => items.map((i) => i.trim()).filter(Boolean);
  return {
    title: jd.title.trim(),
    summary: jd.summary.trim(),
    aboutCompany: jd.aboutCompany.trim(),
    responsibilities: list(jd.responsibilities),
    requirements: list(jd.requirements),
    niceToHave: list(jd.niceToHave),
    benefits: list(jd.benefits),
    ...(jd.companyUrl ? { companyUrl: jd.companyUrl } : {}),
    ...(jd.careersUrl ? { careersUrl: jd.careersUrl } : {}), // legacy versions only
  };
}

/**
 * Problems with an edited JD, checked with the SAME schema the API uses for edits (editedJdSchema),
 * so the editor never accepts what the server would reject. One message per field.
 */
export function jdProblems(jd: JdContent): string[] {
  const parsed = editedJdSchema.safeParse(tidyJd(jd));
  if (parsed.success) return [];
  const problems = new Set<string>();
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    const section = JD_SECTIONS.find((s) => s.field === field);
    if (field === 'title') {
      problems.add(issue.code === 'too_big' ? `Keep the job title under ${JOB_FORM_LIMITS.titleMax} characters.` : 'Add a job title.');
    } else if (field === 'summary') {
      problems.add('Add a job summary.');
    } else if (section) {
      problems.add(`Add at least one item under “${section.heading}”.`);
    } else {
      problems.add(issue.message);
    }
  }
  return [...problems];
}

export const ABOUT_COMPANY_HEADING = 'About the Company';
export const COMPANY_LINK_HEADING = 'Company Website';
export const companyLinkText = (url: string) => `Learn more about us at ${url}`;
/** Only for older versions that were generated with the careers page link. */
export const HOW_TO_APPLY_HEADING = 'How to Apply';
export const howToApplyText = (url: string) => `See all our openings and apply at ${url}`;

/** Plain-text version for the clipboard (pastes cleanly into email, docs, and job boards). */
export function jdToText(jd: JdContent, form?: JobForm): string {
  const tidy = tidyJd(jd);
  const parts = [form ? `${tidy.title}\n${jobMeta(form).join(' · ')}` : tidy.title, `${ABOUT_ROLE_HEADING}\n${tidy.summary}`];
  if (tidy.aboutCompany) parts.push(`${ABOUT_COMPANY_HEADING}\n${tidy.aboutCompany}`);
  for (const { field, heading } of JD_SECTIONS) {
    const items = tidy[field];
    if (items.length) parts.push(`${heading}\n${items.map((i) => `- ${i}`).join('\n')}`);
  }
  if (tidy.companyUrl) parts.push(`${COMPANY_LINK_HEADING}\n${companyLinkText(tidy.companyUrl)}`);
  if (tidy.careersUrl) parts.push(`${HOW_TO_APPLY_HEADING}\n${howToApplyText(tidy.careersUrl)}`);
  return parts.filter(Boolean).join('\n\n');
}
