import { JOB_FORM_LIMITS, jobFormSchema, type JobForm } from '@hireflow/contracts';

type ZodIssue = NonNullable<ReturnType<typeof jobFormSchema.safeParse>['error']>['issues'][number];

export type WorkMode = JobForm['workMode'];
export type EmploymentType = JobForm['employmentType'];
export type SalaryType = JobForm['salaryType'];

export const WORK_MODES: { value: WorkMode; label: string }[] = [
  { value: 'ONSITE', label: 'On-site' },
  { value: 'HYBRID', label: 'Hybrid' },
  { value: 'REMOTE', label: 'Remote' },
];

export const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: 'FULL_TIME', label: 'Full-time' },
  { value: 'PART_TIME', label: 'Part-time' },
  { value: 'INTERNSHIP', label: 'Internship' },
  { value: 'CONTRACT', label: 'Contract' },
];

export { JOB_FORM_LIMITS };

/** What the form inputs hold (numbers stay strings until submit so inputs can be empty). */
export interface JobFormDraft {
  title: string;
  department: string;
  experienceMin: string;
  experienceMax: string;
  mustHaveSkills: string[];
  niceToHaveSkills: string[];
  locations: string[];
  workMode: WorkMode | '';
  employmentType: EmploymentType | '';
  salaryMin: string;
  salaryMax: string;
  currency: string;
  salaryType: SalaryType;
  openings: string;
  shortDescription: string;
  /** Last date to apply as YYYY-MM-DD (what <input type="date"> holds); '' = no deadline. */
  deadline: string;
  /** The saved deadline (ISO), sent back unchanged while the date above is untouched, so a re-save never moves it. */
  savedDeadline?: string;
}

export type DraftField = keyof JobFormDraft;
export type FieldErrors = Partial<Record<DraftField, string>>;

export const emptyDraft = (): JobFormDraft => ({
  title: '',
  department: '',
  experienceMin: '',
  experienceMax: '',
  mustHaveSkills: [],
  niceToHaveSkills: [],
  locations: [],
  workMode: '',
  employmentType: '',
  salaryMin: '',
  salaryMax: '',
  currency: 'INR',
  salaryType: 'CTC',
  openings: '1',
  shortDescription: '',
  deadline: '',
});

/** A saved JobForm back into editable inputs (used to change the requirements of an existing job). */
export const formToDraft = (f: JobForm): JobFormDraft => {
  const str = (v: number | undefined) => (v === undefined ? '' : String(v));
  return {
    title: f.title,
    department: f.department ?? '',
    experienceMin: String(f.experienceMin),
    experienceMax: String(f.experienceMax),
    mustHaveSkills: [...f.mustHaveSkills],
    niceToHaveSkills: [...f.niceToHaveSkills],
    locations: [...f.locations],
    workMode: f.workMode,
    employmentType: f.employmentType,
    salaryMin: str(f.salaryMin),
    salaryMax: str(f.salaryMax),
    currency: f.currency,
    salaryType: f.salaryType,
    openings: String(f.openings),
    shortDescription: f.shortDescription ?? '',
    deadline: f.deadline ? localDate(f.deadline) : '',
    ...(f.deadline ? { savedDeadline: f.deadline } : {}),
  };
};

/** ISO timestamp -> YYYY-MM-DD in the browser's time zone. */
function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The picked date -> the contract's ISO datetime: the end of that day in HR's time zone. */
function deadlineInput(d: JobFormDraft): string | undefined {
  if (!d.deadline) return undefined;
  if (d.savedDeadline && localDate(d.savedDeadline) === d.deadline) return d.savedDeadline;
  const end = new Date(`${d.deadline}T23:59:59`);
  return Number.isNaN(end.getTime()) ? d.deadline : end.toISOString(); // an invalid date fails the schema
}

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
const text = (v: string): string | undefined => (v.trim() === '' ? undefined : v);

/** Draft -> candidate JobForm input. Validation itself is done by the SHARED contract schema. */
export function draftToInput(d: JobFormDraft): Record<string, unknown> {
  return {
    title: d.title,
    department: text(d.department),
    experienceMin: num(d.experienceMin),
    experienceMax: num(d.experienceMax),
    mustHaveSkills: d.mustHaveSkills,
    niceToHaveSkills: d.niceToHaveSkills,
    locations: d.locations,
    workMode: d.workMode || undefined,
    employmentType: d.employmentType || undefined,
    salaryMin: num(d.salaryMin),
    salaryMax: num(d.salaryMax),
    currency: d.currency,
    salaryType: d.salaryType,
    openings: num(d.openings),
    shortDescription: text(d.shortDescription),
    deadline: deadlineInput(d),
  };
}

export type DraftValidation = { ok: true; form: JobForm } | { ok: false; errors: FieldErrors };

export function validateDraft(d: JobFormDraft): DraftValidation {
  const parsed = jobFormSchema.safeParse(draftToInput(d));
  if (parsed.success) return { ok: true, form: parsed.data };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as DraftField | undefined;
    if (field && !errors[field]) errors[field] = friendlyMessage(field, issue);
  }
  return { ok: false, errors };
}

const LIST_NOUN: Partial<Record<DraftField, string>> = {
  mustHaveSkills: 'must-have skill',
  niceToHaveSkills: 'nice-to-have skill',
  locations: 'location',
};

const CHOICE_FIELDS = new Set<DraftField>(['workMode', 'employmentType', 'salaryType']);

function friendlyMessage(field: DraftField, issue: ZodIssue): string {
  if (field === 'experienceMax' && issue.code === 'custom') return 'Maximum must be at least the minimum.';
  if (field === 'salaryMax' && issue.code === 'custom') return 'Maximum salary must be at least the minimum.';
  if (field === 'deadline') return 'Enter a valid date.';
  const isListItem = issue.path.length > 1;
  if (CHOICE_FIELDS.has(field)) return 'Choose an option.';
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' ? 'This field is required.' : 'Enter a valid number.';
    case 'invalid_enum_value':
      return 'Choose an option.';
    case 'too_small':
      if (issue.type === 'array') {
        if (issue.message.startsWith('Add at least')) return `${issue.message}.`;
        return `Add at least ${issue.minimum} ${LIST_NOUN[field] ?? 'item'}${Number(issue.minimum) > 1 ? 's' : ''}.`;
      }
      if (issue.type === 'string') {
        return isListItem ? 'Entries cannot be blank.' : `Enter at least ${issue.minimum} characters.`;
      }
      return issue.inclusive && issue.minimum === 0 ? 'Cannot be negative.' : `Must be at least ${issue.minimum}.`;
    case 'too_big':
      if (issue.type === 'array') return `Add at most ${issue.maximum} ${LIST_NOUN[field] ?? 'item'}s.`;
      if (issue.type === 'string') return `Keep this under ${issue.maximum} characters${isListItem ? ' per entry' : ''}.`;
      return `Must be at most ${issue.maximum}.`;
    default:
      return issue.message;
  }
}
