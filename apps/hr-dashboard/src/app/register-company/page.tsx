import type { Metadata } from 'next';
import { RegisterCompany } from './register-company';

export const metadata: Metadata = { title: 'Register your company · Anvexa' };

export default function RegisterCompanyPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <p className="text-sm font-medium text-muted">Step 2 of 2</p>
        <h1 className="text-xl font-semibold tracking-tight">Register your company</h1>
        <p className="mt-1 text-sm text-muted">
          These details create your company on Anvexa. They are saved once and added to every job description automatically.
        </p>
      </div>
      <RegisterCompany />
    </main>
  );
}
