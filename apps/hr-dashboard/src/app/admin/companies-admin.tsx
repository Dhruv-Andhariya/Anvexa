'use client';

import type { CompanySummary } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner } from '@/components/ui';
import { ApiError, listCompanies } from '@/lib/api';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Every company registered on Anvexa. Companies register themselves; the Platform Admin oversees them. */
export function CompaniesAdmin() {
  const [companies, setCompanies] = useState<CompanySummary[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setCompanies(await listCompanies({ signal }));
      setLoadError('');
    } catch (err) {
      if (!signal?.aborted) setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loadError) return <ErrorNotice title="Could not load companies" message={loadError} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!companies) {
    return (
      <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading companies…
      </Card>
    );
  }

  return (
    <Card className="overflow-x-auto p-0 sm:p-0">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">Company</th>
            <th scope="col" className="px-5 py-3 font-medium">Status</th>
            <th scope="col" className="px-5 py-3 font-medium">Members</th>
            <th scope="col" className="px-5 py-3 font-medium">Jobs</th>
            <th scope="col" className="px-5 py-3 font-medium">Registered</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
            <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent-soft/50">
              <td className="px-5 py-3">
                <Link href={`/admin/companies/${c.id}`} className="font-medium hover:text-accent hover:underline">
                  {c.name}
                </Link>
                <span className="ml-2 text-xs text-muted">{c.slug}</span>
              </td>
              <td className={`px-5 py-3 ${c.status === 'ACTIVE' ? 'text-success' : 'text-danger'}`}>{c.status === 'ACTIVE' ? 'Active' : 'Suspended'}</td>
              <td className="px-5 py-3 text-muted">{c.memberCount}</td>
              <td className="px-5 py-3 text-muted">{c.jobCount}</td>
              <td className="px-5 py-3 text-muted">{new Date(c.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
          {companies.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-8 text-center text-muted">
                No companies have registered yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
