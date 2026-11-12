import { describe, expect, it } from 'vitest';
import {
  CAMERA_CONFIRM_DEFAULTS,
  CAMERA_RULES_DEFAULTS,
  CameraRuleEngine,
  classifyFrame,
  countsTowardsLookAway,
  headPose,
  type CameraAlert,
  type FaceMeasure,
  type ObjectDetection,
} from '../src';

const FRAME_MS = 200; // the page samples about 5 frames per second

/**
 * A synthetic face as the model would report it. yaw: nose offset in eye widths (positive = the subject's left);
 * pitch: nose height between the eyes' line and the chin (0.45 = this person's resting position); eyes: blendshapes.
 */
function face(opts: { yaw?: number; pitch?: number; eyes?: Record<string, number>; cameraOffset?: number } = {}): FaceMeasure {
  const cx = 0.5 + (opts.cameraOffset ?? 0);
  return {
    points: {
      33: { x: cx - 0.1, y: 0.4 },
      263: { x: cx + 0.1, y: 0.4 },
      152: { x: cx, y: 0.7 },
      1: { x: cx + (opts.yaw ?? 0) * 0.2, y: 0.4 + (opts.pitch ?? 0.45) * 0.3 },
    },
    blendshapes: opts.eyes ?? {},
  };
}
const center = () => [face()];
const lookLeft = () => [face({ yaw: 0.6 })];
const lookRight = () => [face({ yaw: -0.6 })];
const headDown = () => [face({ pitch: 0.7 })];
const eyesDown = () => [face({ eyes: { eyeLookDownLeft: 0.8, eyeLookDownRight: 0.8 } })];
const blink = () => [face({ eyes: { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, eyeLookDownLeft: 0.9, eyeLookDownRight: 0.9 } })];

/** Runs `script` ([frames, how long]) through a fresh engine after a calm, centred calibration. */
function run(script: [() => FaceMeasure[], number, number?][], engine = new CameraRuleEngine()): { alerts: CameraAlert[]; engine: CameraRuleEngine } {
  const alerts: CameraAlert[] = [];
  let t = 0;
  const feed = (frames: () => FaceMeasure[], ms: number, brightness: number | null = 120) => {
    for (const end = t + ms; t < end; t += FRAME_MS) alerts.push(...engine.push(t, frames(), brightness));
  };
  feed(center, 3000); // calibration: sitting normally
  for (const [frames, ms, brightness] of script) feed(frames, ms, brightness ?? 120);
  return { alerts, engine };
}
const times = (n: number, step: [() => FaceMeasure[], number][]) => Array.from({ length: n }, () => step).flat();
const longLooks = (alerts: CameraAlert[]) => alerts.filter((a) => a.type === 'CAMERA_GAZE_AWAY' && a.detail.includes('continuously'));

describe('one frame', () => {
  it('reads the head turn and tilt from the face geometry', () => {
    expect(headPose(face())).toEqual({ yaw: 0, pitch: expect.closeTo(0.45, 5) });
    expect(headPose(face({ yaw: 0.5 }))!.yaw).toBeCloseTo(0.5);
  });

  it('judges the head first, then the eyes, and ignores blinks', () => {
    const base = { yaw: 0, pitch: 0.45 };
    expect(classifyFrame(lookLeft(), 120, base).away).toBe('left');
    expect(classifyFrame(lookRight(), 120, base).away).toBe('right');
    expect(classifyFrame(headDown(), 120, base).away).toBe('down');
    expect(classifyFrame(eyesDown(), 120, base).away).toBe('down');
    expect(classifyFrame([face({ eyes: { eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 } })], 120, base).away).toBe('left');
    expect(classifyFrame(blink(), 120, base).away).toBeNull();
    expect(classifyFrame(center(), 120, base).away).toBeNull();
    expect(classifyFrame([], 20, base)).toMatchObject({ faces: 0, dark: true });
  });

  it('for the looking-away rule: the head (any direction) or the eyes far to a side count; eyes looking down alone do not', () => {
    const base = { yaw: 0, pitch: 0.45 };
    expect(countsTowardsLookAway(classifyFrame(lookLeft(), 120, base))).toBe(true);
    expect(countsTowardsLookAway(classifyFrame(headDown(), 120, base))).toBe(true);
    expect(countsTowardsLookAway(classifyFrame([face({ eyes: { eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 } })], 120, base))).toBe(true);
    expect(countsTowardsLookAway(classifyFrame(eyesDown(), 120, base))).toBe(false);
    expect(countsTowardsLookAway(classifyFrame(blink(), 120, base))).toBe(false);
  });
});

describe('looking away and face visibility (synthetic frames at 5 per second)', () => {
  it('1. looking at the screen the whole time: nothing', () => {
    expect(run([[center, 120_000]]).alerts).toEqual([]);
  });

  it('short glances, however many: never the looking-away incident', () => {
    expect(run([[lookLeft, 1000], [center, 5000]]).alerts).toEqual([]);
    expect(run(times(10, [[lookLeft, 800], [center, 3000]])).alerts).toEqual([]);
    expect(longLooks(run(times(30, [[lookLeft, 3000], [center, 1000]])).alerts)).toEqual([]);
  });

  it('2. looking left repeatedly (4 looks of 2 s within a minute): one observation with direction, time and duration', () => {
    const { alerts } = run(times(4, [[lookLeft, 2000], [center, 6000]]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_GAZE_AWAY', detail: 'left: 4 looks in 60 s', at: 3000 });
    expect(alerts[0]!.durationMs).toBeGreaterThanOrEqual(4 * 1600);
    expect(alerts[0]!.durationMs).toBeLessThan(CAMERA_CONFIRM_DEFAULTS.lookAwayMs); // so the server keeps it as an observation
  });

  it('3. looking right repeatedly: one observation for the right; only 3 looks, or spread out: nothing', () => {
    expect(run(times(4, [[lookRight, 2000], [center, 6000]])).alerts.map((a) => a.detail)).toEqual(['right: 4 looks in 60 s']);
    expect(run(times(3, [[lookLeft, 2000], [center, 6000]])).alerts).toEqual([]);
    expect(run(times(4, [[lookLeft, 2000], [center, 25_000]])).alerts).toEqual([]);
  });

  it('4. looking down at a phone for short whiles, repeatedly: an observation, never the long-look incident', () => {
    expect(run(times(4, [[headDown, 2000], [center, 5000]])).alerts.map((a) => a.detail)).toEqual(['down: 4 looks in 60 s (possible phone or notes)']);
  });

  it('5. looking at another screen continuously for more than 120 s: ONE looking-away incident, with direction and duration', () => {
    const { alerts } = run([[lookRight, 130_000], [center, 5000]]);
    const gaze = alerts.filter((a) => a.type === 'CAMERA_GAZE_AWAY');
    expect(gaze).toHaveLength(1);
    expect(gaze[0]).toMatchObject({ at: 3000, detail: 'right: looked away continuously 2 min 0 s' });
    expect(gaze[0]!.durationMs).toBeGreaterThanOrEqual(CAMERA_CONFIRM_DEFAULTS.lookAwayMs);
    expect(gaze[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('looking away for 100 s, back to the screen, then 100 s again: nothing (the timer resets on return)', () => {
    expect(longLooks(run([[lookLeft, 100_000], [center, 3000], [lookLeft, 100_000], [center, 3000]]).alerts)).toEqual([]);
  });

  it('a long look that changes direction (left, then down) is still one continuous look away', () => {
    expect(longLooks(run([[lookLeft, 70_000], [headDown, 60_000], [center, 2000]]).alerts)).toHaveLength(1);
  });

  it('blinks during a long look do not reset it; the eyes looking down alone (typing) never count', () => {
    expect(longLooks(run(times(26, [[lookRight, 5000], [blink, 200]])).alerts)).toHaveLength(1);
    expect(run([[eyesDown, 300_000]]).alerts.filter((a) => a.type === 'CAMERA_GAZE_AWAY')).toEqual([]);
  });

  it('6. moving the head very often: one head-movement observation', () => {
    const { alerts } = run(times(12, [[lookLeft, 400], [lookRight, 400], [center, 600]]));
    expect(alerts.filter((a) => a.type === 'CAMERA_HEAD_MOVEMENT')).toHaveLength(1);
  });

  it('7. face not visible: a temporary loss (15 s) is nothing; a sustained absence (30 s) is one alert', () => {
    expect(run([[() => [], 15_000], [center, 5000]]).alerts).toEqual([]);
    const { alerts } = run([[() => [], 30_000], [center, 5000]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_FACE_MISSING', at: 3000 });
    expect(alerts[0]!.detail).toMatch(/^no face in view/);
    expect(alerts[0]!.durationMs).toBeGreaterThanOrEqual(CAMERA_CONFIRM_DEFAULTS.faceMissingMs);
  });

  it('one wrong "face" frame during an absence does not reset it', () => {
    expect(run([[() => [], 12_000], [center, 200], [() => [], 12_000]]).alerts.map((a) => a.type)).toEqual(['CAMERA_FACE_MISSING']);
  });

  it('8. two faces in view for a while: one alert; a brief second face (detection flicker) is nothing', () => {
    expect(run([[() => [face(), face({ cameraOffset: 0.3 })], 1000], [center, 5000]]).alerts).toEqual([]);
    const { alerts } = run([[() => [face(), face({ cameraOffset: 0.3 })], 10_000]]);
    expect(alerts.map((a) => [a.type, a.detail])).toEqual([['CAMERA_MULTIPLE_FACES', '2 people in view']]);
  });

  it('9. too dark to see the face: a technical "check unavailable" alert, never a face-missing incident', () => {
    const { alerts } = run([[() => [], 25_000, 15]]);
    expect(alerts.map((a) => [a.type, a.detail])).toEqual([['CAMERA_DETECTION_UNAVAILABLE', 'poor lighting: the face could not be seen']]);
  });

  it('a camera placed off to the side: the resting position is learnt, so sitting normally is not "looking away"', () => {
    const engine = new CameraRuleEngine();
    let t = 0;
    const alerts: CameraAlert[] = [];
    // the candidate's normal posture shows the head a bit turned (camera on the side)
    for (; t < 200_000; t += FRAME_MS) alerts.push(...engine.push(t, [face({ yaw: 0.25, pitch: 0.55 })], 120));
    expect(engine.calibrated).toBe(true);
    expect(alerts).toEqual([]);
  });

  it('blinking does not count as looking down', () => {
    expect(run(times(20, [[blink, 300], [center, 1500]])).alerts).toEqual([]);
  });

  it('a behaviour that goes on is one alert, then a cool-down', () => {
    const { alerts } = run([...times(8, [[lookLeft, 2000], [center, 4000]])]);
    expect(alerts.filter((a) => a.type === 'CAMERA_GAZE_AWAY')).toHaveLength(1);
  });

  it('the camera stopping is one technical alert, and every timer starts again afterwards', () => {
    const e = new CameraRuleEngine();
    let t = 0;
    for (; t < 3000; t += FRAME_MS) e.push(t, center(), 120);
    for (; t < 100_000; t += FRAME_MS) e.push(t, lookLeft(), 120);
    expect(e.stopped(t, 'camera turned off')).toMatchObject([{ type: 'CAMERA_STOPPED', detail: 'camera turned off' }]);
    expect(e.stopped(t + 1000, 'camera turned off')).toEqual([]);
    const after: CameraAlert[] = [];
    for (const end = t + 60_000; t < end; t += FRAME_MS) after.push(...e.push(t, lookLeft(), 120));
    expect(longLooks(after)).toEqual([]); // 100 s + 60 s across the interruption is not one continuous look
  });

  it('the model failing is one technical alert', () => {
    const e = new CameraRuleEngine();
    expect(e.unavailable(1000, 'face model failed')).toMatchObject([{ type: 'CAMERA_DETECTION_UNAVAILABLE' }]);
    expect(e.unavailable(2000, 'face model failed')).toEqual([]);
  });

  it('every threshold is a setting', () => {
    const strict = new CameraRuleEngine({ ...CAMERA_RULES_DEFAULTS, repeatCount: 2 });
    expect(run(times(2, [[lookLeft, 2000], [center, 4000]]), strict).alerts).toHaveLength(1);
    const quick = new CameraRuleEngine({ ...CAMERA_RULES_DEFAULTS, sustainedAwayMs: 10_000 });
    expect(longLooks(run([[lookLeft, 12_000]], quick).alerts)).toHaveLength(1);
  });
});

describe('people and devices (object detector, about one sample a second)', () => {
  const person = (score = 0.85, area = 0.3): ObjectDetection => ({ label: 'person', score, area });
  const phone = (score = 0.7): ObjectDetection => ({ label: 'cell phone', score, area: 0.02 });
  /** Faces at 5 frames a second and objects once a second, for `ms`. */
  function feed(engine: CameraRuleEngine, from: number, ms: number, objects: () => ObjectDetection[]): CameraAlert[] {
    const out: CameraAlert[] = [];
    for (let t = from; t < from + ms; t += FRAME_MS) {
      out.push(...engine.push(t, center(), 120));
      if (t % 1000 === 0) out.push(...engine.pushObjects(t, objects()));
    }
    return out;
  }

  it('one person in view: nothing', () => {
    expect(feed(new CameraRuleEngine(), 0, 60_000, () => [person()])).toEqual([]);
  });

  it('a second person standing behind for several seconds: one multiple-person incident (once per occurrence)', () => {
    const alerts = feed(new CameraRuleEngine(), 0, 20_000, () => [person(), person(0.75, 0.2)]);
    expect(alerts.map((a) => [a.type, a.detail])).toEqual([['CAMERA_MULTIPLE_FACES', '2 people in view']]);
    expect(alerts[0]!.durationMs).toBeGreaterThanOrEqual(CAMERA_CONFIRM_DEFAULTS.multiplePersonsMs);
  });

  it('a single wrong detection (one sample), a low score or a tiny far-away figure is nothing', () => {
    const e = new CameraRuleEngine();
    expect(e.pushObjects(0, [person(), person()])).toEqual([]);
    expect(feed(e, 1000, 20_000, () => [person()])).toEqual([]);
    expect(feed(new CameraRuleEngine(), 0, 20_000, () => [person(), person(0.4)])).toEqual([]);
    expect(feed(new CameraRuleEngine(), 0, 20_000, () => [person(), person(0.9, 0.005)])).toEqual([]);
  });

  it('a phone visible for several seconds: one device incident with its confidence', () => {
    const alerts = feed(new CameraRuleEngine(), 0, 15_000, () => [person(), phone(0.72)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_DEVICE_DETECTED', confidence: 0.72 });
    expect(alerts[0]!.detail).toMatch(/^cell phone visible/);
  });

  it('a phone in one or two samples, or a low-score guess, is nothing; laptops and keyboards are never devices', () => {
    const e = new CameraRuleEngine();
    expect([...e.pushObjects(0, [phone()]), ...e.pushObjects(1000, [phone()]), ...feed(e, 5000, 20_000, () => [person()])]).toEqual([]);
    expect(feed(new CameraRuleEngine(), 0, 20_000, () => [phone(0.3)])).toEqual([]);
    expect(feed(new CameraRuleEngine(), 0, 20_000, () => [{ label: 'laptop', score: 0.95, area: 0.4 }, { label: 'keyboard', score: 0.9, area: 0.1 }])).toEqual([]);
  });

  it('a phone that stays in view is one alert; it must leave and come back (after the cool-down) to alert again', () => {
    const e = new CameraRuleEngine();
    expect(feed(e, 0, 60_000, () => [phone()])).toHaveLength(1);
    expect(feed(e, 60_000, 10_000, () => [])).toEqual([]);
    expect(feed(e, 70_000, 10_000, () => [phone()]).map((a) => a.type)).toEqual(['CAMERA_DEVICE_DETECTED']);
  });
});
