// Puts the face model and its runtime next to the candidate app (public/mediapipe), so the page never loads them from
// a third-party CDN: the WASM runtime comes from the installed @mediapipe/tasks-vision package, the model is downloaded
// once and checked against a pinned SHA-256 (a changed or corrupted file is refused). Runs before `dev` and `build`.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(app, 'public', 'mediapipe');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(out, { recursive: true });

// 1. the runtime (WASM) of the installed, pinned package
// (the package does not export package.json: its main file sits at the package's root)
const pkg = dirname(createRequire(join(app, 'package.json')).resolve('@mediapipe/tasks-vision'));
cpSync(join(pkg, 'wasm'), join(out, 'wasm'), { recursive: true });

// 2. the model, downloaded once and verified
const model = join(out, 'face_landmarker.task');
if (existsSync(model) && sha256(readFileSync(model)) === MODEL_SHA256) {
  console.log('face model ready');
} else {
  console.log('downloading the face model (3.7 MB)...');
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== MODEL_SHA256) throw new Error('checksum does not match the pinned model');
    writeFileSync(`${model}.tmp`, buf);
    renameSync(`${model}.tmp`, model);
    console.log('face model ready');
  } catch (err) {
    // the coding page still works; SQL rounds with the camera monitored cannot start until the model is there
    console.warn(`face model NOT available (${err.message}): camera monitoring will not start. Run this script again when online.`);
  }
}
