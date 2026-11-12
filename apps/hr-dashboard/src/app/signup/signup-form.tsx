'use client';

import { PASSWORD_LIMITS, signupRequestSchema, type LoginCodeRequired } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { GOOGLE_ERRORS, GoogleButton, NO_ACCOUNT_NOTICE } from '@/components/google-button';
import { useRefreshSession } from '@/components/session';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, signup, verifySignupCode } from '@/lib/api';

/**
 * Step A of onboarding a new company: the HR person creates their own account. Step B: /register-company.
 * With sign-up email verification on, the account is created only after the code emailed to that address is entered.
 */
export function SignupForm({ initialEmail, noAccount }: { initialEmail?: string; noAccount?: 'google' | 'password' } = {}) {
  // sent here by a failed login: that email / Google account has no Anvexa account yet
  const notice = noAccount === 'google' ? GOOGLE_ERRORS.no_account : noAccount === 'password' ? NO_ACCOUNT_NOTICE : undefined;
  const router = useRouter();
  const refresh = useRefreshSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [emailTaken, setEmailTaken] = useState(false);
  /** Set once the form was accepted and a code was emailed (verification step). */
  const [codeStep, setCodeStep] = useState<LoginCodeRequired | null>(null);
  const [code, setCode] = useState('');

  const created = async () => {
    await refresh();
    router.replace('/register-company');
  };

  const fail = (err: unknown) => {
    setEmailTaken(err instanceof ApiError && err.code === 'EMAIL_TAKEN');
    setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    setBusy(false);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const next: Record<string, string> = {};
    const parsed = signupRequestSchema.safeParse({ name, email, password });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0]);
        next[field] ??=
          field === 'name'
            ? 'Enter your name (at least 2 characters).'
            : field === 'email'
              ? 'Enter a valid email address.'
              : `Use at least ${PASSWORD_LIMITS.min} characters.`;
      }
    }
    if (password !== confirm) next.confirm = 'The passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length || !parsed.success) return;

    setBusy(true);
    setError('');
    setEmailTaken(false);
    try {
      const result = await signup(parsed.data);
      if ('codeRequired' in result) {
        setCodeStep(result);
        setCode('');
        setBusy(false);
        return;
      }
      await created();
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
    setEmailTaken(false);
    try {
      await verifySignupCode({ challenge: codeStep.challenge, code: code.trim() });
      await created();
    } catch (err) {
      // expired / too many wrong codes / email taken meanwhile: back to the form (still filled in)
      if (err instanceof ApiError && (err.code === 'SIGNUP_CODE_EXPIRED' || err.code === 'EMAIL_TAKEN')) setCodeStep(null);
      fail(err);
    }
  };

  if (codeStep) {
    return (
      <Card>
        <form noValidate onSubmit={submitCode} className="flex flex-col gap-4" aria-labelledby="verify-heading">
          <div>
            <p className="text-sm font-medium text-muted">Step 1 of 2</p>
            <h1 id="verify-heading" className="text-xl font-semibold tracking-tight">
              Verify your email
            </h1>
            <p className="mt-1 text-sm text-muted">
              We sent a 6-digit code to <span className="font-medium text-foreground">{codeStep.emailHint}</span>. Enter it to create your
              account.
            </p>
          </div>
          <Field id="code" label="Verification code" required>
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
          {error && <ErrorNotice title="Could not create the account" message={error} />}
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            {busy && <Spinner />}
            {busy ? 'Creating account…' : 'Verify and create account'}
          </Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground" disabled={busy} onClick={() => void submit()}>
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
              Change details
            </button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="signup-heading">
        <div>
          <p className="text-sm font-medium text-muted">Step 1 of 2</p>
          <h1 id="signup-heading" className="text-xl font-semibold tracking-tight">
            Create your account
          </h1>
          <p className="mt-1 text-sm text-muted">Next you will register your company and become its Company Admin.</p>
        </div>
        {notice && !error && (
          <p role="status" className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-foreground">
            {notice}
          </p>
        )}
        <GoogleButton label="Sign up with Google" mode="signup" />
        <Field id="name" label="Your name" required error={errors.name}>
          <input id="name" autoComplete="name" maxLength={100} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="email" label="Work email" required error={errors.email}>
          <input id="email" type="email" autoComplete="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id="password" label="Password" required error={errors.password} hint={`At least ${PASSWORD_LIMITS.min} characters.`}>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_LIMITS.max}
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field id="confirm" label="Confirm password" required error={errors.confirm}>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_LIMITS.max}
            className={inputClass}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {error && (
          <ErrorNotice
            title="Could not create the account"
            message={error}
            action={
              emailTaken ? (
                <Link href="/login" className="font-medium underline">
                  Go to log in
                </Link>
              ) : undefined
            }
          />
        )}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          {busy ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-sm text-muted">
          Already on Anvexa?{' '}
          <Link href="/login" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
            Log in
          </Link>
        </p>
      </form>
    </Card>
  );
}
