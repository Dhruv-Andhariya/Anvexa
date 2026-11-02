'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CompanyProfileForm } from '@/components/company-profile-form';
import { useSession } from '@/components/session';
import { Card, ErrorNotice } from '@/components/ui';
import { ApiError, registerCompany } from '@/lib/api';
import { emptyCompanyDraft, validateCompanyDraft, type CompanyDraft, type CompanyErrors } from '@/lib/company-form';

/** Registers the user's own company from its profile. The API makes them its Company Admin. */
export function RegisterCompany() {
  const router = useRouter();
  const { session, refresh } = useSession();
  const [draft, setDraft] = useState<CompanyDraft>(emptyCompanyDraft);
  const [errors, setErrors] = useState<CompanyErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const onChange = (d: CompanyDraft) => {
    setDraft(d);
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
    setError('');
    try {
      await registerCompany(result.profile);
      await refresh();
      router.replace('/jobs');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
      <Card>
        <CompanyProfileForm draft={draft} errors={errors} saving={saving} isNew submitLabel="Register company" onChange={onChange} onSubmit={onSubmit} />
        {error && (
          <div className="mt-5">
            <ErrorNotice title="Could not register the company" message={error} />
          </div>
        )}
      </Card>
      <Card className="flex flex-col gap-3 text-sm lg:sticky lg:top-6">
        <h2 className="text-base font-semibold">What happens next</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-muted">
          <li>Your company is created and you become its Company Admin.</li>
          <li>Create jobs. HireFlow writes each job description from these details and the job requirements.</li>
          <li>Invite your HR team from the Team page.</li>
        </ol>
        {session.companies.length > 0 && (
          <p className="text-muted">You already belong to {session.companies.map((c) => c.name).join(', ')}. This registers an additional company.</p>
        )}
        {session.companies.length === 0 && (
          <p className="text-muted">Joining an existing company instead? Ask its Company Admin to invite you.</p>
        )}
      </Card>
    </div>
  );
}
