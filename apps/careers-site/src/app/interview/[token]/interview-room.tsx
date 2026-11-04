'use client';

import {
  AI_INTERVIEW_LIMITS,
  type AiInterviewProtectionState,
  type AiInterviewPublicSession,
  type AiInterviewQuestion,
  type AiInterviewTranscriptLine,
  type AiInterviewViolationResult,
  type AiInterviewViolationType,
} from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@/components/ui';
import {
  InterviewApiError,
  acknowledgeWarning,
  endSession,
  getSession,
  getSpeech,
  pauseSession,
  repeatQuestion,
  reportViolation,
  resumeSession,
  sendAnswer,
  sendEvents,
  startSession,
  type PageEvent,
} from '@/lib/interview-api';
import {
  DEVICE_MESSAGES,
  EndOfAnswer,
  MAX_ANSWER_MS,
  MIN_ANSWER_MS,
  PAUSE_TEXT,
  PHASE_LABEL,
  SPEECH_LEVEL,
  describeError,
  deviceProblemOf,
  finishingIn,
  formatClock,
  type PauseReason,
  type Phase,
} from '@/lib/interview-ui';
import { loadFaceCounter, type FaceCounter } from '@/lib/face-counter';
import {
  FaceEpisodeTracker,
  INCIDENT_LABEL,
  ProtectionMonitor,
  WARNING_TEXT,
  fullscreenSupported,
  newIncidentId,
  warningText,
  type Incident,
  type ProtectionSignal,
} from '@/lib/interview-protection';
import { liveTranscriptSupported, startLiveTranscript, type LiveTranscript } from '@/lib/live-transcript';
import { SILENCE_PEAK, pickMimeType, startRecording, type ActiveRecording } from '@/lib/recorder';
import { newClientTurnId, type Recording } from '@/lib/screening-api';

interface PendingAnswer {
  seq: number;
  clientTurnId: string;
  recording: Recording;
}

type DeviceState = 'off' | 'on' | 'lost';

/** An incident to send to the server (kept until it got through: the same id is counted once). */
type OutgoingIncident = { id: string; type: AiInterviewViolationType; detail?: string };

/** A warning from the server, shown until the candidate acknowledges it. */
interface ShownWarning {
  warningNumber: number;
  maxWarnings: number;
  final: boolean;
  type: AiInterviewViolationType;
}

const IN_CALL: Phase['name'][] = ['speaking', 'listening', 'processing', 'error'];

/**
 * The candidate's AI technical interview. A real voice loop: the question is spoken (server text-to-speech), the
 * candidate answers out loud (camera on, shown only to them), the answer is recorded and sent to the API, which
 * transcribes and saves it and returns the next question chosen from what was said. The clock is the server's;
 * every answered question is saved at once, so a refresh, a lost device or a dropped connection continues where it
 * stopped. The live transcript is the browser's own preview; the saved transcript is the server's.
 */
export function InterviewRoom({ token }: { token: string }) {
  const [phase, setPhaseState] = useState<Phase>({ name: 'loading' });
  const [session, setSession] = useState<AiInterviewPublicSession | null>(null);
  const [question, setQuestion] = useState<AiInterviewQuestion | null>(null);
  const [lines, setLines] = useState<AiInterviewTranscriptLine[]>([]);
  const [answered, setAnswered] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [consent, setConsent] = useState(false);
  const [camera, setCamera] = useState<DeviceState>('off');
  const [mic, setMic] = useState<DeviceState>('off');
  const [micHeard, setMicHeard] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [level, setLevel] = useState(0);
  const [live, setLive] = useState({ final: '', interim: '' });
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<number | null>(null);
  const [answerSeconds, setAnswerSeconds] = useState(0);
  const [repeatsLeft, setRepeatsLeft] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  /** Interview protection, always as the server last said (the page never counts warnings itself). */
  const [protection, setProtection] = useState<AiInterviewProtectionState | null>(null);
  const [warning, setWarning] = useState<ShownWarning | null>(null);
  const [fullscreenOn, setFullscreenOn] = useState(false);
  /** On-device face counting: off (not used for this interview), loading, on, or unavailable in this browser. */
  const [faceCheck, setFaceCheck] = useState<'off' | 'loading' | 'on' | 'unavailable'>('off');

  const phaseRef = useRef<Phase>(phase);
  /** The server's remaining seconds, counted down locally between answers (the server's value always wins). */
  const remainingRef = useRef(0);
  const offlineSince = useRef<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const meter = useRef<{ ctx: AudioContext; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null>(null);
  const recording = useRef<ActiveRecording | null>(null);
  const liveText = useRef<LiveTranscript | null>(null);
  const endDetector = useRef<EndOfAnswer | null>(null);
  const answerStarted = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const speechUrls = useRef(new Map<number, string>());
  const pending = useRef<PendingAnswer | null>(null);
  const questionRef = useRef<AiInterviewQuestion | null>(null);
  const mounted = useRef(true);
  const monitor = useRef<ProtectionMonitor | null>(null);
  /** Incidents not delivered yet (offline): sent again with the same id until the server has them. */
  const outbox = useRef<OutgoingIncident[]>([]);
  const videoEl = useRef<HTMLVideoElement | null>(null);
  const faceCounter = useRef<FaceCounter | null>(null);
  const faceLoading = useRef(false);
  const faces = useRef(new FaceEpisodeTracker(newIncidentId));

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);

  const report = useCallback((type: PageEvent['type'], detail?: string, keepalive = false) => {
    void sendEvents(token, [{ type, occurredAt: new Date().toISOString(), ...(detail ? { detail } : {}) }], keepalive);
  }, [token]);

  // ---------------------------------------------------------------- session state from the server

  const apply = useCallback((s: AiInterviewPublicSession) => {
    setSession(s);
    setQuestion(s.current);
    questionRef.current = s.current;
    setLines(s.transcript);
    setAnswered(s.questionsAnswered);
    remainingRef.current = s.remainingSeconds;
    setRemaining(s.remainingSeconds);
    setRepeatsLeft(s.repeatsLeft);
    setProtection(s.protection);
    // a warning not acknowledged before a reload is shown again (the server keeps it)
    const w = s.protection.pendingWarning;
    if (w && s.status !== 'TERMINATED') setWarning({ warningNumber: w.warningNumber, maxWarnings: s.protection.maxWarnings, final: w.final, type: w.type });
  }, []);

  const fail = useCallback((err: unknown) => {
    const d = describeError(err);
    if (err instanceof InterviewApiError && err.code === 'INTERVIEW_TERMINATED') {
      terminateRef.current();
      return;
    }
    if (err instanceof InterviewApiError && err.code === 'INTERVIEW_PAUSED') {
      setPhase({ name: 'paused', reason: 'returning' });
      return;
    }
    setPhase(d.fatal ? { name: 'fatal', title: d.title, message: d.message } : { name: 'error', message: d.message, retry: d.retry });
  }, [setPhase]);

  // ---------------------------------------------------------------- devices

  const stopListening = useCallback(() => {
    liveText.current?.stop();
    liveText.current = null;
    recording.current?.cancel();
    recording.current = null;
    endDetector.current = null;
    setFinishing(null);
  }, []);

  const releaseDevices = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void meter.current?.ctx.close().catch(() => undefined);
    meter.current = null;
    setCamera('off');
    setMic('off');
  }, []);

  /**
   * The server ended the interview (warning limit): stop the interviewer's voice, the microphone and the camera at
   * once, refuse anything further, and show the termination. Saved answers stay on the server.
   */
  const terminate = useCallback(() => {
    monitor.current?.setActive(false, Date.now(), { hidden: false, focused: true, fullscreen: false });
    stopListening();
    if (audio.current) {
      audio.current.pause();
      audio.current.removeAttribute('src');
    }
    pending.current = null;
    outbox.current = [];
    releaseDevices();
    setWarning(null);
    setConfirmEnd(false);
    setPhase({ name: 'terminated' });
    if (typeof document !== 'undefined' && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [releaseDevices, setPhase, stopListening]);
  const terminateRef = useRef(terminate);
  terminateRef.current = terminate;

  /** What the server answered for an incident: its count is the only count. */
  const onProtectionResult = useCallback((r: AiInterviewViolationResult, type: AiInterviewViolationType) => {
    setProtection((p) => (p ? { ...p, warningCount: r.warningCount } : p));
    if (r.outcome === 'TERMINATED' || r.status === 'TERMINATED') {
      terminateRef.current();
      return;
    }
    if (r.outcome === 'WARNING' && r.warningNumber) {
      setWarning({ warningNumber: r.warningNumber, maxWarnings: r.maxWarnings, final: r.warningNumber >= r.maxWarnings, type });
    }
  }, []);

  const sendIncident = useCallback(
    async (incident: OutgoingIncident) => {
      if (!outbox.current.some((i) => i.id === incident.id)) outbox.current.push(incident);
      try {
        const r = await reportViolation(token, incident);
        outbox.current = outbox.current.filter((i) => i.id !== incident.id);
        if (mounted.current) onProtectionResult(r, incident.type);
      } catch (err) {
        // offline / server busy: kept in the outbox and sent again (same id); anything else is not retried
        if (!(err instanceof InterviewApiError && err.retryable)) outbox.current = outbox.current.filter((i) => i.id !== incident.id);
      }
    },
    [onProtectionResult, token],
  );
  const sendIncidentRef = useRef(sendIncident);
  sendIncidentRef.current = sendIncident;

  /** A device stopped while the interview runs: the clock stops (server) and the page waits for it. */
  const deviceLost = useCallback(
    (reason: 'CAMERA_LOST' | 'MIC_LOST') => {
      if (reason === 'CAMERA_LOST') setCamera('lost');
      else setMic('lost');
      const p = phaseRef.current.name;
      if (!IN_CALL.includes(p)) return;
      stopListening();
      audio.current?.pause();
      report(reason, 'track ended');
      // one incident per loss (the server groups further reports until the interview resumes with the device back)
      if (monitor.current) void sendIncidentRef.current({ id: newIncidentId(), type: reason, detail: 'track ended' });
      setPhase({ name: 'paused', reason });
      void pauseSession(token, reason).then((s) => s && apply(s)).catch(() => undefined);
    },
    [apply, report, setPhase, stopListening, token],
  );

  const acquire = useCallback(async (): Promise<boolean> => {
    setDeviceError(null);
    if (!window.isSecureContext) return setDeviceError(DEVICE_MESSAGES.insecure), false;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || !pickMimeType((t) => MediaRecorder.isTypeSupported(t))) {
      return setDeviceError(DEVICE_MESSAGES.unsupported), false;
    }
    try {
      stream.current?.getTracks().forEach((t) => t.stop());
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!s.getVideoTracks().length) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
      if (!s.getAudioTracks().length) throw Object.assign(new Error('no microphone'), { name: 'NotFoundError' });
      stream.current = s;
      s.getVideoTracks().forEach((t) => (t.onended = () => deviceLost('CAMERA_LOST')));
      s.getAudioTracks().forEach((t) => (t.onended = () => deviceLost('MIC_LOST')));
      void meter.current?.ctx.close().catch(() => undefined);
      meter.current = null;
      try {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          const ctx = new AC();
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          ctx.createMediaStreamSource(s).connect(analyser);
          meter.current = { ctx, analyser, buf: new Uint8Array(analyser.fftSize) };
        }
      } catch {
        meter.current = null; // no meter: the microphone still records
      }
      setCamera('on');
      setMic('on');
      setStreamVersion((v) => v + 1);
      return true;
    } catch (err) {
      setDeviceError(DEVICE_MESSAGES[deviceProblemOf(err)]);
      return false;
    }
  }, [deviceLost]);

  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      videoEl.current = el;
      if (el && stream.current && el.srcObject !== stream.current) {
        el.srcObject = stream.current;
        void el.play().catch(() => undefined);
      }
    },
    // streamVersion: attach the new stream after the devices were turned on again
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamVersion],
  );

  // ---------------------------------------------------------------- lifecycle

  useEffect(() => {
    mounted.current = true;
    const urls = speechUrls.current;
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      liveText.current?.stop();
      recording.current?.cancel();
      stream.current?.getTracks().forEach((t) => t.stop());
      void meter.current?.ctx.close().catch(() => undefined);
      audio.current?.pause();
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  useEffect(() => {
    getSession(token)
      .then((s) => {
        if (!mounted.current) return;
        apply(s);
        if (s.status === 'TERMINATED') setPhase({ name: 'terminated' });
        else if (s.status === 'COMPLETED' || s.status === 'INCOMPLETE') setPhase({ name: 'done', incomplete: s.status === 'INCOMPLETE' });
        else if (s.status === 'NOT_STARTED') setPhase({ name: 'welcome' });
        else setPhase({ name: 'paused', reason: 'returning' });
      })
      .catch(fail);
  }, [token, apply, fail, setPhase]);

  // the microphone meter, the end-of-answer detector, the cameras' health and the local clock - one loop
  useEffect(() => {
    let lastTick = Date.now();
    const id = window.setInterval(() => {
      const m = meter.current;
      let now = 0;
      if (m) {
        m.analyser.getByteTimeDomainData(m.buf);
        for (const v of m.buf) now = Math.max(now, Math.abs(v - 128));
        now = Math.min(1, now / 64);
      }
      setLevel(now);
      if (now >= SPEECH_LEVEL) setMicHeard(true);
      const p = phaseRef.current.name;
      if (p === 'listening') {
        setAnswerSeconds(Math.floor((Date.now() - answerStarted.current) / 1000));
        const state = endDetector.current?.sample(now, Date.now());
        if (state) {
          setFinishing(finishingIn(state));
          if (state.kind === 'end') void finishAnswerRef.current();
        }
      }
      // focus lost for longer than the grace (another window / app) becomes one incident
      const blurred = monitor.current?.tick(Date.now());
      if (blurred) void sendIncidentRef.current(blurred);
      // a camera that silently stopped (driver, privacy switch) is a lost camera too
      const video = stream.current?.getVideoTracks()[0];
      if (video && video.readyState === 'ended' && IN_CALL.includes(p)) deviceLost('CAMERA_LOST');
      if (Date.now() - lastTick >= 1000) {
        lastTick = Date.now();
        if (p === 'speaking' || p === 'listening' || p === 'processing') {
          const before = remainingRef.current;
          remainingRef.current = Math.max(0, before - 1);
          setRemaining(remainingRef.current);
          if (remainingRef.current === 0 && before > 0 && p === 'listening') void finishAnswerRef.current(); // time is up: send what was said
        }
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [deviceLost]);

  // connection: pause the conversation while offline, continue when back (the events are sent once they can be)
  useEffect(() => {
    const p = phaseRef.current.name;
    if (!online && IN_CALL.includes(p)) offlineSince.current ??= new Date().toISOString();
    if (online) for (const i of [...outbox.current]) void sendIncidentRef.current(i);
    if (online && offlineSince.current) {
      void sendEvents(token, [
        { type: 'CONNECTION_LOST', occurredAt: offlineSince.current },
        { type: 'CONNECTION_RESTORED', occurredAt: new Date().toISOString() },
      ]);
      offlineSince.current = null;
    }
    if (!online && (p === 'speaking' || p === 'listening')) {
      stopListening();
      audio.current?.pause();
      setPhase({ name: 'paused', reason: 'CONNECTION_LOST' });
    } else if (online && phaseRef.current.name === 'paused' && (phaseRef.current as { reason: PauseReason }).reason === 'CONNECTION_LOST') {
      void getSession(token)
        .then((s) => {
          apply(s);
          if (s.status === 'TERMINATED') terminateRef.current();
          else if (s.status === 'COMPLETED' || s.status === 'INCOMPLETE') setPhase({ name: 'done', incomplete: s.status === 'INCOMPLETE' });
          else if (s.status === 'PAUSED') setPhase({ name: 'paused', reason: 'returning' });
          else if (s.current) void askRef.current(s.current);
        })
        .catch(fail);
    }
  }, [online, apply, fail, setPhase, stopListening, token]);

  // leaving the page: tell the server (the clock stops while away); switching tabs is only noted for HR
  useEffect(() => {
    const hide = () => {
      if (!IN_CALL.includes(phaseRef.current.name)) return;
      report('PAGE_CLOSED', undefined, true);
      void pauseSession(token, 'PAGE_CLOSED', true).catch(() => undefined);
    };
    const visibility = () => {
      if (IN_CALL.includes(phaseRef.current.name)) report(document.visibilityState === 'hidden' ? 'PAGE_HIDDEN' : 'PAGE_VISIBLE');
    };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [report, token]);

  // ---------------------------------------------------------------- interview protection

  const monitorOn = !!protection?.enabled;
  const fullscreenWanted = monitorOn && !!protection?.fullscreenRequired && fullscreenSupported();
  useEffect(() => {
    monitor.current = monitorOn
      ? new ProtectionMonitor({ tabSwitch: !!protection?.tabSwitchMonitoring, fullscreen: fullscreenWanted, newId: newIncidentId })
      : null;
  }, [monitorOn, protection?.tabSwitchMonitoring, fullscreenWanted]);

  // monitoring runs only while the interview itself runs (not on the setup, pause, or end screens)
  useEffect(() => {
    monitor.current?.setActive(IN_CALL.includes(phase.name), Date.now(), {
      hidden: document.visibilityState === 'hidden',
      focused: document.hasFocus(),
      fullscreen: !!document.fullscreenElement,
    });
  }, [phase.name, monitorOn, protection?.tabSwitchMonitoring, fullscreenWanted]);

  // the browser's signals -> incidents (one per act of leaving; coming back is never one)
  useEffect(() => {
    const feed = (signal: ProtectionSignal) => {
      const incident: Incident | null | undefined = monitor.current?.signal(signal, Date.now());
      if (incident) void sendIncidentRef.current(incident);
    };
    const visibility = () => feed(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
    const blur = () => feed('blur');
    const focus = () => feed('focus');
    const fullscreen = () => {
      const on = !!document.fullscreenElement;
      setFullscreenOn(on);
      feed(on ? 'fullscreen-enter' : 'fullscreen-exit');
    };
    // a reload / close also hides the page: that is not leaving the interview (it pauses it, see below)
    const unloading = () => feed('unloading');
    const shown = (e: PageTransitionEvent) => e.persisted && feed('restored');
    setFullscreenOn(!!document.fullscreenElement);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    document.addEventListener('fullscreenchange', fullscreen);
    window.addEventListener('beforeunload', unloading);
    window.addEventListener('pagehide', unloading);
    window.addEventListener('pageshow', shown);
    // undelivered incidents (a flaky connection) are sent again now and then
    const retry = window.setInterval(() => outbox.current.forEach((i) => void sendIncidentRef.current(i)), 10_000);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      document.removeEventListener('fullscreenchange', fullscreen);
      window.removeEventListener('beforeunload', unloading);
      window.removeEventListener('pagehide', unloading);
      window.removeEventListener('pageshow', shown);
      window.clearInterval(retry);
    };
  }, []);

  // multiple faces: counted on this device about once a second while the interview runs (only the number is used)
  const facesOn = monitorOn && !!protection && protection.multipleFacesPolicy !== 'OFF';
  const facesRunning = facesOn && IN_CALL.includes(phase.name);
  useEffect(() => {
    if (!facesRunning) {
      faces.current.reset();
      return;
    }
    if (faceCounter.current) setFaceCheck('on');
    else if (!faceLoading.current) {
      // loaded once per page; kept across pauses
      faceLoading.current = true;
      setFaceCheck('loading');
      loadFaceCounter()
        .then((c) => {
          if (!mounted.current) return c.close();
          faceCounter.current = c;
          setFaceCheck('on');
        })
        // an old browser / no WebAssembly: the interview goes on without it (nothing is reported)
        .catch(() => mounted.current && setFaceCheck('unavailable'))
        .finally(() => (faceLoading.current = false));
    }
    const id = window.setInterval(() => {
      const counter = faceCounter.current;
      const video = videoEl.current;
      if (!counter || !video || document.visibilityState === 'hidden') return;
      const incident = faces.current.sample(counter.count(video), Date.now());
      if (incident) void sendIncidentRef.current(incident);
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

  // fullscreen is left by the page itself once the interview is over
  useEffect(() => {
    if ((phase.name === 'done' || phase.name === 'fatal') && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [phase.name]);

  /** Must run inside a click (browsers only allow fullscreen after a user action). */
  const enterFullscreen = () => {
    if (!fullscreenWanted || document.fullscreenElement) return;
    void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
  };

  const acknowledge = () => {
    if (!warning) return;
    enterFullscreen();
    void acknowledgeWarning(token, warning.warningNumber);
    setWarning(null);
  };

  // ---------------------------------------------------------------- audio out

  /** Must run inside a click: unlocks audio playback on iOS / Safari for the rest of the interview. */
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

  /** Plays a question; resolves when it finished (false when audio is unavailable: the text is on the screen). */
  const speak = async (q: AiInterviewQuestion): Promise<boolean> => {
    if (!audio.current) audio.current = new Audio();
    const el = audio.current;
    try {
      el.src = await speechUrl(q.seq);
      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error('playback'));
        el.onpause = () => (phaseRef.current.name === 'speaking' ? undefined : resolve());
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
    const audioOnly = new MediaStream(stream.current.getAudioTracks());
    recording.current = startRecording(audioOnly);
    endDetector.current = new EndOfAnswer();
    answerStarted.current = Date.now();
    setAnswerSeconds(0);
    setLive({ final: '', interim: '' });
    liveText.current = startLiveTranscript((final, interim) => mounted.current && setLive({ final, interim }));
    setPhase({ name: 'listening' });
    window.setTimeout(() => {
      if (phaseRef.current.name === 'listening' && Date.now() - answerStarted.current >= MAX_ANSWER_MS - 100) void finishAnswerRef.current();
    }, MAX_ANSWER_MS);
  }, [setPhase]);

  const ask = useCallback(
    async (q: AiInterviewQuestion) => {
      setQuestion(q);
      questionRef.current = q;
      setNotice(null);
      setPhase({ name: 'speaking' });
      const spoken = await speak(q);
      if (!mounted.current || phaseRef.current.name !== 'speaking') return; // paused or ended meanwhile
      if (q.kind === 'CLOSING') {
        releaseDevices();
        setPhase({ name: 'done', incomplete: false });
        return;
      }
      if (!spoken) setNotice('The question could not be played aloud - please read it on the screen and answer.');
      listen();
    },
    // speak only uses refs + token
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listen, releaseDevices, setPhase, token],
  );
  const askRef = useRef(ask);
  askRef.current = ask;

  const submit = useCallback(
    async (p: PendingAnswer) => {
      setPhase({ name: 'processing' });
      try {
        const res = await sendAnswer(token, p.seq, p.clientTurnId, p.recording);
        if (!mounted.current) return;
        pending.current = null;
        remainingRef.current = res.remainingSeconds;
        setRemaining(res.remainingSeconds);
        setAnswered(res.questionsAnswered);
        if (res.outcome === 'RETRY') {
          setPhase({ name: 'error', message: res.message ?? 'Please answer again.', retry: 'record' });
          return;
        }
        const q = questionRef.current;
        if (res.transcript !== null && q) {
          setLastSaved(res.transcript);
          setLines((prev) => (prev.some((l) => l.seq === p.seq) ? prev : [...prev, { seq: p.seq, question: q.text, answer: res.transcript! }]));
        }
        if (res.next) {
          setRepeatsLeft(AI_INTERVIEW_LIMITS.repeatsPerQuestion);
          await ask(res.next);
        }
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof InterviewApiError && (err.code === 'OUT_OF_SYNC' || err.code === 'INTERVIEW_ENDED')) {
          // answered in another tab, or the time ran out: continue from the server's state
          pending.current = null;
          const s = await getSession(token).catch(() => null);
          if (s) {
            apply(s);
            if (s.status === 'TERMINATED') {
              terminateRef.current();
              return;
            }
            if (s.status === 'COMPLETED' || s.status === 'INCOMPLETE') {
              if (s.current?.kind === 'CLOSING') await ask(s.current);
              else setPhase({ name: 'done', incomplete: s.status === 'INCOMPLETE' });
              return;
            }
            if (s.current) {
              await ask(s.current);
              return;
            }
          }
        }
        fail(err);
      }
    },
    [token, ask, apply, fail, setPhase],
  );

  const finishAnswer = useCallback(async () => {
    if (phaseRef.current.name !== 'listening') return;
    liveText.current?.stop();
    liveText.current = null;
    endDetector.current = null;
    setFinishing(null);
    const rec = recording.current;
    recording.current = null;
    const q = questionRef.current;
    if (!rec || !q) return;
    setPhase({ name: 'processing' });
    const result = await rec.stop();
    if (result.durationMs < MIN_ANSWER_MS || result.blob.size < 1_000) {
      setPhase({ name: 'error', message: 'That was very short. Please answer again when you are ready.', retry: 'record' });
      return;
    }
    if (result.peak !== null && result.peak < SILENCE_PEAK) {
      // nothing reached the microphone: never send silence (the server checks too)
      setPhase({ name: 'error', message: "We couldn't hear anything. Check that your microphone is on and not muted, then answer again.", retry: 'record' });
      return;
    }
    pending.current = { seq: q.seq, clientTurnId: newClientTurnId(), recording: result };
    await submit(pending.current);
  }, [setPhase, submit]);
  const finishAnswerRef = useRef(finishAnswer);
  finishAnswerRef.current = finishAnswer;

  // ---------------------------------------------------------------- buttons

  const toSetup = async () => {
    setPhase({ name: 'setup' });
    await acquire();
  };

  const begin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      unlockAudio();
      enterFullscreen();
      const s = await startSession(token);
      apply(s);
      if (s.current) await ask(s.current);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** After a pause / reload: devices on again, the clock runs again, the current question is asked again. */
  const continueInterview = async () => {
    if (busy) return;
    setBusy(true);
    try {
      unlockAudio();
      enterFullscreen();
      if (!stream.current || camera !== 'on' || mic !== 'on') {
        if (!(await acquire())) return;
        report('CAMERA_RESTORED');
        report('MIC_RESTORED');
      }
      const s = session?.status === 'PAUSED' || phase.name === 'paused' ? await resumeSession(token) : await getSession(token);
      apply(s);
      if (s.status === 'TERMINATED') terminate();
      else if (s.status === 'COMPLETED' || s.status === 'INCOMPLETE') setPhase({ name: 'done', incomplete: s.status === 'INCOMPLETE' });
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
    else await continueInterview();
  };

  const repeat = async () => {
    const q = questionRef.current;
    if (!q || phase.name !== 'listening') return;
    try {
      setRepeatsLeft(await repeatQuestion(token));
    } catch (err) {
      setNotice(err instanceof InterviewApiError ? err.message : 'This question cannot be repeated right now.');
      return;
    }
    stopListening();
    await ask(q);
  };

  const end = async () => {
    setConfirmEnd(false);
    stopListening();
    audio.current?.pause();
    try {
      const s = await endSession(token);
      apply(s);
      if (s.status === 'TERMINATED') return terminate();
      releaseDevices();
      setPhase({ name: 'done', incomplete: s.status === 'INCOMPLETE' });
    } catch (err) {
      fail(err);
    }
  };

  // ---------------------------------------------------------------- view

  const inCall = IN_CALL.includes(phase.name);
  const total = (session?.durationMinutes ?? 20) * 60;
  const lowTime = inCall && remaining <= 90;

  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-accent">{session?.roundName ?? 'AI technical interview'}</p>
          <h1 className="text-2xl font-semibold tracking-tight">{session ? session.jobTitle : 'Loading…'}</h1>
          {session && <p className="text-sm text-muted">{session.companyName}</p>}
        </div>
        {(inCall || phase.name === 'paused') && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Interview status">
            <div
              className={`rounded-md border px-3 py-1.5 text-sm font-semibold tabular-nums ${lowTime ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border bg-surface'}`}
              role="timer"
              aria-label={`Time left ${formatClock(remaining)}`}
            >
              {phase.name === 'paused' ? 'Paused · ' : ''}
              {formatClock(remaining)} left
            </div>
            {protection?.enabled && (
              <div
                className={`rounded-md border px-3 py-1.5 text-sm font-semibold tabular-nums ${protection.warningCount > 0 ? 'border-danger/40 bg-danger-soft text-danger' : 'border-border bg-surface'}`}
                aria-label={`Warnings ${protection.warningCount} of ${protection.maxWarnings}`}
              >
                Warnings: {protection.warningCount}/{protection.maxWarnings}
              </div>
            )}
          </div>
        )}
      </header>

      {inCall && fullscreenWanted && !fullscreenOn && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          <span>This interview must be taken in fullscreen. Please return to fullscreen.</span>
          <Button variant="primary" onClick={enterFullscreen}>
            Return to fullscreen
          </Button>
        </div>
      )}

      {!online && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
          You are offline. Your saved answers are safe - the interview continues when your internet is back.
        </p>
      )}

      {phase.name === 'loading' && (
        <Card>
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Opening your interview…
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
          <h2 className="text-lg font-semibold">Hi {session.candidateFirstName || 'there'}, welcome to your technical interview</h2>
          <p className="text-sm">
            You will talk with an AI interviewer for about {session.durationMinutes} minutes. It asks about the projects and skills in your resume, the technical
            skills of this role, and a few practical problems - and it follows up on what you say. Answer out loud, in English, as you would with a person.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Use a laptop or desktop (or a phone) in a quiet place, with a stable internet connection. Chrome or Edge work best.</li>
            <li>Your camera and microphone must stay on during the whole interview. If one stops, the interview pauses until it is back.</li>
            <li>Each question is spoken and shown on the screen. Answer, then stop talking for a few seconds or press “Done answering”.</li>
            <li>Once you start, the clock runs. If your connection drops or you reload the page, you continue where you left off.</li>
            <li>Your link works until {formatDate(session.expiresAt)}.</li>
          </ul>
          {session.protection.enabled && <ProtectionNotice protection={session.protection} fullscreen={fullscreenSupported()} />}
          <div className="rounded-md border border-border bg-background p-3 text-xs text-muted">
            <p className="font-medium text-foreground">How your camera, voice and answers are used</p>
            <p className="mt-1">
              Your camera picture is shown only to you on this page: it is not recorded and not uploaded, and there is no face recognition, gaze or emotion
              detection, and no screen recording.
              {session.protection.multipleFacesPolicy !== 'OFF' &&
                ' To notice when more than one person is in view, your own device counts the faces in the picture; only that number is used, no image leaves your device and nobody is identified.'} The page notes for the hiring team when the camera, microphone or connection stops
              {session.protection.enabled ? ', and the monitored activities listed above (only that they happened, and when)' : ''}. Each spoken answer is sent to our AI provider (Google
              Gemini) to turn it into text and choose the next question; the audio is not stored. While you speak, your browser may show a live transcript
              using its own speech service (in Chrome and Edge this is Google or Microsoft). The text of your answers, the questions asked and an AI-written
              evaluation are saved for {session.companyName}&apos;s HR team, who make every decision - the AI does not. You can ask for your data to be deleted
              from this careers site&apos;s “my data” page.
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              I agree that my camera and microphone are used for this interview, and that my spoken answers are processed by AI and saved as text for this job application.
              {session.protection.enabled && ' I understand the interview protection rules above, including that exceeding the warnings ends the interview.'}
            </span>
          </label>
          <Button variant="primary" className="self-start" disabled={!consent} onClick={() => void toSetup()}>
            Continue to device check
          </Button>
        </Card>
      )}

      {(phase.name === 'setup' || phase.name === 'paused') && (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <Card>
            {phase.name === 'setup' ? (
              <>
                <h2 className="text-lg font-semibold">Check your camera and microphone</h2>
                <ol className="flex flex-col gap-3 text-sm">
                  <Check ok={camera === 'on'} label="Camera on" hint={camera === 'on' ? 'You can see yourself on the right.' : 'Allow the camera when your browser asks.'} />
                  <Check
                    ok={mic === 'on' && micHeard}
                    label="Microphone working"
                    hint={mic !== 'on' ? 'Allow the microphone when your browser asks.' : micHeard ? 'We can hear you.' : 'Say “hello” out loud to test it.'}
                  >
                    {mic === 'on' && <Meter level={level} />}
                  </Check>
                  <Check ok={online} label="Internet connection" hint={online ? 'Connected.' : 'You are offline.'} />
                  <Check ok={liveTranscriptSupported()} optional label="Live transcript" hint={liveTranscriptSupported() ? 'Your words appear while you speak.' : 'Not available in this browser - your answers are still transcribed and saved.'} />
                </ol>
                {deviceError && (
                  <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                    {deviceError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={busy || camera !== 'on' || mic !== 'on' || !micHeard || !online} onClick={() => void begin()}>
                    {busy && <Spinner />} Start interview
                  </Button>
                  {(camera !== 'on' || mic !== 'on') && (
                    <Button onClick={() => void acquire()} disabled={busy}>
                      Turn on camera and microphone
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted">The clock starts when you press “Start interview”. The interviewer speaks first.</p>
              </>
            ) : (
              <>
                <h2 className="text-lg font-semibold">{PAUSE_TEXT[phase.reason].title}</h2>
                <p className="text-sm text-muted">{PAUSE_TEXT[phase.reason].message}</p>
                {session && phase.reason !== 'CONNECTION_LOST' && (
                  <p className="text-xs text-muted">
                    {lines.length > 1 ? `${lines.length - 1} answers saved. ` : ''}Pause time left for technical problems: {formatClock(session.pauseSecondsLeft)}.
                  </p>
                )}
                {deviceError && (
                  <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
                    {deviceError}
                  </p>
                )}
                {phase.reason === 'CONNECTION_LOST' ? (
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Spinner /> Reconnecting…
                  </p>
                ) : (
                  <Button variant="primary" className="self-start" disabled={busy || !online} onClick={() => void continueInterview()}>
                    {busy && <Spinner />} {camera === 'on' && mic === 'on' ? 'Continue interview' : 'Turn on camera and microphone and continue'}
                  </Button>
                )}
              </>
            )}
          </Card>
          <CameraPanel videoRef={videoRef} camera={camera} mic={mic} online={online} level={level} protection={protection} fullscreen={fullscreenWanted ? fullscreenOn : null} faceCheck={facesOn ? faceCheck : 'off'} />
        </div>
      )}

      {inCall && question && (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <div className="flex min-w-0 flex-col gap-5">
            <Card>
              <div className="flex flex-col gap-1">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-accent-soft" role="progressbar" aria-label="Interview time used" aria-valuemin={0} aria-valuemax={total} aria-valuenow={total - remaining}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-1000 motion-reduce:transition-none" style={{ width: `${Math.min(100, Math.round(((total - remaining) / total) * 100))}%` }} />
                </div>
                <p className="text-xs text-muted">
                  {answered} question{answered === 1 ? '' : 's'} answered · {formatClock(total - remaining)} of {formatClock(total)}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <Interviewer phase={phase.name} level={level} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="text-sm font-medium" aria-live="polite">
                    {phase.name === 'listening' && finishing !== null ? `Finishing your answer in ${finishing}… keep talking to continue` : PHASE_LABEL[phase.name] ?? ''}
                  </p>
                  {phase.name === 'listening' && <p className="text-xs tabular-nums text-muted">Answering for {formatClock(answerSeconds)}</p>}
                  {phase.name === 'speaking' && <p className="text-xs text-muted">Listen to the question - you answer when it finishes.</p>}
                </div>
              </div>
              <blockquote className="rounded-md border-l-4 border-accent bg-accent-soft px-4 py-3 text-base leading-relaxed">{question.text}</blockquote>
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
                    {question.kind !== 'INTRO' && (
                      <Button onClick={() => void repeat()} disabled={repeatsLeft <= 0}>
                        Repeat the question{repeatsLeft > 0 ? ` (${repeatsLeft} left)` : ''}
                      </Button>
                    )}
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
            </Card>

            <Card>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">Live transcript</h2>
                <span className="text-xs text-muted">{liveTranscriptSupported() ? 'Preview from your browser' : 'Not available in this browser'}</span>
              </div>
              <div className="min-h-16 rounded-md border border-border bg-background px-3 py-2 text-sm" aria-live="polite">
                {phase.name === 'listening' ? (
                  live.final || live.interim ? (
                    <p>
                      {live.final} <span className="text-muted">{live.interim}</span>
                    </p>
                  ) : (
                    <p className="text-muted">{liveTranscriptSupported() ? 'Start speaking - your words appear here.' : 'Speak your answer - it is transcribed when you finish.'}</p>
                  )
                ) : phase.name === 'processing' ? (
                  <p className="flex items-center gap-2 text-muted">
                    <Spinner /> Transcribing your answer…
                  </p>
                ) : lastSaved ? (
                  <p>
                    <span className="text-xs font-medium text-muted">Saved: </span>
                    {lastSaved}
                  </p>
                ) : (
                  <p className="text-muted">Your answer appears here while you speak.</p>
                )}
              </div>
              <p className="text-xs text-muted">The saved transcript of each answer (below) is made from your recording and is what the hiring team reads.</p>
            </Card>

            {lines.length > 0 && (
              <section aria-label="Conversation so far" className="flex flex-col gap-3">
                <h2 className="text-sm font-semibold text-muted">Conversation so far</h2>
                <ol className="flex flex-col gap-3">
                  {lines.map((l) => (
                    <li key={l.seq} className="rounded-lg border border-border bg-surface p-4 text-sm">
                      <p className="text-muted">
                        <span className="font-medium text-foreground">Interviewer:</span> {l.question}
                      </p>
                      <p className="mt-2">
                        <span className="font-medium">You:</span> {l.answer}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <div className="border-t border-border pt-3">
              {confirmEnd ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>End the interview now? Your answers so far are saved and go to the hiring team. You cannot continue afterwards.</span>
                  <Button onClick={() => void end()}>Yes, end the interview</Button>
                  <Button onClick={() => setConfirmEnd(false)}>Keep going</Button>
                </div>
              ) : (
                <button type="button" className="text-sm text-muted underline hover:text-foreground" disabled={phase.name === 'processing'} onClick={() => setConfirmEnd(true)}>
                  End interview
                </button>
              )}
            </div>
          </div>
          <CameraPanel videoRef={videoRef} camera={camera} mic={mic} online={online} level={level} protection={protection} fullscreen={fullscreenWanted ? fullscreenOn : null} faceCheck={facesOn ? faceCheck : 'off'} />
        </div>
      )}

      {phase.name === 'terminated' && (
        <section role="alert" className="flex flex-col gap-3 rounded-lg border border-danger/50 bg-danger-soft p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold text-danger">{WARNING_TEXT.terminated.title}</h2>
          <p className="text-sm">{WARNING_TEXT.terminated.message}</p>
          <p className="text-sm text-muted">
            The answers you gave before this point are saved. The {session?.companyName ?? ''} hiring team reviews what happened and makes the decision - you
            will hear from them. This interview cannot be restarted. You can close this page.
          </p>
        </section>
      )}

      {warning && inCall && <WarningDialog warning={warning} onAcknowledge={acknowledge} />}

      {phase.name === 'done' && (
        <Card>
          <h2 className="text-lg font-semibold">{phase.incomplete ? 'Your interview has ended' : 'Thank you - your interview is complete'}</h2>
          <p className="text-sm text-muted">
            Your answers have been saved and shared with the {session?.companyName ?? ''} hiring team. They review every interview themselves and will contact you
            about the next steps. You can close this page.
          </p>
        </Card>
      )}
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-6">{children}</section>;
}

function CameraPanel({
  videoRef,
  camera,
  mic,
  online,
  level,
  protection,
  fullscreen,
  faceCheck,
}: {
  videoRef: (el: HTMLVideoElement | null) => void;
  camera: DeviceState;
  mic: DeviceState;
  online: boolean;
  level: number;
  protection: AiInterviewProtectionState | null;
  /** null = fullscreen is not required (or not available in this browser). */
  fullscreen: boolean | null;
  faceCheck: 'off' | 'loading' | 'on' | 'unavailable';
}) {
  return (
    // on a phone the preview comes first (and smaller) so the candidate always sees their camera while answering
    <aside className="order-first flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm lg:sticky lg:top-6 lg:order-none lg:self-start" aria-label="Your camera and devices">
      <div className="relative mx-auto aspect-video w-full max-w-72 overflow-hidden rounded-md bg-black lg:max-w-none">
        {camera === 'on' ? (
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera (only you see this)" />
        ) : (
          <div className="grid h-full place-items-center px-4 text-center text-sm text-white/80">{camera === 'lost' ? 'Camera turned off' : 'Camera is off'}</div>
        )}
      </div>
      <ul className="flex flex-col gap-1.5 text-sm">
        <Status ok={camera === 'on'} label={camera === 'on' ? 'Camera on' : camera === 'lost' ? 'Camera lost' : 'Camera off'} />
        <Status ok={mic === 'on'} label={mic === 'on' ? 'Microphone on' : mic === 'lost' ? 'Microphone lost' : 'Microphone off'}>
          {mic === 'on' && <Meter level={level} />}
        </Status>
        <Status ok={online} label={online ? 'Connected' : 'Offline'} />
        {fullscreen !== null && <Status ok={fullscreen} label={fullscreen ? 'Fullscreen on' : 'Not in fullscreen'} />}
        {faceCheck !== 'off' && (
          <Status ok={faceCheck !== 'unavailable'} label={faceCheck === 'on' ? 'Face check on (on this device)' : faceCheck === 'loading' ? 'Face check starting…' : 'Face check unavailable in this browser'} />
        )}
        {protection?.enabled && (
          <Status ok={protection.warningCount === 0} label={`Protection monitoring active · Warnings: ${protection.warningCount}/${protection.maxWarnings}`} />
        )}
      </ul>
      <p className="text-xs text-muted">
        Only you see your camera. It is not recorded or uploaded.{faceCheck !== 'off' ? ' This device counts how many faces are visible - nothing else.' : ''}
      </p>
    </aside>
  );
}

/** What is monitored and what happens, shown before the candidate agrees. */
function ProtectionNotice({ protection, fullscreen }: { protection: AiInterviewProtectionState; fullscreen: boolean }) {
  const max = protection.maxWarnings;
  const devicesWarn = protection.cameraPolicy === 'WARN' || protection.microphonePolicy === 'WARN';
  return (
    <div className="rounded-md border border-accent/40 bg-accent-soft p-3 text-sm">
      <p className="font-medium">Interview protection</p>
      <p className="mt-1 text-xs">While the interview runs, this page notices when:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
        {protection.tabSwitchMonitoring && <li>you leave this tab, minimise the browser, or switch to another window or app (for more than about 2 seconds)</li>}
        {protection.fullscreenRequired && fullscreen && <li>you leave fullscreen (the interview runs in fullscreen)</li>}
        {protection.multipleFacesPolicy !== 'OFF' && (
          <li>
            more than one person is visible in your camera for about 5 seconds (counted on your device; no image is stored or sent)
            {protection.multipleFacesPolicy === 'WARN' ? ' - this counts as a warning' : ' - noted for the hiring team, not a warning'}
          </li>
        )}
        <li>
          your camera or microphone stops - the interview pauses until it is back
          {devicesWarn ? '; for this interview that also counts as a warning' : ' (this is treated as a technical problem, not a warning)'}
        </li>
      </ul>
      <p className="mt-2 text-xs">
        Each such incident is one warning, whatever its kind: you may receive {max} warning{max === 1 ? '' : 's'}
        {max > 1 ? ` (the ${max === 2 ? 'second' : `${max}th`} is the final warning)` : ' (it is the final warning)'}. The next incident ends the interview
        automatically. Your answers so far are kept and the hiring team reviews what happened - a person makes the decision, not the system.
      </p>
      <p className="mt-1 text-xs text-muted">
        The page only learns that it was hidden or lost focus - never which website or app you opened. Reloading the page or a lost connection is not a
        warning.
      </p>
    </div>
  );
}

/** Warning N / final warning: must be acknowledged. Server-issued; the page only shows it. */
function WarningDialog({ warning, onAcknowledge }: { warning: ShownWarning; onAcknowledge: () => void }) {
  const text = warningText(warning.warningNumber, warning.maxWarnings, warning.final);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="presentation">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="warning-title"
        aria-describedby="warning-text"
        className={`flex w-full max-w-md flex-col gap-3 rounded-lg border-2 bg-surface p-5 shadow-lg ${warning.final ? 'border-danger' : 'border-accent'}`}
      >
        <h2 id="warning-title" className={`text-lg font-semibold ${warning.final ? 'text-danger' : ''}`}>
          {text.title}
        </h2>
        <p className="text-sm font-medium">{INCIDENT_LABEL[warning.type]}</p>
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

function Status({ ok, label, children }: { ok: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-success' : 'bg-danger'}`} />
      <span className={ok ? '' : 'text-danger'}>{label}</span>
      {children}
    </li>
  );
}

function Check({ ok, label, hint, optional, children }: { ok: boolean; label: string; hint: string; optional?: boolean; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold ${ok ? 'bg-success text-white' : optional ? 'bg-border text-muted' : 'bg-danger-soft text-danger'}`}
      >
        {ok ? '✓' : optional ? '–' : '!'}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-medium">
          {label}
          <span className="sr-only">{ok ? ' - ready' : optional ? ' - optional' : ' - not ready'}</span>
        </span>
        <span className="text-xs text-muted">{hint}</span>
        {children}
      </div>
    </li>
  );
}

function Meter({ level }: { level: number }) {
  return (
    <span className="ml-auto inline-flex h-2 w-24 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <span className="h-full rounded-full bg-success transition-[width] duration-100 motion-reduce:transition-none" style={{ width: `${Math.round(level * 100)}%` }} />
    </span>
  );
}

/** The interviewer's state. Honest: it pulses only while audio really plays or the microphone really records. */
function Interviewer({ phase, level }: { phase: Phase['name']; level: number }) {
  const ring = phase === 'speaking' ? 'ring-accent motion-safe:animate-pulse' : phase === 'listening' ? 'ring-success' : phase === 'error' ? 'ring-danger' : 'ring-border';
  const scale = phase === 'listening' ? 1 + level * 0.12 : 1;
  return (
    <div aria-hidden="true" className={`grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent-soft ring-4 transition-transform ${ring}`} style={{ transform: `scale(${scale})` }}>
      {phase === 'processing' ? <Spinner className="h-6 w-6 text-accent" /> : <span className="text-lg font-semibold text-accent">AI</span>}
    </div>
  );
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** 0.05 s of silence: played muted inside the first click so later questions can play on iOS / Safari. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
