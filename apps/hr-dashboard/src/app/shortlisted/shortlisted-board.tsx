'use client';

import type {
  AtsPart,
  CandidateEmailKind,
  CandidateView,
  JobCandidates,
  ScreenedCandidate,
  ScreeningJob,
  SendDecisionEmailsResult,
} from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AiScreeningPanel } from '@/components/ai-screening-panel';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { fetchResumeBlob, listCandidates, listScreeningJobs, retryScreening, sendDecisionEmails, setDecision } from '@/lib/ats-api';
import { resumeDownloadUrl } from '@/lib/publisher-api';
import { canEmail, emailKindFor, VIEWS, type AutoEmails } from './shortlisted';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const date = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(iso));
const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';
const GOOD = 'border-success/40 bg-success-soft text-success';
const BAD = 'border-danger/40 bg-danger-soft text-danger';
const INFO = 'border-accent/40 bg-accent-soft text-accent';
const PLAIN = 'border-border text-muted';

/**
 * M11 for HR: per job, the candidates the ATS shortlisted (score >= the job's private minimum, or shortlisted by HR).
 * The ATS only suggests - HR decides and sends every email. Other candidates stay on the Applications page and in
 * the other tabs here, never in the default list.
 */
export function ShortlistedBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const [jobs, setJobs] = useState<ScreeningJob[] | null>(null);
  const [error, setError] = useState<{ message: string; notReady: boolean } | null>(null);

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      setJobs(await listScreeningJobs({ signal }));
    } catch (err) {
      if (!signal?.aborted) setError({ message: messageOf(err), notReady: err instanceof ApiError && err.code === 'ATS_NOT_READY' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs]);

  const view = (VIEWS.find((v) => v.key === params.get('view'))?.key ?? 'shortlisted') as CandidateView;
  const jobId = params.get('job') ?? jobs?.find((j) => j.counts.total > 0)?.jobId ?? jobs?.[0]?.jobId ?? null;
  const go = (next: { job?: string; view?: CandidateView }) => {
    const q = new URLSearchParams({ job: next.job ?? jobId ?? '', view: next.view ?? view });
    router.replace(`/shortlisted?${q.toString()}`);
  };

  if (error) {
    return error.notReady ? (
      <Card>
        <p className="font-medium">Resume screening is not set up on the server yet</p>
        <p className="mt-1 text-sm text-muted">Its database migration has not been applied. Applications still arrive as usual.</p>
      </Card>
    ) : (
      <ErrorNotice title="Could not load your jobs" message={error.message} action={<Button onClick={() => loadJobs()}>Try again</Button>} />
    );
  }
  if (!jobs) {
    return (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading jobs…
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Shortlisted Students</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Students whose resume met the job’s minimum ATS score. Decision emails go out automatically as soon as a resume
          is screened: shortlisted students get the shortlist email with their AI screening link, the others the
          rejection email. Everyone who applied is still on the Applications page.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No approved jobs yet</p>
          <Link href="/jobs" className="text-sm font-medium text-accent hover:underline">
            Go to jobs →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job role
            <select className={inputClass} value={jobId ?? ''} onChange={(e) => go({ job: e.target.value })}>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title} — {j.counts.shortlisted} shortlisted of {j.counts.total}
                </option>
              ))}
            </select>
          </label>
          {jobId && <CandidateList key={`${jobId}:${view}`} jobId={jobId} view={view} onView={(v) => go({ view: v })} onChanged={() => loadJobs()} />}
        </>
      )}
    </div>
  );
}

function CandidateList({
  jobId,
  view,
  onView,
  onChanged,
}: {
  jobId: string;
  view: CandidateView;
  onView: (v: CandidateView) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<JobCandidates | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [emailResult, setEmailResult] = useState<{ kind: CandidateEmailKind; result: SendDecisionEmailsResult } | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        setData(await listCandidates(jobId, view, { signal }));
      } catch (err) {
        if (!signal?.aborted) setError(messageOf(err));
      }
    },
    [jobId, view],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // queued emails go out in the background: refresh while any is on its way
  useEffect(() => {
    if (!data?.candidates.some((c) => c.decisionEmail && ['QUEUED', 'SENDING'].includes(c.decisionEmail.status))) return;
    const t = setTimeout(() => void load(), 4000);
    return () => clearTimeout(t);
  }, [data, load]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setActionError('');
    setBusy(key);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  if (error) return <ErrorNotice title="Could not load the candidates" message={error} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!data) {
    return (
      <Card className="flex min-h-32 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading candidates…
      </Card>
    );
  }

  const auto: AutoEmails = { shortlist: data.autoShortlistEmails, rejection: data.autoRejectionEmails };
  // one candidate at a time (no tick boxes): only an email that could not be delivered, or with automatic emails off
  const send = (c: ScreenedCandidate) => {
    const kind = emailKindFor(c);
    if (!kind) return;
    void act(`email:${c.applicationId}`, async () => setEmailResult({ kind, result: await sendDecisionEmails(kind, [c.applicationId]) }));
  };

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Candidate lists" className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => onView(v.key)}
            aria-current={v.key === view ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${v.key === view ? 'border-accent bg-accent text-accent-foreground' : 'border-border hover:bg-accent-soft'}`}
          >
            {v.label} <span className="opacity-80">({v.count(data.counts)})</span>
          </button>
        ))}
      </nav>

      {data.minAtsScore === null && (
        <Card className="border-danger/40 text-sm">
          This job has no minimum ATS score yet, so nobody is shortlisted automatically.{' '}
          <Link href={`/jobs/${encodeURIComponent(jobId)}`} className="font-medium text-accent underline">
            Set it on the job page
          </Link>{' '}
          (it stays private to your HR team).
        </Card>
      )}
      {data.minAtsScore !== null && (
        <p className="text-sm text-muted">
          Minimum ATS score for this job: <span className="font-semibold text-foreground">{data.minAtsScore}%</span> (private)
        </p>
      )}
      {(data.autoShortlistEmails || data.autoRejectionEmails) && (
        <p className="rounded-md border border-success/40 bg-success-soft px-3 py-2 text-sm">
          {data.autoShortlistEmails && data.autoRejectionEmails
            ? 'Decision emails are automatic: shortlisted students get the shortlist email with their AI screening link, and the others the rejection email, as soon as their resume is screened. No action needed.'
            : data.autoShortlistEmails
              ? 'Shortlisted students get the shortlist email with their AI screening link automatically, as soon as their resume is screened.'
              : 'Students who are not shortlisted get the rejection email automatically, as soon as their resume is screened.'}
        </p>
      )}
      {!data.shortlistEmailsReady && view === 'shortlisted' && (
        <p className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
          Shortlist emails can be sent once the AI screening round link is added on the server. You can already review,
          shortlist and send rejection emails.
        </p>
      )}

      {actionError && <ErrorNotice title="That did not work" message={actionError} />}
      {emailResult && <EmailResultNotice {...emailResult} names={new Map(data.candidates.map((c) => [c.applicationId, c.name]))} />}


      {data.candidates.length === 0 ? (
        <Card>
          <p className="font-medium">{VIEWS.find((v) => v.key === view)!.empty}</p>
          {data.counts.total === 0 && <p className="mt-1 text-sm text-muted">No applications for this job yet.</p>}
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.candidates.map((c) => (
            <li key={c.applicationId}>
              <CandidateCard
                c={c}
                busy={busy}
                onSend={() => send(c)}
                autoReject={data.autoRejectionEmails}
                auto={auto}
                onDecide={(decision) => act(`decide:${c.applicationId}`, () => setDecision(c.applicationId, decision))}
                onRetry={() => act(`retry:${c.applicationId}`, () => retryScreening(c.applicationId))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmailResultNotice({ kind, result, names }: { kind: CandidateEmailKind; result: SendDecisionEmailsResult; names: Map<string, string> }) {
  const what = kind === 'SHORTLIST' ? 'shortlist' : 'rejection';
  return (
    <Card className={`flex flex-col gap-1 text-sm ${result.skipped.length ? 'border-danger/40' : 'border-success/40'}`}>
      {result.queued.length > 0 && (
        <p className="font-medium text-success">
          {result.queued.length} {what} {result.queued.length === 1 ? 'email is' : 'emails are'} on the way. The status below updates when sent.
        </p>
      )}
      {result.skipped.map((s) => (
        <p key={s.applicationId}>
          <span className="font-medium">{names.get(s.applicationId) ?? 'A candidate'}</span>: {s.reason}
        </p>
      ))}
    </Card>
  );
}

function CandidateCard({
  c,
  busy,
  autoReject,
  auto,
  onSend,
  onDecide,
  onRetry,
}: {
  c: ScreenedCandidate;
  busy: string | null;
  autoReject: boolean;
  auto: AutoEmails;
  onSend: () => void;
  onDecide: (decision: ScreenedCandidate['hrDecision']) => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const locked = !!c.decisionEmail && c.decisionEmail.status !== 'FAILED';
  const meets = c.score !== null && c.minAtsScore !== null && c.score >= c.minAtsScore;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <div className="min-w-0 text-sm">
            <p className="text-base font-semibold">{c.name}</p>
            <p className="break-all text-muted">
              <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> · {c.phone}
              {c.city && ` · ${c.city}`}
            </p>
            <p>
              {c.degree} in {c.branch} · {c.college} · {c.graduationYear}
            </p>
            {c.experienceYears !== null && <p>Experience: {experienceText(c.experienceYears)}</p>}
            <p className="text-muted">Applied {date(c.appliedAt)}</p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {c.score !== null ? (
            <div className="text-right">
              <p className={`text-2xl font-semibold ${meets ? 'text-success' : 'text-danger'}`}>
                {c.score}
                <span className="text-sm font-normal text-muted"> / 100</span>
              </p>
              {c.minAtsScore !== null && <p className="text-xs text-muted">minimum {c.minAtsScore}</p>}
            </div>
          ) : (
            <StatusPill c={c} />
          )}
          <DecisionPills c={c} />
        </div>
      </div>

      {c.autoRejectionReason === 'EXPERIENCE_BELOW_REQUIRED' && (
        <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          Rejected automatically: {experienceText(c.experienceYears ?? 0)} of experience
          {c.requiredExperienceMin !== null && `, below the ${experienceText(c.requiredExperienceMin)} this job requires`}. The resume was not
          screened. You can still shortlist this student.
        </p>
      )}
      {c.status === 'SCORED' && !c.autoRejectionReason && (
        <div className="flex flex-col gap-2 text-sm">
          {c.matchedSkills.length > 0 && <SkillRow label="Matched skills" skills={c.matchedSkills} style={GOOD} />}
          {c.missingSkills.length > 0 && <SkillRow label="Missing skills" skills={c.missingSkills} style={BAD} />}
          {c.profile?.summary && <p className="text-muted">{c.profile.summary}</p>}
        </div>
      )}
      {c.status !== 'SCORED' && c.lastError && (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">
          {c.status === 'NEEDS_REVIEW' ? 'Needs your review: ' : 'Screening will try again: '}
          {c.lastError}
        </p>
      )}

      <EmailStatus c={c} />
      {canEmail(c, auto) && (
        <Button className="self-start" onClick={onSend} disabled={busy !== null}>
          {busy === `email:${c.applicationId}` && <Spinner />}
          {c.decisionEmail?.status === 'FAILED'
            ? 'Send the email again'
            : emailKindFor(c) === 'SHORTLIST'
              ? 'Send shortlist email'
              : 'Send rejection email'}
        </Button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {c.status === 'SCORED' && (
          <Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide details' : 'Score details, experience & projects'}
          </Button>
        )}
        <ResumeButtons c={c} />
        {c.status === 'SCORED' && !locked && (
          <>
            {c.decision !== 'SHORTLISTED' && (
              <Button
                onClick={() => {
                  // with automatic shortlist emails the email (and screening link) goes at once and cannot be taken back
                  if (auto.shortlist && !window.confirm(`${c.name} will get the shortlist email with the AI screening link right away. This cannot be undone. Continue?`)) return;
                  onDecide('SHORTLISTED');
                }}
                disabled={busy !== null}
              >
                {busy === `decide:${c.applicationId}` && <Spinner />}
                Shortlist
              </Button>
            )}
            {c.decision !== 'NOT_SHORTLISTED' && (
              <Button
                onClick={() => {
                  // with automatic rejections the email goes at once and cannot be taken back
                  if (autoReject && !window.confirm(`${c.name} will get the rejection email right away. This cannot be undone. Continue?`)) return;
                  onDecide('NOT_SHORTLISTED');
                }}
                disabled={busy !== null}
                className="border-danger/40! text-danger! hover:bg-danger-soft!"
              >
                {busy === `decide:${c.applicationId}` && <Spinner />}
                Don’t shortlist
              </Button>
            )}
            {c.hrDecision && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (autoReject && c.systemDecision === 'NOT_SHORTLISTED' && !window.confirm(`The ATS did not shortlist ${c.name}, so they will get the rejection email right away. Continue?`)) return;
                  onDecide(null);
                }}
                disabled={busy !== null}
              >
                Use the ATS suggestion
              </Button>
            )}
          </>
        )}
        {c.status === 'NEEDS_REVIEW' && (
          <Button onClick={onRetry} disabled={busy !== null}>
            {busy === `retry:${c.applicationId}` && <Spinner />}
            Screen again
          </Button>
        )}
      </div>

      {/* M12: the candidate got the shortlist email's screening link */}
      {c.screeningLinkExpiresAt && <AiScreeningPanel applicationId={c.applicationId} />}

      {open && c.status === 'SCORED' && <Details c={c} />}
    </Card>
  );
}

/** "0 years (fresher)", "1 year", "2.5 years" */
function experienceText(years: number): string {
  return years === 0 ? '0 years (fresher)' : `${years} year${years === 1 ? '' : 's'}`;
}

function StatusPill({ c }: { c: ScreenedCandidate }) {
  if (c.status === 'NEEDS_REVIEW') return <span className={`${pill} ${BAD}`}>Needs HR review</span>;
  if (c.autoRejectionReason === 'EXPERIENCE_BELOW_REQUIRED') return <span className={`${pill} ${BAD}`}>Below required experience</span>;
  if (c.status === 'SCORED') return <span className={`${pill} ${PLAIN}`}>Screened</span>;
  return (
    <span className={`${pill} ${INFO}`}>
      <Spinner className="mr-1 h-3 w-3" /> Screening…
    </span>
  );
}

function DecisionPills({ c }: { c: ScreenedCandidate }) {
  if (c.status !== 'SCORED') return null;
  const label = (d: ScreenedCandidate['decision']) => (d === 'SHORTLISTED' ? 'Shortlisted' : d === 'NOT_SHORTLISTED' ? 'Not shortlisted' : 'Undecided');
  const style = (d: ScreenedCandidate['decision']) => (d === 'SHORTLISTED' ? GOOD : d === 'NOT_SHORTLISTED' ? BAD : PLAIN);
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {c.hrDecision ? (
        <>
          <span className={`${pill} ${style(c.hrDecision)}`}>HR: {label(c.hrDecision)}</span>
          <span className={`${pill} ${PLAIN}`}>ATS suggested: {label(c.systemDecision)}</span>
        </>
      ) : (
        <span className={`${pill} ${style(c.systemDecision)}`}>ATS suggests: {label(c.systemDecision)}</span>
      )}
    </div>
  );
}

function EmailStatus({ c }: { c: ScreenedCandidate }) {
  const e = c.decisionEmail;
  if (!e) return null;
  const what = e.kind === 'SHORTLIST' ? 'Shortlist email' : 'Rejection email';
  if (e.status === 'SENT') {
    return (
      <p className="text-sm text-success">
        {what} sent {e.sentAt ? date(e.sentAt) : ''}
        {c.screeningLinkExpiresAt && <span className="text-muted"> · AI screening link valid until {date(c.screeningLinkExpiresAt)}</span>}
      </p>
    );
  }
  if (e.status === 'FAILED') return <p className="text-sm text-danger">{what} could not be sent: {e.error ?? 'unknown error'}.</p>;
  if (e.status === 'QUEUED' && e.error) {
    // held, e.g. until the AI screening link is public: it goes out by itself, nothing to do
    return <p className="text-sm text-muted">{what} queued - {e.error}</p>;
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted">
      <Spinner className="h-3 w-3" /> {what} is being sent…
    </p>
  );
}

function SkillRow({ label, skills, style }: { label: string; skills: string[]; style: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
      {skills.map((s) => (
        <span key={s} className={`${pill} ${style}`}>{s}</span>
      ))}
    </div>
  );
}

function ResumeButtons({ c }: { c: ScreenedCandidate }) {
  const [preview, setPreview] = useState<{ url: string } | { error: string } | 'loading' | null>(null);
  useEffect(() => () => {
    if (preview && typeof preview === 'object' && 'url' in preview) URL.revokeObjectURL(preview.url);
  }, [preview]);
  if (!c.resume) return <span className="text-sm text-muted">No resume</span>;
  const isPdf = c.resume.mimeType === 'application/pdf';

  const open = async () => {
    setPreview('loading');
    try {
      const blob = await fetchResumeBlob(c.applicationId);
      setPreview({ url: URL.createObjectURL(new Blob([blob], { type: 'application/pdf' })) });
    } catch (err) {
      setPreview({ error: messageOf(err) });
    }
  };

  return (
    <>
      {isPdf && (
        <Button onClick={() => (preview ? setPreview(null) : void open())}>
          {preview === 'loading' && <Spinner />}
          {preview && preview !== 'loading' ? 'Close preview' : 'Preview resume'}
        </Button>
      )}
      <a
        href={resumeDownloadUrl(c.applicationId)}
        className="inline-flex items-center rounded-md border border-border px-3.5 py-2 text-sm font-medium hover:bg-accent-soft"
        title={c.resume.fileName}
      >
        Download resume
      </a>
      {preview && typeof preview === 'object' && (
        <div className="basis-full">
          {'url' in preview ? (
            <iframe title={`Resume of ${c.name}`} src={preview.url} className="h-[70vh] w-full rounded-md border border-border" />
          ) : (
            <p className="text-sm text-danger">{preview.error}</p>
          )}
        </div>
      )}
    </>
  );
}

function Details({ c }: { c: ScreenedCandidate }) {
  const p = c.profile;
  return (
    <div className="grid gap-6 border-t border-border pt-4 text-sm lg:grid-cols-2">
      <section>
        <h3 className="mb-2 font-semibold">How the score was made</h3>
        <ul className="flex flex-col gap-3">
          {(c.breakdown ?? []).map((part) => (
            <ScorePart key={part.key} part={part} />
          ))}
        </ul>
      </section>
      {p && (
        <section className="flex flex-col gap-4">
          {p.experience.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Experience & internships</h3>
              <ul className="flex flex-col gap-1.5">
                {p.experience.map((e, i) => (
                  <li key={i}>
                    <span className="font-medium">{e.role}</span> · {e.organization}
                    <span className="text-muted">
                      {' '}
                      · {e.kind}
                      {e.months > 0 && ` · ${e.months} months`}
                    </span>
                    {e.relevant && <span className={`${pill} ${GOOD} ml-2`}>relevant</span>}
                    {e.summary && <p className="text-muted">{e.summary}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.projects.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Projects</h3>
              <ul className="flex flex-col gap-1.5">
                {p.projects.map((pr, i) => (
                  <li key={i}>
                    <span className="font-medium">{pr.title}</span>
                    {pr.relevant && <span className={`${pill} ${GOOD} ml-2`}>matches the role</span>}
                    {pr.technologies.length > 0 && <span className="text-muted"> · {pr.technologies.join(', ')}</span>}
                    {pr.summary && <p className="text-muted">{pr.summary}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ListBlock title="Achievements" items={p.achievements} />
          <ListBlock title="Certifications" items={p.certifications} />
          <ListBlock title="Education" items={p.education.map((e) => [e.degree, e.field, e.institution, e.year].filter(Boolean).join(' · '))} />
        </section>
      )}
    </div>
  );
}

function ScorePart({ part }: { part: AtsPart }) {
  const pct = Math.round((part.points / part.max) * 100);
  return (
    <li>
      <div className="flex justify-between gap-3">
        <span className="font-medium">{part.label}</span>
        <span className="tabular-nums">
          {part.points} / {part.max}
        </span>
      </div>
      <div className="mt-1 h-2 rounded-full bg-accent-soft" role="img" aria-label={`${pct}%`}>
        <div className="h-2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-muted">{part.reason}</p>
    </li>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h3 className="mb-1 font-semibold">{title}</h3>
      <ul className="list-disc pl-5">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
