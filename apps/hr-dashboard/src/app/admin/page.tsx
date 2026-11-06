import type { Metadata } from 'next';
import { CompaniesAdmin } from './companies-admin';

export const metadata: Metadata = { title: 'Companies · Anvexa' };

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-accent">Platform Admin</p>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="mt-1 text-sm text-muted">Companies register themselves. Here you can see every company, its team, and suspend or activate it.</p>
      </div>
      <CompaniesAdmin />
    </main>
  );
}
