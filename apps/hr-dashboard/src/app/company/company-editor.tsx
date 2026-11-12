'use client';

import type { CompanyProfileRecord } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CompanyFacts } from '@/components/company-card';
import { CompanyProfileForm } from '@/components/company-profile-form';
import { isCompanyAdmin, useSession } from '@/components/session';
import { Button, Card, ErrorNotice, Spinner } from '@/components/ui';
import { ApiError, getCompanyProfile, saveCompanyProfile } from '@/lib/api';
import {
  emptyCompanyDraft,
  profileToDraft,
  validateCompanyDraft,
  type CompanyDraft,
  type CompanyErrors,
} from '@/lib/company-form';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Step 1: the Company Admin saves the company profile once. `next` is where to continue afterwards (e.g. /jobs/new). */
export function CompanyEditor({ next }: { next?: string }) {
  const router = useRouter();
  const { session } = useSession();
  const canEdit = isCompanyAdmin(session);
  const [saved, setSaved] = useState<CompanyProfileRecord | null>(null);
  const [draft, setDraft] = useState<CompanyDraft>(emptyCompanyDraft);
  const [errors, setErrors] = useState<CompanyErrors>({});
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const profile = await getCompanyProfile({ signal });
      setSaved(profile);
      if (profile) setDraft(profileToDraft(profile));
      setLoadState('ready');
    } catch (err) {
      if (signal?.aborted) return;
      setLoadError(message(err));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const onChange = (d: CompanyDraft) => {
    setDraft(d);
    setJustSaved(false);
    if (Object.keys(errors).length) {
      const result = validateCompanyDraft(d);
      setErrors(result.ok ? {} : result.errors);
    }
  };

  const onSubmit = async () => {
    const result = validateCompanyDraft(draft);
    if (!result.ok) {
      setErrors(result.errors);
      document.getElementById(Object.keys(result.errors)[0]!)?.focus();
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveError('');
    try {
      const profile = await saveCompanyProfile(result.profile);
      setSaved(profile);
      setDraft(profileToDraft(profile));
      setJustSaved(true);
      if (next) router.push(next);
    } catch (err) {
      setSaveError(message(err));
    } finally {
      setSaving(false);
    }
  };

  if (loadState === 'loading') {
    return (
      <Card className="flex min-h-64 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading company profile…
      </Card>
    );
  }
  if (loadState === 'error') {
    return (
      <ErrorNotice
        title="Could not load the company profile"
        message={loadError}
        action={<Button onClick={() => load()}>Try again</Button>}
      />
    );
  }

  if (!canEdit) {
    // HR Members use the saved profile but cannot change it (the API enforces this too)
    return (
      <Card className="flex flex-col gap-3">
        {saved ? (
          <CompanyFacts profile={saved} />
        ) : (
          <p className="text-sm text-muted">No company profile has been saved yet.</p>
        )}
        <p className="text-sm text-muted">Only your Company Admin can change the company profile.</p>
      </Card>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
      <Card>
        <CompanyProfileForm
          draft={draft}
          errors={errors}
          saving={saving}
          isNew={!saved}
          onChange={onChange}
          onSubmit={onSubmit}
        />
        {saveError && (
          <div className="mt-5">
            <ErrorNotice title="Could not save the company profile" message={saveError} />
          </div>
        )}
      </Card>

      <Card className="flex flex-col gap-3 text-sm lg:sticky lg:top-6">
        <h2 className="text-base font-semibold">How this is used</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>You save this profile once.</li>
          <li>Every new job loads it automatically.</li>
          <li>The AI receives it together with the job requirements and writes the “About the Company” section from it.</li>
          <li>Before approving, you verify the company details used in each job description.</li>
        </ol>
        {saved && (
          <p className="text-muted">
            Last saved {new Date(saved.updatedAt).toLocaleString()}. Changes apply to job descriptions generated from now on.
          </p>
        )}
        {justSaved && (
          <p role="status" className="rounded-md border border-success/40 bg-success-soft px-3 py-2 font-medium text-success">
            Company profile saved.
          </p>
        )}
        {saved && !next && (
          <Link href="/jobs/new" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
            Create a job →
          </Link>
        )}
      </Card>
    </div>
  );
}
