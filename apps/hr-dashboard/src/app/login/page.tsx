import type { Metadata } from 'next';
import { safeNext } from '@/lib/safe-next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · ANVEXA' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <p className="mb-6 text-center text-base font-semibold tracking-tight">ANVEXA</p>
      <LoginForm
        next={next}
        passwordReset={params.reset === 'done'}
        oauthError={typeof params.oauth_error === 'string' ? params.oauth_error : undefined}
      />
    </main>
  );
}
