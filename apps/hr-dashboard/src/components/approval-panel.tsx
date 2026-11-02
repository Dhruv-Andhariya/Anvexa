'use client';

import type { CompanyProfile, JobApproval } from '@hireflow/contracts';
import { useState, type FormEvent } from 'react';
import { CompanyFacts } from './company-card';
import { Button, Field, Spinner, inputClass } from './ui';

interface Props {
  /** Company profile exactly as the AI received it for the current version. */
  snapshot: CompanyProfile | null;
  /** True when the saved profile was changed after this version was written. */
  profileChanged: boolean;
  approval: JobApproval | null;
  /** e.g. editing in progress or another request running */
  blockedReason: string | null;
  approving: boolean;
  /** the logged-in user: the API records them as the approver */
  approverName: string;
  onApprove: (input: { note: string }) => void;
}

/** Step 4: HR verifies the company details used in the JD and approves the current version. */
export function ApprovalPanel({ snapshot, profileChanged, approval, blockedReason, approving, approverName, onApprove }: Props) {
  const [verified, setVerified] = useState(false);
  const [note, setNote] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApprove({ note: note.trim() });
  };

  const facts = snapshot ? (
    <CompanyFacts profile={snapshot} />
  ) : (
    <p className="text-sm text-muted">No company details were recorded for this version.</p>
  );

  if (approval) {
    return (
      <section aria-labelledby="approval-heading" className="flex flex-col gap-4">
        <h2 id="approval-heading" className="text-base font-semibold">
          Approval
        </h2>
        <div role="status" className="rounded-md border border-success/40 bg-success-soft px-4 py-3 text-sm text-success">
          <p className="font-medium">Approved by {approval.approvedBy}</p>
          <p className="mt-0.5">
            {new Date(approval.approvedAt).toLocaleString()} · company details verified
          </p>
          {approval.note && <p className="mt-2 text-foreground">“{approval.note}”</p>}
        </div>
        <p className="text-sm text-muted">This job is locked. The approved version is ready for a job post.</p>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Company details in this JD</summary>
          <div className="mt-3">{facts}</div>
        </details>
      </section>
    );
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby="approval-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="approval-heading" className="text-base font-semibold">
          Verify and approve
        </h2>
        <p className="mt-1 text-sm text-muted">Check the company details the AI used, then approve this version.</p>
      </div>

      <div className="rounded-md border border-border p-4">{facts}</div>

      {profileChanged && (
        <p role="note" className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          Your company profile changed after this version was written. Regenerate to use the latest company details.
        </p>
      )}

      <fieldset disabled={approving || blockedReason !== null} className="flex flex-col gap-4">
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-accent"
          />
          <span>I verified that the company details in this job description are correct.</span>
        </label>

        <Field id="approvalNote" label="Note">
          <textarea id="approvalNote" rows={2} maxLength={500} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <Button type="submit" variant="primary" disabled={!verified || approving || blockedReason !== null} aria-busy={approving}>
          {approving && <Spinner />}
          {approving ? 'Approving…' : 'Approve job description'}
        </Button>
        <p className="text-xs text-muted">You approve as {approverName}. This is recorded with the approval.</p>
      </fieldset>
      {blockedReason && <p className="text-sm text-muted">{blockedReason}</p>}
    </form>
  );
}
