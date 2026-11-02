'use client';

import type { FormEvent, ReactNode } from 'react';
import {
  EMPLOYMENT_TYPES,
  JOB_FORM_LIMITS as L,
  WORK_MODES,
  type DraftField,
  type FieldErrors,
  type JobFormDraft,
} from '@/lib/job-form';
import { TagInput } from './tag-input';
import { Button, Field, Spinner, describedBy, inputClass } from './ui';

interface Props {
  draft: JobFormDraft;
  errors: FieldErrors;
  loading: boolean;
  onChange: (draft: JobFormDraft) => void;
  onSubmit: () => void;
  submitLabel?: string;
  busyLabel?: string;
  /** Extra buttons next to submit (e.g. Cancel). */
  actions?: ReactNode;
  /** Extra fields shown before the submit button (e.g. the private minimum ATS score on a new job). */
  extraFields?: ReactNode;
}

export function JobFormPanel({
  draft,
  errors,
  loading,
  onChange,
  onSubmit,
  submitLabel = 'Generate Job Description',
  busyLabel = 'Generating…',
  actions,
  extraFields,
}: Props) {
  const set = <K extends DraftField>(key: K, value: JobFormDraft[K]) => onChange({ ...draft, [key]: value });
  const aria = (id: DraftField, hint?: string) => ({
    'aria-invalid': errors[id] ? true : undefined,
    'aria-describedby': describedBy(id, hint, errors[id]),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  const skillsHint = 'Press Enter or comma after each skill.';

  return (
    <form noValidate onSubmit={submit} aria-labelledby="job-form-heading" className="flex flex-col gap-6">
      <div>
        <h2 id="job-form-heading" className="text-lg font-semibold">
          Job requirements
        </h2>
        <p className="mt-1 text-sm text-muted">
          The AI writes the role only from what you enter here, and the company part only from your saved company
          profile — it will not invent details or benefits.
        </p>
      </div>

      <fieldset disabled={loading} className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="title" label="Job title" required error={errors.title}>
            <input
              id="title"
              className={inputClass}
              value={draft.title}
              maxLength={L.titleMax}
              onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Junior Backend Developer"
              autoComplete="off"
              {...aria('title')}
            />
          </Field>
          <Field id="department" label="Department" error={errors.department}>
            <input
              id="department"
              className={inputClass}
              value={draft.department}
              maxLength={L.departmentMax}
              onChange={(e) => set('department', e.target.value)}
              placeholder="e.g. Engineering"
              {...aria('department')}
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            Required experience (years) <span className="text-danger" aria-hidden="true">*</span>
          </legend>
          <div className="grid grid-cols-2 gap-3">
            <Field id="experienceMin" label="Minimum" required error={errors.experienceMin}>
              <input
                id="experienceMin"
                type="number"
                inputMode="decimal"
                min={0}
                max={L.experienceMax}
                step={0.5}
                className={inputClass}
                value={draft.experienceMin}
                onChange={(e) => set('experienceMin', e.target.value)}
                {...aria('experienceMin')}
              />
            </Field>
            <Field id="experienceMax" label="Maximum" required error={errors.experienceMax}>
              <input
                id="experienceMax"
                type="number"
                inputMode="decimal"
                min={0}
                max={L.experienceMax}
                step={0.5}
                className={inputClass}
                value={draft.experienceMax}
                onChange={(e) => set('experienceMax', e.target.value)}
                {...aria('experienceMax')}
              />
            </Field>
          </div>
        </fieldset>

        <Field id="mustHaveSkills" label="Must-have skills" required hint={`${skillsHint} At least 3.`} error={errors.mustHaveSkills}>
          <TagInput
            id="mustHaveSkills"
            values={draft.mustHaveSkills}
            onChange={(v) => set('mustHaveSkills', v)}
            placeholder="e.g. Python"
            maxItems={L.skillsMax}
            maxLength={L.skillMax}
            invalid={!!errors.mustHaveSkills}
            describedBy={describedBy('mustHaveSkills', true, errors.mustHaveSkills)}
          />
        </Field>

        <Field id="niceToHaveSkills" label="Nice-to-have skills" hint={skillsHint} error={errors.niceToHaveSkills}>
          <TagInput
            id="niceToHaveSkills"
            values={draft.niceToHaveSkills}
            onChange={(v) => set('niceToHaveSkills', v)}
            placeholder="e.g. Docker"
            maxItems={L.skillsMax}
            maxLength={L.skillMax}
            invalid={!!errors.niceToHaveSkills}
            describedBy={describedBy('niceToHaveSkills', true, errors.niceToHaveSkills)}
          />
        </Field>

        <Field id="locations" label="Job location" required hint="Add one or more cities." error={errors.locations}>
          <TagInput
            id="locations"
            values={draft.locations}
            onChange={(v) => set('locations', v)}
            placeholder="e.g. Ahmedabad"
            maxItems={L.locationsMax}
            maxLength={L.locationMax}
            invalid={!!errors.locations}
            describedBy={describedBy('locations', true, errors.locations)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <fieldset aria-describedby={errors.workMode ? 'workMode-error' : undefined}>
            <legend className="mb-1.5 text-sm font-medium">
              Work mode <span className="text-danger" aria-hidden="true">*</span>
            </legend>
            <div className="grid grid-cols-3 gap-1 rounded-md border border-border bg-surface p-1">
              {WORK_MODES.map((m) => (
                <label
                  key={m.value}
                  className="cursor-pointer rounded px-2 py-1.5 text-center text-sm has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-2 has-focus-visible:ring-accent/50"
                >
                  <input
                    type="radio"
                    name="workMode"
                    value={m.value}
                    checked={draft.workMode === m.value}
                    onChange={() => set('workMode', m.value)}
                    className="sr-only"
                  />
                  {m.label}
                </label>
              ))}
            </div>
            {errors.workMode && (
              <p id="workMode-error" className="mt-1.5 text-xs font-medium text-danger">
                {errors.workMode}
              </p>
            )}
          </fieldset>

          <Field id="employmentType" label="Employment type" required error={errors.employmentType}>
            <select
              id="employmentType"
              className={inputClass}
              value={draft.employmentType}
              onChange={(e) => set('employmentType', e.target.value as JobFormDraft['employmentType'])}
              {...aria('employmentType')}
            >
              <option value="">Select…</option>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">
            Salary range <span className="font-normal text-muted">(optional)</span>
          </legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field id="salaryMin" label="Minimum" error={errors.salaryMin}>
              <input
                id="salaryMin"
                type="number"
                inputMode="numeric"
                min={0}
                className={inputClass}
                value={draft.salaryMin}
                onChange={(e) => set('salaryMin', e.target.value)}
                {...aria('salaryMin')}
              />
            </Field>
            <Field id="salaryMax" label="Maximum" error={errors.salaryMax}>
              <input
                id="salaryMax"
                type="number"
                inputMode="numeric"
                min={0}
                className={inputClass}
                value={draft.salaryMax}
                onChange={(e) => set('salaryMax', e.target.value)}
                {...aria('salaryMax')}
              />
            </Field>
            <Field id="currency" label="Currency" error={errors.currency}>
              <select
                id="currency"
                className={inputClass}
                value={draft.currency}
                onChange={(e) => set('currency', e.target.value)}
              >
                {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field id="salaryType" label="Type" error={errors.salaryType}>
              <select
                id="salaryType"
                className={inputClass}
                value={draft.salaryType}
                onChange={(e) => set('salaryType', e.target.value as JobFormDraft['salaryType'])}
              >
                <option value="CTC">CTC</option>
                <option value="IN_HAND">In-hand</option>
              </select>
            </Field>
          </div>
          <p className="text-xs text-muted">Leave empty to keep salary out of the job description.</p>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="openings" label="Number of openings" required error={errors.openings}>
            <input
              id="openings"
              type="number"
              inputMode="numeric"
              min={1}
              max={L.openingsMax}
              step={1}
              className={inputClass}
              value={draft.openings}
              onChange={(e) => set('openings', e.target.value)}
              {...aria('openings')}
            />
          </Field>
          <Field id="deadline" label="Last date to apply" hint="Applications close at the end of this day." error={errors.deadline}>
            <input
              id="deadline"
              type="date"
              className={inputClass}
              value={draft.deadline}
              onChange={(e) => set('deadline', e.target.value)}
              {...aria('deadline', 'hint')}
            />
          </Field>
        </div>

        <Field
          id="shortDescription"
          label="Additional requirements"
          hint={`Anything else the JD should reflect, e.g. domain, team, or tools. ${draft.shortDescription.length}/${L.shortDescriptionMax}`}
          error={errors.shortDescription}
        >
          <textarea
            id="shortDescription"
            rows={4}
            className={inputClass}
            value={draft.shortDescription}
            maxLength={L.shortDescriptionMax}
            onChange={(e) => set('shortDescription', e.target.value)}
            {...aria('shortDescription', 'hint')}
          />
        </Field>
      </fieldset>

      {extraFields}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={loading} aria-busy={loading}>
          {loading && <Spinner />}
          {loading ? busyLabel : submitLabel}
        </Button>
        {actions}
        {Object.keys(errors).length > 0 && (
          <p className="text-sm text-danger" role="alert">
            Fix the highlighted fields to continue.
          </p>
        )}
      </div>
    </form>
  );
}
