import type { Metadata } from 'next';
import { CompanyAdminDetail } from './company-detail';

export const metadata: Metadata = { title: 'Company · ANVEXA' };

export default async function AdminCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <CompanyAdminDetail id={id} />
    </main>
  );
}
