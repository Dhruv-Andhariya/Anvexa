'use client';

import type { FaceLandmarker, ObjectDetector } from '@mediapipe/tasks-vision';
import { CameraRuleEngine, type CameraAlert } from '@hireflow/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Spinner } from '@/components/ui';
import {
  CAMERA_MESSAGES,
  cameraProblemOf,
  cameraSupport,
  followCameraPermission,
  startCamera,
  watchCameraPermission,
  type CameraPermission,
  type CameraProblem,
} from '@/lib/camera';
import { loadFaceLandmarker, loadObjectDetector, toDetections, toMeasures } from './face-model';

/** Frames analysed per second; slowed down on weak computers so the page stays responsive. */
const FRAME_MS = 200;
const SLOW_FRAME_MS = 500;
const SLOW_DETECT_MS = 80;
/** The object detector (people, phones) is heavier: about once a second, every 2 s on a weak computer. */
const OBJECT_MS = 1000;
const SLOW_OBJECT_MS = 2000;
const SLOW_OBJECT_DETECT_MS = 150;

export type CameraStatus = 'off' | 'starting' | 'on' | 'error';
/** What the candidate's own preview says (live, never sent): a face, none, or more than one. */
export type FaceHint = 'ok' | 'none' | 'many' | null;

interface Options {
  /** The round is camera-monitored (server config). Nothing happens otherwise. */
  enabled: boolean;
  /** True only while the assessment is in progress: only then do frames count. */
  active: boolean;
  /** Epoch ms on the server's clock (alerts carry server times). */
  serverNow: () => number;
  /** A grouped alert from the rules (contracts camera-proctoring.ts). */
  onAlert: (alert: CameraAlert) => void;
}

/**
 * The webcam, analysed in the browser with MediaPipe: Face Landmarker about 5 times a second (face in view, head pose,
 * eyes) and an Object Detector about once a second (people and phones in view). Each frame is reduced to a few numbers
 * (4 face points, eye scores, labels with scores) that the shared rules turn into rare, grouped alerts; frames, images
 * and landmarks never leave this function.
 *
 * Permission: when the site is already allowed the camera turns on by itself (also after a reload mid-test); when the
 * browser has not asked yet, `start()` (from a click) makes it ask; when it is blocked, the page explains how to allow
 * it and turns the camera on as soon as it is allowed. Only the camera is asked for, never the microphone.
 */
export function useCameraMonitor({ enabled, active, serverNow, onAlert }: Options) {
  const [status, setStatus] = useState<CameraStatus>('off');
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [face, setFace] = useState<FaceHint>(null);
  const [permission, setPermission] = useState<CameraPermission>('unknown');
  /** The camera runs and its picture shows, the face check is still loading. */
  const [preparing, setPreparing] = useState(false);

  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const previews = useRef(new Set<HTMLVideoElement>());
  const landmarker = useRef<FaceLandmarker | null>(null);
  const model = useRef<Promise<FaceLandmarker> | null>(null);
  /** The people / phone detector; null when it could not load (the face checks still run). */
  const detector = useRef<ObjectDetector | null>(null);
  const detectorLoad = useRef<Promise<ObjectDetector | null> | null>(null);
  const starting = useRef(false);
  /** When the model's runtime last crashed (a second crash within a minute stops the check). */
  const lastCrash = useRef(0);
  const engine = useRef(new CameraRuleEngine());
  const unwatch = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const onAlertRef = useRef(onAlert);
  const serverNowRef = useRef(serverNow);
  activeRef.current = active;
  onAlertRef.current = onAlert;
  serverNowRef.current = serverNow;

  const release = useCallback(() => {
    unwatch.current?.();
    unwatch.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    for (const v of previews.current) v.srcObject = null;
  }, []);

  /** The camera went away during the attempt: one alert (the rules group repeats), and the page asks to turn it on. */
  const lost = useCallback(
    (why: string) => {
      release();
      setStatus('error');
      setProblem('unknown');
      setFace(null);
      if (activeRef.current) engine.current.stopped(serverNowRef.current(), why).forEach((a) => onAlertRef.current(a));
    },
    [release],
  );

  /** The face model, loaded once (and early: as soon as the round needs the camera, before the click). */
  const loadModel = useCallback(() => {
    model.current ??= loadFaceLandmarker().catch((err: unknown) => {
      model.current = null; // a failed load is tried again next time
      throw err;
    });
    return model.current;
  }, []);

  /** A technical alert (never misconduct): the check could not run. Only reported while the attempt runs. */
  const unavailable = useCallback((why: string) => {
    if (activeRef.current) engine.current.unavailable(serverNowRef.current(), why).forEach((a) => onAlertRef.current(a));
  }, []);

  /** The people / phone detector, loaded once in the background. A failure leaves the face checks running. */
  const loadDetector = useCallback(() => {
    detectorLoad.current ??= loadObjectDetector().catch(() => {
      detectorLoad.current = null;
      return null;
    });
    return detectorLoad.current;
  }, []);

  const showPreview = (el: HTMLVideoElement, s: MediaStream | null) => {
    if (el.srcObject !== s) el.srcObject = s;
    if (s) void el.play().catch(() => undefined);
  };

  const start = useCallback(async (): Promise<boolean> => {
    if (!enabled || starting.current) return false;
    const unsupported = cameraSupport();
    if (unsupported) {
      setProblem(unsupported);
      setStatus('error');
      return false;
    }
    starting.current = true;
    setStatus('starting');
    setProblem(null);
    try {
      let s: MediaStream;
      try {
        s = await startCamera(); // the browser asks the candidate here when it has not decided yet
      } catch (err) {
        setProblem(cameraProblemOf(err));
        setStatus('error');
        return false;
      }
      // the candidate sees their picture at once; the face check finishes loading meanwhile
      stream.current = s;
      for (const p of previews.current) showPreview(p, s);
      setPreparing(true);
      try {
        landmarker.current ??= await loadModel();
      } catch {
        release();
        setProblem('model');
        setStatus('error');
        return false;
      } finally {
        setPreparing(false);
      }
      detector.current ??= await loadDetector();
      // a hidden element for the analysis, so it does not depend on which screen shows the preview
      const v = video.current ?? document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.srcObject = s;
      video.current = v;
      await v.play().catch(() => undefined);
      s.getVideoTracks()[0]?.addEventListener('ended', () => lost('camera turned off or disconnected'));
      unwatch.current = await watchCameraPermission(() => lost('camera permission withdrawn'));
      setStatus('on');
      return true;
    } finally {
      starting.current = false;
    }
  }, [enabled, lost, loadModel, loadDetector, release]);

  /** A preview <video> (the candidate's own picture). Several may exist; all show the same stream. */
  const preview = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    previews.current.add(el);
    showPreview(el, stream.current);
  }, []);

  // as soon as the round needs the camera: follow the browser's permission and start loading the face model
  useEffect(() => {
    if (!enabled) return;
    void loadModel().catch(() => undefined); // errors show when the candidate turns the camera on
    void loadDetector();
    let stop: (() => void) | null = null;
    let alive = true;
    void followCameraPermission((p) => alive && setPermission(p)).then((s) => {
      if (alive) stop = s;
      else s();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [enabled, loadModel, loadDetector]);

  // allowed already (or just allowed after being blocked): no need to ask, the camera turns on by itself
  useEffect(() => {
    if (!enabled || permission !== 'granted') return;
    if (status === 'off' || (status === 'error' && problem === 'denied')) void start();
  }, [enabled, permission, status, problem, start]);

  // the analysis loop: a few frames per second while the camera runs; frames count only during the attempt
  useEffect(() => {
    if (status !== 'on') return;
    let timer: number | null = null;
    let frame = 0;
    let slowFrames = 0;
    let every = FRAME_MS;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let brightness: number | null = null;

    let lastTs = 0;
    let stopped = false;
    let lastObjects = -Infinity;
    let objectEvery = OBJECT_MS;
    let objectWarned = false;

    /**
     * The model's runtime crashed ("Aborted()"): every later frame would fail too. Throw this instance away and load a
     * fresh one once, quietly; a second crash soon after stops the check and asks the candidate to press Try again.
     */
    const recover = async () => {
      stopped = true;
      const broken = landmarker.current;
      landmarker.current = null;
      model.current = null;
      try {
        broken?.close();
      } catch {
        // already dead
      }
      const now = Date.now();
      if (now - lastCrash.current < 60_000) {
        lastCrash.current = now;
        unavailable('the face check stopped working');
        release();
        setProblem('model');
        setStatus('error');
        return;
      }
      lastCrash.current = now;
      try {
        landmarker.current = await loadModel();
        stopped = false;
        timer = window.setTimeout(tick, every);
      } catch {
        unavailable('the face check could not be restarted');
        release();
        setProblem('model');
        setStatus('error');
      }
    };

    /** People and phones in view, about once a second (never every frame). A detector failure only disables it. */
    const detectObjects = (v: HTMLVideoElement, ts: number) => {
      const od = detector.current;
      if (!od) {
        if (!objectWarned && activeRef.current) {
          objectWarned = true;
          unavailable('people / phone check unavailable');
        }
        return;
      }
      const began = performance.now();
      try {
        const found = toDetections(od.detectForVideo(v, ts), v.videoWidth, v.videoHeight);
        if (activeRef.current) engine.current.pushObjects(serverNowRef.current(), found).forEach((a) => onAlertRef.current(a));
      } catch {
        detector.current = null; // broken: the face checks continue, HR sees "check unavailable"
        try {
          od.close();
        } catch {
          // already closed
        }
      }
      objectEvery = performance.now() - began > SLOW_OBJECT_DETECT_MS ? SLOW_OBJECT_MS : OBJECT_MS;
    };

    const tick = () => {
      if (stopped) return;
      const v = video.current;
      const lm = landmarker.current;
      // a hidden tab is already reported as a tab switch, and the browser slows timers there: nothing to analyse
      if (document.hidden) {
        timer = window.setTimeout(tick, SLOW_FRAME_MS);
        return;
      }
      // a frame with no picture yet (camera warming up, resizing) cannot be analysed
      if (v && lm && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
        const began = performance.now();
        // the model needs strictly increasing frame times
        lastTs = Math.max(began, lastTs + 1);
        let detected: ReturnType<FaceLandmarker['detectForVideo']>;
        try {
          detected = lm.detectForVideo(v, lastTs);
        } catch {
          void recover();
          return;
        }
        try {
          const faces = toMeasures(detected);
          // room brightness about once a second (dark rooms explain a missing face)
          if (ctx && frame % 5 === 0) {
            ctx.drawImage(v, 0, 0, 32, 24);
            const px = ctx.getImageData(0, 0, 32, 24).data;
            let sum = 0;
            for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
            brightness = sum / (px.length / 4);
          }
          frame += 1;
          setFace(faces.length === 0 ? 'none' : faces.length > 1 ? 'many' : 'ok');
          if (activeRef.current) engine.current.push(serverNowRef.current(), faces, brightness).forEach((a) => onAlertRef.current(a));
          if (activeRef.current && began - lastObjects >= objectEvery) {
            lastObjects = began;
            lastTs += 1; // the detectors need strictly increasing frame times too
            detectObjects(v, lastTs);
          }
        } catch {
          // one frame that could not be read (e.g. the video resized): skip it
        }
        // a weak computer: analyse fewer frames rather than slow the page down
        if (performance.now() - began > SLOW_DETECT_MS) slowFrames += 1;
        else slowFrames = Math.max(0, slowFrames - 1);
        every = slowFrames > 5 ? SLOW_FRAME_MS : FRAME_MS;
      }
      timer = window.setTimeout(tick, every);
    };
    timer = window.setTimeout(tick, every);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [status, loadModel, release, unavailable]);

  // stop everything when the page goes away. The closed model is forgotten everywhere (also the preloaded promise):
  // React may mount the page again (development mode does it on purpose) and must then build a fresh one.
  useEffect(
    () => () => {
      release();
      const lm = landmarker.current;
      const od = detector.current;
      landmarker.current = null;
      model.current = null;
      detector.current = null;
      detectorLoad.current = null;
      try {
        lm?.close();
        od?.close();
      } catch {
        // already closed
      }
    },
    [release],
  );

  const stop = useCallback(() => {
    release();
    setStatus('off');
    setFace(null);
  }, [release]);

  return { enabled, status, problem, face, permission, preparing, start, stop, preview };
}

export type CameraMonitor = ReturnType<typeof useCameraMonitor>;

const FACE_TEXT: Record<Exclude<FaceHint, null>, string> = {
  ok: 'Face visible',
  none: 'Face not visible: sit in front of the camera',
  many: 'More than one face in view',
};

/**
 * What to do to get the camera on, for the situation the browser is in: not asked yet (the browser will ask), blocked
 * for this site (how to allow it; the page continues by itself), busy in another app, missing... and the button.
 */
function CameraHelp({ cam, primary = false }: { cam: CameraMonitor; primary?: boolean }) {
  const blocked = cam.problem === 'denied' || (cam.permission === 'denied' && cam.status !== 'on');
  const busy = cam.status === 'starting';
  return (
    <div className="flex flex-col gap-2 text-sm">
      {blocked ? (
        <>
          <p className="text-danger">{CAMERA_MESSAGES.denied}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>Click the camera icon, or the lock / settings icon, at the left end of the address bar.</li>
            <li>Set Camera to &ldquo;Allow&rdquo; for this website (the microphone is not needed).</li>
            <li>
              If it is still blocked on Windows: Settings → Privacy &amp; security → Camera → turn on camera access, and &ldquo;Let apps / desktop apps access
              your camera&rdquo;. On a Mac: System Settings → Privacy &amp; Security → Camera → allow your browser.
            </li>
          </ol>
        </>
      ) : cam.problem ? (
        <p className="text-danger">{CAMERA_MESSAGES[cam.problem]}</p>
      ) : cam.permission !== 'granted' && cam.status === 'off' ? (
        <p className="text-muted">
          Press the button below. Your browser will ask whether this website may use your camera: choose <span className="font-medium">Allow</span>. Only the
          camera is used, never the microphone.
        </p>
      ) : null}
      <div>
        <Button variant={primary ? 'primary' : 'secondary'} onClick={() => void cam.start()} disabled={busy}>
          {busy && <Spinner />} {busy ? 'Waiting for the camera…' : blocked || cam.problem ? 'Try again' : 'Allow camera'}
        </Button>
      </div>
    </div>
  );
}

/** Intro screen: the candidate turns the camera on and sees what it sees before starting. */
export function CameraCheck({ cam }: { cam: CameraMonitor }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3 sm:flex-row sm:items-start">
      <video ref={cam.preview} autoPlay muted playsInline aria-label="Your camera" className="h-32 w-44 shrink-0 rounded-md bg-black object-cover [transform:scaleX(-1)]" />
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Camera check</p>
        {cam.status === 'on' ? (
          <p className={cam.face === 'ok' ? 'text-success' : 'text-danger'}>{cam.face ? FACE_TEXT[cam.face] : 'Looking for your face…'}</p>
        ) : cam.preparing ? (
          <p className="flex items-center gap-2 text-muted">
            <Spinner /> Camera on. Preparing the face check (the first time can take a few seconds)…
          </p>
        ) : (
          <p className="text-muted">This test needs your camera. Sit facing the screen, with your face well lit.</p>
        )}
        {cam.status !== 'on' && !cam.preparing && <CameraHelp cam={cam} />}
      </div>
    </div>
  );
}

/** During the attempt: the candidate's own small picture, so they can see they are in view. */
export function CameraTile({ cam }: { cam: CameraMonitor }) {
  if (cam.status !== 'on') return null;
  const ok = cam.face === 'ok' || cam.face === null;
  return (
    <div className="fixed bottom-4 left-4 z-20 flex flex-col gap-1 rounded-md border border-border bg-surface p-1.5 shadow-md">
      <video ref={cam.preview} autoPlay muted playsInline aria-label="Your camera" className="h-24 w-32 rounded bg-black object-cover [transform:scaleX(-1)]" />
      <p className={`px-0.5 text-[11px] ${ok ? 'text-muted' : 'font-medium text-danger'}`}>{cam.face && cam.face !== 'ok' ? FACE_TEXT[cam.face] : 'Camera on'}</p>
    </div>
  );
}

/** The camera stopped (or the page was reloaded): like the full-screen gate, the assessment waits until it is back. */
export function CameraGate({ cam }: { cam: CameraMonitor }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="cam-title" aria-describedby="cam-text">
      <Card className="flex w-full max-w-md flex-col gap-4 p-5">
        <h2 id="cam-title" className="text-lg font-semibold tracking-tight">
          Turn your camera on to continue
        </h2>
        <p id="cam-text" className="text-sm text-muted">
          This assessment is taken with the camera on. The timer keeps running and your answers are kept. If the camera stopped during the assessment, this
          was recorded.
        </p>
        {cam.preparing ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Camera on. Preparing the face check…
          </p>
        ) : (
          <CameraHelp cam={cam} primary />
        )}
      </Card>
    </div>
  );
}
