'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { LoginCodeRequired, Session } from '@hireflow/contracts';
import { GOOGLE_ERRORS, GoogleButton } from '@/components/google-button';
import { useRefreshSession } from '@/components/session';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, login, verifyLoginCode } from '@/lib/api';

/**
 * Login for returning users. New company HR signs up at /signup; team members join through an invitation link.
 * With login 2FA on, the right password emails a 6-digit code and a second step asks for it.
 */
export function LoginForm({ next, passwordReset, oauthError }: { next?: string; passwordReset?: boolean; oauthError?: string }) {
  const router = useRouter();
  const refresh = useRefreshSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(oauthError ? (GOOGLE_ERRORS[oauthError] ?? GOOGLE_ERRORS.rejected!) : '');
  /** Set once the password was right and a code was emailed (2FA step). */
  const [codeStep, setCodeStep] = useState<LoginCodeRequired | null>(null);
  const [code, setCode] = useState('');

  const enter = async (session: Session) => {
    await refresh();
    router.replace(
      next ?? (session.company ? '/jobs' : session.user.isPlatformAdmin ? '/admin' : session.companies.length ? '/jobs' : '/register-company'),
    );
  };

  const fail = (err: unknown) => {
    // no account with this email: login fails and the person goes to sign-up (email filled in)
    if (err instanceof ApiError && err.code === 'ACCOUNT_NOT_FOUND') {
      router.replace(`/signup?reason=no_account&email=${encodeURIComponent(email.trim())}`);
      return;
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    setBusy(false);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await login({ email: email.trim(), password });
      if ('codeRequired' in result) {
        setCodeStep(result);
        setCode('');
        setBusy(false);
        return;
      }
      await enter(result);
    } catch (err) {
      fail(err);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!codeStep) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await enter(await verifyLoginCode({ challenge: codeStep.challenge, code: code.trim() }));
    } catch (err) {
      // expired / too many wrong codes: back to the password step for a fresh code
      if (err instanceof ApiError && err.code === 'LOGIN_CODE_EXPIRED') setCodeStep(null);
      fail(err);
    }
  };

  if (codeStep) {
    return (
      <Card>
        <form noValidate onSubmit={submitCode} className="flex flex-col gap-4" aria-labelledby="code-heading">
          <h1 id="code-heading" className="text-xl font-semibold tracking-tight">
            Check your email
          </h1>
          <p className="text-sm text-muted">
            We sent a 6-digit login code to <span className="font-medium text-foreground">{codeStep.emailHint}</span>. It expires in a
            few minutes.
          </p>
          <Field id="code" label="Login code" required>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              className={`${inputClass} font-mono tracking-[0.4em]`}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          {error && <ErrorNotice title="Could not log in" message={error} />}
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            {busy && <Spinner />}
            {busy ? 'Checking…' : 'Verify and log in'}
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="font-medium text-accent hover:underline" disabled={busy} onClick={() => void submit()}>
              Send a new code
            </button>
            <button
              type="button"
              className="text-muted hover:underline"
              disabled={busy}
              onClick={() => {
                setCodeStep(null);
                setError('');
              }}
            >
              Use a different account
            </button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="login-heading">
        <h1 id="login-heading" className="text-xl font-semibold tracking-tight">
          Log in
        </h1>
        <GoogleButton next={next} />
        <Field id="email" label="Work email" required>
          <input
            id="email"
            type="email"
            autoComplete="username"
            className={inputClass}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field id="password" label="Password" required>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Link
          href={email.trim() ? `/forgot-password?email=${encodeURIComponent(email.trim())}` : '/forgot-password'}
          className="-mt-2 self-end text-sm font-medium text-accent hover:underline"
        >
          Forgot password?
        </Link>
        {passwordReset && !error && (
          <p role="status" className="rounded-md border border-success/40 bg-success-soft px-4 py-3 text-sm text-success">
            Your password was changed. Log in with the new password.
          </p>
        )}
        {error && <ErrorNotice title="Could not log in" message={error} />}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
        <p className="text-sm text-muted">
          New company on Anvexa?{' '}
          <Link href="/signup" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
          . Joining your company&apos;s existing team? Ask your Company Admin for an invitation link.
        </p>
      </form>
    </Card>
  );
}
