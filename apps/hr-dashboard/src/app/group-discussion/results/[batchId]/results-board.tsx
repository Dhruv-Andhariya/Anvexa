'use client';

import { GD_CRITERIA, GD_CRITERION_LABEL, type GdRecommendation, type GdResultStudent, type GdResults } from '@hireflow/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { SessionRecording } from '@/components/gd/session-recording';
import { confirmGdSelection, getGdResults, includePrivateTalk, rebuildGdSessionAudio, reprocessGd, setGdDecision, setGdRubricScores } from '@/lib/gd-api';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const pill = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium';
const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const DECISION: Record<GdRecommendation, { text: string; style: string }> = {
  SELECTED: { text: 'Selected', style: 'border-success/40 bg-success-soft text-success' },
  NOT_SELECTED: { text: 'Not selected', style: 'border-danger/40 bg-danger-soft text-danger' },
};

/**
 * HR results of one group: the whole session as one audio recording, ranked students with the AI's scores,
 * recommendation and the evidence quotes behind each score, HR's overrides (logged with name and time), private talks in / out of the evaluation, and "Confirm selection"
 * (results recorded, result emails sent). Nothing is final until HR confirms.
 */
export function ResultsBoard({ batchId }: { batchId: string }) {
  const [data, setData] = useState<GdResults | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getGdResults(batchId));
      setError('');
    } catch (err) {
      setError(messageOf(err));
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  // keep fresh while the evaluation runs or emails go out
  const running = data?.processing.status === 'PENDING' || data?.processing.status === 'RUNNING' || data?.batchStatus === 'IN_PROGRESS' || data?.batchStatus === 'LOBBY_OPEN';
  const sending = !!data?.students.some((s) => s.resultEmail && s.resultEmail.status !== 'SENT' && s.resultEmail.status !== 'FAILED');
  useEffect(() => {
    if (!running && !sending) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [running, sending, load]);

  async function run(action: () => Promise<GdResults>) {
    setBusy(true);
    setError('');
    try {
      setData(await action());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return error ? (
      <ErrorNotice title="Could not load the results" message={error} action={<Button onClick={() => load()}>Try again</Button>} />
    ) : (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Loading results…
      </Card>
    );
  }

  const confirmed = !!data.confirmedAt;
  const selected = data.students.filter((s) => s.finalDecision === 'SELECTED').length;
  const canConfirm = !confirmed && data.batchStatus === 'COMPLETED' && data.processing.status !== 'PENDING' && data.processing.status !== 'RUNNING';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/group-discussion?round=${encodeURIComponent(data.roundId)}`} className="text-sm text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
            ← Group Discussion
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">
            Results · {data.eventName} · Group {data.number}
          </h1>
          <p className="text-sm text-muted">
            {data.jobTitle} · {data.roundName} · {dateTime.format(new Date(data.startsAt))}
          </p>
          {data.topic && (
            <p className="mt-1 text-sm">
              <span className="text-muted">Topic:</span> {data.topic}
            </p>
          )}
        </div>
        <Link href={`/group-discussion/live/${encodeURIComponent(batchId)}`} className="text-sm font-medium text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">
          Live page →
        </Link>
      </div>

      <Processing data={data} busy={busy} onRetry={() => void run(() => reprocessGd(batchId))} />
      {error && <ErrorNotice title="That did not work" message={error} />}
      <SessionCard data={data} busy={busy} onRebuild={() => void run(() => rebuildGdSessionAudio(batchId))} />

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">
            {selected} of {data.students.length} selected
          </p>
          <p className="text-sm text-muted">
            {confirmed
              ? `Confirmed ${dateTime.format(new Date(data.confirmedAt!))}. Result emails go out automatically.`
              : data.rubric
                ? 'Score every student on the rubric (the AI’s scores are a guide); the rubric total decides unless you override it. Then confirm to record the results.'
                : 'The AI recommends; you decide. Change any decision below, then confirm to record the results and email every student.'}
          </p>
        </div>
        {!confirmed && (
          <Button
            variant="primary"
            disabled={!canConfirm || busy}
            onClick={() => {
              if (window.confirm(`Confirm the selection? ${selected} student(s) will get the "selected" email and the others a polite update. This cannot be undone.`)) {
                void run(() => confirmGdSelection(batchId));
              }
            }}
          >
            Confirm selection
          </Button>
        )}
      </Card>

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Student</th>
              <th className="px-3 py-2">Overall</th>
              <th className="px-3 py-2">AI recommends</th>
              <th className="px-3 py-2">Decision</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.students.map((s, i) => (
              <StudentRow
                key={s.participantId}
                rank={i + 1}
                s={s}
                open={open === s.participantId}
                onToggle={() => setOpen(open === s.participantId ? null : s.participantId)}
                disabled={busy || confirmed}
                onDecide={(decision, reason) => void run(() => setGdDecision(batchId, s.participantId, decision, reason))}
                rubric={data.rubric ?? null}
                onScore={(scores, remarks) => run(() => setGdRubricScores(batchId, s.participantId, scores, remarks))}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Card className="flex flex-col gap-3">
        <h2 className="font-semibold">Private talks</h2>
        {data.privateTalks.length === 0 ? (
          <p className="text-sm text-muted">No private talks in this group.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.privateTalks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {t.studentName} · {dateTime.format(new Date(t.startedAt))}
                  {t.endedAt ? ` – ${dateTime.format(new Date(t.endedAt))}` : ' (running)'}
                </span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={t.includeInEvaluation} disabled={busy || confirmed} onChange={(e) => void run(() => includePrivateTalk(t.id, e.target.checked))} />
                  Include in evaluation
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">Private talks are left out of the scoring unless you include them; changing this evaluates the group again.</p>
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="font-semibold">HR activity log</h2>
        {data.activity.length === 0 ? (
          <p className="text-sm text-muted">Nothing logged.</p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto text-xs">
            {data.activity.map((a, i) => (
              <li key={i}>
                <span className="text-muted">{dateTime.format(new Date(a.at))}</span> · {a.hrName ?? 'HR'} · {a.kind.toLowerCase().replace(/_/g, ' ')}
                {a.participantName ? ` · ${a.participantName}` : ''}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Processing({ data, busy, onRetry }: { data: GdResults; busy: boolean; onRetry: () => void }) {
  if (data.batchStatus !== 'COMPLETED') {
    return (
      <Card>
        <p className="font-medium">This group discussion has not finished yet.</p>
        <p className="text-sm text-muted">Results appear here a few minutes after it ends.</p>
      </Card>
    );
  }
  const p = data.processing;
  if (p.status === 'PENDING' || p.status === 'RUNNING') {
    return (
      <Card className="flex items-center gap-3">
        <Spinner className="text-muted" />
        <div>
          <p className="font-medium">Transcribing and evaluating…</p>
          <p className="text-sm text-muted">Every student&apos;s audio is transcribed, then scored against the rubric. This takes a few minutes.{p.error ? ` Last attempt: ${p.error}` : ''}</p>
        </div>
      </Card>
    );
  }
  if (p.status === 'FAILED') {
    return (
      <ErrorNotice
        title="The evaluation could not finish"
        message={`${p.error ?? 'Unknown error.'} Check that the GD worker is running, then try again. You can also decide by hand.`}
        action={
          <Button disabled={busy} onClick={onRetry}>
            Evaluate again
          </Button>
        }
      />
    );
  }
  return null;
}

function StudentRow({
  rank,
  s,
  open,
  onToggle,
  disabled,
  onDecide,
  rubric,
  onScore,
}: {
  rank: number;
  s: GdResultStudent;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  onDecide: (decision: GdRecommendation | null, reason: string) => void;
  rubric: { name: string; maxMarks: number }[] | null;
  onScore: (scores: { parameter: string; marks: number }[], remarks: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(s.hrDecision?.reason ?? '');
  const [scoring, setScoring] = useState(false);
  const e = s.evaluation;
  const absent = s.attendance === 'ABSENT' || s.attendance === 'INVITED' || s.attendance === 'SCHEDULED';
  const value = s.hrDecision?.decision ?? 'AI';
  return (
    <>
      <tr className="border-b border-border align-top">
        <td className="px-3 py-2 tabular-nums text-muted">{rank}</td>
        <td className="px-3 py-2">
          <p className="font-medium">{s.name}</p>
          <p className="text-xs text-muted">{s.email}</p>
          {absent && <span className={`${pill} mt-1 border-border text-muted`}>Absent</span>}
          {rubric && !absent && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {s.rubric ? (
                <span className={`${pill} ${s.rubric.passed ? DECISION.SELECTED.style : DECISION.NOT_SELECTED.style}`}>
                  Rubric {s.rubric.total} / {s.rubric.maxTotal}
                </span>
              ) : (
                <span className={`${pill} border-danger/40 text-danger`}>Not scored yet</span>
              )}
              {!disabled && (
                <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setScoring(!scoring)} aria-expanded={scoring}>
                  {scoring ? 'Close' : s.rubric ? 'Edit scores' : 'Score'}
                </Button>
              )}
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-lg font-semibold tabular-nums">{e?.overall != null ? e.overall.toFixed(1) : '—'}</td>
        <td className="px-3 py-2">
          {e?.recommendation ? <span className={`${pill} ${DECISION[e.recommendation].style}`}>{DECISION[e.recommendation].text}</span> : <span className="text-muted">—</span>}
          {e?.status === 'NO_AUDIO' && <p className="mt-1 text-xs text-muted">No audio recorded</p>}
          {e?.status === 'FAILED' && <p className="mt-1 text-xs text-danger">Evaluation failed</p>}
        </td>
        <td className="px-3 py-2">
          {absent ? (
            <span className={`${pill} ${DECISION.NOT_SELECTED.style}`}>Not selected</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              <select
                className={`${inputClass} w-auto py-1`}
                value={value}
                disabled={disabled}
                onChange={(ev) => onDecide(ev.target.value === 'AI' ? null : (ev.target.value as GdRecommendation), reason)}
                aria-label={`Decision for ${s.name}`}
              >
                {rubric ? (
                  <option value="AI">Follow rubric ({s.rubric ? (s.rubric.passed ? 'selected' : 'not selected') : 'not scored yet'})</option>
                ) : (
                  <option value="AI">Follow AI ({e?.recommendation ? DECISION[e.recommendation].text.toLowerCase() : 'not selected'})</option>
                )}
                <option value="SELECTED">Selected (override)</option>
                <option value="NOT_SELECTED">Not selected (override)</option>
              </select>
              {s.hrDecision && (
                <p className="text-xs text-muted">
                  by {s.hrDecision.by ?? 'HR'}, {dateTime.format(new Date(s.hrDecision.at))}
                </p>
              )}
              <span className={`${pill} self-start ${DECISION[s.finalDecision].style}`}>Final: {DECISION[s.finalDecision].text}</span>
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-xs text-muted">{s.resultEmail ? `${s.resultEmail.status.toLowerCase()}${s.resultEmail.sentAt ? ` ${dateTime.format(new Date(s.resultEmail.sentAt))}` : ''}` : '—'}</td>
        <td className="px-3 py-2">
          {e && (
            <Button variant="ghost" className="px-2 py-1 text-xs" onClick={onToggle} aria-expanded={open}>
              {open ? 'Hide' : 'Details'}
            </Button>
          )}
        </td>
      </tr>
      {scoring && rubric && (
        <tr className="border-b border-border bg-background/60">
          <td colSpan={7} className="px-3 py-4">
            <RubricForm
              name={s.name}
              rubric={rubric}
              initial={s.rubric ?? null}
              onSave={async (scores, remarks) => {
                await onScore(scores, remarks);
                setScoring(false);
              }}
            />
          </td>
        </tr>
      )}
      {open && e && (
        <tr className="border-b border-border bg-background/60">
          <td colSpan={7} className="px-3 py-4">
            <div className="grid gap-5 lg:grid-cols-3">
              <div>
                <p className="mb-2 text-xs font-medium uppercase text-muted">Scores (1-10)</p>
                {e.scores ? (
                  <ul className="flex flex-col gap-1.5">
                    {GD_CRITERIA.map((c) => {
                      const v = e.scores![c];
                      return (
                        <li key={c} className="text-sm">
                          <div className="flex justify-between gap-2">
                            <span>{GD_CRITERION_LABEL[c]}</span>
                            <span className="tabular-nums font-medium">{v ?? 'n/a'}</span>
                          </div>
                          {v != null && (
                            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-border">
                              <div className="h-full bg-accent" style={{ width: `${v * 10}%` }} />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-muted">{e.error ?? 'No scores.'}</p>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase text-muted">Speaking metrics</p>
                {e.metrics ? (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted">Talk time</dt>
                    <dd className="tabular-nums">
                      {Math.round(e.metrics.talkSeconds)} s ({Math.round(e.metrics.talkShare * 100)}%)
                    </dd>
                    <dt className="text-muted">Words / minute</dt>
                    <dd className="tabular-nums">{Math.round(e.metrics.wordsPerMinute)}</dd>
                    <dt className="text-muted">Turns</dt>
                    <dd className="tabular-nums">{e.metrics.turns}</dd>
                    <dt className="text-muted">Interruptions</dt>
                    <dd className="tabular-nums">{e.metrics.interruptions}</dd>
                    <dt className="text-muted">Filler words</dt>
                    <dd className="tabular-nums">{e.metrics.fillerWords}</dd>
                    <dt className="text-muted">Summary</dt>
                    <dd className="tabular-nums">{Math.round(e.metrics.summarySeconds)} s</dd>
                    <dt className="text-muted">Answered HR</dt>
                    <dd>{e.metrics.answeredHr ? 'Yes' : 'No'}</dd>
                  </dl>
                ) : (
                  <p className="text-sm text-muted">—</p>
                )}
                {e.feedback && <p className="mt-3 text-sm">{e.feedback}</p>}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium uppercase text-muted">Evidence</p>
                {e.evidence.length === 0 ? (
                  <p className="text-sm text-muted">No quotes.</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {e.evidence.map((ev, i) => (
                      <li key={i}>
                        <span className="text-xs font-medium text-muted">{GD_CRITERION_LABEL[ev.criterion as keyof typeof GD_CRITERION_LABEL] ?? ev.criterion}</span>
                        <blockquote className="border-l-2 border-accent pl-2 italic">“{ev.quote}”</blockquote>
                        <p className="text-xs text-muted">{ev.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {!disabled && (
                  <label className="mt-3 flex flex-col gap-1 text-xs font-medium">
                    Reason for an override (saved with the next decision change)
                    <input className={inputClass} value={reason} maxLength={500} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. strong answers to HR" />
                  </label>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** The whole session as one audio file: built by the GD worker right after the evaluation. */
function SessionCard({ data, busy, onRebuild }: { data: GdResults; busy: boolean; onRebuild: () => void }) {
  if (data.batchStatus !== 'COMPLETED') return null;
  const processing = data.processing.status === 'PENDING' || data.processing.status === 'RUNNING';
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="font-semibold">Session recording</h2>
      {data.sessionAudio ? (
        <SessionRecording batchId={data.batchId} audio={data.sessionAudio} />
      ) : processing ? (
        <p className="text-sm text-muted">Everyone&apos;s audio is combined into one recording right after the evaluation.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {data.sessionAudioError ? `The recording could not be built: ${data.sessionAudioError}` : 'No session recording yet.'}
          </p>
          <Button variant="secondary" disabled={busy} onClick={onRebuild}>
            {busy ? 'Building…' : 'Build the recording'}
          </Button>
        </div>
      )}
    </Card>
  );
}

/** HR's evaluator form: one mark per rubric parameter, never more than its maximum. */
function RubricForm({
  name,
  rubric,
  initial,
  onSave,
}: {
  name: string;
  rubric: { name: string; maxMarks: number }[];
  initial: { scores: { parameter: string; marks: number }[]; remarks: string } | null;
  onSave: (scores: { parameter: string; marks: number }[], remarks: string) => Promise<void>;
}) {
  const [marks, setMarks] = useState<Record<string, string>>(() =>
    Object.fromEntries(rubric.map((p) => [p.name, String(initial?.scores.find((x) => x.parameter === p.name)?.marks ?? '')])),
  );
  const [remarks, setRemarks] = useState(initial?.remarks ?? '');
  const [saving, setSaving] = useState(false);
  const problems = rubric
    .map((p) => {
      const raw = marks[p.name] ?? '';
      const n = Number(raw);
      if (raw.trim() === '') return `Score ${p.name}.`;
      return !Number.isFinite(n) || n < 0 || n > p.maxMarks ? `${p.name}: between 0 and ${p.maxMarks}.` : null;
    })
    .filter((x): x is string => !!x);
  const total = rubric.reduce((sum, p) => sum + (Number(marks[p.name]) || 0), 0);
  const max = rubric.reduce((sum, p) => sum + p.maxMarks, 0);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (problems.length) return;
        setSaving(true);
        void onSave(rubric.map((p) => ({ parameter: p.name, marks: Number(marks[p.name]) })), remarks.trim()).finally(() => setSaving(false));
      }}
    >
      <p className="text-sm font-medium">Rubric scores for {name}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rubric.map((p) => (
          <label key={p.name} className="flex flex-col gap-1 text-sm">
            {p.name} <span className="text-xs text-muted">out of {p.maxMarks}</span>
            <input
              type="number"
              min={0}
              max={p.maxMarks}
              step="0.5"
              className={`${inputClass} w-28`}
              value={marks[p.name] ?? ''}
              aria-invalid={problems.some((x) => x.startsWith(p.name))}
              onChange={(ev) => setMarks({ ...marks, [p.name]: ev.target.value })}
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        Remarks (optional, kept with the result)
        <textarea className={inputClass} rows={2} maxLength={1000} value={remarks} onChange={(ev) => setRemarks(ev.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || problems.length > 0}>
          {saving && <Spinner />} Save scores
        </Button>
        <span className="text-sm tabular-nums">
          Total {Math.round(total * 100) / 100} / {max}
        </span>
        {problems.length > 0 && <span className="text-xs text-danger">{problems[0]}</span>}
      </div>
    </form>
  );
}
