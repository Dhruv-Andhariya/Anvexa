'use client';

import type { ChannelPostResult, JobRounds, PublishableJob, PublishPreview, PublishResult } from '@hireflow/contracts';
import { SELECTION_PROCESS_LIMITS } from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { previewPublish, publishJob, retryPublish } from '@/lib/publisher-api';
import { fromSaved, fromTypedSteps, keepKeys, messagesUnder, toRequest, validate, type RoundDraft, type Validation } from '@/lib/rounds';
import { getRounds, saveRounds } from '@/lib/rounds-api';
import { RoundsEditor } from '../rounds/rounds-editor';
import { Button, Spinner, inputClass } from '../ui';

export const POST_STATUS_STYLE: Record<ChannelPostResult['status'], string> = {
  PUBLISHED: 'border-success/40 bg-success-soft text-success',
  FAILED: 'border-danger/40 bg-danger-soft text-danger',
  NOT_CONFIGURED: 'border-border text-muted',
  PENDING: 'border-border text-muted',
  PUBLISHING: 'border-accent/40 bg-accent-soft text-accent',
};
export const POST_STATUS_TEXT: Record<ChannelPostResult['status'], string> = {
  PUBLISHED: 'Published',
  FAILED: 'Failed',
  NOT_CONFIGURED: 'Not set up',
  PENDING: 'Waiting',
  PUBLISHING: 'Publishing…',
};

type Step = 'edit' | 'loading-preview' | 'preview' | 'publishing' | 'done';

const toSteps = (text: string) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, SELECTION_PROCESS_LIMITS.stepsMax);

/** The rounds of the job, or "legacy" when the server has no rounds yet (migration not applied / feature off). */
type RoundsState = { kind: 'loading' } | { kind: 'ready'; data: JobRounds } | { kind: 'legacy' } | { kind: 'error'; message: string };

/** What is still missing before the rounds count as complete, one line per round. */
const missingOf = (v: Validation, drafts: RoundDraft[]) => [
  ...v.general,
  ...drafts.flatMap((d, i) => {
    const messages = [...new Set(messagesUnder(v, `rounds.${i}`))];
    return messages.length ? [`${d.name.trim() || `Round ${i + 1}`}: ${messages.join(' · ')}`] : [];
  }),
];

/**
 * M05 + M06: HR sets up the job's assessment rounds (after the fixed resume and AI voice screening), sees the exact
 * post for every channel (built by the API from the APPROVED JD and the round NAMES), then confirms. The rounds can
 * be saved as a draft at any time; publishing needs them complete. Questions, pass marks and time limits never
 * appear in a post.
 */
export function PublishDialog({ job, onClose, onPublished }: { job: PublishableJob; onClose: () => void; onPublished: () => void }) {
  const [steps, setSteps] = useState((job.listing?.selectionProcess ?? []).join('\n'));
  const [rounds, setRounds] = useState<RoundsState>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<RoundDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<Step>('edit');
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  /** Rounds still incomplete when HR went to the preview (shown there; publishing stays blocked). */
  const [missing, setMissing] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const busy = step === 'publishing' || step === 'loading-preview' || saving;
  const locked = rounds.kind === 'ready' && rounds.data.locked;

  const close = useCallback(() => {
    if (busy) return;
    if (dirty && !window.confirm('Close without saving your changes to the rounds?')) return;
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    getRounds(job.jobId, { signal: controller.signal })
      .then((data) => {
        setRounds({ kind: 'ready', data });
        const typed = job.listing?.selectionProcess ?? [];
        if (data.status === 'NOT_STARTED' && typed.length) {
          setDrafts(fromTypedSteps(typed));
          setDirty(true);
          setNotice('Your earlier selection process was turned into rounds. Add their questions and passing criteria, then save.');
        } else {
          setDrafts(fromSaved(data.rounds));
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        const legacy = err instanceof ApiError && (err.code === 'ROUNDS_NOT_READY' || err.code === 'FEATURE_DISABLED');
        setRounds(legacy ? { kind: 'legacy' } : { kind: 'error', message: err instanceof ApiError ? err.message : 'Could not load the rounds.' });
      });
    return () => controller.abort();
  }, [job.jobId, job.listing]);

  const editRounds = (next: RoundDraft[]) => {
    setDrafts(next);
    setDirty(true);
    setNotice('');
    // once HR tried to save, re-check while they type so fixed problems disappear
    if (validation) setValidation(validate(next, validation.complete));
  };

  /** Saves the rounds; complete = true is needed before previewing / publishing. false = not saved. */
  const persist = async (complete: boolean): Promise<boolean> => {
    const v = validate(drafts, complete);
    if (!v.ok) {
      setValidation(v);
      setError(complete ? 'Finish the rounds below before previewing the posts.' : 'Fix the marked fields before saving.');
      return false;
    }
    setValidation(null);
    setError('');
    setSaving(true);
    try {
      const data = await saveRounds(job.jobId, toRequest(drafts, complete));
      setRounds({ kind: 'ready', data });
      setDrafts(keepKeys(fromSaved(data.rounds), drafts));
      setDirty(false);
      setNotice(complete ? '' : 'Draft saved. The job can be published once every round is complete.');
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the rounds.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** What the posts show as the selection process (the server builds the same from the saved rounds). */
  const selectionProcess = () => (rounds.kind === 'legacy' ? toSteps(steps) : drafts.map((d) => d.name.trim()).filter(Boolean));

  // the error box sits at the top of the scrolling body: bring it into view
  useEffect(() => {
    if (error) bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [error]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const loadPreview = async () => {
    setError('');
    setActive(0);
    setMissing([]);
    if (rounds.kind === 'ready' && !locked) {
      // Incomplete rounds still go to the preview (saved as a draft); the preview lists what is missing and
      // the server keeps "Confirm & publish" blocked. Only real errors (e.g. pass mark above the total) stop here.
      const check = validate(drafts, true);
      const complete = check.ok;
      if ((dirty || rounds.data.status !== (complete ? 'COMPLETE' : 'DRAFT')) && !(await persist(complete))) return;
      if (!complete) {
        setMissing(missingOf(check, drafts));
        setValidation(check);
      }
    }
    setStep('loading-preview');
    try {
      setPreview(await previewPublish(job.jobId, { selectionProcess: selectionProcess() }));
    } catch (err) {
      setPreview(null);
      setError(err instanceof ApiError ? err.message : 'Could not load the preview.');
    }
    setStep('preview');
  };

  const confirm = async () => {
    setError('');
    setStep('publishing');
    try {
      setResult(await publishJob(job.jobId, { selectionProcess: selectionProcess() }));
      setStep('done');
      onPublished();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publishing failed. Please try again.');
      setStep('preview');
    }
  };

  const retry = async () => {
    setError('');
    setStep('publishing');
    try {
      setResult(await retryPublish(job.jobId));
      onPublished();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Retry failed.');
    }
    setStep('done');
  };

  const live = preview?.channels.filter((c) => c.availability === 'live') ?? [];
  const soon = preview?.channels.filter((c) => c.availability === 'coming_soon') ?? [];
  const current = live[active];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-dialog-title"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-xl border border-border bg-surface focus:outline-none sm:rounded-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="publish-dialog-title" className="text-lg font-semibold">
              {step === 'done' ? 'Publishing result' : step === 'edit' ? 'Publish job' : 'Preview the posts'}
            </h2>
            <p className="truncate text-sm text-muted">
              {job.title} · approved version {job.version}
            </p>
          </div>
          <Button variant="ghost" aria-label="Close" onClick={close} disabled={busy}>
            ×
          </Button>
        </div>

        <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
              {error}
            </p>
          )}

          {(step === 'edit' || (step === 'loading-preview' && !preview)) && rounds.kind !== 'legacy' ? (
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-semibold">Assessment rounds</h3>
                <p className="text-sm text-muted">
                  Choose the rounds students go through after screening, in order. Students only see the round names, as the
                  selection process on the careers page and in posts. Questions, answers, pass marks and time limits stay
                  private to your HR team.
                </p>
              </div>
              {locked && (
                <p className="rounded-md border border-border bg-accent-soft px-4 py-2 text-sm">
                  Students have started these rounds, so the rounds and questions are locked. You can still change each round&apos;s
                  passing criterion and pass mark (saving it grades that round&apos;s results again), and skip a round (or undo a
                  skip): students then get the link of the next round that runs.
                </p>
              )}
              {notice && <p className="rounded-md border border-success/40 bg-success-soft px-4 py-2 text-sm text-success">{notice}</p>}
              {rounds.kind === 'loading' ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Spinner className="text-muted" /> Loading rounds…
                </p>
              ) : rounds.kind === 'error' ? (
                <p role="alert" className="text-sm text-danger">
                  {rounds.message}
                </p>
              ) : (
                <RoundsEditor
                  jobId={job.jobId}
                  fixedSteps={rounds.data.fixedSteps}
                  rounds={drafts}
                  validation={validation}
                  disabled={busy || locked}
                  locked={locked && !busy}
                  onChange={editRounds}
                  onSkipped={(key, skipped, message) => {
                    // saved on the server already: not an unsaved edit
                    setDrafts((d) => d.map((r) => (r.key === key ? { ...r, skipped } : r)));
                    setNotice(message);
                  }}
                />
              )}
            </div>
          ) : step === 'edit' || (step === 'loading-preview' && !preview) ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="selection-steps" className="text-sm font-medium">
                Selection process <span className="font-normal text-muted">(optional, one step per line — shown to students as written)</span>
              </label>
              <textarea
                id="selection-steps"
                rows={4}
                className={inputClass}
                placeholder={'Online aptitude test\nTechnical interview\nHR interview'}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                disabled={busy}
              />
              <p className="text-sm text-muted">
                The post is written from the approved job description, the job requirements and your company profile. Nothing
                else is added.
              </p>
            </div>
          ) : step === 'done' && result ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm">
                Version {result.version} is live. Apply link:{' '}
                <a href={result.applyUrl} target="_blank" rel="noopener" className="break-all font-medium text-accent underline">
                  {result.applyUrl}
                </a>
              </p>
              <ul className="flex flex-col gap-2">
                {result.posts.map((p) => (
                  <li key={p.channel} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                    <span className="font-medium">{p.channel}</span>
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${POST_STATUS_STYLE[p.status]}`}>
                      {p.unchanged ? 'Already posted · not changed' : POST_STATUS_TEXT[p.status]}
                    </span>
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener" className="text-accent underline">
                        open
                      </a>
                    )}
                    {p.error && <span className="w-full text-xs text-muted">{p.error}</span>}
                    {p.unchanged && (
                      <span className="w-full text-xs text-muted">
                        The earlier post was left as it was (posts are not edited). Only the careers page shows version {result.version}.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : preview ? (
            <div className="flex flex-col gap-4">
              {missing.length > 0 && (
                <div className="rounded-md border border-border bg-accent-soft px-4 py-3 text-sm">
                  <p className="font-medium">Rounds saved as a draft. Still missing before you can publish:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {missing.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-muted">Go Back to finish them; the fields are marked.</p>
                </div>
              )}
              {preview.errors.length > 0 && (
                <ul role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
                  {preview.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
              {preview.warnings.map((w) => (
                <p key={w} className="rounded-md border border-border bg-accent-soft px-4 py-2 text-sm">
                  {w}
                </p>
              ))}

              <div role="tablist" aria-label="Channels" className="flex flex-wrap gap-2">
                {live.map((c, i) => (
                  <button
                    key={c.channel}
                    role="tab"
                    type="button"
                    aria-selected={i === active}
                    onClick={() => setActive(i)}
                    className={`rounded-full border px-3 py-1 text-sm ${i === active ? 'border-accent bg-accent-soft font-medium' : 'border-border'}`}
                  >
                    {c.label}
                    {c.blockers.length > 0 && ' ⚠'}
                  </button>
                ))}
              </div>

              {current && (
                <div role="tabpanel" className="flex flex-col gap-2">
                  {current.blockers.length > 0 && <p className="text-sm text-muted">Will be skipped: {current.blockers.join(' ')}</p>}
                  {current.text && (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-sans text-sm leading-relaxed">
                      {current.text}
                    </pre>
                  )}
                </div>
              )}

              {job.listing && (
                <p className="text-sm text-muted">
                  Already published: the careers page will show this version, but posts made earlier (e.g. LinkedIn) are not
                  edited or posted again.
                </p>
              )}

              {soon.length > 0 && <p className="text-sm text-muted">Coming soon: {soon.map((c) => c.label).join(', ')}</p>}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          {step === 'done' ? (
            <>
              {result?.posts.some((p) => p.status === 'FAILED' || p.status === 'NOT_CONFIGURED') && (
                <Button onClick={retry}>Retry failed channels</Button>
              )}
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </>
          ) : step === 'edit' || (step === 'loading-preview' && !preview) ? (
            <>
              <Button onClick={close} disabled={busy}>
                Cancel
              </Button>
              {rounds.kind === 'ready' && !locked && (
                <Button onClick={() => void persist(false)} disabled={busy}>
                  {saving && <Spinner />}
                  Save draft
                </Button>
              )}
              <Button variant="primary" onClick={loadPreview} disabled={busy || rounds.kind === 'loading' || rounds.kind === 'error'}>
                {step === 'loading-preview' && <Spinner />}
                Preview posts
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setStep('edit')} disabled={busy}>
                Back
              </Button>
              <Button variant="primary" onClick={confirm} disabled={!preview || preview.errors.length > 0 || busy}>
                {step === 'publishing' && <Spinner />}
                {step === 'publishing' ? 'Publishing…' : 'Confirm & publish'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
