'use client';

import type { CompanyProfileRecord } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CompanyFacts } from '@/components/company-card';
import { JobFormPanel } from '@/components/job-form-panel';
import { ScreeningScoreField } from '@/components/screening-score-field';
import { isCompanyAdmin, useSession } from '@/components/session';
import { Button, Card, ErrorNotice, Spinner } from '@/components/ui';
import { ApiError, createJob, getCompanyProfile } from '@/lib/api';
import { parseMinAtsScore } from '@/lib/ats-api';
import { emptyDraft, validateDraft, type FieldErrors, type JobFormDraft } from '@/lib/job-form';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

type Profile = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; profile: CompanyProfileRecord | null };

/** Step 2: HR enters the job requirements. The saved company profile is loaded automatically. */
export function NewJob() {
  const router = useRouter();
  const { session } = useSession();
  const [company, setCompany] = useState<Profile>({ kind: 'loading' });
  const [draft, setDraft] = useState<JobFormDraft>(emptyDraft);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  // M11: private minimum ATS score, saved apart from the (public) job form.
  const [minAts, setMinAts] = useState('');
  const [minAtsError, setMinAtsError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    setCompany({ kind: 'loading' });
    try {
      setCompany({ kind: 'ready', profile: await getCompanyProfile({ signal }) });
    } catch (err) {
      if (!signal?.aborted) setCompany({ kind: 'error', message: message(err) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const onDraftChange = (next: JobFormDraft) => {
    setDraft(next);
    if (Object.keys(errors).length) {
      // re-validate live once the user has tried to submit, so fixed fields clear immediately
      const result = validateDraft(next);
      setErrors(result.ok ? {} : result.errors);
    }
  };

  const onSubmit = async () => {
    const result = validateDraft(draft);
    const ats = parseMinAtsScore(minAts);
    setMinAtsError(ats.ok ? '' : ats.error);
    if (!result.ok) {
      setErrors(result.errors);
      const first = Object.keys(result.errors)[0];
      if (first) (document.getElementById(first) ?? document.querySelector<HTMLElement>(`[name="${first}"]`))?.focus();
      return;
    }
    setErrors({});
    if (!ats.ok) {
      document.getElementById('minAtsScore')?.focus();
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const job = await createJob(result.form, {}, ats.value);
      // the review page runs step 3 (generation) so loading, errors and retry live in one place
      router.push(`/jobs/${job.id}?generate=1`);
    } catch (err) {
      setSaveError(message(err));
      setSaving(false);
    }
  };

  if (company.kind === 'loading') {
    return (
      <Card className="flex min-h-64 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading your company profile…
      </Card>
    );
  }
  if (company.kind === 'error') {
    return (
      <ErrorNotice
        title="Could not load your company profile"
        message={company.message}
        action={<Button onClick={() => load()}>Try again</Button>}
      />
    );
  }
  if (!company.profile) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm font-medium text-muted">Step 1 of 4 is missing</p>
        <h2 className="text-lg font-semibold">Save your company profile first</h2>
        <p className="max-w-xl text-sm text-muted">
          The AI needs your company details to describe the company accurately in the job description. You only do this once.
        </p>
        {isCompanyAdmin(session) ? (
          <Link
            href="/company?next=/jobs/new"
            className="inline-flex items-center rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            Create company profile
          </Link>
        ) : (
          <p className="text-sm text-muted">Ask your Company Admin to save the company profile.</p>
        )}
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
      <Card>
        <JobFormPanel
          draft={draft}
          errors={errors}
          loading={saving}
          onChange={onDraftChange}
          onSubmit={onSubmit}
          submitLabel="Save job & generate JD"
          busyLabel="Saving job…"
          extraFields={
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <legend className="px-1 text-sm font-semibold">Resume screening (private)</legend>
              <ScreeningScoreField
                value={minAts}
                error={minAtsError}
                onChange={(v) => {
                  setMinAts(v);
                  if (minAtsError) {
                    const r = parseMinAtsScore(v);
                    setMinAtsError(r.ok ? '' : r.error);
                  }
                }}
              />
            </fieldset>
          }
        />
        {saveError && (
          <div className="mt-5">
            <ErrorNotice title="Could not save the job" message={saveError} />
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-4 lg:sticky lg:top-6">
        <div>
          <h2 className="text-base font-semibold">Company profile</h2>
          <p className="mt-1 text-sm text-muted">Loaded automatically. The AI uses it for the “About the Company” section.</p>
        </div>
        <CompanyFacts profile={company.profile} />
        {isCompanyAdmin(session) && (
          <Link href="/company?next=/jobs/new" className="text-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
            Edit company profile
          </Link>
        )}
      </Card>
    </div>
  );
}
