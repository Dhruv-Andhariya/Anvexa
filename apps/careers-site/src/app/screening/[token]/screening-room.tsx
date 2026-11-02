'use client';

import type { AiScreeningPublicSession, AiScreeningQuestion, AiScreeningTranscriptLine } from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import { MIC_MESSAGES, SILENCE_PEAK, micProblemOf, micSupport, startRecording, type ActiveRecording, type MicProblem } from '@/lib/recorder';
import {
  ScreeningApiError,
  endSession,
  getSession,
  getSpeech,
  newClientTurnId,
  sendAnswer,
  startSession,
  type Recording,
} from '@/lib/screening-api';
import { describeError, MAX_ANSWER_MS, MIN_ANSWER_MS, PHASE_LABEL, type Phase } from '@/lib/screening-ui';

interface PendingAnswer {
  seq: number;
  clientTurnId: string;
  recording: Recording;
}

/**
 * The candidate's AI screening round (M12). A real voice loop: the question is spoken (server text-to-speech), the
 * candidate answers into the microphone, the recording is sent to the API which transcribes + saves it and returns the
 * next question. Every answered question is saved on the server at once; a refresh continues where it stopped.
 */
export function ScreeningRoom({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [session, setSession] = useState<AiScreeningPublicSession | null>(null);
  const [question, setQuestion] = useState<AiScreeningQuestion | null>(null);
  const [lines, setLines] = useState<AiScreeningTranscriptLine[]>([]);
  const [stepsDone, setStepsDone] = useState(0);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const stream = useRef<MediaStream | null>(null);
  const recording = useRef<ActiveRecording | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const speechUrls = useRef(new Map<number, string>());
  const pending = useRef<PendingAnswer | null>(null);
  const timer = useRef<number | null>(null);
  const autoStop = useRef<number | null>(null);
  const mounted = useRef(true);

  // ---------------------------------------------------------------- lifecycle

  useEffect(() => {
    mounted.current = true;
    const urls = speechUrls.current;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      recording.current?.cancel();
      stream.current?.getTracks().forEach((t) => t.stop());
      audio.current?.pause();
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (timer.current) window.clearInterval(timer.current);
      if (autoStop.current) window.clearTimeout(autoStop.current);
    };
  }, []);

  const apply = useCallback((s: AiScreeningPublicSession) => {
    setSession(s);
    setQuestion(s.current);
    setLines(s.transcript);
    setStepsDone(s.stepsDone);
  }, []);

  const fail = useCallback((err: unknown) => {
    const d = describeError(err);
    setPhase(d.fatal ? { name: 'fatal', title: d.title, message: d.message } : { name: 'error', message: d.message, retry: d.retry });
  }, []);

  useEffect(() => {
    getSession(token)
      .then((s) => {
        if (!mounted.current) return;
        apply(s);
        if (s.status === 'COMPLETED') setPhase({ name: 'done' });
        else if (s.status === 'NOT_STARTED') setPhase({ name: 'welcome' });
        else setPhase({ name: 'paused', ended: s.status === 'ENDED_EARLY' });
      })
      .catch(fail);
  }, [token, apply, fail]);

  // ---------------------------------------------------------------- audio out

  /** Must run inside a click: unlocks audio playback on iOS / Safari for the rest of the session. */
  const unlockAudio = () => {
    if (!audio.current) audio.current = new Audio();
    const el = audio.current;
    el.muted = true;
    el.src = SILENT_WAV;
    void el.play().catch(() => undefined).finally(() => {
      el.pause();
      el.muted = false;
    });
  };

  const speechUrl = async (seq: number): Promise<string> => {
    const cached = speechUrls.current.get(seq);
    if (cached) return cached;
    const url = URL.createObjectURL(await getSpeech(token, seq));
    speechUrls.current.set(seq, url);
    return url;
  };

  /** Speaks a question; resolves when it finished playing (or false when audio is unavailable). */
  const speak = async (q: AiScreeningQuestion): Promise<boolean> => {
    if (!audio.current) audio.current = new Audio();
    const el = audio.current;
    try {
      el.src = await speechUrl(q.seq);
      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error('playback'));
        el.play().catch(reject);
      });
      return true;
    } catch {
      return false;
    }
  };

  // ---------------------------------------------------------------- the loop

  const listen = useCallback(() => {
    if (!stream.current) return;
    recording.current = startRecording(stream.current);
    setSeconds(0);
    setPhase({ name: 'listening' });
    const started = Date.now();
    timer.current = window.setInterval(() => {
      setLevel(recording.current?.level() ?? 0);
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 120);
    autoStop.current = window.setTimeout(() => void finishAnswerRef.current(), MAX_ANSWER_MS);
  }, []);

  const ask = useCallback(
    async (q: AiScreeningQuestion) => {
      setQuestion(q);
      setPhase({ name: 'speaking' });
      const spoken = await speak(q);
      if (!mounted.current) return;
      if (q.kind === 'CLOSING') {
        stream.current?.getTracks().forEach((t) => t.stop());
        setPhase({ name: 'done' });
        return;
      }
      setNotice(spoken ? null : 'The question could not be played aloud - please read it on the screen and answer.');
      listen();
    },
    // speak only uses refs + token
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listen, token],
  );

  const submit = useCallback(
    async (p: PendingAnswer) => {
      setPhase({ name: 'processing' });
      try {
        const res = await sendAnswer(token, p.seq, p.clientTurnId, p.recording);
        if (!mounted.current) return;
        pending.current = null;
        if (res.outcome === 'RETRY') {
          setPhase({ name: 'error', message: res.message ?? 'Please answer again.', retry: 'record' });
          return;
        }
        if (res.transcript !== null && question) {
          setLines((prev) =>
            prev.some((l) => l.seq === p.seq) ? prev : [...prev, { seq: p.seq, step: question.step, question: question.text, answer: res.transcript!, aiReply: res.aiReply }],
          );
        }
        setStepsDone(res.stepsDone);
        if (res.next) await ask(res.next);
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof ScreeningApiError && err.code === 'OUT_OF_SYNC') {
          // answered in another tab (or saved before a network error): continue from the server's state
          pending.current = null;
          const s = await getSession(token).catch(() => null);
          if (s?.current) {
            apply(s);
            await ask(s.current);
            return;
          }
        }
        fail(err);
      }
    },
    [token, question, ask, apply, fail],
  );

  const finishAnswer = useCallback(async () => {
    if (timer.current) window.clearInterval(timer.current);
    if (autoStop.current) window.clearTimeout(autoStop.current);
    timer.current = autoStop.current = null;
    const rec = recording.current;
    recording.current = null;
    if (!rec || !question) return;
    const result = await rec.stop();
    setLevel(0);
    if (result.durationMs < MIN_ANSWER_MS || result.blob.size < 1_000) {
      setPhase({ name: 'error', message: 'That was very short. Please answer again when you are ready.', retry: 'record' });
      return;
    }
    if (result.peak !== null && result.peak < SILENCE_PEAK) {
      // nothing reached the microphone: never send silence (the server checks too)
      setPhase({ name: 'error', message: "We couldn't hear anything. Check that your microphone is on and not muted, then answer again.", retry: 'record' });
      return;
    }
    pending.current = { seq: question.seq, clientTurnId: newClientTurnId(), recording: result };
    await submit(pending.current);
  }, [question, submit]);
  const finishAnswerRef = useRef(finishAnswer);
  finishAnswerRef.current = finishAnswer;

  // ---------------------------------------------------------------- buttons

  const begin = async (withConsent: boolean) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const problem = micSupport();
      if (problem) {
        setPhase({ name: 'mic', problem });
        return;
      }
      unlockAudio();
      try {
        stream.current ??= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (err) {
        setPhase({ name: 'mic', problem: micProblemOf(err) });
        return;
      }
      const s = await startSession(token, withConsent);
      apply(s);
      if (s.status === 'COMPLETED') setPhase({ name: 'done' });
      else if (s.current) await ask(s.current);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (phase.name !== 'error') return;
    setNotice(null);
    if (phase.retry === 'resend' && pending.current) await submit(pending.current); // same recording, same id
    else if (phase.retry === 'reload' || !session) window.location.reload();
    else if (stream.current) listen();
    else await begin(false);
  };

  const repeat = async () => {
    if (!question || phase.name !== 'listening') return;
    recording.current?.cancel();
    recording.current = null;
    if (timer.current) window.clearInterval(timer.current);
    if (autoStop.current) window.clearTimeout(autoStop.current);
    await ask(question);
  };

  const end = async () => {
    setConfirmEnd(false);
    recording.current?.cancel();
    recording.current = null;
    if (timer.current) window.clearInterval(timer.current);
    if (autoStop.current) window.clearTimeout(autoStop.current);
    audio.current?.pause();
    try {
      apply(await endSession(token));
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      setPhase({ name: 'paused', ended: true });
    } catch (err) {
      fail(err);
    }
  };

  // ---------------------------------------------------------------- view

  const total = session?.totalSteps ?? 6;
  const inCall = ['speaking', 'listening', 'processing', 'error'].includes(phase.name);

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="text-sm font-medium text-accent">AI screening round</p>
        <h1 className="text-2xl font-semibold tracking-tight">{session ? session.jobTitle : 'Loading…'}</h1>
        {session && <p className="text-sm text-muted">{session.companyName}</p>}
      </header>

      {!online && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          You are offline. Your saved answers are safe - reconnect to continue.
        </p>
      )}

      {phase.name === 'loading' && (
        <Card>
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Opening your screening…
          </p>
        </Card>
      )}

      {phase.name === 'fatal' && (
        <Card>
          <h2 className="text-lg font-semibold">{phase.title}</h2>
          <p className="text-sm text-muted">{phase.message}</p>
        </Card>
      )}

      {phase.name === 'welcome' && session && (
        <Card>
          <h2 className="text-lg font-semibold">Hi {session.candidateFirstName || 'there'}, welcome!</h2>
          <p className="text-sm">
            This is a short voice conversation with an AI interviewer about your background - about {session.estimatedMinutes} minutes, six questions.
            It is not a technical test and it does not make any hiring decision: the HR team reviews your answers.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Use Chrome, Edge, Firefox or Safari on a laptop or phone, in a quiet place.</li>
            <li>Your browser will ask to use the microphone. Answer each question out loud, then press “Done answering”.</li>
            <li>You can hear a question again, and you can stop and come back while your link is valid (until {formatDate(session.expiresAt)}).</li>
          </ul>
          <div className="rounded-md border border-border bg-background p-3 text-xs text-muted">
            <p className="font-medium text-foreground">How your voice is used</p>
            <p className="mt-1">
              Each spoken answer is sent to our AI provider (Google Gemini) only to turn it into text and understand it. We save the text of your answers
              and the questions asked - not the audio recording. {session.companyName}&apos;s HR team can read them, together with your application. You can
              ask for your data to be deleted from this careers site&apos;s “my data” page.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>I agree that my spoken answers are processed by AI and saved as text for this job application.</span>
          </label>
          <Button variant="primary" className="self-start" disabled={!consent || busy} onClick={() => void begin(true)}>
            {busy && <Spinner />} Start screening
          </Button>
        </Card>
      )}

      {phase.name === 'paused' && session && (
        <Card>
          <h2 className="text-lg font-semibold">{phase.ended ? 'You paused the screening' : 'Welcome back'}</h2>
          <p className="text-sm text-muted">
            Your {lines.length} answer{lines.length === 1 ? ' is' : 's are'} saved. Continue where you left off - your link works until {formatDate(session.expiresAt)}.
          </p>
          <Button variant="primary" className="self-start" disabled={busy} onClick={() => void begin(false)}>
            {busy && <Spinner />} Continue screening
          </Button>
        </Card>
      )}

      {phase.name === 'mic' && (
        <Card>
          <h2 className="text-lg font-semibold">Microphone needed</h2>
          <p role="alert" className="text-sm text-danger">
            {MIC_MESSAGES[phase.problem as MicProblem]}
          </p>
          <Button variant="primary" className="self-start" disabled={busy} onClick={() => void begin(!session?.consentGiven)}>
            Try again
          </Button>
        </Card>
      )}

      {inCall && (
        <Card>
          <Progress done={stepsDone} total={total} />
          <div className="flex items-center gap-5 pl-1">
            <Interviewer phase={phase.name} level={level} />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-medium" aria-live="polite">
                {PHASE_LABEL[phase.name] ?? ''}
                {phase.name === 'listening' && <span className="ml-2 tabular-nums text-muted">{formatSeconds(seconds)}</span>}
              </p>
              {question && <p className="text-xs text-muted">Question {Math.min(stepsDone + 1, total)} of {total}</p>}
            </div>
          </div>
          {question && (
            <blockquote className="rounded-md border-l-4 border-accent bg-accent-soft px-4 py-3 text-base">{question.text}</blockquote>
          )}
          {notice && <p className="text-sm text-muted">{notice}</p>}
          {phase.name === 'error' && (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              {phase.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {phase.name === 'listening' && (
              <>
                <Button variant="primary" onClick={() => void finishAnswer()}>
                  Done answering
                </Button>
                <Button onClick={() => void repeat()}>Hear the question again</Button>
              </>
            )}
            {phase.name === 'processing' && (
              <Button variant="primary" disabled>
                <Spinner /> Saving your answer…
              </Button>
            )}
            {phase.name === 'error' && (
              <Button variant="primary" onClick={() => void retry()}>
                {phase.retry === 'resend' ? 'Send my answer again' : phase.retry === 'reload' ? 'Reload' : 'Answer again'}
              </Button>
            )}
          </div>
          <div className="border-t border-border pt-3">
            {confirmEnd ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>End now? Your answers so far are saved, and you can continue later.</span>
                <Button onClick={() => void end()}>Yes, end</Button>
                <Button onClick={() => setConfirmEnd(false)}>Keep going</Button>
              </div>
            ) : (
              <button type="button" className="text-sm text-muted underline hover:text-foreground" disabled={phase.name === 'processing'} onClick={() => setConfirmEnd(true)}>
                End screening
              </button>
            )}
          </div>
        </Card>
      )}

      {phase.name === 'done' && (
        <Card>
          <h2 className="text-lg font-semibold">Thank you - your screening is complete</h2>
          <p className="text-sm text-muted">
            Your answers have been saved and shared with the {session?.companyName ?? ''} HR team. They will contact you about the next steps. You can close
            this page.
          </p>
        </Card>
      )}

      {lines.length > 0 && phase.name !== 'fatal' && (
        <section aria-label="Your answers so far" className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-muted">Conversation so far</h2>
          <ol className="flex flex-col gap-3">
            {lines.map((l) => (
              <li key={l.seq} className="rounded-lg border border-border bg-surface p-4 text-sm">
                <p className="text-muted">
                  <span className="font-medium text-foreground">AI:</span> {l.question}
                </p>
                <p className="mt-2">
                  <span className="font-medium">You:</span> {l.answer}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">{children}</section>;
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = Math.round((Math.min(done, total) / total) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="h-2 w-full overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Screening progress">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted">
        {Math.min(done, total)} of {total} topics covered
      </p>
    </div>
  );
}

/** The interviewer's state. Honest: it pulses only while audio really plays or the microphone really records. */
function Interviewer({ phase, level }: { phase: Phase['name']; level: number }) {
  const ring =
    phase === 'speaking' ? 'ring-accent animate-pulse' : phase === 'listening' ? 'ring-success' : phase === 'error' ? 'ring-danger' : 'ring-border';
  const scale = phase === 'listening' ? 1 + level * 0.12 : 1;
  return (
    <div
      aria-hidden="true"
      className={`grid h-16 w-16 shrink-0 place-items-center rounded-full bg-accent-soft ring-4 transition-transform ${ring}`}
      style={{ transform: `scale(${scale})` }}
    >
      {phase === 'processing' ? <Spinner className="h-6 w-6 text-accent" /> : <span className="text-xl font-semibold text-accent">AI</span>}
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatSeconds(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 0.05 s of silence: played muted inside the first click so later questions can play on iOS / Safari. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
