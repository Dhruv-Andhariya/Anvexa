import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { safeNext } from '@/lib/safe-next';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Log in · Anvexa' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  return (
    <AuthFrame>
      <LoginForm
        next={next}
        passwordReset={params.reset === 'done'}
        oauthError={typeof params.oauth_error === 'string' ? params.oauth_error : undefined}
      />
    </AuthFrame>
  );
}
