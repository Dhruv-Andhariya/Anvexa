'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Spinner, inputClass } from '@/components/ui';
import {
  ApiError,
  LANGUAGE_LABELS,
  finishAssessment,
  formatClock,
  getAssessment,
  runCode,
  startAssessment,
  startProctoring,
  submitCode,
  type AssessmentState,
  type Language,
  type PublicQuestion,
  type QuestionProgress,
} from '@/lib/dsa-api';
import { CodeEditor } from './code-editor';
import { ProblemPanel, difficultyTone } from './problem-panel';
import { ResultsPanel, type PanelResult } from './results-panel';
import { FullscreenGate, ProctorNotice, enterFullscreen, fullscreenSupported, inFullscreen, leaveFullscreen, useProctoring } from './proctoring';
import { ErrorScreen, IntroScreen, LoadingScreen, ResultScreen } from './screens';

interface Saved {
  drafts: Record<string, string>;
  language: Language;
  activeId: string | null;
}

const storageKey = (token: string) => `hf-dsa:${token}`;
const draftKey = (questionId: string, language: Language) => `${questionId}:${language}`;

function loadSaved(token: string): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey(token));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function persist(token: string, saved: Saved) {
  try {
    window.sessionStorage.setItem(storageKey(token), JSON.stringify(saved));
  } catch {
    // storage unavailable: drafts then live in memory only
  }
}

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');

export function Assessment({ token }: { token: string }) {
  const [state, setState] = useState<AssessmentState | null>(null);
  const [fatal, setFatal] = useState<{ title: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');

  const [activeId, setActiveId] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>('python');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, PanelResult>>({});
  const [busy, setBusy] = useState<'run' | 'submit' | null>(null);
  const [actionError, setActionError] = useState('');
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // Countdown. The server's clock is the source of truth; we only display the difference.
  const [now, setNow] = useState(() => Date.now());
  const clockOffset = useRef(0);
  const hydrated = useRef(false);

  const applyState = useCallback((next: AssessmentState) => {
    const received = Date.now();
    clockOffset.current = Date.parse(next.serverTime) - received;
    setNow(received); // the ticker only runs while in progress, so `now` may be stale
    setState(next);
  }, []);

  const load = useCallback(async () => {
    setFatal(null);
    try {
      applyState(await getAssessment(token));
    } catch (err) {
      setFatal({
        title: err instanceof ApiError && err.code === 'INVALID_TOKEN' ? 'Link not valid' : 'Could not load the assessment',
        message: errorMessage(err),
      });
    }
  }, [token, applyState]);

  useEffect(() => {
    void load();
  }, [load]);

  // Restore drafts once, after the first state arrives.
  useEffect(() => {
    if (!state || hydrated.current) return;
    hydrated.current = true;
    resumedLoad.current = state.status === 'in_progress'; // the page was opened in the middle of an attempt
    const saved = loadSaved(token);
    if (saved) {
      setDrafts(saved.drafts ?? {});
      if (saved.language) setLanguage(saved.language);
    }
    const first = state.questions?.[0]?.id ?? null;
    const wanted = saved?.activeId && state.questions?.some((q) => q.id === saved.activeId) ? saved.activeId : first;
    setActiveId(wanted);
  }, [state, token]);

  useEffect(() => {
    if (!hydrated.current) return;
    persist(token, { drafts, language, activeId });
  }, [token, drafts, language, activeId]);

  const inProgress = state?.status === 'in_progress';

  // Integrity monitoring (full screen, focus, clipboard, shortcuts). The server decides what the events mean.
  const resumedLoad = useRef(false);
  const proctor = useProctoring({
    token,
    config: state?.proctoring ?? null,
    active: inProgress,
    resumed: resumedLoad.current,
    serverNow: () => Date.now() + clockOffset.current,
    onEnded: () => void load(),
  });
  useEffect(() => {
    if (state?.status === 'finished') void leaveFullscreen();
  }, [state?.status]);

  useEffect(() => {
    if (!inProgress) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [inProgress]);

  const remaining =
    inProgress && state?.deadlineAt
      ? Math.max(0, Math.ceil((Date.parse(state.deadlineAt) - (now + clockOffset.current)) / 1000))
      : null;

  // When the countdown reaches zero, ask the server: it decides that the assessment is over.
  const expiryPolls = useRef(0);
  useEffect(() => {
    if (remaining !== 0 || !inProgress) {
      expiryPolls.current = 0;
      return;
    }
    if (expiryPolls.current++ % 3 === 0) void load();
  }, [remaining, inProgress, now, load]);

  // Re-sync with the server when the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && hydrated.current) void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const questions = state?.questions;
  const question: PublicQuestion | undefined = useMemo(
    () => questions?.find((q) => q.id === activeId) ?? questions?.[0],
    [questions, activeId],
  );
  const progressById = useMemo(() => {
    const map = new Map<string, QuestionProgress>();
    state?.progress.forEach((p) => map.set(p.questionId, p));
    return map;
  }, [state?.progress]);

  if (fatal) return <ErrorScreen title={fatal.title} message={fatal.message} onRetry={fatal.title === 'Link not valid' ? undefined : () => void load()} />;
  if (!state) return <LoadingScreen />;

  if (state.status === 'finished' && state.result) {
    return <ResultScreen result={state.result} candidateName={state.candidateName} showScore={state.showScore} />;
  }

  if (state.status === 'not_started') {
    return (
      <IntroScreen
        state={state}
        starting={starting}
        error={startError}
        onStart={async (consented) => {
          const p = state.proctoring;
          setStartError('');
          // Full screen must be requested straight from the click, before any await (browsers need the user gesture).
          let fsOn = false;
          if (p.enabled && p.requireFullscreen) {
            if (!fullscreenSupported()) {
              setStartError('This browser cannot enter full-screen mode, which this assessment requires. Please use a current desktop version of Chrome, Edge or Firefox.');
              return;
            }
            fsOn = await enterFullscreen();
            if (!fsOn) {
              setStartError('Full-screen mode was not allowed, so the assessment has not started. Allow full screen and press Start again.');
              return;
            }
          }
          setStarting(true);
          try {
            if (p.enabled) {
              if (!consented) throw new ApiError(400, 'CONSENT_REQUIRED', 'Please accept the monitoring notice to start.');
              await startProctoring(token, { consentVersion: p.consentVersion, fullscreen: inFullscreen() });
            }
            applyState(await startAssessment(token));
          } catch (err) {
            await leaveFullscreen(); // nothing started, so do not leave the candidate stuck in full screen
            setStartError(errorMessage(err));
          } finally {
            setStarting(false);
          }
        }}
      />
    );
  }

  if (!question) return <LoadingScreen />;

  const code = drafts[draftKey(question.id, language)] ?? question.starterCode[language];
  const setCode = (next: string) => setDrafts((d) => ({ ...d, [draftKey(question.id, language)]: next }));
  const lowTime = remaining !== null && remaining <= 300;
  const strikesAllowed = state.proctoring.maxStrikes;
  const strikesUsed = Math.max(proctor.strikesUsed, state.proctoring.strikesUsed);
  const needFullscreen = proctor.enabled && state.proctoring.requireFullscreen && !proctor.fullscreen;
  const blocked = needFullscreen && state.proctoring.fullscreenReentry === 'block';
  const reenter = async () => {
    const ok = await proctor.reenter();
    setActionError(ok ? '' : 'Your browser did not switch to full screen. Press the button again.');
  };

  const execute = async (kind: 'run' | 'submit') => {
    if (busy) return;
    setBusy(kind);
    setActionError('');
    try {
      const payload = { questionId: question.id, language, code };
      if (kind === 'run') {
        const data = await runCode(token, payload);
        setResults((r) => ({ ...r, [question.id]: { kind, data } }));
      } else {
        const data = await submitCode(token, payload);
        setResults((r) => ({ ...r, [question.id]: { kind, data } }));
        setState((s) => (s ? { ...s, progress: s.progress.map((p) => (p.questionId === data.progress.questionId ? data.progress : p)) } : s));
      }
    } catch (err) {
      setActionError(errorMessage(err));
      if (err instanceof ApiError && (err.code === 'TIME_EXPIRED' || err.code === 'ALREADY_FINISHED')) void load();
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await proctor.flush(); // let the last integrity events reach the server before the record is sealed
      applyState(await finishAssessment(token));
      setConfirmFinish(false);
    } catch (err) {
      setActionError(errorMessage(err));
      setConfirmFinish(false);
    } finally {
      setFinishing(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6" inert={blocked}>
      {needFullscreen && state.proctoring.fullscreenReentry === 'warn' && (
        <FullscreenGate mode="warn" onReenter={() => void reenter()} strikesUsed={strikesUsed} strikesAllowed={strikesAllowed} />
      )}
      <Card className="flex flex-wrap items-center gap-3 px-3 py-2 sm:px-4">
        <nav aria-label="Questions" className="flex min-w-0 basis-full gap-2 overflow-x-auto sm:flex-1 sm:basis-0">
          {state.questions?.map((q, i) => {
            const p = progressById.get(q.id);
            const active = q.id === question.id;
            const solved = !!p && p.total > 0 && p.passed === p.total;
            return (
              <button
                key={q.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                  setActiveId(q.id);
                  setActionError('');
                }}
                className={
                  'flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
                  (active ? 'border-accent bg-accent-soft font-medium' : 'border-border bg-surface hover:bg-accent-soft')
                }
              >
                <span className="text-muted">{i + 1}</span>
                <span>{q.difficulty}</span>
                <Badge tone={solved ? 'success' : p && p.attempts > 0 ? 'danger' : difficultyTone(q.difficulty)}>
                  {p && p.attempts > 0 ? `${p.bestScore}/${q.marks}` : `${q.marks}`}
                </Badge>
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {proctor.enabled && (
            <span title="Browser integrity events are recorded during this assessment">
              <Badge tone={proctor.level === 'ok' && strikesUsed === 0 ? 'neutral' : 'danger'}>
                Monitored
                {strikesAllowed > 0
                  ? ` · warnings ${Math.min(strikesUsed, strikesAllowed)}/${strikesAllowed}`
                  : proctor.violationCount > 0
                    ? ` · ${proctor.violationCount}`
                    : ''}
              </Badge>
            </span>
          )}
          <div
            role="timer"
            aria-label="Time remaining"
            className={`rounded-md border px-3 py-1.5 font-mono text-sm font-semibold ${lowTime ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border bg-background'}`}
          >
            {remaining === null ? '--:--' : formatClock(remaining)}
          </div>
          <Button variant="secondary" onClick={() => setConfirmFinish(true)}>
            Finish assessment
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className={`min-w-0 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto ${proctor.enabled ? 'select-none' : ''}`}>
          <ProblemPanel question={question} />
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card className="flex flex-col gap-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="language" className="text-sm font-medium">
                Language
              </label>
              <select
                id="language"
                className={`${inputClass} !w-auto`}
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
              >
                {state.languages.map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm('Reset this question to the starter code for the selected language?')) setCode(question.starterCode[language]);
                }}
              >
                Reset code
              </Button>
            </div>

            <CodeEditor
              label={`${LANGUAGE_LABELS[language]} solution for ${question.title}`}
              value={code}
              onChange={setCode}
              disabled={busy !== null}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => void execute('run')} disabled={busy !== null}>
                {busy === 'run' && <Spinner />} Run code
              </Button>
              <Button variant="primary" onClick={() => void execute('submit')} disabled={busy !== null}>
                {busy === 'submit' && <Spinner />} Submit
              </Button>
              <span className="text-xs text-muted">Submit scores this question. You can submit again.</span>
            </div>
          </Card>

          <Card>
            <ResultsPanel result={results[question.id]} busy={busy} error={actionError} />
          </Card>
        </div>
      </div>

      {blocked && <FullscreenGate mode="block" onReenter={() => void reenter()} strikesUsed={strikesUsed} strikesAllowed={strikesAllowed} />}
      {proctor.enabled && (
        <ProctorNotice
          notice={proctor.notice}
          violationCount={proctor.violationCount}
          level={proctor.level}
          strikesUsed={strikesUsed}
          strikesAllowed={strikesAllowed}
        />
      )}

      {confirmFinish && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="finish-title">
          <Card className="flex w-full max-w-md flex-col gap-4 p-5">
            <h2 id="finish-title" className="text-lg font-semibold tracking-tight">
              Finish the assessment?
            </h2>
            <p className="text-sm text-muted">
              Your best submitted score for each question will be recorded and you will not be able to change your answers. Code that
              you ran but did not submit is not scored.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmFinish(false)} disabled={finishing}>
                Keep working
              </Button>
              <Button variant="primary" onClick={() => void finish()} disabled={finishing}>
                {finishing && <Spinner />} Finish
              </Button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
