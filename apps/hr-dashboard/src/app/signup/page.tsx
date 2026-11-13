import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create your account · Anvexa' };

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * /signup - also where a failed login lands when the account does not exist:
 *   ?reason=no_account&email=...   (email + password login, the email is filled in)
 *   ?oauth_error=no_account        (Log in with Google, from the API's callback)
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const noAccount = str(params.oauth_error) === 'no_account' ? 'google' : str(params.reason) === 'no_account' ? 'password' : undefined;
  const email = str(params.email)?.trim().slice(0, 254);
  return (
    <AuthFrame>
      <SignupForm initialEmail={email} noAccount={noAccount} />
    </AuthFrame>
  );
}
