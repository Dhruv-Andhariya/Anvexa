import type { Metadata } from 'next';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Forgot password · Anvexa' };

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const email = (await searchParams).email;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <p className="mb-6 text-center text-base font-semibold tracking-tight">Anvexa</p>
      <ForgotPasswordForm initialEmail={typeof email === 'string' ? email : ''} />
    </main>
  );
}
