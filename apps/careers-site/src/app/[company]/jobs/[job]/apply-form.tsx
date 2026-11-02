'use client';

import type { ApplicationReceipt } from '@hireflow/contracts';
import { useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PhoneVerify } from '@/components/phone-verify';
import { Button, Field, Spinner, describedBy, inputClass } from '@/components/ui';
import { CONTENT } from '@/content';
import { ApiError, submitApplication } from '@/lib/api';
import {
  buildApplicationFormData,
  checkResumeFile,
  emptyApplyDraft,
  fieldForPath,
  validateApplyDraft,
  type ApplyDraft,
  type ApplyErrors,
} from '@/lib/apply-form';
import { rememberPhoneProof } from '@/lib/phone-proof';

interface Props {
  companySlug: string;
  jobSlug: string;
}

const T = CONTENT.form;

/** M08 apply form. Plain inputs + one fetch per step: small bundle, works on slow phones. */
export function ApplyForm({ companySlug, jobSlug }: Props) {
  const [draft, setDraft] = useState<ApplyDraft>(emptyApplyDraft);
  const [errors, setErrors] = useState<ApplyErrors>({});
  const [resume, setResume] = useState<File | null>(null);
  const [otpToken, setOtpToken] = useState<string | null>(null);
  /** Bumped to reset the phone widget (e.g. when the server says the proof expired). */
  const [phoneKey, setPhoneKey] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const [formError, setFormError] = useState('');
  const [receipt, setReceipt] = useState<ApplicationReceipt | null>(null);
  /** HR closed the job after this page loaded: the API refused the application, so the form gives way to a notice. */
  const [jobClosed, setJobClosed] = useState(false);
  const submitted = useRef(false);

  const set = <K extends keyof ApplyDraft>(key: K, value: ApplyDraft[K]) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (submitted.current) {
      const r = validateApplyDraft(next, key === 'phone' ? null : otpToken);
      setErrors((prev) => ({ ...(r.ok ? {} : r.errors), resume: prev.resume }));
      if (r.ok) setFormError('');
    }
  };

  const showApiError = (err: unknown, fallbackField?: keyof ApplyErrors) => {
    if (err instanceof ApiError) {
      const fieldErrors: ApplyErrors = {};
      for (const issue of err.issues) {
        const f = fieldForPath(issue.path);
        if (f) fieldErrors[f] = issue.message;
      }
      if (Object.keys(fieldErrors).length) setErrors(fieldErrors);
      else if (fallbackField) setErrors((e) => ({ ...e, [fallbackField]: err.message }));
      else setFormError(err.message);
    } else {
      setFormError(T.errors.generic);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    submitted.current = true;
    setFormError('');
    const source = new URLSearchParams(window.location.search).get('src') ?? undefined;
    const result = validateApplyDraft(draft, otpToken, source);
    const resumeError = checkResumeFile(resume);
    const allErrors: ApplyErrors = { ...(result.ok ? {} : result.errors), ...(resumeError ? { resume: resumeError } : {}) };
    setErrors(allErrors);
    if (!result.ok || resumeError || !resume) {
      const first = Object.keys(allErrors)[0];
      if (first) document.getElementById(first)?.focus();
      setFormError(T.errors.fixFields);
      return;
    }

    setProgress(0);
    try {
      setReceipt(await submitApplication(buildApplicationFormData(companySlug, jobSlug, result.form, resume), setProgress));
      rememberPhoneProof({ companySlug, phone: result.form.phone, otpToken: result.form.otpToken });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PHONE_NOT_VERIFIED') {
        setOtpToken(null);
        setPhoneKey((k) => k + 1);
      }
      if (err instanceof ApiError && err.code === 'JOB_CLOSED') setJobClosed(true);
      else showApiError(err);
    } finally {
      setProgress(null);
    }
  };

  if (jobClosed) {
    return (
      <p role="status" className="rounded-md border border-border bg-accent-soft px-4 py-3 text-sm">
        {CONTENT.jobPage.closed}
      </p>
    );
  }

  if (receipt) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{T.success.title}</h2>
        <p>{T.success.body(receipt.jobTitle, receipt.companyName)}</p>
        <p className="text-sm text-muted">
          {T.success.id}: <span className="font-mono text-foreground">{receipt.applicationId}</span>
        </p>
        <p className="text-sm">{receipt.confirmationEmailSent ? T.success.emailSent(draft.email.trim()) : T.success.emailNotSent}</p>
        <p className="text-sm text-muted">{T.success.next}</p>
        <Link href={`/${encodeURIComponent(companySlug)}/my-data`} className="text-sm font-medium text-accent underline">
          {T.success.manage}
        </Link>
      </div>
    );
  }

  const busy = progress !== null;
  const text = (id: keyof ApplyDraft, label: string, opts: { required?: boolean; type?: string; hint?: ReactNode; autoComplete?: string; inputMode?: 'numeric' | 'decimal' | 'tel' | 'email' | 'url' } = {}) => (
    <Field id={id} label={label} required={opts.required ?? true} hint={opts.hint} error={errors[id]}>
      <input
        id={id}
        name={id}
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        autoComplete={opts.autoComplete}
        className={inputClass}
        value={draft[id] as string}
        aria-invalid={!!errors[id]}
        aria-describedby={describedBy(id, opts.hint, errors[id])}
        onChange={(ev) => set(id, ev.target.value as ApplyDraft[typeof id])}
        disabled={busy}
      />
    </Field>
  );
  const consent = (id: 'consentDataProcessing' | 'consentAiEvaluation' | 'consentRecordings', label: string, required: boolean) => (
    <div className="flex flex-col gap-1">
      <label className="flex items-start gap-2.5 text-sm">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
          checked={draft[id]}
          aria-invalid={!!errors[id]}
          aria-describedby={errors[id] ? `${id}-error` : undefined}
          onChange={(ev) => set(id, ev.target.checked)}
          disabled={busy}
        />
        <span>
          {label}
          {required && <span className="text-danger" aria-hidden="true"> *</span>}
        </span>
      </label>
      {errors[id] && (
        <p id={`${id}-error`} className="pl-6.5 text-xs font-medium text-danger">
          {errors[id]}
        </p>
      )}
    </div>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-6" aria-labelledby="apply-heading">
      <div>
        <h2 id="apply-heading" className="text-xl font-semibold">
          {T.heading}
        </h2>
        <p className="mt-1 text-sm text-muted">{T.intro}</p>
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{T.sections.you}</legend>
        {text('name', T.labels.name, { autoComplete: 'name' })}
        {text('email', T.labels.email, { type: 'email', inputMode: 'email', autoComplete: 'email' })}

        <PhoneVerify
          key={phoneKey}
          companySlug={companySlug}
          phone={draft.phone}
          onPhoneChange={(v) => set('phone', v)}
          onVerified={(token) => {
            setOtpToken(token);
            if (token) setErrors((e) => ({ ...e, phone: undefined }));
          }}
          error={errors.phone}
          disabled={busy}
        />

        {text('city', T.labels.city, { autoComplete: 'address-level2' })}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{T.sections.education}</legend>
        {text('college', T.labels.college)}
        <div className="grid gap-4 sm:grid-cols-2">
          {text('degree', T.labels.degree, { hint: T.hints.degree })}
          {text('branch', T.labels.branch)}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {text('graduationYear', T.labels.graduationYear, { inputMode: 'numeric' })}
          <Field id="scoreType" label={T.labels.scoreType} required>
            <select
              id="scoreType"
              className={inputClass}
              value={draft.scoreType}
              onChange={(ev) => set('scoreType', ev.target.value as ApplyDraft['scoreType'])}
              disabled={busy}
            >
              <option value="CGPA">CGPA (out of 10)</option>
              <option value="PERCENTAGE">Percentage</option>
            </select>
          </Field>
          {text('scoreValue', T.labels.scoreValue, { inputMode: 'decimal' })}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{T.sections.links}</legend>
        {text('linkedinUrl', T.labels.linkedinUrl, { required: false, type: 'url', inputMode: 'url' })}
        {text('githubUrl', T.labels.githubUrl, { required: false, type: 'url', inputMode: 'url' })}
        {text('portfolioUrl', T.labels.portfolioUrl, { required: false, type: 'url', inputMode: 'url' })}
        {text('projectUrl', T.labels.projectUrl, { required: false, type: 'url', inputMode: 'url', hint: T.hints.projectUrl })}
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{T.sections.resume}</legend>
        <Field id="resume" label={T.labels.resume} required hint={T.hints.resume} error={errors.resume}>
          <input
            id="resume"
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-2 file:text-sm file:font-medium"
            aria-invalid={!!errors.resume}
            aria-describedby={describedBy('resume', T.hints.resume, errors.resume)}
            onChange={(ev) => {
              const f = ev.target.files?.[0] ?? null;
              setResume(f);
              setErrors((e) => ({ ...e, resume: f ? checkResumeFile(f) : undefined }));
            }}
            disabled={busy}
          />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted">{T.sections.consent}</legend>
        {consent('consentDataProcessing', T.consent.dataProcessing, true)}
        {consent('consentAiEvaluation', T.consent.aiEvaluation, true)}
        {consent('consentRecordings', T.consent.recordings, false)}
        <p className="text-xs text-muted">{T.consent.policy}</p>
      </fieldset>

      {formError && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          {formError}
        </p>
      )}

      <Button type="submit" variant="primary" className="w-full py-3 text-base" disabled={busy}>
        {busy && <Spinner />}
        {busy ? T.uploading(progress ?? 0) : T.submit}
      </Button>
      {busy && <progress className="h-1.5 w-full" max={100} value={progress ?? 0} aria-label="Upload progress" />}
    </form>
  );
}
