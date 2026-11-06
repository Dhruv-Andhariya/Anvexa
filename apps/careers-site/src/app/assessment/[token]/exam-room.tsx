'use client';

import type { AssessmentIncidentType, AssessmentProtectionState, AssessmentPublicView, AssessmentQuestion, AssessmentViolationResult } from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import {
  AssessmentApiError,
  acknowledgeIncident,
  getAssessment,
  reportIncident,
  saveAnswers,
  sendEvents,
  startAssessment,
  submitAssessment,
  type ProctorEventInput,
} from '@/lib/assessment-api';
import {
  choose,
  clearAnswer,
  describeError,
  draftKey,
  formatRemaining,
  paletteState,
  pickKnown,
  readDraft,
  remainingMs,
  summary,
  toAnswerList,
  toAnswerMap,
  toggleMarked,
  writeDraft,
  type AnswerMap,
  type PaletteState,
} from '@/lib/assessment-ui';
import { CAMERA_MESSAGES, cameraProblemOf, cameraSupport, fullscreenSupported, startCamera, watchCameraPermission, type CameraProblem } from '@/lib/camera';
import { loadFaceCounter, type FaceCounter } from '@/lib/face-counter';
import {
  ASSESSMENT_INCIDENT_TEXT,
  FaceEpisodeTracker,
  ProtectionMonitor,
  newIncidentId,
  warningText,
  warningTexts,
  type Incident,
  type ProtectionSignal,
} from '@/lib/interview-protection';

/** An incident not delivered yet (offline): sent again with the same id, so it is counted once. */
type OutgoingIncident = { id: string; type: AssessmentIncidentType; detail?: string };
/** A warning from the server, shown until acknowledged. */
interface ShownWarning {
  warningNumber: number;
  maxWarnings: number;
  final: boolean;
  type: AssessmentIncidentType;
}

type Phase =
  | { name: 'loading' }
  | { name: 'fatal'; title: string; message: string }
  | { name: 'landing' }
  | { name: 'check' }
  | { name: 'exam' }
  | { name: 'done' }
  /** Ended by the server: more warnings than allowed. The saved answers are kept; HR reviews. */
  | { name: 'terminated' };

type SaveState = 'saved' | 'saving' | 'offline' | 'error';

const SAVE_DELAY_MS = 700;
const EVENT_FLUSH_MS = 4000;

/**
 * The candidate's online assessment (M13): landing page -> system check (camera, full screen) -> timed exam ->
 * submitted. The server owns the questions, the clock and the result: this page only shows the questions, keeps the
 * answers (on the server, and on this device while offline) and reports proctoring events. No video is recorded.
 */
export function ExamRoom({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [view, setView] = useState<AssessmentPublicView | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cameraProblem, setCameraProblem] = useState<CameraProblem | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraLost, setCameraLost] = useState(false);

  const [questions, setQuestions] = useState<AssessmentQuestion[]>([]);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [current, setCurrent] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [online, setOnline] = useState(true);
  /** Protection, always as the server last said (the page never counts warnings itself). */
  const [protection, setProtection] = useState<AssessmentProtectionState | null>(null);
  const [warning, setWarning] = useState<ShownWarning | null>(null);
  const [fullscreenOn, setFullscreenOn] = useState(true);
  const [faceCheck, setFaceCheck] = useState<'off' | 'loading' | 'on' | 'unavailable'>('off');

  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const deadline = useRef<string | null>(null);
  const offset = useRef(0);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const answersRef = useRef<AnswerMap>({});
  const saveTimer = useRef<number | null>(null);
  const saving = useRef(false);
  const events = useRef<ProctorEventInput[]>([]);
  const draft = useRef<string | null>(null);
  const finishing = useRef(false);
  const wasFullscreen = useRef(false);
  const mounted = useRef(true);
  const monitor = useRef<ProtectionMonitor | null>(null);
  const outbox = useRef<OutgoingIncident[]>([]);
  const faceCounter = useRef<FaceCounter | null>(null);
  const faceLoading = useRef(false);
  const faces = useRef(new FaceEpisodeTracker(newIncidentId));

  // ---------------------------------------------------------------- helpers

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    stream.current = null;
    setCameraOn(false);
  }, []);

  const record = useCallback((type: ProctorEventInput['type'], detail?: ProctorEventInput['detail']) => {
    events.current = [...events.current, { type, occurredAt: new Date().toISOString(), ...(detail ? { detail } : {}) }].slice(-200);
  }, []);

  const flushEvents = useCallback(async () => {
    if (!events.current.length) return;
    const batch = events.current.slice(0, 20);
    try {
      await sendEvents(token, batch);
      events.current = events.current.slice(batch.length);
    } catch {
      // kept and sent with the next flush
    }
  }, [token]);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof AssessmentApiError && err.code === 'ASSESSMENT_TERMINATED') {
        terminateRef.current();
        return;
      }
      const d = describeError(err);
      if (d.fatal) {
        stopCamera();
        setPhase({ name: 'fatal', title: d.title, message: d.message });
      } else setError(d.message);
    },
    [stopCamera],
  );

  /** The test is over (submitted here, timed out, or submitted in another tab): show the final page. */
  const finished = useCallback(
    (v: AssessmentPublicView | null) => {
      if (v?.status === 'TERMINATED') {
        setView(v);
        terminateRef.current();
        return;
      }
      if (v) setView(v);
      if (draft.current) writeDraft(draft.current, null);
      stopCamera();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setPhase({ name: 'done' });
    },
    [stopCamera],
  );

  /**
   * The server ended the test (warning limit): stop the camera, the timer and saving at once, leave full screen, and
   * show the termination. The answers saved so far are on the server; HR reviews before any result is sent.
   */
  const terminate = useCallback(() => {
    finishing.current = true;
    monitor.current?.setActive(false, Date.now(), { hidden: false, focused: true, fullscreen: false });
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    outbox.current = [];
    if (draft.current) writeDraft(draft.current, null);
    stopCamera();
    setWarning(null);
    setConfirmSubmit(false);
    setPhase({ name: 'terminated' });
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [stopCamera]);
  const terminateRef = useRef(terminate);
  terminateRef.current = terminate;

  /** The server's answer to an incident: its count is the only count. */
  const onProtectionResult = useCallback((r: AssessmentViolationResult, type: AssessmentIncidentType) => {
    setProtection((p) => (p ? { ...p, warningCount: r.warningCount } : p));
    if (r.outcome === 'TERMINATED' || r.status === 'TERMINATED') {
      terminateRef.current();
      return;
    }
    if (r.outcome === 'WARNING' && r.warningNumber) setWarning({ warningNumber: r.warningNumber, maxWarnings: r.maxWarnings, final: r.warningNumber >= r.maxWarnings, type });
  }, []);

  const sendIncident = useCallback(
    async (incident: OutgoingIncident) => {
      if (!outbox.current.some((i) => i.id === incident.id)) outbox.current.push(incident);
      try {
        const r = await reportIncident(token, incident);
        outbox.current = outbox.current.filter((i) => i.id !== incident.id);
        if (mounted.current) onProtectionResult(r, incident.type);
      } catch (err) {
        if (!(err instanceof AssessmentApiError && (err.retryable || err.status === 0))) outbox.current = outbox.current.filter((i) => i.id !== incident.id);
      }
    },
    [onProtectionResult, token],
  );
  const sendIncidentRef = useRef(sendIncident);
  sendIncidentRef.current = sendIncident;

  /** The server's view: protection state + a warning not acknowledged before a reload. */
  const applyProtection = useCallback((v: AssessmentPublicView) => {
    setProtection(v.protection);
    const w = v.protection.pendingWarning;
    if (w && v.status === 'IN_PROGRESS') setWarning({ warningNumber: w.warningNumber, maxWarnings: v.protection.maxWarnings, final: w.final, type: w.type });
  }, []);

  const enterExam = useCallback(
    async (v: AssessmentPublicView, loadedAt: number) => {
      const a = v.attempt!;
      offset.current = Date.parse(v.serverNow) - loadedAt;
      deadline.current = a.deadlineAt;
      draft.current = await draftKey(token);
      const local = readDraft(draft.current);
      let map = toAnswerMap(a.answers);
      revision.current = a.revision;
      savedRevision.current = a.revision;
      if (local && local.revision > a.revision) {
        // answers given while offline (before a refresh) are newer than the server's copy
        map = pickKnown(local.answers, a.questions);
        revision.current = local.revision;
      }
      answersRef.current = map;
      setQuestions(a.questions);
      setAnswers(map);
      setCurrent(0);
      setPhase({ name: 'exam' });
      if (revision.current > savedRevision.current) scheduleSave(0);
    },
    [token],
  );

  // ---------------------------------------------------------------- load

  useEffect(() => {
    mounted.current = true;
    const loadedAt = Date.now();
    getAssessment(token)
      .then((v) => {
        if (!mounted.current) return;
        setView(v);
        applyProtection(v);
        if (v.status === 'TERMINATED') setPhase({ name: 'terminated' });
        else if (v.status === 'SUBMITTED' || v.status === 'TIMED_OUT') setPhase({ name: 'done' });
        else if (v.status === 'IN_PROGRESS') setPhase({ name: 'check' });
        else setPhase({ name: 'landing' });
        offset.current = Date.parse(v.serverNow) - loadedAt;
      })
      .catch(fail);
    const on = () => {
      setOnline(true);
      // incidents that could not be sent while offline go now (same ids: counted once)
      for (const i of [...outbox.current]) void sendIncidentRef.current(i);
    };
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [token, fail, applyProtection]);

  // ---------------------------------------------------------------- camera

  const openCamera = useCallback(async (): Promise<boolean> => {
    const unsupported = cameraSupport();
    if (unsupported) {
      setCameraProblem(unsupported);
      return false;
    }
    try {
      stopCamera();
      const s = await startCamera();
      stream.current = s;
      setCameraProblem(null);
      setCameraOn(true);
      setCameraLost(false);
      if (video.current) video.current.srcObject = s;
      s.getVideoTracks().forEach((t) => {
        t.onended = () => {
          if (!mounted.current || stream.current !== s) return;
          record('CAMERA_STOPPED');
          setCameraOn(false);
          setCameraLost(true);
        };
      });
      return true;
    } catch (err) {
      setCameraProblem(cameraProblemOf(err));
      return false;
    }
  }, [record, stopCamera]);

  // the check page starts the camera preview by itself
  useEffect(() => {
    if (phase.name === 'check' && !stream.current) void openCamera();
  }, [phase.name, openCamera]);

  // keep the <video> showing the stream after re-renders / layout changes
  useEffect(() => {
    if (video.current && stream.current && video.current.srcObject !== stream.current) video.current.srcObject = stream.current;
  });

  // ---------------------------------------------------------------- saving

  const saveNow = useCallback(async () => {
    if (saving.current || finishing.current) return;
    if (revision.current <= savedRevision.current) {
      setSaveState('saved');
      return;
    }
    saving.current = true;
    setSaveState('saving');
    const rev = revision.current;
    try {
      const res = await saveAnswers(token, rev, toAnswerList(answersRef.current));
      savedRevision.current = Math.max(savedRevision.current, Math.min(res.revision, rev));
      deadline.current = res.deadlineAt;
      setSaveState(revision.current > savedRevision.current ? 'saving' : 'saved');
    } catch (err) {
      if (err instanceof AssessmentApiError && err.code === 'ASSESSMENT_TERMINATED') {
        saving.current = false;
        terminateRef.current();
        return;
      }
      if (err instanceof AssessmentApiError && (err.code === 'TIME_UP' || err.code === 'ASSESSMENT_SUBMITTED')) {
        saving.current = false;
        finished(await getAssessment(token).catch(() => null));
        return;
      }
      if (err instanceof AssessmentApiError && !err.retryable && err.status !== 0) {
        saving.current = false;
        fail(err);
        setSaveState('error');
        return;
      }
      setSaveState('offline');
    }
    saving.current = false;
    if (revision.current > savedRevision.current) scheduleSave(3000);
  }, [token, finished, fail]);

  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  function scheduleSave(delay = SAVE_DELAY_MS) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void saveRef.current(), delay);
  }

  const update = (next: AnswerMap) => {
    answersRef.current = next;
    setAnswers(next);
    revision.current += 1;
    if (draft.current) writeDraft(draft.current, { revision: revision.current, answers: next });
    setSaveState('saving');
    scheduleSave();
  };

  // ---------------------------------------------------------------- submit

  const submit = useCallback(
    async (auto: boolean) => {
      if (finishing.current) return;
      finishing.current = true;
      setBusy(true);
      setConfirmSubmit(false);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      const rev = Math.max(revision.current, 1);
      try {
        await flushEvents();
        const v = await submitAssessment(token, rev, toAnswerList(answersRef.current));
        finished(v);
      } catch (err) {
        if (err instanceof AssessmentApiError && err.code === 'ASSESSMENT_TERMINATED') {
          terminateRef.current();
          return;
        }
        finishing.current = false;
        if (err instanceof AssessmentApiError && err.code === 'ASSESSMENT_SUBMITTED') {
          finished(await getAssessment(token).catch(() => null));
          return;
        }
        setError(
          auto
            ? 'Time is up, but your answers could not be sent because of the connection. Reconnect - your answers saved on the server count.'
            : describeError(err).message,
        );
      }
      setBusy(false);
    },
    [token, flushEvents, finished],
  );

  // ---------------------------------------------------------------- exam: timer, autosave on reconnect, proctoring

  useEffect(() => {
    if (phase.name !== 'exam') return;
    const tick = () => {
      if (!deadline.current) return setRemaining(null);
      const left = remainingMs(deadline.current, offset.current);
      setRemaining(left);
      if (left <= 0) void submit(true);
    };
    tick();
    const t = window.setInterval(tick, 500);
    const flush = window.setInterval(() => void flushEvents(), EVENT_FLUSH_MS);
    return () => {
      window.clearInterval(t);
      window.clearInterval(flush);
    };
  }, [phase.name, submit, flushEvents]);

  useEffect(() => {
    if (phase.name !== 'exam') return;
    let unwatch = () => undefined as void;
    void watchCameraPermission(() => {
      record('CAMERA_PERMISSION_REVOKED');
      setCameraLost(true);
    }).then((u) => (unwatch = u));

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        record('TAB_SWITCH');
        void flushEvents();
      } else if (!monitor.current) {
        setNotice('You left the test page. This is recorded for the hiring team to review - please stay on this page until you submit.');
      }
    };
    const onFullscreen = () => {
      if (document.fullscreenElement) {
        wasFullscreen.current = true;
      } else if (wasFullscreen.current && !finishing.current) {
        wasFullscreen.current = false;
        record('FULLSCREEN_EXIT');
        if (!monitor.current) setNotice('You left full screen. This is recorded for the hiring team to review.');
      }
    };
    const onOffline = () => {
      record('CONNECTION_LOST');
      setSaveState('offline');
    };
    const onOnline = () => {
      void flushEvents();
      if (revision.current > savedRevision.current) scheduleSave(0);
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (revision.current > savedRevision.current && !finishing.current) e.preventDefault();
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      unwatch();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [phase.name, record, flushEvents]);

  // ---------------------------------------------------------------- protection (tab / window / full screen / faces)

  const monitorOn = !!protection?.enabled;
  const fullscreenWanted = monitorOn && !!protection?.fullscreenRequired && fullscreenSupported();
  useEffect(() => {
    monitor.current = monitorOn ? new ProtectionMonitor({ tabSwitch: !!protection?.tabSwitchMonitoring, fullscreen: fullscreenWanted, newId: newIncidentId }) : null;
  }, [monitorOn, protection?.tabSwitchMonitoring, fullscreenWanted]);

  // only while the test runs (not on the landing / check / end pages)
  useEffect(() => {
    monitor.current?.setActive(phase.name === 'exam', Date.now(), {
      hidden: document.visibilityState === 'hidden',
      focused: document.hasFocus(),
      fullscreen: !!document.fullscreenElement,
    });
  }, [phase.name, monitorOn, protection?.tabSwitchMonitoring, fullscreenWanted]);

  useEffect(() => {
    const feed = (signal: ProtectionSignal) => {
      const incident: Incident | null | undefined = monitor.current?.signal(signal, Date.now());
      if (incident) void sendIncidentRef.current(incident as OutgoingIncident);
    };
    const visibility = () => feed(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
    const blur = () => feed('blur');
    const focus = () => feed('focus');
    const fs = () => {
      setFullscreenOn(!!document.fullscreenElement);
      feed(document.fullscreenElement ? 'fullscreen-enter' : 'fullscreen-exit');
    };
    // a reload / close hides the page too: not leaving the test (the timer keeps running on the server)
    const unloading = () => feed('unloading');
    const shown = (e: PageTransitionEvent) => e.persisted && feed('restored');
    // focus lost longer than the grace = one incident; undelivered incidents are retried
    const tick = window.setInterval(() => {
      const i = monitor.current?.tick(Date.now());
      if (i) void sendIncidentRef.current(i as OutgoingIncident);
    }, 250);
    const retry = window.setInterval(() => outbox.current.forEach((i) => void sendIncidentRef.current(i)), 10_000);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    document.addEventListener('fullscreenchange', fs);
    window.addEventListener('beforeunload', unloading);
    window.addEventListener('pagehide', unloading);
    window.addEventListener('pageshow', shown);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(retry);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      document.removeEventListener('fullscreenchange', fs);
      window.removeEventListener('beforeunload', unloading);
      window.removeEventListener('pagehide', unloading);
      window.removeEventListener('pageshow', shown);
    };
  }, []);

  // more than one face: counted on this device about once a second while the test runs (only the number is used)
  const facesOn = monitorOn && !!protection && protection.multipleFacesPolicy !== 'OFF';
  const facesRunning = facesOn && phase.name === 'exam' && cameraOn;
  useEffect(() => {
    if (!facesRunning) {
      faces.current.reset();
      return;
    }
    if (faceCounter.current) setFaceCheck('on');
    else if (!faceLoading.current) {
      faceLoading.current = true;
      setFaceCheck('loading');
      loadFaceCounter()
        .then((c) => {
          if (!mounted.current) return c.close();
          faceCounter.current = c;
          setFaceCheck('on');
        })
        .catch(() => mounted.current && setFaceCheck('unavailable'))
        .finally(() => (faceLoading.current = false));
    }
    const id = window.setInterval(() => {
      const counter = faceCounter.current;
      if (!counter || !video.current || document.visibilityState === 'hidden') return;
      const incident = faces.current.sample(counter.count(video.current), Date.now());
      if (incident) void sendIncidentRef.current(incident as OutgoingIncident);
    }, 1000);
    return () => window.clearInterval(id);
  }, [facesRunning]);
  useEffect(
    () => () => {
      faceCounter.current?.close();
      faceCounter.current = null;
    },
    [],
  );

  const acknowledge = () => {
    if (!warning) return;
    if (fullscreenWanted && !document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
    void acknowledgeIncident(token, warning.warningNumber);
    setWarning(null);
  };

  // ---------------------------------------------------------------- actions

  const goFullscreen = async () => {
    if (!fullscreenSupported() || document.fullscreenElement) return;
    await document.documentElement.requestFullscreen().catch(() => undefined);
  };

  /** From the check page: full screen (needs this click), then start or continue. */
  const begin = async () => {
    if (!view) return;
    setError(null);
    if (view.cameraRequired && !stream.current && !(await openCamera())) return;
    setBusy(true);
    await goFullscreen();
    const loadedAt = Date.now();
    try {
      const v = view.status === 'IN_PROGRESS' ? await getAssessment(token) : await startAssessment(token);
      if (!mounted.current) return;
      setView(v);
      applyProtection(v);
      if (v.status !== 'IN_PROGRESS' || !v.attempt) {
        finished(v);
      } else {
        if (stream.current) record('CAMERA_STARTED');
        await enterExam(v, loadedAt);
      }
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  };

  // ---------------------------------------------------------------- render

  const header = view && (
    <header className="flex flex-col gap-1">
      <p className="text-sm font-medium text-accent">{view.roundName}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{view.jobTitle}</h1>
      <p className="text-sm text-muted">{view.companyName}</p>
    </header>
  );

  if (phase.name === 'loading') {
    return (
      <Card>
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Opening your assessment…
        </p>
      </Card>
    );
  }

  if (phase.name === 'fatal') {
    return (
      <Card>
        <h1 className="text-lg font-semibold">{phase.title}</h1>
        <p className="text-sm text-muted">{phase.message}</p>
      </Card>
    );
  }

  if (phase.name === 'terminated') {
    const t = warningTexts('assessment').terminated;
    return (
      <>
        {header}
        <section role="alert" className="flex flex-col gap-3 rounded-lg border border-danger/50 bg-danger-soft p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-danger">{t.title}</h2>
          <p className="text-sm">{t.message}</p>
          <p className="text-sm text-muted">
            The answers you saved before this point are kept. The {view?.companyName ?? ''} hiring team reviews what happened and makes the decision - you will
            hear from them by email. This assessment cannot be restarted. You can close this page.
          </p>
        </section>
      </>
    );
  }

  if (phase.name === 'done' && view) {
    return (
      <>
        {header}
        <Card>
          <h2 className="text-lg font-semibold">{view.status === 'TIMED_OUT' ? 'Time is up - your assessment was submitted' : 'Thank you - your assessment is submitted'}</h2>
          <p className="text-sm text-muted">
            {view.status === 'TIMED_OUT' ? 'The answers you saved before the time ran out were submitted. ' : 'Your answers have been saved. '}
            The {view.companyName} hiring team will email you about the next steps. You can close this page.
          </p>
        </Card>
      </>
    );
  }

  if (!view) return null;

  if (phase.name === 'landing') {
    return (
      <>
        {header}
        <Card>
          <h2 className="text-lg font-semibold">Hi {view.candidateFirstName || 'there'}, welcome to your assessment</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Fact label="Duration" value={view.timeLimitMinutes ? `${view.timeLimitMinutes} minutes` : 'No time limit'} />
            <Fact label="Questions" value={String(view.questionCount)} />
            <Fact label="Maximum marks" value={String(view.totalMarks)} />
            <Fact label="Link valid until" value={formatDate(view.linkExpiresAt)} />
          </dl>
          {view.instructions.trim() && (
            <div className="rounded-md border border-border bg-background p-3 text-sm">
              <p className="font-medium">Instructions from the hiring team</p>
              <p className="mt-1 whitespace-pre-wrap text-muted">{view.instructions}</p>
            </div>
          )}
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Once you start, the timer runs on our server and does not stop - also if you close the page or lose your connection.</li>
            <li>Your answers are saved automatically as you go. If you refresh or reconnect, you continue where you were.</li>
            <li>When the time is up, the answers you saved are submitted automatically.</li>
            <li>Use a recent Chrome, Edge, Firefox or Safari, ideally on a laptop, and do not switch to other tabs or apps.</li>
          </ul>
          <div role="note" className="rounded-md border border-accent/40 bg-accent-soft p-3 text-sm">
            <p className="font-medium">This assessment is monitored</p>
            <p className="mt-1">
              {view.cameraRequired ? 'Your webcam must stay on during the test. The video is shown only to you on this page - it is not recorded or uploaded. ' : ''}
              The page records events such as {view.cameraRequired ? 'the camera turning off, ' : ''}leaving the test tab, leaving full screen and losing the connection, with
              the time they happened. {view.companyName}&apos;s hiring team can review these events with your answers. An event alone is not treated as cheating and
              does not decide your result.
            </p>
          </div>
          {view.protection.enabled && <ProtectionRules p={view.protection} />}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              I have read the instructions and I agree to the monitoring described above for this job application.
              {view.protection.enabled && ' I understand that exceeding the warnings ends my assessment.'}
            </span>
          </label>
          <Button variant="primary" className="self-start" disabled={!consent} onClick={() => setPhase({ name: 'check' })}>
            Continue to system check
          </Button>
        </Card>
      </>
    );
  }

  if (phase.name === 'check') {
    const resume = view.status === 'IN_PROGRESS';
    const cameraOk = cameraOn && !cameraProblem;
    const canStart = !view.cameraRequired || cameraOk;
    return (
      <>
        {header}
        <Card>
          <h2 className="text-lg font-semibold">{resume ? 'Welcome back - check your setup to continue' : 'System check'}</h2>
          {resume && <p className="text-sm text-muted">Your assessment is in progress and the timer is running. Your saved answers are waiting for you.</p>}
          <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
            <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-background">
              <video ref={video} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
              {!cameraOn && <p className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted">{cameraProblem ? 'Camera not available' : 'Starting camera…'}</p>}
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              <Check ok={cameraSupport() === null} label="Supported browser on a secure page" />
              <Check ok={cameraOk} pending={!cameraOn && !cameraProblem} label={view.cameraRequired ? 'Webcam on (required)' : 'Webcam on (recommended)'} />
              <Check ok={fullscreenSupported()} optional label="Full screen available" />
              <Check ok={online} label="Internet connection" />
            </ul>
          </div>
          {cameraProblem && (
            <div role="alert" className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              <p>{CAMERA_MESSAGES[cameraProblem]}</p>
              <Button className="self-start" onClick={() => void openCamera()}>
                Try the camera again
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Button variant="primary" className="self-start" disabled={!canStart || busy || !online} onClick={() => void begin()}>
            {busy && <Spinner />} {resume ? 'Continue assessment' : 'Start assessment'}
          </Button>
          {!resume && <p className="text-xs text-muted">The timer starts when you press Start. The page opens in full screen.</p>}
        </Card>
      </>
    );
  }

  // ---------------------------------------------------------------- exam
  const q = questions[current];
  const stats = summary(questions, answers);
  const low = remaining !== null && remaining <= 5 * 60_000;
  const picked = q ? (answers[q.id]?.selected ?? []) : [];
  const marked = q ? !!answers[q.id]?.marked : false;
  const progress = questions.length ? Math.round(((current + 1) / questions.length) * 100) : 0;

  // Covers the site header: the exam is a full-screen app of its own.
  return (
    <div className="fixed inset-0 z-10 flex flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 32 32" className="h-9 w-9 text-accent" aria-hidden="true">
              <path fill="currentColor" d="M4 4h7v9h10V4h7v24h-7v-9H11v9H4z" />
            </svg>
            <p className="text-base font-semibold leading-tight">
              Anvexa
              <br />
              Careers
            </p>
          </div>
          <span className="hidden h-10 w-px bg-border sm:block" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-semibold tracking-tight">{view.roundName}</p>
            <p className="truncate text-sm text-muted">
              {view.candidateFirstName} · {view.jobTitle} · {view.companyName}
            </p>
          </div>
          {remaining !== null && (
            <div className="flex items-center gap-3">
              <Icon name="clock" className={`h-8 w-8 ${low ? 'text-danger' : 'text-accent'}`} />
              <div>
                <p className="text-xs text-muted">Time Remaining</p>
                <p
                  className={`font-mono text-2xl font-bold leading-none tabular-nums ${low ? 'text-danger' : 'text-foreground'}`}
                  role="timer"
                  aria-label={`Time left ${formatRemaining(remaining)}`}
                >
                  {formatRemaining(remaining)}
                </p>
              </div>
            </div>
          )}
          <span className="hidden h-10 w-px bg-border sm:block" aria-hidden="true" />
          <div className="relative h-[72px] w-32 overflow-hidden rounded-lg border border-border bg-background" title="Your camera (not recorded)">
            <video ref={video} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
            <span
              className={`absolute right-1.5 top-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold text-white ${cameraOn ? 'bg-danger' : 'bg-muted'}`}
              aria-hidden="true"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white" /> {cameraOn ? 'LIVE' : 'OFF'}
            </span>
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <p className={`flex items-center gap-2 font-medium ${online ? 'text-success' : 'text-danger'}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} aria-hidden="true" />
              {online ? 'Connected' : 'Offline'}
            </p>
            <SaveBadge state={online ? saveState : 'offline'} />
          </div>
          {protection?.enabled && (
            <div className="flex flex-col gap-1 text-sm">
              <p
                className={`rounded-md border px-2.5 py-1 font-semibold tabular-nums ${protection.warningCount > 0 ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border'}`}
                aria-label={`Warnings ${protection.warningCount} of ${protection.maxWarnings}`}
              >
                Warnings: {protection.warningCount}/{protection.maxWarnings}
              </p>
              {faceCheck !== 'off' && facesOn && (
                <p className="text-xs text-muted">{faceCheck === 'on' ? 'Face check on (this device)' : faceCheck === 'loading' ? 'Face check starting…' : 'Face check unavailable'}</p>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {fullscreenWanted && !fullscreenOn && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          <span className="flex-1">This assessment must be taken in full screen. Please return to full screen.</span>
          <Button variant="primary" onClick={() => void goFullscreen()}>
            Return to full screen
          </Button>
        </div>
      )}
      {notice && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          <span className="flex-1">{notice}</span>
          {fullscreenSupported() && !document.fullscreenElement && <Button onClick={() => void goFullscreen()}>Return to full screen</Button>}
          <Button onClick={() => setNotice(null)}>OK</Button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          <span className="flex-1">{error}</span>
          <Button onClick={() => setError(null)}>OK</Button>
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[1fr_380px]">
        {q && (
          <section className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-5 shadow-sm sm:p-8" aria-labelledby="question-title">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span id="question-title" className="text-xl font-semibold">
                  Question {current + 1} of {questions.length}
                </span>
                <span className="text-muted" aria-hidden="true">
                  •
                </span>
                <span className="text-xl text-accent">
                  {q.marks} mark{q.marks === 1 ? '' : 's'}
                </span>
                {q.multiple && <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-foreground">Select all that apply</span>}
                {marked && <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">Marked for review</span>}
                <span className="ml-auto text-sm text-muted">{progress}% Complete</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-background" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <p className="whitespace-pre-wrap text-lg font-medium leading-relaxed sm:text-xl">{q.text}</p>
            <fieldset className="flex flex-col gap-3">
              <legend className="sr-only">Your answer</legend>
              {q.options.map((o, i) => {
                const on = picked.includes(i);
                const shape = q.multiple ? 'rounded-md' : 'rounded-full';
                return (
                  <label
                    key={i}
                    className={`flex cursor-pointer items-center gap-4 rounded-lg border px-5 py-4 transition focus-within:ring-2 focus-within:ring-accent/50 ${on ? 'border-accent bg-accent-soft' : 'border-border bg-background/40 hover:border-accent/50 hover:bg-accent-soft/40'}`}
                  >
                    <input
                      type={q.multiple ? 'checkbox' : 'radio'}
                      name={`q-${q.id}`}
                      className="sr-only"
                      checked={on}
                      onChange={() => update(choose(answersRef.current, q, i))}
                    />
                    <span className={`grid h-6 w-6 shrink-0 place-items-center border-2 ${shape} ${on ? 'border-accent' : 'border-muted'}`} aria-hidden="true">
                      {on && <span className={`h-3 w-3 bg-accent ${shape}`} />}
                    </span>
                    <span className="w-6 text-lg font-semibold text-accent">{String.fromCharCode(65 + i)}.</span>
                    <span className="flex-1 whitespace-pre-wrap text-base sm:text-lg">{o}</span>
                  </label>
                );
              })}
            </fieldset>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button disabled={current === 0} onClick={() => setCurrent(current - 1)}>
                <Icon name="left" /> Previous
              </Button>
              <span className="hidden h-8 w-px bg-border sm:block" aria-hidden="true" />
              <Button onClick={() => update(toggleMarked(answersRef.current, q.id))} aria-pressed={marked}>
                <Icon name="flag" /> {marked ? 'Unmark review' : 'Mark for review'}
              </Button>
              <span className="hidden h-8 w-px bg-border sm:block" aria-hidden="true" />
              <Button disabled={!picked.length} onClick={() => update(clearAnswer(answersRef.current, q.id))}>
                <Icon name="trash" /> Clear answer
              </Button>
              <span className="flex-1" />
              {current < questions.length - 1 ? (
                <Button variant="primary" className="px-6 text-base font-semibold" onClick={() => setCurrent(current + 1)}>
                  Save & Next <Icon name="right" />
                </Button>
              ) : (
                <Button variant="primary" className="px-6 text-base font-semibold" onClick={() => setConfirmSubmit(true)}>
                  Review & submit <Icon name="right" />
                </Button>
              )}
            </div>
          </section>
        )}

        <aside className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-5 shadow-sm lg:sticky lg:top-28" aria-label="Question navigation">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Icon name="chart" className="h-6 w-6 text-accent" /> Assessment Overview
          </h2>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat value={stats.answered} label="Answered" icon={<Icon name="check" className="h-5 w-5 text-success" />} />
            <Stat value={stats.unanswered} label="Not answered" icon={<Icon name="minus" className="h-5 w-5 text-muted" />} />
            <Stat value={stats.marked} label="Marked for review" icon={<Icon name="bookmark" className="h-5 w-5 text-amber-500" />} />
          </div>
          <hr className="border-border" />
          <div className="flex flex-col gap-3">
            <h3 className="font-semibold">Question Palette</h3>
            <ol className="grid grid-cols-5 gap-2">
              {questions.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setCurrent(i)}
                    aria-current={i === current ? 'step' : undefined}
                    aria-label={`Question ${i + 1}, ${PALETTE_TEXT[paletteState(answers, item.id)]}`}
                    className={`aspect-square w-full rounded-lg border text-lg font-semibold tabular-nums transition hover:border-accent/60 ${PALETTE_STYLE[paletteState(answers, item.id)]} ${i === current ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}
                  >
                    {i + 1}
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            {(['answered', 'unanswered', 'marked', 'answered-marked'] as PaletteState[]).map((s) => (
              <li key={s} className="flex items-center gap-3">
                <span className={`inline-block h-4 w-4 rounded-full ${LEGEND_DOT[s]}`} aria-hidden="true" /> {PALETTE_TEXT[s]}
              </li>
            ))}
          </ul>
          <Button variant="primary" className="py-3.5 text-base font-semibold" disabled={busy} onClick={() => setConfirmSubmit(true)}>
            {busy ? <Spinner /> : <Icon name="send" className="h-5 w-5" />} Submit assessment
          </Button>
        </aside>
      </div>
      </div>

      {confirmSubmit && (
        <div className="fixed inset-0 z-20 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="submit-title">
          <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-surface p-6 shadow-lg">
            <h2 id="submit-title" className="text-lg font-semibold">
              Submit your assessment?
            </h2>
            <p className="text-sm text-muted">
              You answered {stats.answered} of {stats.total} questions
              {stats.unanswered ? `; ${stats.unanswered} ${stats.unanswered === 1 ? 'is' : 'are'} not answered` : ''}
              {stats.marked ? ` and ${stats.marked} ${stats.marked === 1 ? 'is' : 'are'} marked for review` : ''}. After submitting you cannot change your answers.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setConfirmSubmit(false)} disabled={busy}>
                Back to the test
              </Button>
              <Button variant="primary" onClick={() => void submit(false)} disabled={busy}>
                {busy && <Spinner />} Submit now
              </Button>
            </div>
          </div>
        </div>
      )}

      {warning && <WarningDialog warning={warning} onAcknowledge={acknowledge} />}

      {cameraLost && view.cameraRequired && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-black/70 p-4" role="alertdialog" aria-modal="true" aria-labelledby="camera-title">
          <div className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-surface p-6 shadow-lg">
            <h2 id="camera-title" className="text-lg font-semibold">
              Your camera turned off
            </h2>
            <p className="text-sm text-muted">
              The webcam must stay on during this assessment. This has been recorded for the hiring team. The timer is still running - turn the camera back on to
              continue. Your answers are saved.
            </p>
            {cameraProblem && <p className="text-sm text-danger">{CAMERA_MESSAGES[cameraProblem]}</p>}
            <Button
              variant="primary"
              onClick={async () => {
                if (await openCamera()) record('CAMERA_STARTED');
              }}
            >
              Turn the camera back on
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const PALETTE_STYLE: Record<PaletteState, string> = {
  answered: 'border-success/60 bg-success/15 text-success',
  unanswered: 'border-border bg-background text-foreground',
  marked: 'border-amber-500/70 bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'answered-marked': 'border-violet-500/70 bg-violet-500/15 text-violet-600 dark:text-violet-400',
};

const LEGEND_DOT: Record<PaletteState, string> = {
  answered: 'bg-success',
  unanswered: 'bg-muted',
  marked: 'bg-amber-500',
  'answered-marked': 'bg-violet-500',
};

const PALETTE_TEXT: Record<PaletteState, string> = {
  answered: 'Answered',
  unanswered: 'Not answered',
  marked: 'Marked for review',
  'answered-marked': 'Answered and marked for review',
};

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'All answers saved',
  saving: 'Auto-saving…',
  offline: 'Offline - answers kept on this device',
  error: 'Not saved',
};

function SaveBadge({ state }: { state: SaveState }) {
  const tone = state === 'saved' || state === 'saving' ? 'text-muted' : 'text-danger';
  return (
    <p className={`flex items-center gap-2 ${tone}`} aria-live="polite">
      {state === 'saving' ? <Spinner className="h-3.5 w-3.5" /> : <Icon name="check" className="h-3.5 w-3.5" />}
      {SAVE_TEXT[state]}
    </p>
  );
}

const ICONS = {
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  left: <path d="M19 12H5m7 7-7-7 7-7" />,
  right: <path d="M5 12h14m-7-7 7 7-7 7" />,
  flag: <path d="M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1" />,
  trash: <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6m4-6v6" />,
  send: <path d="m22 2-7 20-4-9-9-4zm0 0L11 13" />,
  chart: <path d="M18 20V10M12 20V4M6 20v-6" />,
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  minus: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8" />
    </>
  ),
  bookmark: <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
};

function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">{children}</section>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function Stat({ value, label, icon }: { value: number; label: string; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-border bg-background px-2 py-3">
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs leading-tight text-muted">{label}</p>
      <span className="mt-1">{icon}</span>
    </div>
  );
}

function Check({ ok, label, pending, optional }: { ok: boolean; label: string; pending?: boolean; optional?: boolean }) {
  const icon = pending ? '…' : ok ? '✓' : optional ? '–' : '✗';
  const tone = pending ? 'text-muted' : ok ? 'text-success' : optional ? 'text-muted' : 'text-danger';
  return (
    <li className="flex items-center gap-2">
      <span className={`w-4 text-center font-bold ${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      <span className="sr-only">{pending ? 'checking' : ok ? 'ok' : optional ? 'not available (optional)' : 'not ok'}</span>
    </li>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** The rules, shown before the candidate agrees. */
function ProtectionRules({ p }: { p: AssessmentProtectionState }) {
  const max = p.maxWarnings;
  return (
    <div role="note" className="rounded-md border border-danger/30 bg-danger-soft/40 p-3 text-sm">
      <p className="font-medium">Warnings during this assessment</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
        {p.tabSwitchMonitoring && <li>leaving this tab, minimising the browser, or switching to another window or app (for more than about 2 seconds)</li>}
        {p.fullscreenRequired && fullscreenSupported() && <li>leaving full screen</li>}
        {p.multipleFacesPolicy !== 'OFF' && (
          <li>
            more than one person visible in your camera for about 5 seconds{p.multipleFacesPolicy === 'WARN' ? '' : ' (noted for the hiring team only, not a warning)'} - counted on
            your device; no image is stored or sent and nobody is identified
          </li>
        )}
      </ul>
      <p className="mt-2 text-xs">
        Each incident is one warning, whatever its kind. You may receive {max} warning{max === 1 ? '' : 's'} (the last one is the final warning); the next incident
        ends your assessment automatically. The answers you saved are kept and the hiring team reviews what happened - a person makes the decision. Reloading
        the page or losing the connection is not a warning.
      </p>
    </div>
  );
}

/** Warning N / final warning: must be acknowledged. Issued by the server; the page only shows it. */
function WarningDialog({ warning, onAcknowledge }: { warning: ShownWarning; onAcknowledge: () => void }) {
  const text = warningText(warning.warningNumber, warning.maxWarnings, warning.final, 'assessment');
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-4" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="warning-title"
        aria-describedby="warning-text"
        className={`flex w-full max-w-md flex-col gap-3 rounded-lg border-2 bg-surface p-6 shadow-lg ${warning.final ? 'border-danger' : 'border-accent'}`}
      >
        <h2 id="warning-title" className={`text-lg font-semibold ${warning.final ? 'text-danger' : ''}`}>
          {text.title}
        </h2>
        <p className="text-sm font-medium">{ASSESSMENT_INCIDENT_TEXT[warning.type]}</p>
        <p id="warning-text" className="text-sm">
          {text.message}
        </p>
        <Button autoFocus variant="primary" className="self-start" onClick={onAcknowledge}>
          I understand
        </Button>
      </div>
    </div>
  );
}
