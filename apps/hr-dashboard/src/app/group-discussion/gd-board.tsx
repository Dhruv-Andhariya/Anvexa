'use client';

import {
  GD_LIMITS,
  gdSettingsSchema,
  planGroupSizes,
  planGroupSlots,
  type GdAttendance,
  type GdBatchStatus,
  type GdEvent,
  type GdRoundOverview,
  type GdRoundSummary,
  type GdSettings,
  type GdTopic,
} from '@hireflow/contracts';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Card, ErrorNotice, Field, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { cancelGdEvent, createGdEvent, getGdRound, listGdRounds, setGdBatchTopic } from '@/lib/gd-api';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';

const ATTENDANCE: Record<GdAttendance, { text: string; style: string }> = {
  WAITING: { text: 'Waiting', style: 'border-border text-muted' },
  SCHEDULED: { text: 'Scheduled', style: 'border-accent/40 bg-accent-soft text-accent' },
  INVITED: { text: 'Invited', style: 'border-accent/40 bg-accent-soft text-accent' },
  JOINED: { text: 'Joined', style: 'border-success/40 bg-success-soft text-success' },
  ABSENT: { text: 'Absent', style: 'border-danger/40 bg-danger-soft text-danger' },
  ADMITTED_LATE: { text: 'Admitted late', style: 'border-success/40 bg-success-soft text-success' },
};
const BATCH: Record<GdBatchStatus, string> = {
  SCHEDULED: 'Scheduled',
  LOBBY_OPEN: 'Lobby open',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** "2026-11-03T10:00" in the browser's time zone (what <input type="datetime-local"> wants). */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tomorrow at 10:00 local time: a sensible first suggestion. */
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return localInputValue(d);
}

/**
 * HR "Group Discussion": per GD round, the students who passed the round before it and wait for a group, a form that
 * splits all of them into groups with time slots and topics, and the scheduled events. HR only, same company.
 */
export function GdBoard() {
  const router = useRouter();
  const params = useSearchParams();
  const [rounds, setRounds] = useState<GdRoundSummary[] | null>(null);
  const [error, setError] = useState<{ message: string; notReady: boolean } | null>(null);

  const loadRounds = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try {
      setRounds(await listGdRounds({ signal }));
    } catch (err) {
      if (!signal?.aborted) setError({ message: messageOf(err), notReady: err instanceof ApiError && err.code === 'FEATURE_DISABLED' });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadRounds(controller.signal);
    return () => controller.abort();
  }, [loadRounds]);

  const roundId = params.get('round') ?? rounds?.[0]?.roundId ?? null;

  if (error) {
    return error.notReady ? (
      <Card>
        <p className="font-medium">Group discussions are switched off on the server</p>
        <p className="mt-1 text-sm text-muted">Everything else keeps working.</p>
      </Card>
    ) : (
      <ErrorNotice title="Could not load your group discussion rounds" message={error.message} action={<Button onClick={() => loadRounds()}>Try again</Button>} />
    );
  }
  if (!rounds) {
    return (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading…
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Group Discussion</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Students who pass the round before a group discussion wait here automatically. Schedule a GD to split them into
          groups: each group gets its own time slot, room and topic, and an AI moderator runs the discussion.
        </p>
      </div>

      {rounds.length === 0 ? (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">No group discussion rounds yet</p>
          <p className="text-sm text-muted">
            Add a round of type <span className="font-medium">Group Discussion</span> to a job on the Publish page. Its questions
            are the discussion topics.
          </p>
          <Link href="/publish" className="text-sm font-medium text-accent hover:underline">
            Open the Publish page →
          </Link>
        </Card>
      ) : (
        <>
          <label className="flex max-w-xl flex-col gap-1.5 text-sm font-medium">
            Job and round
            <select className={inputClass} value={roundId ?? ''} onChange={(e) => router.replace(`/group-discussion?round=${encodeURIComponent(e.target.value)}`)}>
              {rounds.map((r) => (
                <option key={r.roundId} value={r.roundId}>
                  {r.jobTitle} — {r.roundName} ({r.waiting} waiting, {r.scheduled} scheduled)
                </option>
              ))}
            </select>
          </label>
          {roundId && <RoundPanel key={roundId} roundId={roundId} onChanged={() => loadRounds()} />}
        </>
      )}
    </div>
  );
}

function RoundPanel({ roundId, onChanged }: { roundId: string; onChanged: () => void }) {
  const [data, setData] = useState<GdRoundOverview | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError('');
      try {
        setData(await getGdRound(roundId, { signal }));
      } catch (err) {
        if (!signal?.aborted) setError(messageOf(err));
      }
    },
    [roundId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const updated = (next: GdRoundOverview) => {
    setData(next);
    onChanged();
  };

  if (error) return <ErrorNotice title="Could not load this round" message={error} action={<Button onClick={() => load()}>Try again</Button>} />;
  if (!data) {
    return (
      <Card className="flex min-h-32 items-center justify-center gap-3 text-muted">
        <Spinner className="text-accent" /> Loading the round…
      </Card>
    );
  }

  const groups = data.events.filter((e) => e.status === 'SCHEDULED').reduce((n, e) => n + e.batches.length, 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Waiting for a group" value={data.pool.length} />
        <Stat label="Groups scheduled" value={groups} />
        <Stat label="Topics" value={data.topics.length} />
      </div>

      {(!data.roundsComplete || data.topics.length === 0) && (
        <Card className="flex flex-col items-start gap-2">
          <p className="font-medium">{!data.roundsComplete ? 'The rounds of this job are still a draft' : 'This round has no discussion topics yet'}</p>
          <p className="text-sm text-muted">
            {!data.roundsComplete
              ? 'Students only reach the group discussion once the job\'s rounds are complete.'
              : 'Each question of the Group Discussion round is a topic. Add at least one before scheduling.'}
          </p>
          <Link href={`/publish?job=${encodeURIComponent(data.jobId)}`} className="text-sm font-medium text-accent hover:underline">
            Open the Publish page →
          </Link>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <WaitingList data={data} />
        <ScheduleForm data={data} onScheduled={updated} />
      </div>

      <section aria-labelledby="gd-events" className="flex flex-col gap-4">
        <h2 id="gd-events" className="text-lg font-semibold">
          Scheduled group discussions
        </h2>
        {data.events.length === 0 ? (
          <p className="text-sm text-muted">Nothing scheduled yet.</p>
        ) : (
          data.events.map((e) => <EventCard key={e.id} event={e} topics={data.topics} onUpdated={updated} />)
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function WaitingList({ data }: { data: GdRoundOverview }) {
  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">Waiting students</h2>
        <p className="text-sm text-muted">Added automatically when they pass the round before the group discussion.</p>
      </div>
      {data.pool.length === 0 ? (
        <p className="text-sm text-muted">No one is waiting right now.</p>
      ) : (
        <ul className="flex max-h-96 flex-col divide-y divide-border overflow-y-auto">
          {data.pool.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted">
                  {p.email}
                  {p.college ? ` · ${p.college}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted">since {dateTime.format(new Date(p.addedAt))}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type NumberKey = Exclude<keyof GdSettings, 'hrQuestionsEnabled'>;

const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string; min: number; max: number }[] = [
  { key: 'minGroupSize', label: 'Smallest group', hint: 'students', min: GD_LIMITS.groupSizeMin, max: GD_LIMITS.groupSizeMax },
  { key: 'maxGroupSize', label: 'Largest group', hint: 'students', min: GD_LIMITS.groupSizeMin, max: GD_LIMITS.groupSizeMax },
  { key: 'graceMinutes', label: 'Joining window', hint: 'minutes; then the room locks', min: 1, max: GD_LIMITS.graceMinutesMax },
  { key: 'introSeconds', label: 'Introduction', hint: 'seconds', min: GD_LIMITS.introSecondsMin, max: GD_LIMITS.introSecondsMax },
  { key: 'thinkingSeconds', label: 'Thinking time', hint: 'seconds', min: GD_LIMITS.thinkingSecondsMin, max: GD_LIMITS.thinkingSecondsMax },
  { key: 'discussionMinutes', label: 'Discussion', hint: 'minutes', min: GD_LIMITS.discussionMinutesMin, max: GD_LIMITS.discussionMinutesMax },
  { key: 'summarySeconds', label: 'Summary', hint: 'seconds per student', min: GD_LIMITS.summarySecondsMin, max: GD_LIMITS.summarySecondsMax },
  { key: 'silencePromptSeconds', label: 'Prompt after silence', hint: 'seconds', min: GD_LIMITS.silencePromptSecondsMin, max: GD_LIMITS.silencePromptSecondsMax },
  { key: 'breakMinutes', label: 'Break between groups', hint: 'minutes', min: 0, max: GD_LIMITS.breakMinutesMax },
];

function ScheduleForm({ data, onScheduled }: { data: GdRoundOverview; onScheduled: (d: GdRoundOverview) => void }) {
  const [name, setName] = useState(`${data.roundName} - ${dateTime.format(new Date()).split(',')[0]}`);
  const [start, setStart] = useState(defaultStart);
  const [settings, setSettings] = useState<GdSettings>(data.suggestedSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const parsed = gdSettingsSchema.safeParse(settings);
  const startDate = start ? new Date(start) : null;
  const preview = useMemo(() => {
    if (!parsed.success || !startDate || Number.isNaN(startDate.getTime())) return null;
    const plan = planGroupSizes(data.pool.length, settings.minGroupSize, settings.maxGroupSize);
    return { ...plan, slots: planGroupSlots(startDate, settings, plan.sizes) };
  }, [parsed.success, startDate?.getTime(), settings, data.pool.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSchedule = data.roundsComplete && data.topics.length > 0 && data.pool.length > 0 && parsed.success && !!preview && name.trim().length > 0;
  const set = (key: NumberKey, value: string) => setSettings((s) => ({ ...s, [key]: value === '' ? Number.NaN : Number(value) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSchedule || !startDate) return;
    setBusy(true);
    setError('');
    try {
      onScheduled(await createGdEvent(data.roundId, { name: name.trim(), startsAt: startDate.toISOString(), settings }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h2 className="text-lg font-semibold">Schedule a group discussion</h2>
          <p className="text-sm text-muted">All {data.pool.length} waiting students are put into groups that run one after another.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="gd-name" label="Name" required>
            <input id="gd-name" className={inputClass} value={name} maxLength={GD_LIMITS.nameMax} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="gd-start" label="First group starts" required hint={`At least ${GD_LIMITS.minLeadMinutes} minutes from now`}>
            <input id="gd-start" type="datetime-local" className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {NUMBER_FIELDS.map((f) => (
            <Field key={f.key} id={`gd-${f.key}`} label={f.label} required hint={f.hint}>
              <input
                id={`gd-${f.key}`}
                type="number"
                inputMode="numeric"
                className={inputClass}
                min={f.min}
                max={f.max}
                value={Number.isNaN(settings[f.key]) ? '' : settings[f.key]}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </Field>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={settings.hrQuestionsEnabled} onChange={(e) => setSettings((s) => ({ ...s, hrQuestionsEnabled: e.target.checked }))} />
            HR questions at the end
          </label>
          {settings.hrQuestionsEnabled && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="number"
                className={`${inputClass} w-20`}
                min={1}
                max={GD_LIMITS.hrQuestionsMinutesMax}
                value={Number.isNaN(settings.hrQuestionsMinutes) ? '' : settings.hrQuestionsMinutes}
                onChange={(e) => set('hrQuestionsMinutes', e.target.value)}
                aria-label="HR questions, minutes"
              />
              minutes
            </label>
          )}
        </div>

        {!parsed.success && <p className="text-sm font-medium text-danger">{parsed.error.issues[0]?.message}</p>}

        {preview && preview.sizes.length > 0 && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">
              {data.pool.length} students → {preview.sizes.length} group{preview.sizes.length === 1 ? '' : 's'} ({preview.sizes.join(', ')})
            </p>
            <ul className="mt-1 text-muted">
              {preview.slots.map((s, i) => (
                <li key={i}>
                  Group {i + 1}: {dateTime.format(s.startsAt)} – {time.format(s.endsAt)}
                </li>
              ))}
            </ul>
            {preview.undersized && (
              <p className="mt-2 font-medium text-danger">
                Some groups will have fewer than {settings.minGroupSize} students; there are not enough students for more even groups.
              </p>
            )}
          </div>
        )}

        {error && <ErrorNotice title="Could not schedule" message={error} />}
        <div>
          <Button type="submit" variant="primary" disabled={!canSchedule || busy}>
            {busy && <Spinner />} Schedule {preview?.sizes.length ?? 0} group{preview?.sizes.length === 1 ? '' : 's'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EventCard({ event, topics, onUpdated }: { event: GdEvent; topics: GdTopic[]; onUpdated: (d: GdRoundOverview) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editable = event.status === 'SCHEDULED' && event.batches.every((b) => b.status === 'SCHEDULED');

  async function run(action: () => Promise<GdRoundOverview>) {
    setBusy(true);
    setError('');
    try {
      onUpdated(await action());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const s = event.settings;
  return (
    <Card className={`flex flex-col gap-4 ${event.status === 'CANCELLED' ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{event.name}</h3>
          <p className="text-sm text-muted">
            {dateTime.format(new Date(event.startsAt))} · groups of {s.minGroupSize}–{s.maxGroupSize} · discussion {s.discussionMinutes} min ·{' '}
            {s.hrQuestionsEnabled ? `HR questions ${s.hrQuestionsMinutes} min` : 'no HR questions'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`${pill} ${event.status === 'CANCELLED' ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border text-muted'}`}>
            {event.status === 'SCHEDULED' ? 'Scheduled' : event.status === 'CANCELLED' ? 'Cancelled' : 'Completed'}
          </span>
          {editable && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Cancel "${event.name}"? Its students go back to the waiting list.`)) void run(() => cancelGdEvent(event.id));
              }}
            >
              Cancel event
            </Button>
          )}
        </div>
      </div>
      {event.undersized && event.status !== 'CANCELLED' && (
        <p className="text-sm text-danger">Some groups are smaller than {s.minGroupSize} students.</p>
      )}
      {error && <ErrorNotice title="That did not work" message={error} />}

      {event.status !== 'CANCELLED' && (
        <div className="grid gap-3 md:grid-cols-2">
          {event.batches.map((b) => (
            <div key={b.id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">
                  Group {b.number} · {time.format(new Date(b.startsAt))}–{time.format(new Date(b.endsAt))}
                </span>
                <span className={`${pill} border-border text-muted`}>{BATCH[b.status]}</span>
              </div>
              <div className="flex gap-3 text-xs font-medium">
                <Link href={`/group-discussion/live/${encodeURIComponent(b.id)}`} className="text-accent hover:underline">
                  {b.status === 'LOBBY_OPEN' || b.status === 'IN_PROGRESS' ? '● Join live' : 'Live page'}
                </Link>
                {b.status === 'COMPLETED' && (
                  <Link href={`/group-discussion/results/${encodeURIComponent(b.id)}`} className="text-accent hover:underline">
                    Results
                  </Link>
                )}
              </div>
              {b.status === 'SCHEDULED' && topics.length > 0 ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Topic
                  <select
                    className={inputClass}
                    value={b.topic?.id ?? ''}
                    disabled={busy}
                    onChange={(e) => void run(() => setGdBatchTopic(b.id, e.target.value))}
                  >
                    {!b.topic && <option value="">Pick a topic</option>}
                    {topics.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.text}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-sm">
                  <span className="text-muted">Topic: </span>
                  {b.topic?.text ?? '—'}
                </p>
              )}
              <ul className="flex flex-wrap gap-1.5">
                {b.participants.map((p) => (
                  <li key={p.id} className={`${pill} ${ATTENDANCE[p.attendance].style}`} title={`${p.email} · ${ATTENDANCE[p.attendance].text}`}>
                    {p.name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
