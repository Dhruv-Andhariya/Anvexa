'use client';

import type { CreatedInvitation } from '@hireflow/contracts';
import { useState } from 'react';
import { ROLE_LABEL } from '@/lib/roles';
import { Button } from './ui';

/** Shown once after creating an invitation: the link is emailed to the invitee, and shown here once to copy as a fallback. */
export function InviteLink({ invitation, onDone }: { invitation: CreatedInvitation; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invitation.inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border border-success/40 bg-success-soft px-4 py-3 text-sm">
      <p className="font-medium text-success">
        Invitation created for {invitation.email} ({ROLE_LABEL[invitation.role]})
      </p>
      <p>
        We emailed this link to {invitation.email}. If it does not arrive (check spam), copy it and send it yourself. It works once and expires{' '}
        {new Date(invitation.expiresAt).toLocaleString()}. It will not be shown again.
      </p>
      <input readOnly value={invitation.inviteUrl} onFocus={(e) => e.target.select()} className="w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs" />
      <div className="flex gap-2">
        <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
