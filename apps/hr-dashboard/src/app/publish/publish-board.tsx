'use client';

import type { ChannelInfo, PublishableJob, RefreshLinksResult, UnpublishResult } from '@hireflow/contracts';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { confirmAndDeleteJob, dangerButton, PostsNotRemovedNotice } from '@/components/delete-job';
import {
  POST_STATUS_STYLE,
  POST_STATUS_TEXT,
  PublishDialog,
} from '@/components/publish/publish-dialog';
import { isCompanyAdmin, useSession } from '@/components/session';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import {
  closeJob,
  deleteJobPosts,
  disconnectLinkedIn,
  linkedInConnectUrl,
  listChannels,
  listPublishableJobs,
  refreshPostLinks,
  reopenJob,
  retryPublish,
  saveChannelSetting,
} from '@/lib/publisher-api';
import { EmptyPublishArt } from '@/components/empty-art';
import { EmptyState } from '@/components/empty-state';

const messageOf = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
const date = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(iso));

/** M06: every approved job of the company, ready to publish (or already live) on the careers site and LinkedIn. */
export function PublishBoard() {
  const { session } = useSession();
  const focusJob = useSearchParams().get('job');
  const [jobs, setJobs] = useState<PublishableJob[] | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [dialogJob, setDialogJob] = useState<PublishableJob | null>(null);
  /** Last unpublish / delete whose posts could not all be removed automatically: HR must remove those by hand. */
  const [leftovers, setLeftovers] = useState<{ title: string; result: Pick<UnpublishResult, 'notRemoved'> } | null>(null);
  /** Last "Update apply links": which posts now carry the current link, and which must be fixed by hand. */
  const [linkResult, setLinkResult] = useState<{ title: string; result: RefreshLinksResult } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError('');
    try {
      const [j, c] = await Promise.all([listPublishableJobs({ signal }), listChannels({ signal })]);
      setJobs(j);
      setChannels(c);
    } catch (err) {
      if (!signal?.aborted) setLoadError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const act = async (jobId: string, fn: () => Promise<unknown>) => {
    setActionError('');
    setLeftovers(null);
    setLinkResult(null);
    setBusyJob(jobId);
    try {
      await fn();
      await load();
    } catch (err) {
      setActionError(messageOf(err));
    } finally {
      setBusyJob(null);
    }
  };

  if (loadError) {
    return (
      <ErrorNotice
        title="Could not load your approved jobs"
        message={loadError}
        action={<Button onClick={() => load()}>Try again</Button>}
      />
    );
  }
  if (!jobs) {
    return (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading approved jobs…
      </Card>
    );
  }

  const unpublish = (job: PublishableJob) => {
    const ok = window.confirm(
      `Unpublish "${job.title}" from your careers page and LinkedIn?

` +
        'The LinkedIn post is deleted and the apply link stops working. The job stays approved, so you can publish ' +
        'it again later as a new post. Applications already received are kept.',
    );
    if (!ok) return;
    void act(job.jobId, async () => {
      const result = await deleteJobPosts(job.jobId);
      if (result.notRemoved.length) setLeftovers({ title: job.title, result });
    });
  };

  /** Deletes the job for good (also from the jobs list), with its applications. */
  const deleteForGood = (job: PublishableJob) =>
    void act(job.jobId, async () => {
      const deleted = await confirmAndDeleteJob({ id: job.jobId, title: job.title, applications: job.applications });
      if (deleted?.result.notRemoved.length) setLeftovers(deleted);
    });

  const refreshLinks = (job: PublishableJob) =>
    void act(job.jobId, async () => setLinkResult({ title: job.title, result: await refreshPostLinks(job.jobId) }));

  const ordered = focusJob
    ? [...jobs].sort((a, b) => Number(b.jobId === focusJob) - Number(a.jobId === focusJob))
    : jobs;
  const soon = channels.filter((c) => c.availability === 'coming_soon');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Publish jobs</h1>
        <p className="mt-1 text-sm text-muted">
          Approved jobs from your job list. Publishing puts the approved job description on your
          careers page and LinkedIn, with one apply link and your company careers page link.
        </p>
      </div>

      {actionError && <ErrorNotice title="That did not work" message={actionError} />}
      {leftovers && <PostsNotRemovedNotice title={leftovers.title} result={leftovers.result} />}

      {linkResult && <LinkResultNotice {...linkResult} />}

      {ordered.length === 0 ? (
        <EmptyState
          art={EmptyPublishArt}
          eyebrow="Publishing"
          steps={['Create a job and generate its description', 'Approve the AI-written description', 'Publish to your careers page and job boards']}
          title="Nothing ready to publish yet"
          description="Approve a job description first — it will appear here, ready to go live on your careers page and job boards."
          action={{ href: '/jobs', label: 'Go to jobs' }}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {ordered.map((job) => (
            <li key={job.jobId}>
              <JobRow
                job={job}
                highlighted={job.jobId === focusJob}
                busy={busyJob === job.jobId}
                onPublish={() => setDialogJob(job)}
                onRetry={() => act(job.jobId, () => retryPublish(job.jobId))}
                onRefreshLinks={() => refreshLinks(job)}
                onUnpublish={() => unpublish(job)}
                onDelete={() => deleteForGood(job)}
                onToggle={() =>
                  act(job.jobId, () =>
                    job.listing?.status === 'CLOSED' ? reopenJob(job.jobId) : closeJob(job.jobId),
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}

      {soon.length > 0 && (
        <p className="text-sm text-muted">Coming soon: {soon.map((c) => c.label).join(', ')}</p>
      )}

      {isCompanyAdmin(session) && (
        <LinkedInSettings
          channel={channels.find((c) => c.channel === 'linkedin')}
          onSaved={() => load()}
        />
      )}

      {dialogJob && (
        <PublishDialog
          job={dialogJob}
          onClose={() => setDialogJob(null)}
          onPublished={() => void load()}
        />
      )}
    </div>
  );
}

function JobRow({
  job,
  highlighted,
  busy,
  onPublish,
  onRetry,
  onRefreshLinks,
  onToggle,
  onUnpublish,
  onDelete,
}: {
  job: PublishableJob;
  highlighted: boolean;
  busy: boolean;
  onPublish: () => void;
  onRetry: () => void;
  onRefreshLinks: () => void;
  onToggle: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
}) {
  const l = job.listing;
  // LIVE in the database but the last date to apply has passed: students already see it as closed.
  const expired = l?.status === 'LIVE' && !!job.deadline && new Date(job.deadline) <= new Date();
  const needsRetry = !expired && job.posts.some((p) => p.status === 'FAILED' || p.status === 'NOT_CONFIGURED');
  // Posts on other sites (LinkedIn...) carry the apply link in their text; our careers page never needs editing.
  const hasPosts = job.posts.some((p) => p.status === 'PUBLISHED' && p.channel !== 'careers');
  return (
    <Card className={`flex flex-col gap-4 ${highlighted ? 'ring-2 ring-accent/50' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/jobs/${job.jobId}`} className="text-lg font-semibold hover:underline">
            {job.title}
          </Link>
          <p className="text-sm text-muted">
            Approved version {job.version} · {job.approvedBy} · {date(job.approvedAt)}
            {job.deadline && ` · apply by ${date(job.deadline)}`}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            !l
              ? 'border-border text-muted'
              : l.status === 'LIVE' && !expired
                ? 'border-success/40 bg-success-soft text-success'
                : 'border-danger/40 bg-danger-soft text-danger'
          }`}
        >
          {!l ? 'Not published' : expired ? 'Closed · deadline passed' : l.status === 'LIVE' ? 'Live' : 'Closed'}
        </span>
      </div>

      {l && (
        <div className="flex flex-col gap-2 text-sm">
          <p className="break-all">
            Apply link:{' '}
            <a
              href={l.applyUrl}
              target="_blank"
              rel="noopener"
              className="font-medium text-accent underline"
            >
              {l.applyUrl}
            </a>
          </p>
          <Applications job={job} />
          {l.linksOutdated && hasPosts && (
            <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
              The public site link changed and these posts may still have the old apply link (the
              automatic update could not finish — see the error below). Fix the problem, then click
              “Update apply link in posts”.
            </p>
          )}
          {l.outdated && (
            <p className="rounded-md border border-accent/40 bg-accent-soft px-3 py-2">
              A newer version was approved after publishing. Publish again to show it.
            </p>
          )}
          {job.posts.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {job.posts.map((p) => (
                <li
                  key={p.channel}
                  className="flex items-center gap-1.5"
                  title={p.error ?? undefined}
                >
                  <span className="font-medium">{p.channel}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${POST_STATUS_STYLE[p.status]}`}
                  >
                    {POST_STATUS_TEXT[p.status]}
                  </span>
                  {p.url && p.channel !== 'careers' && (
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener"
                      className="text-accent underline"
                    >
                      open
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          {job.posts
            .filter((p) => p.error)
            .map((p) => (
              <p key={p.channel} className="text-xs text-muted">
                {p.channel}: {p.error}
              </p>
            ))}
        </div>
      )}

      {/* After an unpublish the job is "Not published" but keeps the applications it received. */}
      {!l && job.applications > 0 && (
        <div className="text-sm">
          <Applications job={job} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(!l || (l.status === 'LIVE' && !expired)) && (
          <Button variant="primary" onClick={onPublish} disabled={busy}>
            {!l
              ? 'Preview & publish'
              : l.outdated
                ? 'Publish new version'
                : 'Preview & publish again'}
          </Button>
        )}
        {l?.status === 'LIVE' && needsRetry && (
          <Button onClick={onRetry} disabled={busy}>
            {busy && <Spinner />}
            Retry failed channels
          </Button>
        )}
        {l && hasPosts && (
          <Button
            onClick={onRefreshLinks}
            disabled={busy}
            title="Edits the existing posts (same post, likes kept) so they use the apply link shown above. Use it after the public site link changed."
          >
            {busy && <Spinner />}
            Update apply link in posts
          </Button>
        )}
        {l && (
          <Button onClick={onToggle} disabled={busy}>
            {busy && <Spinner />}
            {l.status === 'CLOSED' ? 'Reopen job' : 'Close job (stop applications)'}
          </Button>
        )}
        {l && (
          <Button
            onClick={onUnpublish}
            disabled={busy}
            className={dangerButton}
            title="Takes the job off your careers page and LinkedIn. The job and its applications are kept."
          >
            {busy && <Spinner />}
            Unpublish
          </Button>
        )}
        <Button
          onClick={onDelete}
          disabled={busy}
          className={dangerButton}
          title="Deletes the job for good: also from your job list, with all its applications."
        >
          {busy && <Spinner />}
          Delete job
        </Button>
      </div>
    </Card>
  );
}

function LinkResultNotice({ title, result }: { title: string; result: RefreshLinksResult }) {
  return (
    <Card
      className={`flex flex-col gap-2 text-sm ${result.notUpdated.length ? 'border-danger/40' : 'border-success/40'}`}
    >
      {result.updated.length > 0 && (
        <p>
          <span className="font-medium text-success">“{title}”: {result.updated.join(', ')} updated.</span> The
          post now links to{' '}
          <a href={result.applyUrl} target="_blank" rel="noopener" className="break-all text-accent underline">
            {result.applyUrl}
          </a>
          . LinkedIn may keep showing the old preview card for a while; the link itself is new.
        </p>
      )}
      {result.updated.length === 0 && result.notUpdated.length === 0 && (
        <p>“{title}” has no posts to update — the careers page already uses the current link.</p>
      )}
      {result.notUpdated.length > 0 && (
        <>
          <p className="font-medium">These posts could not be updated:</p>
          <ul className="flex flex-col gap-1">
            {result.notUpdated.map((n) => (
              <li key={n.channel}>
                <span className="font-medium">{n.channel}</span>: {n.error}
                {n.url && (
                  <>
                    {' '}
                    <a href={n.url} target="_blank" rel="noopener" className="text-accent underline">
                      open post
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Applications({ job }: { job: PublishableJob }) {
  return (
    <p>
      Applications: <span className="font-medium">{job.applications}</span>
      {job.applications > 0 && (
        <>
          {' · '}
          <Link
            href={`/applications?job=${encodeURIComponent(job.jobId)}`}
            className="font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
          >
            View applications →
          </Link>
        </>
      )}
    </p>
  );
}

/** /publish?linkedin=<code> after "Connect LinkedIn" (set by the API callback). */
const CONNECT_RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: {
    ok: true,
    text: 'LinkedIn connected. New jobs will be posted on LinkedIn.',
  },
  denied: { ok: false, text: 'LinkedIn connection was cancelled.' },
  not_configured: {
    ok: false,
    text: 'LinkedIn login is not set up on the server yet (LinkedIn app keys or ENCRYPTION_KEY missing).',
  },
  invalid_state: {
    ok: false,
    text: 'The LinkedIn login expired or was opened in another tab. Please try again.',
  },
  wrong_account: {
    ok: false,
    text: 'That LinkedIn account is not allowed to post for Anvexa. Log in to LinkedIn with the approved account and connect again.',
  },
  failed: { ok: false, text: 'LinkedIn did not accept the connection. Please try again.' },
};

/**
 * Company Admin: connect the company's LinkedIn page (OAuth - the token is stored encrypted on the server and never
 * shown here) and choose which page to post on.
 */
function LinkedInSettings({
  channel,
  onSaved,
}: {
  channel: ChannelInfo | undefined;
  onSaved: () => void;
}) {
  const connectResult = CONNECT_RESULT[useSearchParams().get('linkedin') ?? ''];
  const [disconnecting, setDisconnecting] = useState(false);
  const initialOrg =
    typeof channel?.config.organizationId === 'string' ? channel.config.organizationId : '';
  const [orgId, setOrgId] = useState(initialOrg);
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    setOrgId(initialOrg);
    setEnabled(channel?.enabled ?? true);
  }, [initialOrg, channel?.enabled]);

  if (!channel) return null;
  const connection = channel.connection;
  // LINKEDIN_POST_AS=member on the server (demo): posts go to the connected person's profile, no page id needed.
  const asMember = channel.label === 'LinkedIn (personal profile)';

  const disconnect = async () => {
    setError('');
    setDisconnecting(true);
    try {
      await disconnectLinkedIn();
      onSaved();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setDisconnecting(false);
    }
  };
  const valid = orgId === '' || /^\d{1,20}$/.test(orgId);

  const save = async () => {
    setError('');
    setState('saving');
    try {
      await saveChannelSetting('linkedin', {
        enabled,
        config: orgId ? { organizationId: orgId } : {},
      });
      setState('saved');
      onSaved();
    } catch (err) {
      setError(messageOf(err));
      setState('idle');
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{channel.label}</h2>
      {asMember ? (
        <p className="text-sm text-muted">
          Demo mode: jobs are posted on the personal LinkedIn profile of whoever connects below (not
          the company page).
        </p>
      ) : (
        <p className="text-sm text-muted">
          Jobs are posted on your LinkedIn company page. Connect LinkedIn with an account that is an
          admin of that page, then enter the page’s numeric organization id. Until both are done
          LinkedIn shows “Not set up” and everything else still publishes.
        </p>
      )}
      {connectResult && (
        <p className={`text-sm ${connectResult.ok ? 'text-success' : 'text-danger'}`}>
          {connectResult.text}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          {connection?.connected ? (
            <span className="text-success">
              Connected{connection.accountName ? ` as ${connection.accountName}` : ''}
              {connection.expiresAt ? ` · valid until ${date(connection.expiresAt)}` : ''}
            </span>
          ) : connection?.expired ? (
            <span className="text-danger">Connection expired — connect again</span>
          ) : (
            <span className="text-muted">Not connected</span>
          )}
        </span>
        <Button
          variant={connection?.connected ? 'secondary' : 'primary'}
          onClick={() => window.location.assign(linkedInConnectUrl())}
        >
          {connection?.connected ? 'Reconnect LinkedIn' : 'Connect LinkedIn'}
        </Button>
        {connection && (
          <Button variant="ghost" onClick={disconnect} disabled={disconnecting}>
            {disconnecting && <Spinner />}
            Disconnect
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {!asMember && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Organization id</span>
            <input
              className={`${inputClass} w-56`}
              inputMode="numeric"
              placeholder="e.g. 12345678"
              value={orgId}
              onChange={(e) => {
                setOrgId(e.target.value.trim());
                setState('idle');
              }}
              aria-invalid={!valid}
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => (setEnabled(e.target.checked), setState('idle'))}
          />
          Post on LinkedIn
        </label>
        <Button variant="primary" onClick={save} disabled={!valid || state === 'saving'}>
          {state === 'saving' && <Spinner />}
          Save
        </Button>
        {state === 'saved' && <span className="text-sm text-success">Saved</span>}
      </div>
      {!valid && <p className="text-sm text-danger">Use digits only.</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}
