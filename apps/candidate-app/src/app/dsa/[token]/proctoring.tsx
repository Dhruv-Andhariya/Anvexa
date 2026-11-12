'use client';

import type { CameraAlert, ProctorCandidateWarning } from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card } from '@/components/ui';
import { ApiError, sendProctorEvents, type ProctorEventInput, type ProctorInputType, type ProctoringConfig } from '@/lib/dsa-api';
import { NOTICE_TEXT, classifyKey } from './proctoring-rules';

// ---------------------------------------------------------------- full screen helpers (browser Fullscreen API)

export const fullscreenSupported = () => typeof document !== 'undefined' && !!document.fullscreenEnabled;
export const inFullscreen = () => typeof document !== 'undefined' && !!document.fullscreenElement;

/** Must be called from a click handler (browsers require a user gesture). Resolves true when full screen is on. */
export async function enterFullscreen(): Promise<boolean> {
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // denied, or no gesture: the caller shows a message
  }
  return inFullscreen();
}

export async function leaveFullscreen(): Promise<void> {
  if (inFullscreen()) {
    try {
      await document.exitFullscreen();
    } catch {
      // already leaving
    }
  }
}

// ---------------------------------------------------------------- the monitoring hook

interface Options {
  token: string;
  config: ProctoringConfig | null;
  /** True only while the assessment is in progress. Nothing is listened to otherwise. */
  active: boolean;
  /** True when the page was (re)loaded in the middle of an attempt. */
  resumed: boolean;
  /** Epoch ms on the server's clock. */
  serverNow: () => number;
  /** Called when the server ended the attempt (policy). */
  onEnded: () => void;
  /** The warning number already shown before this page was (re)loaded: it is not shown again. */
  shownWarning?: number;
}

export interface Notice {
  id: number;
  text: string;
}

const CLIENT_DEDUPE_MS = 300;

/** An id per event (the server counts a retried event once). */
let eventSeq = 0;
const newEventId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ev-${Date.now().toString(36)}-${(eventSeq++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// A focus loss only counts if it lasts this long. It also lets a blur turn out to be a tab switch (reported once, as
// that), and ignores flickers (a notification toast, a system pop-up) that are not a deliberate action.
const BLUR_SETTLE_MS = 1000;
const FLUSH_DELAY_MS = 250;
const MAX_QUEUE = 200;

/**
 * Browser-level monitoring: full screen, tab / window focus, clipboard, context menu and restricted shortcuts.
 * It reports to the server (the source of truth) and shows the candidate what was recorded.
 * It cannot see other applications or block operating-system actions.
 */
export function useProctoring({ token, config, active, resumed, serverNow, onEnded, shownWarning = 0 }: Options) {
  const [fullscreen, setFullscreen] = useState(inFullscreen);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [violationCount, setViolationCount] = useState(0);
  const [level, setLevel] = useState<'ok' | 'warning' | 'final_warning'>('ok');
  const [strikesUsed, setStrikesUsed] = useState(0);
  /** A warning the server just issued: shown as a dialog until the candidate confirms it. */
  const [warning, setWarning] = useState<ProctorCandidateWarning | null>(null);
  const lastWarning = useRef(shownWarning);
  lastWarning.current = Math.max(lastWarning.current, shownWarning);

  const queue = useRef<ProctorEventInput[]>([]);
  const flushTimer = useRef<number | null>(null);
  const flushing = useRef(false);
  const lastEmit = useRef<Record<string, number>>({});
  const noticeId = useRef(0);
  const serverNowRef = useRef(serverNow);
  const onEndedRef = useRef(onEnded);
  serverNowRef.current = serverNow;
  onEndedRef.current = onEnded;

  const flush = useCallback(async (): Promise<void> => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (queue.current.length > 0) {
        const batch = queue.current.splice(0, 20);
        try {
          const res = await sendProctorEvents(token, batch);
          setViolationCount(res.violationCount);
          setStrikesUsed(res.strikesUsed);
          setLevel(res.level);
          // the server decides the warnings (never this page): show each new one once
          if (res.warning && res.warning.warningNumber > lastWarning.current && !res.ended) {
            lastWarning.current = res.warning.warningNumber;
            setWarning(res.warning);
          }
          if (res.ended || res.terminated) onEndedRef.current();
        } catch (err) {
          // Network trouble: keep the events and try again shortly. A refusal (assessment over, bad request) drops them.
          if (err instanceof ApiError && err.status !== 0 && err.status !== 503 && err.status !== 429) break;
          queue.current.unshift(...batch);
          flushTimer.current = window.setTimeout(() => void flush(), 3000);
          break;
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [token]);

  const emit = useCallback(
    (type: ProctorInputType, detail?: string, at?: number, extra?: Pick<ProctorEventInput, 'durationMs' | 'confidence'>) => {
      const now = Date.now();
      const key = type;
      if (now - (lastEmit.current[key] ?? 0) < CLIENT_DEDUPE_MS) return; // one action reported twice (key + clipboard event)
      lastEmit.current[key] = now;
      if (queue.current.length >= MAX_QUEUE) queue.current.shift();
      queue.current.push({ type, at: at ?? serverNowRef.current(), eventId: newEventId(), ...(detail ? { detail } : {}), ...(extra ?? {}) });
      const text = NOTICE_TEXT[type];
      if (text) setNotice({ id: ++noticeId.current, text });
      if (flushTimer.current === null) flushTimer.current = window.setTimeout(() => void flush(), FLUSH_DELAY_MS);
    },
    [flush],
  );

  const enabled = !!config?.enabled && active;

  useEffect(() => {
    if (!enabled) return;
    let blurOpen = false;
    let blurTimer: number | null = null;
    const inEditor = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-code-editor]');

    const onFullscreen = () => {
      const on = inFullscreen();
      setFullscreen(on);
      emit(on ? 'FULLSCREEN_RETURN' : 'FULLSCREEN_EXIT');
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (blurTimer !== null) {
          window.clearTimeout(blurTimer); // the blur belongs to this tab switch
          blurTimer = null;
        }
        emit('TAB_SWITCH');
      } else {
        emit('TAB_RETURN');
      }
    };
    const onBlur = () => {
      if (blurTimer !== null) window.clearTimeout(blurTimer);
      const blurAt = serverNowRef.current(); // the moment focus was actually lost
      // Switching tabs fires blur then visibilitychange. Only a blur that leaves the tab visible AND lasts is a focus loss.
      blurTimer = window.setTimeout(() => {
        blurTimer = null;
        if (!document.hidden && !document.hasFocus()) {
          blurOpen = true;
          emit('WINDOW_BLUR', undefined, blurAt);
        }
      }, BLUR_SETTLE_MS);
    };
    const onFocus = () => {
      if (blurTimer !== null) {
        window.clearTimeout(blurTimer);
        blurTimer = null;
      }
      if (blurOpen) {
        blurOpen = false;
        emit('WINDOW_RETURN');
      }
    };
    const block = (type: ProctorInputType, detail?: string) => (e: Event) => {
      e.preventDefault();
      emit(type, detail);
    };
    const onCopy = block('COPY', 'clipboard event');
    const onCut = block('CUT', 'clipboard event');
    const onPaste = block('PASTE', 'clipboard event');
    const onContext = block('CONTEXT_MENU');
    const onDrop = block('PASTE', 'drag and drop');
    const onDragOver = (e: Event) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      const verdict = classifyKey(e, inEditor(e.target));
      if (!verdict) return;
      e.preventDefault();
      emit(verdict.type, verdict.detail);
    };

    // Windows reports the PrintScreen key on keyup only. Nothing else is acted on at keyup.
    const onKeyUp = (e: KeyboardEvent) => {
      const verdict = classifyKey(e, inEditor(e.target));
      if (verdict?.type === 'SCREENSHOT_ATTEMPT') emit(verdict.type, verdict.detail);
    };

    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('cut', onCut, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('keydown', onKeyDown, true);
    setFullscreen(inFullscreen());

    return () => {
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('cut', onCut, true);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('contextmenu', onContext, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('keydown', onKeyDown, true);
      if (blurTimer !== null) window.clearTimeout(blurTimer);
    };
  }, [enabled, emit]);

  // Reloading in the middle of an attempt is noted (not counted as a violation).
  const resumedSent = useRef(false);
  useEffect(() => {
    if (enabled && resumed && !resumedSent.current) {
      resumedSent.current = true;
      emit('SESSION_RESUMED');
    }
  }, [enabled, resumed, emit]);

  // Let the last events out when monitoring stops or the page closes.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => {
      if (queue.current.length > 0) void flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [enabled, flush]);

  // Clear the notice after a few seconds.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const reenter = useCallback(async () => enterFullscreen(), []);

  // Webcam checks (webcam.tsx) report through the same queue, only while monitoring runs.
  const report = useCallback((type: ProctorInputType, detail?: string) => {
    if (enabled) emit(type, detail);
  }, [enabled, emit]);

  // AI camera alerts (camera-monitor.tsx): already grouped on the device; sent with their time, duration and confidence.
  const reportCamera = useCallback(
    (alert: CameraAlert) => {
      if (enabled) emit(alert.type, alert.detail, alert.at, { durationMs: Math.round(alert.durationMs), confidence: alert.confidence });
    },
    [enabled, emit],
  );

  const dismissWarning = useCallback(() => setWarning(null), []);

  return { fullscreen, notice, violationCount, level, strikesUsed, flush, reenter, enabled, report, reportCamera, warning, dismissWarning };
}

// ---------------------------------------------------------------- UI

/** Warning 1 / Warning 2 from the server, with what was detected. The candidate confirms it to continue. */
export function WarningDialog({ warning, onClose }: { warning: ProctorCandidateWarning; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="warn-title" aria-describedby="warn-text">
      <Card className="flex w-full max-w-md flex-col gap-3 border-danger/40 p-5">
        <h2 id="warn-title" className="text-lg font-semibold tracking-tight text-danger">
          Warning {warning.warningNumber} of {warning.maxWarnings}
        </h2>
        <p id="warn-text" className="text-sm">
          {warning.message}
        </p>
        {warning.reason && (
          <p className="rounded-md border border-border bg-background px-3 py-2 text-sm text-muted">
            <span className="font-medium text-foreground">What was detected: </span>
            {warning.reason}
          </p>
        )}
        <p className="text-xs text-muted">The timer keeps running. Detections are possible incidents for the hiring team to review, not proof on their own.</p>
        <div>
          <Button variant="primary" onClick={onClose} autoFocus>
            I understand
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** Blocks the assessment until full screen is back (policy "block"), or shows a banner (policy "warn"). */
export function FullscreenGate({ mode, onReenter, strikesUsed, strikesAllowed }: { mode: 'block' | 'warn'; onReenter: () => void; strikesUsed: number; strikesAllowed: number }) {
  const limit = strikesAllowed > 0 ? ` This counted as warning ${Math.min(strikesUsed, strikesAllowed)} of ${strikesAllowed}.${strikesUsed >= strikesAllowed ? ' You have no warnings left: the next suspicious activity, including leaving full screen again, ends the assessment.' : ''}` : '';
  if (mode === 'warn') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
        <span>Full-screen mode is off. Return to full screen to continue the assessment. The time away is recorded.{limit}</span>
        <Button variant="secondary" className="ml-auto" onClick={onReenter}>
          Return to full screen
        </Button>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="fs-title" aria-describedby="fs-text">
      <Card className="flex w-full max-w-md flex-col gap-4 p-5">
        <h2 id="fs-title" className="text-lg font-semibold tracking-tight">
          Return to full screen to continue
        </h2>
        <p id="fs-text" className="text-sm text-muted">
          The assessment must be taken in full-screen mode. You left full screen, and this was recorded together with how long you were away. The
          timer keeps running. Your code is kept.{limit}
        </p>
        <div>
          <Button variant="primary" onClick={onReenter}>
            Return to full screen
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** The latest thing that was recorded, shown briefly. */
export function ProctorNotice({
  notice,
  violationCount,
  level,
  strikesUsed,
  strikesAllowed,
}: {
  notice: Notice | null;
  violationCount: number;
  level: 'ok' | 'warning' | 'final_warning';
  strikesUsed: number;
  strikesAllowed: number;
}) {
  if (!notice) return null;
  const strong = level !== 'ok';
  const limited = strikesAllowed > 0 && strikesUsed > 0;
  const lastOne = limited && strikesUsed >= strikesAllowed;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 right-4 z-20 max-w-sm rounded-md border px-3 py-2 text-sm shadow-md ${strong ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border bg-surface text-foreground'}`}
    >
      <p>{notice.text}</p>
      {limited ? (
        <p className="mt-1 text-xs font-medium">
          Warning {Math.min(strikesUsed, strikesAllowed)} of {strikesAllowed}.
          {lastOne
            ? ' That was your last allowed warning. The next suspicious activity, including leaving full screen, ends your assessment immediately.'
            : ' After the last allowed warning, the next suspicious activity ends your assessment.'}
        </p>
      ) : (
        violationCount > 0 && (
          <p className="mt-1 text-xs opacity-80">
            {violationCount} {violationCount === 1 ? 'event' : 'events'} recorded so far.
            {level === 'final_warning' ? ' Further violations may lead to your attempt being flagged for review.' : level === 'warning' ? ' Please keep to the assessment rules.' : ''}
          </p>
        )
      )}
    </div>
  );
}
