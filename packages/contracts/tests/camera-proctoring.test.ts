import { describe, expect, it } from 'vitest';
import { CAMERA_RULES_DEFAULTS, CameraRuleEngine, classifyFrame, headPose, type CameraAlert, type FaceMeasure } from '../src';

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
});

describe('scenarios (synthetic frames at 5 per second)', () => {
  it('1. looking at the screen the whole time: nothing', () => {
    expect(run([[center, 120_000]]).alerts).toEqual([]);
  });

  it('a single glance away, or several short glances: nothing', () => {
    expect(run([[lookLeft, 1000], [center, 5000]]).alerts).toEqual([]);
    expect(run(times(10, [[lookLeft, 800], [center, 3000]])).alerts).toEqual([]);
  });

  it('2. looking left repeatedly (4 looks of 2 s within a minute): one alert, with direction, time and duration', () => {
    const { alerts } = run(times(4, [[lookLeft, 2000], [center, 6000]]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_GAZE_AWAY', detail: 'left: 4 looks in 60 s', at: 3000 });
    expect(alerts[0]!.durationMs).toBeGreaterThanOrEqual(4 * 1600);
    expect(alerts[0]!.confidence).toBeGreaterThan(0.5);
  });

  it('3. looking right repeatedly: one alert for the right', () => {
    const { alerts } = run(times(4, [[lookRight, 2000], [center, 6000]]));
    expect(alerts.map((a) => a.detail)).toEqual(['right: 4 looks in 60 s']);
  });

  it('only 3 looks, or looks spread over more than a minute: nothing yet', () => {
    expect(run(times(3, [[lookLeft, 2000], [center, 6000]])).alerts).toEqual([]);
    expect(run(times(4, [[lookLeft, 2000], [center, 25_000]])).alerts).toEqual([]);
  });

  it('4. looking down as if at a phone (head or eyes): repeated, or one long look', () => {
    expect(run(times(4, [[headDown, 2000], [center, 5000]])).alerts.map((a) => a.detail)).toEqual(['down: 4 looks in 60 s (possible phone or notes)']);
    expect(run([[eyesDown, 7000], [center, 2000]]).alerts.map((a) => a.detail)).toEqual(['down: looked away 6 s (possible phone or notes)']);
  });

  it('5. looking at another screen for a long time: one alert, not one per frame', () => {
    const { alerts } = run([[lookRight, 40_000], [center, 5000]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_GAZE_AWAY', detail: 'right: looked away 6 s' });
  });

  it('6. moving the head very often: one head-movement alert', () => {
    const { alerts } = run(times(12, [[lookLeft, 400], [lookRight, 400], [center, 600]]));
    expect(alerts.filter((a) => a.type === 'CAMERA_HEAD_MOVEMENT')).toHaveLength(1);
  });

  it('7. leaving the camera view: one face-missing alert per absence; a short absence is nothing', () => {
    expect(run([[() => [], 3000], [center, 5000]]).alerts).toEqual([]);
    const { alerts } = run([[() => [], 30_000], [center, 5000]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'CAMERA_FACE_MISSING', detail: 'no face in view', at: 3000 });
  });

  it('8. two people in view: one alert; a brief second face (detection flicker) is nothing', () => {
    expect(run([[() => [face(), face({ cameraOffset: 0.3 })], 1000], [center, 5000]]).alerts).toEqual([]);
    const { alerts } = run([[() => [face(), face({ cameraOffset: 0.3 })], 10_000]]);
    expect(alerts.map((a) => [a.type, a.detail])).toEqual([['CAMERA_MULTIPLE_FACES', '2 faces in view']]);
  });

  it('9. too dark to see the face: the face-missing alert says so', () => {
    const { alerts } = run([[() => [], 8000, 15]]);
    expect(alerts.map((a) => a.detail)).toEqual(['poor lighting: the face could not be seen']);
  });

  it('a camera placed off to the side: the resting position is learnt, so sitting normally is not "looking away"', () => {
    const engine = new CameraRuleEngine();
    let t = 0;
    const alerts: CameraAlert[] = [];
    // the candidate's normal posture shows the head a bit turned (camera on the side)
    for (; t < 120_000; t += FRAME_MS) alerts.push(...engine.push(t, [face({ yaw: 0.25, pitch: 0.55 })], 120));
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

  it('the camera stopping is one alert', () => {
    const engine = new CameraRuleEngine();
    expect(engine.stopped(1000, 'camera turned off')).toMatchObject([{ type: 'CAMERA_STOPPED', detail: 'camera turned off' }]);
    expect(engine.stopped(2000, 'camera turned off')).toEqual([]);
  });

  it('every threshold is a setting', () => {
    const strict = new CameraRuleEngine({ ...CAMERA_RULES_DEFAULTS, repeatCount: 2 });
    expect(run(times(2, [[lookLeft, 2000], [center, 4000]]), strict).alerts).toHaveLength(1);
  });
});
