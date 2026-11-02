'use client';

import { PASSWORD_LIMITS, type InvitationPreview } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useRefreshSession } from '@/components/session';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, acceptInvitation, getInvitation } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/roles';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Join a company from an invitation link: new users create their account, existing users confirm their password. */
export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const refresh = useRefreshSession();
  const [invite, setInvite] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getInvitation(token, { signal: controller.signal })
      .then(setInvite)
      .catch((err) => {
        if (!controller.signal.aborted) setLoadError(message(err));
      });
    return () => controller.abort();
  }, [token]);

  if (loadError) {
    return (
      <Card className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Invitation unavailable</h1>
        <p className="text-sm text-muted">{loadError}</p>
        <Link href="/login" className="text-sm font-medium text-accent hover:underline">
          Go to log in
        </Link>
      </Card>
    );
  }
  if (!invite) {
    return (
      <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading invitation…
      </Card>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!invite.existingUser && name.trim().length < 2) next.name = 'Enter your name (at least 2 characters).';
    if (password.length < PASSWORD_LIMITS.min) next.password = `Use at least ${PASSWORD_LIMITS.min} characters.`;
    if (!invite.existingUser && password !== confirm) next.confirm = 'The passwords do not match.';
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setError('');
    try {
      await acceptInvitation({ token, password, name: invite.existingUser ? undefined : name.trim() });
      await refresh();
      router.replace('/jobs');
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  return (
    <Card>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4" aria-labelledby="invite-heading">
        <div>
          <h1 id="invite-heading" className="text-xl font-semibold tracking-tight">
            Join {invite.companyName}
          </h1>
          <p className="mt-1 text-sm text-muted">
            You were invited as <span className="font-medium text-foreground">{ROLE_LABEL[invite.role]}</span> with{' '}
            <span className="font-medium text-foreground">{invite.email}</span>.
          </p>
        </div>
        {invite.existingUser ? (
          <p className="text-sm text-muted">You already have a HireFlow account. Enter its password to join this company.</p>
        ) : (
          <Field id="name" label="Your name" required error={errors.name}>
            <input id="name" autoComplete="name" maxLength={100} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        )}
        <Field
          id="password"
          label={invite.existingUser ? 'Password' : 'Choose a password'}
          required
          error={errors.password}
          hint={invite.existingUser ? undefined : `At least ${PASSWORD_LIMITS.min} characters.`}
        >
          <input
            id="password"
            type="password"
            autoComplete={invite.existingUser ? 'current-password' : 'new-password'}
            maxLength={PASSWORD_LIMITS.max}
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {!invite.existingUser && (
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
        )}
        {error && <ErrorNotice title="Could not accept the invitation" message={error} />}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {busy && <Spinner />}
          {busy ? 'Joining…' : `Join ${invite.companyName}`}
        </Button>
        <p className="text-xs text-muted">This link expires {new Date(invite.expiresAt).toLocaleString()}.</p>
      </form>
    </Card>
  );
}
