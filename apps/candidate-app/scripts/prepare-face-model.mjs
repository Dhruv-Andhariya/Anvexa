// Puts the face model, the object model and their runtime next to the candidate app (public/mediapipe), so the page never loads them from
// a third-party CDN: the WASM runtime comes from the installed @mediapipe/tasks-vision package, the model is downloaded
// once and checked against a pinned SHA-256 (a changed or corrupted file is refused). Runs before `dev` and `build`.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
const OBJECT_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
const OBJECT_MODEL_SHA256 = '0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(app, 'public', 'mediapipe');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(out, { recursive: true });

// 1. the runtime (WASM) of the installed, pinned package
// (the package does not export package.json: its main file sits at the package's root)
const pkg = dirname(createRequire(join(app, 'package.json')).resolve('@mediapipe/tasks-vision'));
cpSync(join(pkg, 'wasm'), join(out, 'wasm'), { recursive: true });

// 2. the models, downloaded once and verified
const MODELS = [
  { name: 'face model', file: 'face_landmarker.task', url: MODEL_URL, sha256: MODEL_SHA256, size: '3.7 MB' },
  // people and phones in view (COCO object detector), run about once a second
  { name: 'object model', file: 'efficientdet_lite0.tflite', url: OBJECT_MODEL_URL, sha256: OBJECT_MODEL_SHA256, size: '4.6 MB' },
];
for (const m of MODELS) {
  const model = join(out, m.file);
  if (existsSync(model) && sha256(readFileSync(model)) === m.sha256) {
    console.log(`${m.name} ready`);
    continue;
  }
  console.log(`downloading the ${m.name} (${m.size})...`);
  try {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== m.sha256) throw new Error('checksum does not match the pinned model');
    writeFileSync(`${model}.tmp`, buf);
    renameSync(`${model}.tmp`, model);
    console.log(`${m.name} ready`);
  } catch (err) {
    // the coding page still works; camera-monitored rounds report "camera check unavailable" until the model is there
    console.warn(`${m.name} NOT available (${err.message}): run this script again when online.`);
  }
}
