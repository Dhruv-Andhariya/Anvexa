import type { Metadata } from 'next';
import { CONTENT } from '@/content';
import { MyDataPanel } from './my-data-panel';

export const metadata: Metadata = { title: CONTENT.myData.title, robots: { index: false } };

type Params = { params: Promise<{ company: string }> };

/** DPDP: a student sees or deletes their own data at this company (M09). */
export default async function MyDataPage({ params }: Params) {
  const { company } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{CONTENT.myData.title}</h1>
      <p className="mt-2 text-sm text-muted">{CONTENT.myData.intro}</p>
      <div className="mt-6 rounded-xl border border-border bg-surface p-5 sm:p-6">
        <MyDataPanel companySlug={company} />
      </div>
    </main>
  );
}
