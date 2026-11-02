'use client';

import { COMPANY_ROLES, type CompanyRole, type CreatedInvitation, type Member, type Team } from '@hireflow/contracts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { InviteLink } from '@/components/invite-link';
import { useSession } from '@/components/session';
import { TeamTable } from '@/components/team-table';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError, getTeam, inviteMember, revokeInvitation, updateMember } from '@/lib/api';
import { ROLE_LABEL } from '@/lib/roles';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Company Admin: members, roles, invitations. The API scopes all of it to the admin's own company. */
export function TeamManager() {
  const { session } = useSession();
  const [team, setTeam] = useState<Team | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<CompanyRole>('HR_MEMBER');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setTeam(await getTeam({ signal }));
      setLoadError('');
    } catch (err) {
      if (!signal?.aborted) setLoadError(message(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setActionError('Enter an email address.');
    void run(async () => {
      setCreated(await inviteMember({ email: email.trim(), role }));
      setEmail('');
    });
  };

  if (loadError) return <ErrorNotice title="Could not load the team" message={loadError} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!team) {
    return (
      <Card className="flex min-h-40 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading team…
      </Card>
    );
  }

  const memberActions = (m: Member) => (
    <div className="flex justify-end gap-2">
      <select
        aria-label={`Role of ${m.name}`}
        className="rounded-md border border-border bg-surface px-2 py-1"
        value={m.role}
        disabled={busy}
        onChange={(e) => void run(() => updateMember(m.userId, { role: e.target.value as CompanyRole }))}
      >
        {COMPANY_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        disabled={busy || m.userId === session.user.id}
        onClick={() => void run(() => updateMember(m.userId, { status: m.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }))}
      >
        {m.status === 'ACTIVE' ? 'Disable' : 'Enable'}
      </Button>
    </div>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Members</h2>
        {actionError && <ErrorNotice title="Could not update the team" message={actionError} />}
        <TeamTable
          members={team.members}
          invitations={team.invitations}
          memberActions={memberActions}
          invitationActions={(i) => (
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => revokeInvitation(i.id))}>
              Revoke
            </Button>
          )}
        />
      </Card>

      <Card className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Invite a team member</h2>
        {created ? (
          <InviteLink invitation={created} onDone={() => setCreated(null)} />
        ) : (
          <form noValidate onSubmit={invite} className="flex flex-col gap-4">
            <Field id="inviteEmail" label="Email" required>
              <input id="inviteEmail" type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field id="inviteRole" label="Role" required hint="HR Members manage jobs and JDs. Company Admins can also edit the company profile and the team.">
              <select id="inviteRole" className={inputClass} value={role} onChange={(e) => setRole(e.target.value as CompanyRole)}>
                {COMPANY_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy && <Spinner />}
              Send invitation
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
