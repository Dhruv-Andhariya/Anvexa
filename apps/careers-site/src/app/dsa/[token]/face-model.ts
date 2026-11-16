import type { FaceLandmarker, FaceLandmarkerResult, ObjectDetector, ObjectDetectorResult } from '@mediapipe/tasks-vision';
import { CAMERA_RULES_DEFAULTS, FACE_POINTS, type FaceMeasure, type ObjectDetection } from '@hireflow/contracts';

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

/**
 * MediaPipe Object Detector (EfficientDet-Lite0, COCO labels), served by this app like the face model: counts the
 * people in view and notices a phone. Run about once a second (it is heavier than the face model). Only labels the
 * rules use are asked for, so nothing else about the room is even computed.
 */
export async function loadObjectDetector(): Promise<ObjectDetector> {
  quietMediapipeInfo();
  const { FilesetResolver, ObjectDetector } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  return ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/mediapipe/efficientdet_lite0.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO',
    maxResults: 6,
    scoreThreshold: Math.min(CAMERA_RULES_DEFAULTS.personScore, CAMERA_RULES_DEFAULTS.deviceScore),
    categoryAllowlist: ['person', ...CAMERA_RULES_DEFAULTS.deviceLabels],
  });
}

/** Label, score and the box's share of the frame for each detection: no image data is kept. */
export function toDetections(result: ObjectDetectorResult, width: number, height: number): ObjectDetection[] {
  const frame = Math.max(1, width * height);
  return result.detections.flatMap((d) => {
    const c = d.categories[0];
    if (!c) return [];
    const box = d.boundingBox;
    return [{ label: c.categoryName, score: c.score, area: box ? (box.width * box.height) / frame : 0 }];
  });
}
