/**
 * AI camera monitoring for SQL rounds (candidate app coding page): the rules that turn what the face model sees in
 * each video frame into a FEW grouped alerts. Pure TypeScript (no browser APIs), shared by the page and the tests.
 *
 * What it can and cannot tell: from a webcam it can estimate where a face is turned and where the eyes look, whether a
 * face is in view, and how many faces are in view. It CANNOT see a second laptop or phone outside the camera's view:
 * a repeated or long look away is a SUSPICIOUS PATTERN for HR to review, never proof. A single glance never alerts:
 *   - frames are compared with the candidate's own resting position (calibrated at the start), so where the camera
 *     sits and how the candidate sits matter less;
 *   - an off-screen look counts only when it lasts (episode >= minEpisodeMs); short glances and blinks are ignored;
 *   - an alert needs a PATTERN: repeated counted looks in the same direction within a window, or one long look;
 *   - a continuing behaviour is ONE alert, then a cool-down.
 * Every threshold is a setting (CAMERA_RULES_DEFAULTS).
 */

export const CAMERA_EVENT_TYPES = [
  /** Repeated or long looks away from the screen (left / right / down / up). */
  'CAMERA_GAZE_AWAY',
  /** No face in view for a while (left the camera's view, covered it, or too dark to see). */
  'CAMERA_FACE_MISSING',
  /** More than one face in view for a while. */
  'CAMERA_MULTIPLE_FACES',
  /** Very frequent head turning. */
  'CAMERA_HEAD_MOVEMENT',
  /** The camera stopped (turned off, unplugged, permission withdrawn). */
  'CAMERA_STOPPED',
] as const;
export type CameraEventType = (typeof CAMERA_EVENT_TYPES)[number];

export type GazeDirection = 'left' | 'right' | 'up' | 'down';

/** HR wording for each alert. */
export const CAMERA_EVENT_LABELS: Record<CameraEventType, string> = {
  CAMERA_GAZE_AWAY: 'Looked away from the screen (repeated or long)',
  CAMERA_FACE_MISSING: 'Face not visible',
  CAMERA_MULTIPLE_FACES: 'More than one face in view',
  CAMERA_HEAD_MOVEMENT: 'Frequent head movement',
  CAMERA_STOPPED: 'Camera stopped',
};

export interface CameraRules {
  /** Off-screen looks shorter than this are glances: ignored. */
  minEpisodeMs: number;
  /** Back on the screen at least this long ends a look (short returns are part of the same look). */
  returnMs: number;
  /** This many counted looks in the same direction within `repeatWindowMs` is a pattern. */
  repeatCount: number;
  repeatWindowMs: number;
  /** One look away lasting this long is a pattern on its own. */
  sustainedAwayMs: number;
  /** No face for this long. */
  faceMissingMs: number;
  /** Two or more faces for this long (shorter flickers are detection noise). */
  multipleFacesMs: number;
  /** This many large head turns within `headMoveWindowMs`. */
  headMoveCount: number;
  headMoveWindowMs: number;
  /** After an alert, the same alert type is not raised again for this long. */
  cooldownMs: number;
  /** Frames with a face, looking at the screen, used to learn the candidate's resting position. */
  calibrationFrames: number;
  /** Head turn (nose offset from the eyes' middle, in eye widths) beyond which the face is turned away. */
  yawAway: number;
  /** Head tilt (change of the nose's height between eyes and chin) beyond which the face is turned down / up. */
  pitchDown: number;
  pitchUp: number;
  /** Eye-only gaze scores (model blendshapes, 0..1) beyond which the eyes look away while the head stays straight. */
  eyesSide: number;
  eyesDown: number;
  /** Eyes this closed: a blink, the frame says nothing about gaze. */
  blink: number;
  /** Average frame brightness (0..255) under which the room is too dark to see a face. */
  darkBrightness: number;
}

export const CAMERA_RULES_DEFAULTS: CameraRules = {
  minEpisodeMs: 1500,
  returnMs: 600,
  repeatCount: 4,
  repeatWindowMs: 60_000,
  sustainedAwayMs: 6000,
  faceMissingMs: 5000,
  multipleFacesMs: 2000,
  headMoveCount: 10,
  headMoveWindowMs: 30_000,
  cooldownMs: 30_000,
  calibrationFrames: 10,
  yawAway: 0.32,
  pitchDown: 0.12,
  pitchUp: 0.12,
  eyesSide: 0.5,
  eyesDown: 0.55,
  blink: 0.6,
  darkBrightness: 40,
};

// ------------------------------------------------------------------ one frame

/** A point of the face mesh in normalized image coordinates (0..1, x to the image's right, y down). */
export interface FacePoint {
  x: number;
  y: number;
}

/** What the face model returned for one face: a few mesh points and the eye blendshape scores. */
export interface FaceMeasure {
  /** Mesh points by MediaPipe index: 1 nose tip, 33 / 263 outer eye corners (subject's right / left), 152 chin. */
  points: Record<number, FacePoint>;
  /** Blendshape scores by name (eyeLookOutLeft, eyeLookInRight, eyeLookDownLeft, eyeBlinkLeft, ...). */
  blendshapes: Record<string, number>;
}

/** Mesh indices the rules need. */
export const FACE_POINTS = { noseTip: 1, rightEyeOuter: 33, leftEyeOuter: 263, chin: 152 } as const;

/**
 * Head pose from geometry (no camera model needed):
 *  - yaw: how far the nose tip is from the eyes' middle, in eye widths. Positive = turned to the subject's LEFT
 *    (in the raw, unmirrored camera image the subject's left is the image's right).
 *  - pitch: where the nose sits between the eyes' line (0) and the chin (1). Larger = head tilted down.
 */
export function headPose(face: FaceMeasure): { yaw: number; pitch: number } | null {
  const nose = face.points[FACE_POINTS.noseTip];
  const r = face.points[FACE_POINTS.rightEyeOuter];
  const l = face.points[FACE_POINTS.leftEyeOuter];
  const chin = face.points[FACE_POINTS.chin];
  if (!nose || !r || !l || !chin) return null;
  const eyeWidth = Math.hypot(l.x - r.x, l.y - r.y);
  const midX = (l.x + r.x) / 2;
  const midY = (l.y + r.y) / 2;
  const height = chin.y - midY;
  if (eyeWidth < 1e-4 || height < 1e-4) return null;
  return { yaw: (nose.x - midX) / eyeWidth, pitch: (nose.y - midY) / height };
}

/** Eye-only gaze from the blendshapes: horizontal (positive = to the subject's left), down, and blink. */
export function eyeGaze(face: FaceMeasure): { side: number; down: number; up: number; blink: number } {
  const b = (n: string) => face.blendshapes[n] ?? 0;
  return {
    // to the subject's left: the left eye looks outward and the right eye inward
    side: (b('eyeLookOutLeft') + b('eyeLookInRight') - b('eyeLookOutRight') - b('eyeLookInLeft')) / 2,
    down: (b('eyeLookDownLeft') + b('eyeLookDownRight')) / 2,
    up: (b('eyeLookUpLeft') + b('eyeLookUpRight')) / 2,
    blink: (b('eyeBlinkLeft') + b('eyeBlinkRight')) / 2,
  };
}

/** What one frame shows, after comparing with the candidate's resting position. */
export interface FrameObservation {
  faces: number;
  /** null = looking at the screen (or no single face, or a blink). */
  away: GazeDirection | null;
  /** How clearly the frame is off-screen (0..1); 0 when on screen. */
  strength: number;
  /** The head's turn relative to the resting position (for head-movement counting). */
  yaw: number | null;
  dark: boolean;
}

export interface Baseline {
  yaw: number;
  pitch: number;
}

/** Classifies one frame. The head decides first; the eyes are only used while the head is roughly straight. */
export function classifyFrame(faces: FaceMeasure[], brightness: number | null, baseline: Baseline | null, rules: CameraRules = CAMERA_RULES_DEFAULTS): FrameObservation {
  const dark = brightness !== null && brightness < rules.darkBrightness;
  if (faces.length !== 1) return { faces: faces.length, away: null, strength: 0, yaw: null, dark };
  const face = faces[0]!;
  const pose = headPose(face);
  const eyes = eyeGaze(face);
  if (!pose) return { faces: 1, away: null, strength: 0, yaw: null, dark };
  const yaw = pose.yaw - (baseline?.yaw ?? 0);
  const pitch = pose.pitch - (baseline?.pitch ?? 0);
  const ratio = (v: number, t: number) => Math.min(1, Math.abs(v) / (t * 2));

  if (Math.abs(yaw) >= rules.yawAway) return { faces: 1, away: yaw > 0 ? 'left' : 'right', strength: ratio(yaw, rules.yawAway), yaw, dark };
  if (pitch >= rules.pitchDown) return { faces: 1, away: 'down', strength: ratio(pitch, rules.pitchDown), yaw, dark };
  if (pitch <= -rules.pitchUp) return { faces: 1, away: 'up', strength: ratio(pitch, rules.pitchUp), yaw, dark };
  // eyes closed (a blink) say nothing about where the candidate looks
  if (eyes.blink >= rules.blink) return { faces: 1, away: null, strength: 0, yaw, dark };
  if (Math.abs(eyes.side) >= rules.eyesSide) return { faces: 1, away: eyes.side > 0 ? 'left' : 'right', strength: ratio(eyes.side, rules.eyesSide), yaw, dark };
  if (eyes.down >= rules.eyesDown) return { faces: 1, away: 'down', strength: ratio(eyes.down, rules.eyesDown), yaw, dark };
  return { faces: 1, away: null, strength: 0, yaw, dark };
}

// ------------------------------------------------------------------ over time

/** One grouped alert for the proctoring record. */
export interface CameraAlert {
  type: CameraEventType;
  /** When the behaviour started (epoch ms). */
  at: number;
  durationMs: number;
  /** How sure the rules are (0..1): share and clarity of the frames behind the alert. */
  confidence: number;
  /** Short label for HR: "left: 4 looks in 60 s", "down: 7 s (possible phone)", "poor lighting"... */
  detail: string;
}

interface Episode {
  dir: GazeDirection;
  start: number;
  lastAway: number;
  frames: number;
  strengthSum: number;
}

const round2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
const DIRECTION_NOTE: Record<GazeDirection, string> = { left: '', right: '', down: ' (possible phone or notes)', up: '' };

/**
 * Feeds frames in time order and returns the alerts they complete. Keeps only small counters: never images.
 * `calibrated` becomes true after `calibrationFrames` single-face frames; before that, gaze is not judged (the
 * candidate is settling in), but face-missing and multiple-face rules already apply.
 */
export class CameraRuleEngine {
  private baseline: Baseline | null = null;
  private calib: Baseline[] = [];
  private episode: Episode | null = null;
  private counted: { dir: GazeDirection; at: number; strength: number; durationMs: number }[] = [];
  private noFaceSince: number | null = null;
  private noFaceDark = 0;
  private noFaceFrames = 0;
  private multiSince: number | null = null;
  private multiFrames = 0;
  private headTurns: number[] = [];
  private headSide: -1 | 0 | 1 = 0;
  private lastAlert: Partial<Record<CameraEventType, number>> = {};
  private sustainedRaised = false;

  constructor(private readonly rules: CameraRules = CAMERA_RULES_DEFAULTS) {}

  get calibrated(): boolean {
    return this.baseline !== null;
  }

  /** One frame at time `t` (ms): the faces the model found and the frame's brightness (null = not measured). */
  push(t: number, faces: FaceMeasure[], brightness: number | null = null): CameraAlert[] {
    const out: CameraAlert[] = [];
    this.learn(faces);
    const obs = classifyFrame(faces, brightness, this.baseline, this.rules);
    this.trackFace(t, obs, out);
    this.trackMulti(t, obs, out);
    if (this.baseline && obs.faces === 1) {
      this.trackGaze(t, obs, out);
      this.trackHead(t, obs, out);
    } else if (obs.faces !== 1) {
      this.closeEpisode(t, out); // no single face: a look cannot continue
    }
    return out;
  }

  /** The camera stopped (track ended, permission withdrawn): one alert, then nothing until it runs again. */
  stopped(t: number, why: string): CameraAlert[] {
    if (!this.cool('CAMERA_STOPPED', t)) return [];
    return [this.raise('CAMERA_STOPPED', t, 0, 1, why)];
  }

  private learn(faces: FaceMeasure[]) {
    if (this.baseline || faces.length !== 1) return;
    const pose = headPose(faces[0]!);
    const eyes = eyeGaze(faces[0]!);
    if (!pose || eyes.blink >= this.rules.blink) return;
    this.calib.push(pose);
    if (this.calib.length >= this.rules.calibrationFrames) {
      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      this.baseline = { yaw: median(this.calib.map((p) => p.yaw)), pitch: median(this.calib.map((p) => p.pitch)) };
    }
  }

  private trackFace(t: number, obs: FrameObservation, out: CameraAlert[]) {
    if (obs.faces > 0) {
      this.noFaceSince = null;
      this.noFaceDark = 0;
      this.noFaceFrames = 0;
      return;
    }
    if (this.noFaceSince === null) this.noFaceSince = t;
    this.noFaceFrames += 1;
    if (obs.dark) this.noFaceDark += 1;
    const lasted = t - this.noFaceSince;
    // one alert per absence: the next one needs the face back first (noFaceSince resets) and the cool-down
    if (lasted >= this.rules.faceMissingMs && this.noFaceFrames > 0 && this.cool('CAMERA_FACE_MISSING', t, this.noFaceSince)) {
      const dark = this.noFaceDark / this.noFaceFrames >= 0.5;
      out.push(this.raise('CAMERA_FACE_MISSING', this.noFaceSince, lasted, 0.9, dark ? 'poor lighting: the face could not be seen' : 'no face in view'));
    }
  }

  private trackMulti(t: number, obs: FrameObservation, out: CameraAlert[]) {
    if (obs.faces < 2) {
      this.multiSince = null;
      this.multiFrames = 0;
      return;
    }
    if (this.multiSince === null) this.multiSince = t;
    this.multiFrames += 1;
    const lasted = t - this.multiSince;
    if (lasted >= this.rules.multipleFacesMs && this.cool('CAMERA_MULTIPLE_FACES', t, this.multiSince)) {
      out.push(this.raise('CAMERA_MULTIPLE_FACES', this.multiSince, lasted, 0.85, `${obs.faces} faces in view`));
    }
  }

  private trackGaze(t: number, obs: FrameObservation, out: CameraAlert[]) {
    const ep = this.episode;
    if (obs.away) {
      if (ep && ep.dir === obs.away) {
        ep.lastAway = t;
        ep.frames += 1;
        ep.strengthSum += obs.strength;
      } else {
        this.closeEpisode(t, out);
        this.episode = { dir: obs.away, start: t, lastAway: t, frames: 1, strengthSum: obs.strength };
        this.sustainedRaised = false;
      }
      const cur = this.episode!;
      const lasted = t - cur.start;
      // one long look is a pattern on its own (e.g. reading another screen)
      if (!this.sustainedRaised && lasted >= this.rules.sustainedAwayMs && this.cool('CAMERA_GAZE_AWAY', t, cur.start)) {
        this.sustainedRaised = true;
        out.push(
          this.raise('CAMERA_GAZE_AWAY', cur.start, lasted, (cur.strengthSum / cur.frames) * 0.5 + 0.5, `${cur.dir}: looked away ${Math.round(lasted / 1000)} s${DIRECTION_NOTE[cur.dir]}`),
        );
        this.counted = [];
      }
      return;
    }
    // back on the screen: a short return belongs to the same look
    if (ep && t - ep.lastAway >= this.rules.returnMs) this.closeEpisode(t, out);
  }

  /** Ends the current look; a look that lasted is counted, and enough counted looks in one direction alert. */
  private closeEpisode(t: number, out: CameraAlert[]) {
    const ep = this.episode;
    this.episode = null;
    if (!ep || this.sustainedRaised) {
      this.sustainedRaised = false;
      return;
    }
    const durationMs = ep.lastAway - ep.start;
    if (durationMs < this.rules.minEpisodeMs) return; // a glance
    this.counted.push({ dir: ep.dir, at: ep.start, strength: ep.strengthSum / ep.frames, durationMs });
    this.counted = this.counted.filter((c) => t - c.at <= this.rules.repeatWindowMs);
    const same = this.counted.filter((c) => c.dir === ep.dir);
    if (same.length >= this.rules.repeatCount && this.cool('CAMERA_GAZE_AWAY', t, same[0]!.at)) {
      const first = same[0]!;
      const total = same.reduce((s, c) => s + c.durationMs, 0);
      const strength = same.reduce((s, c) => s + c.strength, 0) / same.length;
      const windowS = Math.round(this.rules.repeatWindowMs / 1000);
      out.push(
        this.raise('CAMERA_GAZE_AWAY', first.at, total, strength * 0.5 + 0.5, `${ep.dir}: ${same.length} looks in ${windowS} s${DIRECTION_NOTE[ep.dir]}`),
      );
      this.counted = [];
    }
  }

  private trackHead(t: number, obs: FrameObservation, out: CameraAlert[]) {
    if (obs.yaw === null) return;
    const side = obs.yaw >= this.rules.yawAway ? 1 : obs.yaw <= -this.rules.yawAway ? -1 : 0;
    if (side !== 0 && side !== this.headSide) this.headTurns.push(t);
    this.headSide = side;
    this.headTurns = this.headTurns.filter((x) => t - x <= this.rules.headMoveWindowMs);
    if (this.headTurns.length >= this.rules.headMoveCount && this.cool('CAMERA_HEAD_MOVEMENT', t, this.headTurns[0]!)) {
      out.push(this.raise('CAMERA_HEAD_MOVEMENT', this.headTurns[0]!, t - this.headTurns[0]!, 0.7, `${this.headTurns.length} head turns in ${Math.round(this.rules.headMoveWindowMs / 1000)} s`));
      this.headTurns = [];
    }
  }

  /** True (and remembers the time) when this alert type is not in its cool-down. */
  private cool(type: CameraEventType, t: number, since?: number): boolean {
    const last = this.lastAlert[type];
    // the same continuing behaviour (started before the last alert) never alerts twice
    if (last !== undefined && (t - last < this.rules.cooldownMs || (since !== undefined && since <= last))) return false;
    this.lastAlert[type] = t;
    return true;
  }

  private raise(type: CameraEventType, at: number, durationMs: number, confidence: number, detail: string): CameraAlert {
    return { type, at, durationMs: Math.max(0, Math.round(durationMs)), confidence: round2(confidence), detail };
  }
}
