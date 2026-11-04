'use client';

/**
 * Webcam proctoring for the DSA / SQL coding page.
 *
 * The video never leaves the browser: it is shown to the candidate in a small tile and a face detector (MediaPipe,
 * running on this device) looks at one frame a second. The page reports EVENTS only (CAMERA_OFF, NO_FACE,
 * MULTIPLE_FACES); the server counts them as warnings like every other violation. Nothing is recorded or uploaded.
 *
 * Honest limits: a face detector can miss a face (bad light, turned head) and cannot see a second screen, a phone
 * below the camera or someone speaking off-camera. The thresholds below are generous so that thinking, looking at
 * the keyboard or a short glance away never costs a warning.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Spinner } from '@/components/ui';
import type { ProctorInputType } from '@/lib/dsa-api';

// ---------------------------------------------------------------- camera

export type CameraProblem = 'insecure' | 'unsupported' | 'denied' | 'not_found' | 'in_use' | 'unknown';

export const CAMERA_MESSAGES: Record<CameraProblem, string> = {
  insecure: 'The camera only works on a secure (https) page. Please open the link from your email exactly as it is.',
  unsupported: 'This browser cannot use a camera. Please use a recent Chrome, Edge or Firefox.',
  denied: 'Camera access is blocked. Allow the camera for this site (the camera icon in the address bar, or your browser settings), then try again.',
  not_found: 'No camera was found. Connect a webcam, or use a laptop with a camera.',
  in_use: 'Your camera is being used by another app (for example a video call). Close that app, then try again.',
  unknown: 'The camera could not be started. Please try again, or try another browser.',
};

function cameraSupport(): CameraProblem | null {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

function cameraProblemOf(err: unknown): CameraProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'unknown';
}

export type CameraStatus = 'off' | 'starting' | 'on' | 'lost';

export interface Camera {
  status: CameraStatus;
  problem: CameraProblem | null;
  start: () => Promise<boolean>;
  stop: () => void;
  /** Ref callback for every <video> that shows the stream (the preview and the tile). */
  attach: (el: HTMLVideoElement | null) => void;
  /** The video element the face detector reads from (the last one attached). */
  video: React.RefObject<HTMLVideoElement | null>;
}

/** The candidate's webcam: video only, small, never recorded. `lost` = it was on and stopped by itself. */
export function useCamera(): Camera {
  const [status, setStatus] = useState<CameraStatus>('off');
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    stream.current = null;
    if (video.current) video.current.srcObject = null;
    setStatus('off');
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (stream.current?.getVideoTracks().some((t) => t.readyState === 'live')) return true;
    const unsupported = cameraSupport();
    if (unsupported) {
      setProblem(unsupported);
      return false;
    }
    setStatus('starting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      stream.current = s;
      s.getVideoTracks().forEach((t) => {
        // unplugged, turned off by a hardware switch, or the permission withdrawn in the browser
        t.onended = () => {
          stream.current = null;
          setStatus('lost');
        };
      });
      if (video.current) video.current.srcObject = s;
      setProblem(null);
      setStatus('on');
      return true;
    } catch (err) {
      setProblem(cameraProblemOf(err));
      setStatus((prev) => (prev === 'lost' ? 'lost' : 'off'));
      return false;
    }
  }, []);

  const attach = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    video.current = el;
    if (stream.current && el.srcObject !== stream.current) el.srcObject = stream.current;
  }, []);

  // Browsers that tell us when the permission is withdrawn in the settings (Chrome, Edge).
  useEffect(() => {
    if (status !== 'on') return;
    let undo = () => undefined as void;
    let cancelled = false;
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((p) => {
        if (cancelled) return;
        const onChange = () => {
          if (p.state === 'denied') {
            stream.current?.getTracks().forEach((t) => t.stop());
            stream.current = null;
            setStatus('lost');
          }
        };
        p.addEventListener('change', onChange);
        undo = () => p.removeEventListener('change', onChange);
      })
      .catch(() => undefined); // Firefox / Safari: the track's "ended" event still tells us
    return () => {
      cancelled = true;
      undo();
    };
  }, [status]);

  useEffect(() => stop, [stop]);

  return { status, problem, start, stop, attach, video };
}

// ---------------------------------------------------------------- face detection

/**
 * Served by this site (never a third-party CDN): the runtime is copied from @mediapipe/tasks-vision into
 * public/mediapipe/wasm before dev / build (scripts/copy-face-detector.mjs), the model is committed in public/models.
 * Overridable so a company can host the files elsewhere.
 */
const WASM_URL = process.env.NEXT_PUBLIC_FACE_WASM_URL || '/mediapipe/wasm';
const MODEL_URL = process.env.NEXT_PUBLIC_FACE_MODEL_URL || '/models/blaze_face_short_range.tflite';
const absolute = (u: string) => new URL(u, window.location.origin).href;

/** One frame a second is plenty and keeps the editor smooth on a slow laptop. */
const CHECK_EVERY_MS = 1000;
/** No face this long = one NO_FACE warning (looking at the keyboard or thinking never lasts this long without a face). */
const NO_FACE_AFTER_MS = 8000;
/** A second face this long = one MULTIPLE_FACES warning (a person walking past behind is not counted). */
const MULTIPLE_AFTER_MS = 3000;
/** The situation must be normal this long before the same warning can be given again (one warning per episode). */
const REARM_AFTER_MS = 3000;
const MIN_SCORE = 0.6;

export type FaceState = 'loading' | 'ok' | 'none' | 'multiple' | 'unavailable';

interface FaceDetectorLike {
  detectForVideo(video: HTMLVideoElement, timestamp: number): { detections: { categories: { score: number }[] }[] };
  close(): void;
}

let detectorPromise: Promise<FaceDetectorLike | null> | null = null;

/** Loaded once per page; null when the files cannot be loaded (then only the camera-on check runs). */
function loadDetector(): Promise<FaceDetectorLike | null> {
  detectorPromise ??= (async () => {
    try {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(absolute(WASM_URL));
      const make = (delegate: 'GPU' | 'CPU') =>
        FaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: absolute(MODEL_URL), delegate },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        });
      return (await make('GPU').catch(() => make('CPU'))) as unknown as FaceDetectorLike;
    } catch (err) {
      console.warn('face detection unavailable', err);
      detectorPromise = null; // let a later attempt (e.g. after a reload) try again
      return null;
    }
  })();
  return detectorPromise;
}

/**
 * Looks at the webcam once a second while `active` and reports NO_FACE / MULTIPLE_FACES, at most once per episode.
 * Frames are skipped while the tab is hidden (that is reported as a tab switch already).
 */
export function useFaceMonitor({
  video,
  active,
  report,
}: {
  video: React.RefObject<HTMLVideoElement | null>;
  active: boolean;
  report: (type: ProctorInputType, detail?: string) => void;
}): FaceState {
  const [state, setState] = useState<FaceState>('loading');
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: number | null = null;
    let detector: FaceDetectorLike | null = null;
    let lastTs = 0;
    // episode bookkeeping
    let noFaceSince: number | null = null;
    let multiSince: number | null = null;
    let normalSince: number | null = null;
    let noFaceReported = false;
    let multiReported = false;

    const tick = () => {
      if (stopped) return;
      timer = window.setTimeout(tick, CHECK_EVERY_MS);
      const v = video.current;
      if (!detector || !v || document.hidden || v.readyState < 2 || v.videoWidth === 0) return;
      let faces = 0;
      try {
        const ts = Math.max(performance.now(), lastTs + 1); // MediaPipe needs increasing timestamps
        lastTs = ts;
        faces = detector.detectForVideo(v, ts).detections.filter((d) => (d.categories[0]?.score ?? 0) >= MIN_SCORE).length;
      } catch {
        return; // a frame that could not be read is skipped, never counted
      }
      const now = Date.now();
      if (faces === 1) {
        noFaceSince = null;
        multiSince = null;
        normalSince ??= now;
        if (now - normalSince >= REARM_AFTER_MS) {
          noFaceReported = false;
          multiReported = false;
        }
        setState('ok');
        return;
      }
      normalSince = null;
      if (faces === 0) {
        multiSince = null;
        noFaceSince ??= now;
        setState('none');
        if (!noFaceReported && now - noFaceSince >= NO_FACE_AFTER_MS) {
          noFaceReported = true;
          reportRef.current('NO_FACE', `no face for ${Math.round((now - noFaceSince) / 1000)} s`);
        }
      } else {
        noFaceSince = null;
        multiSince ??= now;
        setState('multiple');
        if (!multiReported && now - multiSince >= MULTIPLE_AFTER_MS) {
          multiReported = true;
          reportRef.current('MULTIPLE_FACES', `${Math.min(faces, 9)} faces`);
        }
      }
    };

    setState('loading');
    void loadDetector().then((d) => {
      if (stopped) return;
      detector = d;
      if (!d) {
        setState('unavailable');
        return;
      }
      tick();
    });
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active, video]);

  return state;
}

// ---------------------------------------------------------------- UI

const FACE_LABEL: Record<FaceState, string> = {
  loading: 'Starting face check…',
  ok: 'Face visible',
  none: 'No face visible',
  multiple: 'More than one face',
  unavailable: 'Camera on',
};

/** The live tile shown in the assessment's top bar. */
export function CameraTile({ camera, face }: { camera: Camera; face: FaceState }) {
  const on = camera.status === 'on';
  const bad = !on || face === 'none' || face === 'multiple';
  return (
    <div className="flex items-center gap-2" title="Your webcam. The video stays on this device and is not recorded.">
      <div className="relative h-[54px] w-24 overflow-hidden rounded-md border border-border bg-background">
        <video ref={camera.attach} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
        <span className={`absolute right-1 top-1 flex items-center gap-1 rounded px-1 py-px text-[9px] font-bold text-white ${on ? 'bg-danger' : 'bg-muted'}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-white" /> {on ? 'LIVE' : 'OFF'}
        </span>
      </div>
      <span className={`hidden text-xs xl:inline ${bad ? 'font-medium text-danger' : 'text-muted'}`}>{on ? FACE_LABEL[face] : 'Camera off'}</span>
    </div>
  );
}

/** Start screen: preview and the button that asks the browser for the camera. */
export function CameraCheck({ camera }: { camera: Camera }) {
  const on = camera.status === 'on';
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-center">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-md border border-border bg-surface sm:w-48">
        <video ref={camera.attach} autoPlay muted playsInline className="h-full w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
        {!on && (
          <p className="absolute inset-0 grid place-items-center p-3 text-center text-xs text-muted">
            {camera.status === 'starting' ? 'Starting camera…' : 'Camera is off'}
          </p>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 text-sm">
        <p className={on ? 'font-medium text-success' : 'font-medium'}>{on ? 'Webcam is on. Make sure your face is clearly visible and well lit.' : 'Your webcam must be on to start.'}</p>
        {camera.problem && <p className="text-danger">{CAMERA_MESSAGES[camera.problem]}</p>}
        {!on && (
          <div>
            <Button onClick={() => void camera.start()} disabled={camera.status === 'starting'}>
              {camera.status === 'starting' && <Spinner />} {camera.problem ? 'Try the camera again' : 'Turn on camera'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Covers the assessment until the webcam is back on (the timer keeps running, the code is kept). */
export function CameraGate({ camera, strikesUsed, strikesAllowed, wasLost }: { camera: Camera; strikesUsed: number; strikesAllowed: number; wasLost: boolean }) {
  const limit =
    wasLost && strikesAllowed > 0
      ? ` This counted as warning ${Math.min(strikesUsed, strikesAllowed)} of ${strikesAllowed}.${strikesUsed >= strikesAllowed ? ' You have no warnings left: the next suspicious activity ends the assessment.' : ''}`
      : '';
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-labelledby="cam-title" aria-describedby="cam-text">
      <Card className="flex w-full max-w-md flex-col gap-4 p-5">
        <h2 id="cam-title" className="text-lg font-semibold tracking-tight">
          Turn your webcam back on to continue
        </h2>
        <p id="cam-text" className="text-sm text-muted">
          {wasLost
            ? `Your webcam turned off. It must stay on for the whole assessment, and this was recorded. The timer keeps running. Your code is kept.${limit}`
            : 'This assessment needs your webcam. Turn it on to continue. The timer keeps running. Your code is kept.'}
        </p>
        {camera.problem && <p className="text-sm text-danger">{CAMERA_MESSAGES[camera.problem]}</p>}
        <div>
          <Button variant="primary" onClick={() => void camera.start()} disabled={camera.status === 'starting'}>
            {camera.status === 'starting' && <Spinner />} Turn on camera
          </Button>
        </div>
      </Card>
    </div>
  );
}
