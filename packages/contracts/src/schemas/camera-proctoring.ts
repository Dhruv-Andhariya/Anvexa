/**
 * AI camera monitoring for the SQL and DSA coding rounds (candidate app coding page): the rules that turn what the
 * on-device models see in each video frame into a FEW grouped alerts. Pure TypeScript (no browser APIs), shared by the
 * page, the API (which validates the alerts) and the tests. See docs/PROCTORING.md.
 *
 * What it can and cannot tell: from a webcam it can estimate where a face is turned and where the eyes look, whether a
 * face is in view, how many people / faces are in view, and whether a phone is visible. It CANNOT see what is outside
 * the camera's view, and it cannot tell what a visible phone is used for. Every alert is a SUSPICIOUS PATTERN for HR to
 * review, never proof. Safeguards against false alarms:
 *   - frames are compared with the candidate's own resting position (calibrated at the start);
 *   - every condition must LAST (a sustained tracker with a small tolerance for missed frames): single frames, blinks,
 *     short glances and detection flicker never alert;
 *   - a continuing behaviour is ONE alert (never one per frame), then a cool-down;
 *   - camera loss, poor lighting and a model that cannot run are reported as technical events, not misconduct.
 * Every threshold is a setting (CAMERA_RULES_DEFAULTS); the API confirms alerts with CAMERA_CONFIRM_DEFAULTS.
 */

export const CAMERA_EVENT_TYPES = [
  /** Looked away from the screen: continuously for a long time (an incident), or repeatedly (an observation). */
  'CAMERA_GAZE_AWAY',
  /** No face in view for a sustained time (left the camera's view, or covered it). */
  'CAMERA_FACE_MISSING',
  /** More than one person / face in view for a sustained time. */
  'CAMERA_MULTIPLE_FACES',
  /** A phone was visible for a sustained time. */
  'CAMERA_DEVICE_DETECTED',
  /** Very frequent head turning (an observation only). */
  'CAMERA_HEAD_MOVEMENT',
  /** The camera stopped (turned off, unplugged, permission withdrawn). Technical: never misconduct. */
  'CAMERA_STOPPED',
  /** The check could not run: too dark to see a face, or the model failed. Technical: never misconduct. */
  'CAMERA_DETECTION_UNAVAILABLE',
] as const;
export type CameraEventType = (typeof CAMERA_EVENT_TYPES)[number];

export type GazeDirection = 'left' | 'right' | 'up' | 'down';

/** Version of these rules and models, stored with every proctoring record so a decision can be traced back. */
export const CAMERA_DETECTION_VERSION = 'camera-rules-2 (MediaPipe face_landmarker float16/1 + efficientdet_lite0 int8/1)';

/** HR wording for each alert. */
export const CAMERA_EVENT_LABELS: Record<CameraEventType, string> = {
  CAMERA_GAZE_AWAY: 'Looked away from the screen',
  CAMERA_FACE_MISSING: 'Face not visible',
  CAMERA_MULTIPLE_FACES: 'More than one person in view',
  CAMERA_DEVICE_DETECTED: 'Phone visible',
  CAMERA_HEAD_MOVEMENT: 'Frequent head movement',
  CAMERA_STOPPED: 'Camera stopped',
  CAMERA_DETECTION_UNAVAILABLE: 'Camera check unavailable (lighting or model)',
};

/**
 * What the API needs before a camera alert counts as a confirmed incident (a warning). Shorter alerts are kept for HR as
 * observations. Chosen to keep false alarms low (see docs/PROCTORING.md, "Thresholds"):
 *   - lookAwayMs 120 s: the business rule (continuous looking away for more than two minutes);
 *   - faceMissingMs 20 s: long enough for adjusting the chair, picking something up or a lighting flicker;
 *   - multiplePersonsMs / deviceMs 3 s: at about 1 detection a second that is 3+ agreeing samples, so one wrong frame
 *     never counts, while someone walking past behind the candidate usually does not stay that long;
 *   - minConfidence 0.5: below it the models' own scores say the detection is a guess.
 */
export const CAMERA_CONFIRM_DEFAULTS = {
  lookAwayMs: 120_000,
  faceMissingMs: 20_000,
  multiplePersonsMs: 3000,
  deviceMs: 3000,
  minConfidence: 0.5,
} as const;

export interface CameraRules {
  /** Off-screen looks shorter than this are glances: ignored. */
  minEpisodeMs: number;
  /** Back on the screen at least this long ends a look (short returns, e.g. a blink, are part of the same look). */
  returnMs: number;
  /** This many counted looks in the same direction within `repeatWindowMs` is a pattern (an observation for HR). */
  repeatCount: number;
  repeatWindowMs: number;
  /** One continuous look away lasting this long is an incident (head turned away, or the eyes far to a side). */
  sustainedAwayMs: number;
  /** No face for this long. */
  faceMissingMs: number;
  /** The face back for at least this long ends an absence (a single wrong "face" frame does not). */
  faceReturnMs: number;
  /** Two or more people / faces for this long (shorter flickers are detection noise). */
  multipleFacesMs: number;
  /** A phone visible for this long. */
  deviceMs: number;
  /** Object detections run about once a second: a missed sample within this time does not end an occurrence. */
  objectGapMs: number;
  /** Object-based alerts need at least this many agreeing samples. */
  objectMinHits: number;
  /** Detection scores (0..1) under which a person / device is ignored. */
  personScore: number;
  deviceScore: number;
  /** A detected person smaller than this share of the frame is ignored (a photo far away, noise). */
  personMinArea: number;
  /** Object-detector labels that are devices (COCO names). Laptops, keyboards and screens are the candidate's own setup. */
  deviceLabels: readonly string[];
  /** This many large head turns within `headMoveWindowMs` (an observation for HR). */
  headMoveCount: number;
  headMoveWindowMs: number;
  /** After an alert, the same alert is not raised again for this long. */
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
  sustainedAwayMs: CAMERA_CONFIRM_DEFAULTS.lookAwayMs,
  faceMissingMs: CAMERA_CONFIRM_DEFAULTS.faceMissingMs,
  faceReturnMs: 1000,
  multipleFacesMs: CAMERA_CONFIRM_DEFAULTS.multiplePersonsMs,
  deviceMs: CAMERA_CONFIRM_DEFAULTS.deviceMs,
  objectGapMs: 2500,
  objectMinHits: 3,
  personScore: 0.6,
  deviceScore: 0.5,
  personMinArea: 0.03,
  deviceLabels: ['cell phone'],
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
  /** What decided `away`: the head's pose, or the eyes alone (head straight). null when on screen. */
  by: 'head' | 'eyes' | null;
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
  const none = { away: null, by: null, strength: 0 } as const;
  if (faces.length !== 1) return { faces: faces.length, ...none, yaw: null, dark };
  const face = faces[0]!;
  const pose = headPose(face);
  const eyes = eyeGaze(face);
  if (!pose) return { faces: 1, ...none, yaw: null, dark };
  const yaw = pose.yaw - (baseline?.yaw ?? 0);
  const pitch = pose.pitch - (baseline?.pitch ?? 0);
  const ratio = (v: number, t: number) => Math.min(1, Math.abs(v) / (t * 2));
  const head = (away: GazeDirection, strength: number): FrameObservation => ({ faces: 1, away, by: 'head', strength, yaw, dark });

  if (Math.abs(yaw) >= rules.yawAway) return head(yaw > 0 ? 'left' : 'right', ratio(yaw, rules.yawAway));
  if (pitch >= rules.pitchDown) return head('down', ratio(pitch, rules.pitchDown));
  if (pitch <= -rules.pitchUp) return head('up', ratio(pitch, rules.pitchUp));
  // eyes closed (a blink) say nothing about where the candidate looks
  if (eyes.blink >= rules.blink) return { faces: 1, ...none, yaw, dark };
  if (Math.abs(eyes.side) >= rules.eyesSide) return { faces: 1, away: eyes.side > 0 ? 'left' : 'right', by: 'eyes', strength: ratio(eyes.side, rules.eyesSide), yaw, dark };
  if (eyes.down >= rules.eyesDown) return { faces: 1, away: 'down', by: 'eyes', strength: ratio(eyes.down, rules.eyesDown), yaw, dark };
  return { faces: 1, ...none, yaw, dark };
}

/**
 * Does this frame count towards the continuous look-away incident? The eyes alone are not trusted for it (the rule
 * must not rest on eye direction only): eyes looking DOWN with the head straight is ordinary typing / reading the
 * lower part of the screen. A turned / tilted head, or the eyes far to one side, counts.
 */
export const countsTowardsLookAway = (obs: FrameObservation): boolean =>
  obs.away !== null && (obs.by === 'head' || obs.away === 'left' || obs.away === 'right');

// ------------------------------------------------------------------ objects (person + device detector)

/** One object the detector found in a sampled frame (COCO label, score 0..1, box area as a share of the frame). */
export interface ObjectDetection {
  label: string;
  score: number;
  area: number;
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
  /** Short label for HR: "right: looked away 2 min", "cell phone visible 4 s", "poor lighting"... */
  detail: string;
}

/**
 * A condition that must hold for a while. Brief gaps (a missed detection, a blink) shorter than `gapMs` do not end
 * it; a longer gap does, and the next occurrence starts from zero (the timer resets).
 */
export class SustainedCondition {
  since: number | null = null;
  private last = 0;
  hits = 0;
  private confSum = 0;

  constructor(private readonly gapMs: number) {}

  /** Feeds one sample at `t`; returns how long the condition has lasted so far (0 = not active). */
  update(t: number, on: boolean, confidence = 1): number {
    if (on) {
      if (this.since === null) {
        this.since = t;
        this.hits = 0;
        this.confSum = 0;
      }
      this.last = t;
      this.hits += 1;
      this.confSum += confidence;
    } else if (this.since !== null && t - this.last > this.gapMs) {
      this.since = null;
    }
    return this.since === null ? 0 : this.last - this.since;
  }

  get active(): boolean {
    return this.since !== null;
  }

  get confidence(): number {
    return this.hits ? this.confSum / this.hits : 0;
  }
}

interface Episode {
  dir: GazeDirection;
  start: number;
  lastAway: number;
  frames: number;
  strengthSum: number;
}

/** Cool-down keys: the long-look incident and the repeated-look observation never block each other. */
type AlertKey = CameraEventType | 'GAZE_REPEATED';

const clamp01 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
const DIRECTION_NOTE: Record<GazeDirection, string> = { left: '', right: '', down: ' (possible phone or notes)', up: '' };
const human = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.round(ms / 1000)} s`);

/**
 * Feeds frames in time order and returns the alerts they complete. Keeps only small counters: never images.
 * `calibrated` becomes true after `calibrationFrames` single-face frames; before that, gaze is not judged (the
 * candidate is settling in), but the face, person and device rules already apply.
 */
export class CameraRuleEngine {
  private baseline: Baseline | null = null;
  private calib: Baseline[] = [];
  private episode: Episode | null = null;
  private counted: { dir: GazeDirection; at: number; strength: number; durationMs: number }[] = [];
  private readonly lookAway: SustainedCondition;
  private lookDirs: Partial<Record<GazeDirection, number>> = {};
  private lookRaised = false;
  private readonly noFace: SustainedCondition;
  private noFaceDark = 0;
  private noFaceFrames = 0;
  private noFaceRaised = false;
  private readonly multi: SustainedCondition;
  private multiRaised = false;
  private multiCount = 0;
  private readonly device: SustainedCondition;
  private deviceRaised = false;
  private deviceLabel = '';
  /** The latest object sample: people counted by the detector and when. */
  private persons = { count: 0, score: 0, at: -Infinity };
  private headTurns: number[] = [];
  private headSide: -1 | 0 | 1 = 0;
  private lastAlert: Partial<Record<AlertKey, number>> = {};

  constructor(private readonly rules: CameraRules = CAMERA_RULES_DEFAULTS) {
    this.lookAway = new SustainedCondition(rules.returnMs);
    this.noFace = new SustainedCondition(rules.faceReturnMs);
    this.multi = new SustainedCondition(rules.objectGapMs);
    this.device = new SustainedCondition(rules.objectGapMs);
  }

  get calibrated(): boolean {
    return this.baseline !== null;
  }

  /** One face-model frame at time `t` (ms): the faces found and the frame's brightness (null = not measured). */
  push(t: number, faces: FaceMeasure[], brightness: number | null = null): CameraAlert[] {
    const out: CameraAlert[] = [];
    this.learn(faces);
    const obs = classifyFrame(faces, brightness, this.baseline, this.rules);
    this.trackFace(t, obs, out);
    this.trackMulti(t, obs.faces, out);
    if (this.baseline && obs.faces === 1) {
      this.trackGaze(t, obs, out);
      this.trackHead(t, obs, out);
    } else if (obs.faces !== 1) {
      this.closeEpisode(t, out); // no single face: a look cannot continue
      this.trackLookAway(t, null, out);
    }
    return out;
  }

  /** One object-detector sample at time `t` (about once a second): people and devices in view. */
  pushObjects(t: number, detections: readonly ObjectDetection[]): CameraAlert[] {
    const out: CameraAlert[] = [];
    const people = detections.filter((d) => d.label === 'person' && d.score >= this.rules.personScore && d.area >= this.rules.personMinArea);
    this.persons = { count: people.length, score: people.length ? people.reduce((s, d) => s + d.score, 0) / people.length : 0, at: t };

    const devices = detections.filter((d) => this.rules.deviceLabels.includes(d.label) && d.score >= this.rules.deviceScore);
    const best = devices.reduce<ObjectDetection | null>((a, d) => (!a || d.score > a.score ? d : a), null);
    const wasActive = this.device.active;
    const lasted = this.device.update(t, !!best, best?.score ?? 0);
    if (!this.device.active || !wasActive) this.deviceRaised = false;
    if (best) this.deviceLabel = best.label;
    if (!this.deviceRaised && lasted >= this.rules.deviceMs && this.device.hits >= this.rules.objectMinHits && this.cool('CAMERA_DEVICE_DETECTED', t, this.device.since!)) {
      this.deviceRaised = true;
      out.push(this.raise('CAMERA_DEVICE_DETECTED', this.device.since!, lasted, this.device.confidence, `${this.deviceLabel} visible ${human(lasted)}`));
    }
    return out;
  }

  /** The camera stopped (track ended, permission withdrawn): one technical alert, then nothing until it runs again. */
  stopped(t: number, why: string): CameraAlert[] {
    this.reset(t);
    if (!this.cool('CAMERA_STOPPED', t)) return [];
    return [this.raise('CAMERA_STOPPED', t, 0, 1, why)];
  }

  /** The face / object model could not run (failed to load, crashed): one technical alert. */
  unavailable(t: number, why: string): CameraAlert[] {
    this.reset(t);
    if (!this.cool('CAMERA_DETECTION_UNAVAILABLE', t)) return [];
    return [this.raise('CAMERA_DETECTION_UNAVAILABLE', t, 0, 1, why)];
  }

  /** Nothing continues across a camera / model interruption: every timer starts again from zero. */
  private reset(t: number) {
    this.closeEpisode(t, []);
    this.lookAway.update(t + this.rules.returnMs + 1, false);
    this.noFace.update(t + this.rules.faceReturnMs + 1, false);
    this.multi.update(t + this.rules.objectGapMs + 1, false);
    this.device.update(t + this.rules.objectGapMs + 1, false);
    this.persons = { count: 0, score: 0, at: -Infinity };
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

  /** Face not visible: sustained absence only. A dark room is reported as "check unavailable", never as misconduct. */
  private trackFace(t: number, obs: FrameObservation, out: CameraAlert[]) {
    const wasActive = this.noFace.active;
    const lasted = this.noFace.update(t, obs.faces === 0);
    if (!this.noFace.active) return;
    if (!wasActive) {
      this.noFaceDark = 0;
      this.noFaceFrames = 0;
      this.noFaceRaised = false;
    }
    if (obs.faces === 0) {
      this.noFaceFrames += 1;
      if (obs.dark) this.noFaceDark += 1;
    }
    if (this.noFaceRaised || lasted < this.rules.faceMissingMs) return;
    const since = this.noFace.since!;
    this.noFaceRaised = true;
    if (this.noFaceDark / Math.max(1, this.noFaceFrames) >= 0.5) {
      if (this.cool('CAMERA_DETECTION_UNAVAILABLE', t, since)) {
        out.push(this.raise('CAMERA_DETECTION_UNAVAILABLE', since, lasted, 0.9, 'poor lighting: the face could not be seen'));
      }
      return;
    }
    if (this.cool('CAMERA_FACE_MISSING', t, since)) out.push(this.raise('CAMERA_FACE_MISSING', since, lasted, 0.9, `no face in view ${human(lasted)}`));
  }

  /** More than one person: two faces from the face model, or two people from the (recent) object sample. */
  private trackMulti(t: number, faces: number, out: CameraAlert[]) {
    const personsFresh = t - this.persons.at <= this.rules.objectGapMs;
    const people = Math.max(faces, personsFresh ? this.persons.count : 0);
    const confidence = faces >= 2 ? 0.85 : this.persons.score;
    const wasActive = this.multi.active;
    const lasted = this.multi.update(t, people >= 2, confidence);
    if (!this.multi.active || !wasActive) {
      this.multiRaised = false;
      this.multiCount = 0;
    }
    if (people >= 2) this.multiCount = Math.max(this.multiCount, people);
    if (!this.multiRaised && lasted >= this.rules.multipleFacesMs && this.cool('CAMERA_MULTIPLE_FACES', t, this.multi.since!)) {
      this.multiRaised = true;
      out.push(this.raise('CAMERA_MULTIPLE_FACES', this.multi.since!, lasted, this.multi.confidence, `${this.multiCount} people in view`));
    }
  }

  /** The 120 s rule: one CONTINUOUS look away (any direction; a return to the screen resets it). */
  private trackLookAway(t: number, obs: FrameObservation | null, out: CameraAlert[]) {
    const on = !!obs && countsTowardsLookAway(obs);
    const wasActive = this.lookAway.active;
    const lasted = this.lookAway.update(t, on, obs?.strength ?? 0);
    if (!this.lookAway.active) return;
    if (!wasActive) {
      this.lookDirs = {};
      this.lookRaised = false;
    }
    if (on && obs!.away) this.lookDirs[obs!.away] = (this.lookDirs[obs!.away] ?? 0) + 1;
    if (this.lookRaised || lasted < this.rules.sustainedAwayMs) return;
    const since = this.lookAway.since!;
    if (!this.cool('CAMERA_GAZE_AWAY', t, since)) return;
    this.lookRaised = true;
    const dir = (Object.entries(this.lookDirs) as [GazeDirection, number][]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'left';
    out.push(this.raise('CAMERA_GAZE_AWAY', since, lasted, this.lookAway.confidence * 0.5 + 0.5, `${dir}: looked away continuously ${human(lasted)}${DIRECTION_NOTE[dir]}`));
  }

  private trackGaze(t: number, obs: FrameObservation, out: CameraAlert[]) {
    this.trackLookAway(t, obs, out);
    const ep = this.episode;
    if (obs.away) {
      if (ep && ep.dir === obs.away) {
        ep.lastAway = t;
        ep.frames += 1;
        ep.strengthSum += obs.strength;
      } else {
        this.closeEpisode(t, out);
        this.episode = { dir: obs.away, start: t, lastAway: t, frames: 1, strengthSum: obs.strength };
      }
      return;
    }
    // back on the screen: a short return belongs to the same look
    if (ep && t - ep.lastAway >= this.rules.returnMs) this.closeEpisode(t, out);
  }

  /** Ends the current look; a look that lasted is counted, and enough counted looks in one direction is an observation. */
  private closeEpisode(t: number, out: CameraAlert[]) {
    const ep = this.episode;
    this.episode = null;
    if (!ep) return;
    const durationMs = ep.lastAway - ep.start;
    if (durationMs < this.rules.minEpisodeMs || durationMs >= this.rules.sustainedAwayMs) return; // a glance, or the long-look incident
    this.counted.push({ dir: ep.dir, at: ep.start, strength: ep.strengthSum / ep.frames, durationMs });
    this.counted = this.counted.filter((c) => t - c.at <= this.rules.repeatWindowMs);
    const same = this.counted.filter((c) => c.dir === ep.dir);
    if (same.length >= this.rules.repeatCount && this.cool('GAZE_REPEATED', t, same[0]!.at)) {
      const first = same[0]!;
      const total = same.reduce((s, c) => s + c.durationMs, 0);
      const strength = same.reduce((s, c) => s + c.strength, 0) / same.length;
      const windowS = Math.round(this.rules.repeatWindowMs / 1000);
      out.push(this.raise('CAMERA_GAZE_AWAY', first.at, total, strength * 0.5 + 0.5, `${ep.dir}: ${same.length} looks in ${windowS} s${DIRECTION_NOTE[ep.dir]}`));
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

  /** True (and remembers the time) when this alert is not in its cool-down. */
  private cool(key: AlertKey, t: number, since?: number): boolean {
    const last = this.lastAlert[key];
    // the same continuing behaviour (started before the last alert) never alerts twice
    if (last !== undefined && (t - last < this.rules.cooldownMs || (since !== undefined && since <= last))) return false;
    this.lastAlert[key] = t;
    return true;
  }

  private raise(type: CameraEventType, at: number, durationMs: number, confidence: number, detail: string): CameraAlert {
    return { type, at, durationMs: Math.max(0, Math.round(durationMs)), confidence: clamp01(confidence), detail: detail.slice(0, 60) };
  }
}
