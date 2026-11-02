'use client';

import type { FormEvent } from 'react';
import {
  COMPANY_PROFILE_LIMITS as L,
  COMPANY_SIZES,
  type CompanyDraft,
  type CompanyErrors,
  type CompanyField,
} from '@/lib/company-form';
import { TagInput } from './tag-input';
import { Button, Field, Spinner, describedBy, inputClass } from './ui';

interface Props {
  draft: CompanyDraft;
  errors: CompanyErrors;
  saving: boolean;
  isNew: boolean;
  onChange: (draft: CompanyDraft) => void;
  onSubmit: () => void;
  /** overrides the default "Save company profile" / "Save changes" */
  submitLabel?: string;
}

export function CompanyProfileForm({ draft, errors, saving, isNew, onChange, onSubmit, submitLabel }: Props) {
  const set = <K extends CompanyField>(key: K, value: CompanyDraft[K]) => onChange({ ...draft, [key]: value });
  const aria = (id: CompanyField, hint?: string) => ({
    'aria-invalid': errors[id] ? true : undefined,
    'aria-describedby': describedBy(id, hint, errors[id]),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form noValidate onSubmit={submit} aria-labelledby="company-form-heading" className="flex flex-col gap-6">
      <div>
        <h2 id="company-form-heading" className="text-lg font-semibold">
          Company details
        </h2>
        <p className="mt-1 text-sm text-muted">
          The AI describes your company only with what you write here. Keep it factual — it appears in every job description.
        </p>
      </div>

      <fieldset disabled={saving} className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="name" label="Company name" required error={errors.name}>
            <input
              id="name"
              className={inputClass}
              value={draft.name}
              maxLength={L.nameMax}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Acme Analytics"
              autoComplete="organization"
              {...aria('name')}
            />
          </Field>
          <Field id="industry" label="Industry" required error={errors.industry}>
            <input
              id="industry"
              className={inputClass}
              value={draft.industry}
              maxLength={L.industryMax}
              onChange={(e) => set('industry', e.target.value)}
              placeholder="e.g. B2B SaaS, Fintech, Healthcare"
              {...aria('industry')}
            />
          </Field>
        </div>

        <Field
          id="description"
          label="Company description"
          required
          hint={`What the company does and for whom. ${draft.description.length}/${L.descriptionMax}`}
          error={errors.description}
        >
          <textarea
            id="description"
            rows={5}
            className={inputClass}
            value={draft.description}
            maxLength={L.descriptionMax}
            onChange={(e) => set('description', e.target.value)}
            placeholder="e.g. Acme builds analytics dashboards that help mid-sized retailers in India plan inventory."
            {...aria('description', 'hint')}
          />
        </Field>

        <Field id="productsServices" label="Products or services" error={errors.productsServices}>
          <textarea
            id="productsServices"
            rows={3}
            className={inputClass}
            value={draft.productsServices}
            maxLength={L.productsMax}
            onChange={(e) => set('productsServices', e.target.value)}
            placeholder="e.g. Acme Insights (retail analytics platform), Acme Forecast (demand planning API)"
            {...aria('productsServices')}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="website" label="Website" error={errors.website}>
            <input
              id="website"
              type="url"
              inputMode="url"
              className={inputClass}
              value={draft.website}
              maxLength={L.websiteMax}
              onChange={(e) => set('website', e.target.value)}
              placeholder="https://example.com"
              autoComplete="url"
              {...aria('website')}
            />
          </Field>
          <Field id="careersUrl" label="Careers page link" hint="Where candidates can see all your openings." error={errors.careersUrl}>
            <input
              id="careersUrl"
              type="url"
              inputMode="url"
              className={inputClass}
              value={draft.careersUrl}
              maxLength={L.websiteMax}
              onChange={(e) => set('careersUrl', e.target.value)}
              placeholder="https://example.com/careers"
              {...aria('careersUrl', 'Where candidates can see all your openings.')}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="headquarters" label="Headquarters" error={errors.headquarters}>
            <input
              id="headquarters"
              className={inputClass}
              value={draft.headquarters}
              maxLength={L.headquartersMax}
              onChange={(e) => set('headquarters', e.target.value)}
              placeholder="e.g. Ahmedabad, India"
              {...aria('headquarters')}
            />
          </Field>
          <Field id="companySize" label="Company size (employees)" error={errors.companySize}>
            <select
              id="companySize"
              className={inputClass}
              value={draft.companySize}
              onChange={(e) => set('companySize', e.target.value as CompanyDraft['companySize'])}
              {...aria('companySize')}
            >
              <option value="">Not specified</option>
              {COMPANY_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field id="foundedYear" label="Founded in" error={errors.foundedYear}>
            <input
              id="foundedYear"
              type="number"
              inputMode="numeric"
              min={1800}
              max={2100}
              step={1}
              className={inputClass}
              value={draft.foundedYear}
              onChange={(e) => set('foundedYear', e.target.value)}
              placeholder="e.g. 2018"
              {...aria('foundedYear')}
            />
          </Field>
        </div>

        <Field
          id="culture"
          label="Culture and values"
          hint="How the team works, e.g. small autonomous teams, flexible hours."
          error={errors.culture}
        >
          <textarea
            id="culture"
            rows={3}
            className={inputClass}
            value={draft.culture}
            maxLength={L.cultureMax}
            onChange={(e) => set('culture', e.target.value)}
            {...aria('culture', 'hint')}
          />
        </Field>

        <Field
          id="benefits"
          label="Benefits and perks"
          hint="Press Enter or comma after each one. Only these appear as company benefits in a JD."
          error={errors.benefits}
        >
          <TagInput
            id="benefits"
            values={draft.benefits}
            onChange={(v) => set('benefits', v)}
            placeholder="e.g. Health insurance"
            maxItems={L.benefitsMax}
            maxLength={L.benefitMax}
            invalid={!!errors.benefits}
            describedBy={describedBy('benefits', true, errors.benefits)}
          />
        </Field>
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={saving} aria-busy={saving}>
          {saving && <Spinner />}
          {saving ? 'Saving…' : (submitLabel ?? (isNew ? 'Save company profile' : 'Save changes'))}
        </Button>
        {Object.keys(errors).length > 0 && (
          <p className="text-sm text-danger" role="alert">
            Fix the highlighted fields to continue.
          </p>
        )}
      </div>
    </form>
  );
}
