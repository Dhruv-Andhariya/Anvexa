import {
  COMPANY_PROFILE_LIMITS,
  COMPANY_SIZES,
  companyProfileSchema,
  type CompanyProfile,
} from '@hireflow/contracts';

export { COMPANY_PROFILE_LIMITS, COMPANY_SIZES };

/** What the profile inputs hold (numbers stay strings until submit so inputs can be empty). */
export interface CompanyDraft {
  name: string;
  industry: string;
  description: string;
  productsServices: string;
  website: string;
  careersUrl: string;
  headquarters: string;
  companySize: CompanyProfile['companySize'] | '';
  foundedYear: string;
  culture: string;
  benefits: string[];
}

export type CompanyField = keyof CompanyDraft;
export type CompanyErrors = Partial<Record<CompanyField, string>>;

export const emptyCompanyDraft = (): CompanyDraft => ({
  name: '',
  industry: '',
  description: '',
  productsServices: '',
  website: '',
  careersUrl: '',
  headquarters: '',
  companySize: '',
  foundedYear: '',
  culture: '',
  benefits: [],
});

export const profileToDraft = (p: CompanyProfile): CompanyDraft => ({
  name: p.name,
  industry: p.industry,
  description: p.description,
  productsServices: p.productsServices ?? '',
  website: p.website ?? '',
  careersUrl: p.careersUrl ?? '',
  headquarters: p.headquarters ?? '',
  companySize: p.companySize ?? '',
  foundedYear: p.foundedYear === undefined ? '' : String(p.foundedYear),
  culture: p.culture ?? '',
  benefits: [...p.benefits],
});

const text = (v: string) => (v.trim() === '' ? undefined : v);

/** "acme.com" -> "https://acme.com", so HR does not have to type the scheme. */
export const normalizeWebsite = (v: string) => {
  const t = v.trim();
  if (!t) return undefined;
  return /^[a-z][a-z\d+.-]*:\/\//i.test(t) ? t : `https://${t}`;
};

export function draftToProfileInput(d: CompanyDraft): Record<string, unknown> {
  return {
    name: d.name,
    industry: d.industry,
    description: d.description,
    productsServices: text(d.productsServices),
    website: normalizeWebsite(d.website),
    careersUrl: normalizeWebsite(d.careersUrl),
    headquarters: text(d.headquarters),
    companySize: d.companySize || undefined,
    foundedYear: d.foundedYear.trim() === '' ? undefined : Number(d.foundedYear),
    culture: text(d.culture),
    benefits: d.benefits,
  };
}

export type CompanyValidation = { ok: true; profile: CompanyProfile } | { ok: false; errors: CompanyErrors };

/** Validation is done by the SHARED contract schema, so the browser and the API never disagree. */
export function validateCompanyDraft(d: CompanyDraft): CompanyValidation {
  const parsed = companyProfileSchema.safeParse(draftToProfileInput(d));
  if (parsed.success) return { ok: true, profile: parsed.data };
  const errors: CompanyErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as CompanyField | undefined;
    if (field && !errors[field]) errors[field] = friendly(field, issue);
  }
  return { ok: false, errors };
}

/** Parse a stored JD company snapshot; a missing or malformed one becomes null instead of crashing the page. */
export function readSnapshot(raw: Record<string, unknown> | null): CompanyProfile | null {
  const parsed = raw ? companyProfileSchema.safeParse(raw) : null;
  return parsed?.success ? parsed.data : null;
}

const PROFILE_KEYS = Object.keys(companyProfileSchema.shape);

/** True when two profiles hold the same facts (ignores id/updatedAt and key order). */
export function sameCompany(a: CompanyProfile, b: CompanyProfile): boolean {
  const norm = (p: CompanyProfile) => JSON.stringify(companyProfileSchema.parse(p), PROFILE_KEYS);
  return norm(a) === norm(b);
}

type Issue =NonNullable<ReturnType<typeof companyProfileSchema.safeParse>['error']>['issues'][number];

function friendly(field: CompanyField, issue: Issue): string {
  if (field === 'website') return 'Enter a valid website, e.g. https://example.com';
  if (field === 'careersUrl') return 'Enter a valid link, e.g. https://example.com/careers';
  if (field === 'foundedYear') return 'Enter a year between 1800 and 2100.';
  if (field === 'companySize') return 'Choose an option.';
  const isListItem = issue.path.length > 1;
  switch (issue.code) {
    case 'invalid_type':
      return 'This field is required.';
    case 'too_small':
      if (isListItem) return 'Entries cannot be blank.';
      return field === 'description'
        ? `Describe the company in at least ${issue.minimum} characters.`
        : `Enter at least ${issue.minimum} characters.`;
    case 'too_big':
      if (issue.type === 'array') return `Add at most ${issue.maximum} items.`;
      return `Keep this under ${issue.maximum} characters${isListItem ? ' per entry' : ''}.`;
    default:
      return issue.message;
  }
}
