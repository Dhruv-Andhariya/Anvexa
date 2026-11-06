'use client';

import { forgotPasswordRequestSchema } from '@hireflow/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, forgotPassword } from '@/lib/api';

/** Step 1 of a password reset: ask for the email. The API answers the same whether or not the account exists. */
export function ForgotPasswordForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = forgotPasswordRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await forgotPassword(parsed.data);
      setSentTo(parsed.data.email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <Card>
        <div className="flex flex-col gap-4" role="status">
          <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
          <p className="text-sm">
            If <span className="font-medium">{sentTo}</span> has a ANVEXA account, we have sent it a link to reset the
            password. The link works once and expires in 1 hour.
          </p>
          <p className="text-sm text-muted">No email after a few minutes? Check the spam folder, or try again.</p>
          <Link href="/login" className="text-sm font-medium text-accent hover:underline">
            Back to log in
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="forgot-heading">
        <h1 id="forgot-heading" className="text-xl font-semibold tracking-tight">
          Forgot password
        </h1>
        <p className="text-sm text-muted">Enter the email you log in with. We will email you a link to choose a new password.</p>
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
        {error && <ErrorNotice title="Could not send the link" message={error} />}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <Link href="/login" className="text-sm font-medium text-accent hover:underline">
          Back to log in
        </Link>
      </form>
    </Card>
  );
}
