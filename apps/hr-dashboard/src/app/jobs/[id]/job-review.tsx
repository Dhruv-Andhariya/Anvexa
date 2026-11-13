'use client';

import type { CompanyProfileRecord, JdContent, JdVersion, JobDetail, JobForm } from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalPanel } from '@/components/approval-panel';
import { useSession } from '@/components/session';
import { JdPanel, JdView } from '@/components/jd-panel';
import { JobFormPanel } from '@/components/job-form-panel';
import { ScreeningSettingsCard } from '@/components/screening-settings-card';
import { Button, Card, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';
import { VersionHistory } from '@/components/version-history';
import {
  ApiError,
  approveJob,
  editJobJd,
  generateJobJd,
  getCompanyProfile,
  getJob,
  updateJobForm,
} from '@/lib/api';
import { readSnapshot, sameCompany } from '@/lib/company-form';
import { versionLabel } from '@/lib/jd';
import { EMPLOYMENT_TYPES, WORK_MODES, formToDraft, validateDraft, type FieldErrors, type JobFormDraft } from '@/lib/job-form';

type Busy = 'regenerating' | 'saving' | 'approving' | 'updating' | null;
interface ActionError {
  title: string;
  message: string;
  retry?: () => void;
  stale?: boolean;
}

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

/** Steps 3 + 4 for one job: generate the JD, review and edit it, verify the company details, approve. */
export function JobReview({ id, autoGenerate }: { id: string; autoGenerate: boolean }) {
  const router = useRouter();
  const { session } = useSession();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [profile, setProfile] = useState<CompanyProfileRecord | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null); // JD version open in the editor
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<JobFormDraft | null>(null); // non-null while editing
  const [reqErrors, setReqErrors] = useState<FieldErrors>({});
  // read once: router.replace() below clears ?generate=1, and that must not re-run load()
  const autoGenerateOnce = useRef(autoGenerate);

  const act = useCallback(
    async (kind: Exclude<Busy, null>, title: string, fn: () => Promise<JobDetail>, retry?: () => void) => {
      setBusy(kind);
      setActionError(null);
      try {
        setJob(await fn());
        setPreviewId(null);
        return true;
      } catch (err) {
        const stale = err instanceof ApiError && (err.code === 'STALE_JD_VERSION' || err.code === 'JOB_APPROVED');
        setActionError({ title, message: messageOf(err), retry: stale ? undefined : retry, stale });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const generate = useCallback(
    function run() {
      return act('regenerating', 'Could not generate the job description', () => generateJobJd(id), run);
    },
    [act, id],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoadError(null);
      try {
        const [nextJob, nextProfile] = await Promise.all([getJob(id, { signal }), getCompanyProfile({ signal })]);
        setJob(nextJob);
        setProfile(nextProfile);
        setActionError(null);
        if (autoGenerateOnce.current) {
          autoGenerateOnce.current = false;
          router.replace(`/jobs/${id}`); // a page refresh must not generate again
          if (nextJob.versions.length === 0) void generate();
        }
      } catch (err) {
        if (signal?.aborted) return;
        setLoadError({ message: messageOf(err), notFound: err instanceof ApiError && err.status === 404 });
      }
    },
    [id, generate, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loadError) {
    return loadError.notFound ? (
      <Card className="flex flex-col items-start gap-3">
        <h1 className="text-lg font-semibold">Job not found</h1>
        <Link href="/jobs" className="text-sm font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
          ← Back to jobs
        </Link>
      </Card>
    ) : (
      <ErrorNotice title="Could not load this job" message={loadError.message} action={<Button onClick={() => load()}>Try again</Button>} />
    );
  }
  if (!job) {
    return (
      <Card className="flex min-h-64 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading job…
      </Card>
    );
  }

  const locked = job.status === 'APPROVED';
  const current = job.versions.find((v) => v.id === job.currentJdVersionId) ?? null;
  const preview = previewId ? (job.versions.find((v) => v.id === previewId) ?? null) : null;
  const editingJd = current !== null && editingVersionId === current.id;
  const snapshot = current ? readSnapshot(current.companySnapshot) : null;
  const profileChanged = !!(snapshot && profile && !sameCompany(snapshot, profile));

  const regenerate = () => {
    if (current?.source === 'HR_EDIT' && !window.confirm('Generate a new AI version? Your edited version stays in the version history.')) return;
    void generate();
  };

  const saveEdit = (content: JdContent) =>
    act('saving', 'Could not save your changes', () => editJobJd(id, { baseVersionId: job.currentJdVersionId!, content }));

  // basedOnVersionId: the restored copy keeps the company details of the version it came from
  const restore = (version: JdVersion) =>
    void act('saving', 'Could not restore this version', () =>
      editJobJd(id, { baseVersionId: job.currentJdVersionId!, basedOnVersionId: version.id, content: version.content }),
    );

  const approve = ({ note }: { note: string }) =>
    void act('approving', 'Could not approve the job description', () =>
      approveJob(id, { jdVersionId: job.currentJdVersionId!, companyDetailsVerified: true, note: note || undefined }),
    );

  const saveRequirements = async () => {
    if (!requirements) return;
    const result = validateDraft(requirements);
    if (!result.ok) {
      setReqErrors(result.errors);
      return;
    }
    setReqErrors({});
    const saved = await act('updating', 'Could not save the requirements', () => updateJobForm(id, result.form));
    if (!saved) return;
    setRequirements(null);
    void generate();
  };

  const blockedReason =
    busy !== null
      ? 'Please wait…'
      : editingJd
        ? 'Save or cancel your edits before approving.'
        : requirements
          ? 'Finish editing the requirements first.'
          : preview
            ? 'Go back to the current version to approve it.'
            : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/jobs" className="text-sm text-muted hover:text-foreground">
            ← Jobs
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{job.title}</h1>
            <StatusBadge status={job.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {locked ? 'Step 4 complete — approved and locked.' : current ? 'Step 4 — review, edit, and approve.' : 'Step 3 — generate the job description.'}
          </p>
        </div>
        {locked && (
          <Link href={`/publish?job=${encodeURIComponent(job.id)}`} className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-foreground hover:opacity-90">
            Publish this job →
          </Link>
        )}
      </div>

      {actionError && (
        <ErrorNotice
          title={actionError.title}
          message={actionError.message}
          action={
            actionError.stale ? (
              <Button onClick={() => load()}>Reload</Button>
            ) : actionError.retry ? (
              <Button onClick={actionError.retry}>Try again</Button>
            ) : undefined
          }
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-start">
        <Card>
          {requirements ? (
            <JobFormPanel
              draft={requirements}
              errors={reqErrors}
              loading={busy === 'updating'}
              onChange={(d) => {
                setRequirements(d);
                if (Object.keys(reqErrors).length) {
                  const r = validateDraft(d);
                  setReqErrors(r.ok ? {} : r.errors);
                }
              }}
              onSubmit={saveRequirements}
              submitLabel="Save & regenerate JD"
              busyLabel="Saving…"
              actions={
                <Button onClick={() => setRequirements(null)} disabled={busy !== null}>
                  Cancel
                </Button>
              }
            />
          ) : preview ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm">
                <p>
                  Viewing <span className="font-medium">{versionLabel(preview)}</span> — not the current version.
                </p>
                <div className="flex gap-2">
                  {/* without a current version (requirements changed) the next step is a new JD, not a restore */}
                  {!locked && current && (
                    <Button onClick={() => restore(preview)} disabled={busy !== null}>
                      {busy === 'saving' && <Spinner />}
                      Restore as new version
                    </Button>
                  )}
                  <Button onClick={() => setPreviewId(null)}>{current ? 'Back to current' : 'Close'}</Button>
                </div>
              </div>
              <JdView jd={preview.content} form={job.form} />
            </div>
          ) : current ? (
            <JdPanel
              key={current.id}
              jd={current.content}
              form={job.form}
              company={snapshot}
              versionLabel={versionLabel(current)}
              locked={locked}
              busy={busy === 'regenerating' || busy === 'saving' ? busy : null}
              onSave={saveEdit}
              onRegenerate={regenerate}
              onEditingChange={(editing) => setEditingVersionId(editing ? current.id : null)}
            />
          ) : busy === 'regenerating' || busy === 'updating' ? (
            <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-3 text-center text-muted">
              <Spinner className="h-6 w-6 text-accent" />
              <p className="text-sm">Writing your job description from the company profile and job requirements… this can take up to a minute.</p>
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
              <p className="font-medium">{job.versions.length ? 'The requirements changed' : 'No job description yet'}</p>
              <p className="max-w-sm text-sm text-muted">
                {job.versions.length
                  ? 'Earlier versions were written from the old requirements and can no longer be approved. Generate a new one — the old versions stay in the history.'
                  : 'The AI will combine your saved company profile with this job’s requirements.'}
              </p>
              <Button variant="primary" onClick={() => void generate()}>
                Generate Job Description
              </Button>
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-6 lg:sticky lg:top-6">
          {current && (
            <Card>
              <ApprovalPanel
                key={current.id} // a new version must be verified again
                snapshot={snapshot}
                profileChanged={profileChanged && !locked}
                approval={job.approval}
                blockedReason={blockedReason}
                approving={busy === 'approving'}
                approverName={session.user.name}
                onApprove={approve}
              />
            </Card>
          )}

          <Card>
            <RequirementsSummary
              form={job.form}
              canEdit={!locked && !requirements && !editingJd && busy === null}
              onEdit={() => {
                setPreviewId(null);
                setRequirements(formToDraft(job.form));
              }}
            />
          </Card>

          <Card>
            <ScreeningSettingsCard jobId={job.id} />
          </Card>

          {job.versions.length > 0 && (
            <Card>
              <VersionHistory
                versions={job.versions}
                currentId={job.currentJdVersionId}
                approvedId={job.approval?.jdVersionId ?? null}
                previewId={previewId}
                onPreview={(v) => !editingJd && !requirements && setPreviewId(v)}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function RequirementsSummary({ form, canEdit, onEdit }: { form: JobForm; canEdit: boolean; onEdit: () => void }) {
  const label = <T extends string>(list: { value: T; label: string }[], v: T) => list.find((x) => x.value === v)?.label ?? v;
  const salary =
    form.salaryMin !== undefined || form.salaryMax !== undefined
      ? `${form.currency} ${[form.salaryMin, form.salaryMax].filter((v) => v !== undefined).map((v) => v!.toLocaleString()).join(' – ')} (${form.salaryType === 'CTC' ? 'CTC' : 'in-hand'})`
      : undefined;
  const rows: [string, string | undefined][] = [
    ['Experience', `${form.experienceMin}–${form.experienceMax} years`],
    ['Must-have', form.mustHaveSkills.join(', ')],
    ['Nice-to-have', form.niceToHaveSkills.join(', ') || undefined],
    ['Location', `${form.locations.join(', ')} · ${label(WORK_MODES, form.workMode)}`],
    ['Type', `${label(EMPLOYMENT_TYPES, form.employmentType)} · ${form.openings} opening${form.openings > 1 ? 's' : ''}`],
    ['Salary', salary],
    ['Apply by', form.deadline ? new Date(form.deadline).toLocaleDateString(undefined, { dateStyle: 'medium' }) : undefined],
  ];
  return (
    <section aria-labelledby="req-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="req-heading" className="text-base font-semibold">
          Job requirements
        </h2>
        {canEdit && (
          <Button variant="ghost" onClick={onEdit}>
            Edit
          </Button>
        )}
      </div>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[6.5rem_minmax(0,1fr)]">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}
