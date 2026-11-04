import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { FACE_POINTS, type FaceMeasure } from '@hireflow/contracts';

let quieted = false;

/**
 * MediaPipe's WebAssembly runtime writes its INFORMATIONAL log lines ("INFO: Created TensorFlow Lite XNNPACK delegate
 * for CPU.") through console.error, which the Next.js dev overlay then shows as a red "Console Error" although nothing
 * failed. Only lines starting with "INFO: " are dropped; warnings and real errors still reach console.error.
 */
function quietMediapipeInfo() {
  if (quieted || typeof console === 'undefined') return;
  quieted = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('INFO: ')) return;
    original(...args);
  };
}

/**
 * MediaPipe Face Landmarker, served by this app (public/mediapipe, see scripts/prepare-face-model.mjs): never a
 * third-party CDN, and loaded only for camera-monitored rounds. Runs entirely in the browser.
 */
export async function loadFaceLandmarker(): Promise<FaceLandmarker> {
  quietMediapipeInfo();
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  // CPU (XNNPACK) only: fast enough for a few small frames a second, and the same on every computer. A GPU start that
  // fails half-way can leave the runtime broken, which later shows as "Aborted()" on the first frames.
  return FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'VIDEO',
    // two is enough to notice "more than one person"
    numFaces: 2,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

const NEEDED = Object.values(FACE_POINTS);

/** Keeps only what the rules need (4 mesh points, the eye blendshapes): nothing else of the face is kept or sent. */
export function toMeasures(result: FaceLandmarkerResult): FaceMeasure[] {
  return result.faceLandmarks.map((landmarks, i) => {
    const points: FaceMeasure['points'] = {};
    for (const n of NEEDED) {
      const p = landmarks[n];
      if (p) points[n] = { x: p.x, y: p.y };
    }
    const blendshapes: Record<string, number> = {};
    for (const c of result.faceBlendshapes[i]?.categories ?? []) {
      if (c.categoryName.startsWith('eye')) blendshapes[c.categoryName] = c.score;
    }
    return { points, blendshapes };
  });
}
