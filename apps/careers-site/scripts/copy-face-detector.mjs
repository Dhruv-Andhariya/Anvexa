// Copies MediaPipe's face detector runtime (WASM) from the installed package into public/, so the interview page
// loads it from this site - never from a third-party CDN. Runs before `dev` and `build`; the copy is git-ignored.
// The model itself (public/models/blaze_face_short_range.tflite, ~230 KB) is committed.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// the package does not export package.json: use its folder (pnpm links it into this app's node_modules)
const from = join(here, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(here, '..', 'public', 'mediapipe', 'wasm');

if (!existsSync(from)) {
  console.warn('[face-detector] @mediapipe/tasks-vision/wasm not found: multiple-face detection will be unavailable');
  process.exit(0);
}
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`[face-detector] runtime copied to ${to}`);
