'use client';

import type { CompanyDetail } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TeamTable } from '@/components/team-table';
import { Button, Card, ErrorNotice, Spinner } from '@/components/ui';
import { ApiError, getCompany, setCompanyStatus } from '@/lib/api';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Platform Admin view of one company: status and team. Jobs and JDs are deliberately not shown. */
export function CompanyAdminDetail({ id }: { id: string }) {
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        setCompany(await getCompany(id, { signal }));
        setLoadError('');
      } catch (err) {
        if (!signal?.aborted) setLoadError(message(err));
      }
    },
    [id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loadError) return <ErrorNotice title="Could not load the company" message={loadError} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!company) {
    return (
      <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading company…
      </Card>
    );
  }

  const suspended = company.status === 'SUSPENDED';
  const toggle = async () => {
    if (!suspended && !window.confirm(`Suspend ${company.name}? Its members lose access to jobs until it is activated again. No data is deleted.`)) return;
    setBusy(true);
    setError('');
    try {
      setCompany(await setCompanyStatus(company.id, suspended ? 'ACTIVE' : 'SUSPENDED'));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/admin" className="text-sm text-muted hover:text-foreground">
            ← Companies
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{company.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {company.slug} · {company.jobCount} job{company.jobCount === 1 ? '' : 's'} · registered{' '}
            {new Date(company.createdAt).toLocaleDateString()} ·{' '}
            <span className={suspended ? 'text-danger' : 'text-success'}>{suspended ? 'Suspended' : 'Active'}</span>
          </p>
        </div>
        <Button onClick={() => void toggle()} disabled={busy}>
          {busy && <Spinner />}
          {suspended ? 'Activate company' : 'Suspend company'}
        </Button>
      </div>

      {error && <ErrorNotice title="Could not update the company" message={error} />}

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Members</h2>
        <TeamTable members={company.members} invitations={company.invitations} />
      </Card>
    </div>
  );
}
