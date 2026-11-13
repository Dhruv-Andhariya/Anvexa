'use client';

import { PASSWORD_LIMITS } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, resetPassword } from '@/lib/api';

/** Step 2 of a password reset: the emailed link opens this page. On success the user logs in again. */
export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linkInvalid, setLinkInvalid] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (password.length < PASSWORD_LIMITS.min) next.password = `Use at least ${PASSWORD_LIMITS.min} characters.`;
    if (password !== confirm) next.confirm = 'The passwords do not match.';
    setErrors(next);
    if (next.password || next.confirm) return;

    setBusy(true);
    setError('');
    try {
      await resetPassword({ token, password });
      router.replace('/login?reset=done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSWORD_RESET_INVALID') setLinkInvalid(true);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  return (
    <Card>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="reset-heading">
        <h1 id="reset-heading" className="text-2xl font-bold tracking-tight">
          Choose a new password
        </h1>
        <Field id="password" label="New password" required error={errors.password} hint={`At least ${PASSWORD_LIMITS.min} characters.`}>
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
        <Field id="confirm" label="Confirm new password" required error={errors.confirm}>
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
            title="Could not change the password"
            message={error}
            action={
              linkInvalid ? (
                <Link href="/forgot-password" className="font-medium underline">
                  Get a new link
                </Link>
              ) : undefined
            }
          />
        )}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          {busy ? 'Saving…' : 'Change password'}
        </Button>
        <Link href="/login" className="text-sm font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
          Back to log in
        </Link>
      </form>
    </Card>
  );
}
