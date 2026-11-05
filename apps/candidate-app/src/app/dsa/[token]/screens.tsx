import { useState } from 'react';
import type { AssessmentState, FinalResult } from '@/lib/dsa-api';
import { LANGUAGE_LABELS } from '@/lib/dsa-api';
import { Badge, Button, Card, Spinner } from '@/components/ui';
import { difficultyTone } from './problem-panel';
import { CameraCheck, type CameraMonitor } from './camera-monitor';

export function LoadingScreen() {
  return (
    <main className="mx-auto flex max-w-3xl items-center justify-center gap-2 px-4 py-24 text-sm text-muted">
      <Spinner /> Loading your assessment…
    </main>
  );
}

export function ErrorScreen({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <Card className="flex flex-col gap-3 p-6">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p role="alert" className="text-sm text-muted">
          {message}
        </p>
        {onRetry && (
          <div>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        )}
      </Card>
    </main>
  );
}

export function IntroScreen({
  state,
  starting,
  error,
  onStart,
  camera,
}: {
  state: AssessmentState;
  starting: boolean;
  error: string;
  onStart: (consented: boolean) => void;
  /** Present when the attempt is watched by the AI camera. */
  camera?: CameraMonitor;
}) {
  const [consented, setConsented] = useState(false);
  const p = state.proctoring;
  const cameraReady = !camera || camera.status === 'on';
  const needsConsent = p.enabled;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Card className="flex flex-col gap-6 p-5 sm:p-8">
        <header className="flex flex-col gap-1">
          <p className="text-sm text-muted">Welcome, {state.candidateName}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{state.title}</h1>
        </header>

        <dl className="grid grid-cols-3 gap-3">
          {[
            ['Duration', `${state.durationMinutes} min`],
            ['Questions', String(state.overview.length)],
            ['Total marks', String(state.totalMarks)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-md border border-border bg-background px-3 py-2">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="text-lg font-semibold">{v}</dd>
            </div>
          ))}
        </dl>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Questions</h2>
          <ul className="flex flex-col gap-2">
            {state.overview.map((q, i) => (
              <li key={q.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-muted">{i + 1}.</span>
                <span className="font-medium">{q.title}</span>
                <span className="ml-auto flex items-center gap-2">
                  <Badge tone={difficultyTone(q.difficulty)}>{q.difficulty}</Badge>
                  <span className="text-xs text-muted">{q.marks} marks</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Instructions</h2>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
            <li>
              The {state.durationMinutes}-minute timer starts when you press Start and cannot be paused. It runs on our server, so
              refreshing or closing this page does not reset it.
            </li>
            {state.languages.length === 1 && state.languages[0] === 'sql' ? (
              <>
                <li>Answer each question with one SQL query (SELECT, SQLite). Each question shows its tables, sample data and the expected output. Switch between questions freely; your queries are kept.</li>
                <li>Run query checks your query against the sample datasets. Nothing is scored.</li>
                <li>Submit answer judges your query against the sample datasets and hidden datasets, and scores it. You may submit again; your best score per question counts.</li>
                <li>Partial credit is given for the share of datasets passed.</li>
              </>
            ) : (
              <>
                <li>Solve in {state.languages.map((l) => LANGUAGE_LABELS[l]).join(', ')}. Switch between questions freely; your code is kept.</li>
                <li>Run checks your code against the visible sample tests. Nothing is scored.</li>
                <li>Submit judges your code against the sample tests and hidden tests, and scores it. You may submit again; your best score per question counts.</li>
                <li>Partial credit is given for the share of tests passed.</li>
              </>
            )}
            <li>When time runs out, the assessment ends automatically and your best scores are recorded.</li>
          </ul>
        </section>

        {p.enabled && (
          <section aria-labelledby="monitoring-title" className="flex flex-col gap-3 rounded-md border border-border bg-accent-soft px-4 py-3">
            <h2 id="monitoring-title" className="text-sm font-semibold">
              {camera ? 'Monitoring, webcam and full-screen mode' : 'Monitoring and full-screen mode'}
            </h2>
            <p className="text-sm">
              {p.requireFullscreen
                ? 'This assessment must be taken in full-screen mode. When you press Start, your browser will ask to go full screen. If you leave full screen, the assessment is blocked until you return, the timer keeps running, and the time away is recorded.'
                : 'This assessment is monitored for integrity.'}
              {camera &&
                ' Your webcam must stay on for the whole assessment, with your face clearly visible, looking at the screen, and nobody else in view. A single glance away never counts: only repeated or long looks away are noted. If the camera turns off, the assessment is blocked until you turn it back on.'}
            </p>
            {camera && <CameraCheck cam={camera} />}
            <div>
              <p className="text-xs font-medium text-muted">Your browser reports these events to us</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {p.monitored.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-muted">What we do not do</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                {camera ? (
                  <li>
                    The webcam video stays on your computer: it is checked there, and no video, image or face data is recorded or uploaded (only short
                    alerts such as &ldquo;looked left 4 times in 60 s&rdquo;). No microphone or screen recording.
                  </li>
                ) : (
                  <li>No camera, microphone or screen recording.</li>
                )}
                <li>We do not see other tabs, other applications, passwords or what you type, only the event type, time and how long.</li>
                <li>Copy, cut and paste are disabled in the editor and the questions. Your own code stays usable.</li>
              </ul>
            </div>
            <p className="text-xs text-muted">
              These events are kept with your assessment record and reviewed by the hiring team.
              A normal web page cannot lock your computer: it can only detect and record what the browser reports.
            </p>
            {p.maxStrikes > 0 && (
              <p className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
                <span className="font-semibold">Warnings: </span>
                you are allowed {p.maxStrikes} suspicious {p.maxStrikes === 1 ? 'action' : 'actions'} (for example a screenshot key, switching tabs, copying,
                leaving full screen{camera ? ', the webcam turning off, repeatedly looking away, your face not being visible, or another person in view' : ''}). Each one is recorded and shown to you as a warning. After that, the next suspicious action, including leaving full screen,
                ends your assessment immediately. Your answers submitted so far are kept.
              </p>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
              />
              <span>I have read this notice and agree to take the assessment under these conditions.</span>
            </label>
          </section>
        )}

        {error && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <div>
          <Button variant="primary" onClick={() => onStart(consented)} disabled={starting || (needsConsent && !consented) || !cameraReady}>
            {starting && <Spinner />} {p.enabled && p.requireFullscreen ? 'Start in full screen' : 'Start assessment'}
          </Button>
        </div>
      </Card>
    </main>
  );
}

export function ResultScreen({ result, candidateName, showScore = true }: { result: FinalResult; candidateName: string; showScore?: boolean }) {
  // An HR round: no score, no pass / fail and no per-problem marks. The hiring team writes to the candidate.
  if (!showScore) return <SubmittedScreen result={result} candidateName={candidateName} />;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <Card className="flex flex-col gap-6 p-5 sm:p-8">
        <header className="flex flex-col gap-1">
          <p className="text-sm text-muted">{candidateName}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Assessment complete</h1>
          <p className="text-sm text-muted">
            {result.reason === 'time_expired'
              ? 'Time ran out, so the assessment ended automatically. Your best scores were recorded.'
              : result.reason === 'disqualified'
                ? 'The assessment was ended automatically because the allowed number of warnings was used up. Your answers submitted so far were recorded and will be reviewed by the hiring team.'
                : 'Your assessment was submitted. Your best scores were recorded.'}
          </p>
        </header>

        <div className="flex flex-wrap items-end gap-x-6 gap-y-2 rounded-md border border-border bg-accent-soft px-4 py-4">
          <div>
            <p className="text-xs text-muted">Total score</p>
            <p className="text-3xl font-semibold tracking-tight">
              {result.totalScore}
              <span className="text-lg font-normal text-muted"> / {result.maxScore}</span>
            </p>
          </div>
          <div>
            <p className="text-xs text-muted">Percentage</p>
            <p className="text-xl font-semibold">{result.percentage}%</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Question</th>
                <th className="py-2 pr-3 font-medium">Tests passed</th>
                <th className="py-2 pr-3 font-medium">Submissions</th>
                <th className="py-2 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {result.questions.map((q) => (
                <tr key={q.questionId} className="border-b border-border last:border-0">
                  <td className="py-3 pr-3">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{q.title}</span>
                      <span className="flex items-center gap-2">
                        <Badge tone={difficultyTone(q.difficulty)}>{q.difficulty}</Badge>
                        {q.solved ? <Badge tone="success">Solved</Badge> : q.attempts === 0 ? <Badge>Not attempted</Badge> : <Badge tone="danger">Partial</Badge>}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 pr-3">{q.attempts === 0 ? '—' : `${q.passed} / ${q.total}`}</td>
                  <td className="py-3 pr-3">
                    {q.attempts}
                    {q.language ? <span className="text-muted"> · {LANGUAGE_LABELS[q.language]}</span> : null}
                  </td>
                  <td className="py-3 text-right font-medium">
                    {q.score} / {q.marks}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-sm text-muted">You can now close this window. The hiring team will review your results.</p>
      </Card>
    </main>
  );
}

function SubmittedScreen({ result, candidateName }: { result: FinalResult; candidateName: string }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <Card className="flex flex-col gap-4 p-5 sm:p-8">
        <header className="flex flex-col gap-1">
          <p className="text-sm text-muted">{candidateName}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Assessment complete</h1>
        </header>
        <p className="text-sm">
          {result.reason === 'time_expired'
            ? 'Time ran out, so the assessment ended automatically. Everything you submitted before that was recorded.'
            : result.reason === 'disqualified'
              ? 'The assessment was ended automatically because the allowed number of warnings was used up. Everything you submitted before that was recorded and will be reviewed by the hiring team.'
              : 'Your solutions were submitted successfully.'}
        </p>
        <p className="text-sm text-muted">Thank you for taking the test. The hiring team will review your work and contact you by email about the next step. You can now close this window.</p>
      </Card>
    </main>
  );
}
