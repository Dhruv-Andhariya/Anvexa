import {
  EPISODE_TYPES,
  type ClientProctoringConfig,
  type ProctorEvent,
  type ProctorEventType,
  type ProctorSession,
  type ProctoringStatus,
  type ProctoringSummary,
  type PublicPolicy,
  type Severity,
  CAMERA_CONSENT_VERSION,
  CAMERA_MONITORED_DESCRIPTIONS,
  CONSENT_VERSION,
  MONITORED_DESCRIPTIONS,
  isCameraType,
} from './proctoring.types';
import { CAMERA_CONFIRM_DEFAULTS, PROTECTION_GROUP_WINDOW_SECONDS } from '@hireflow/contracts';
import { cameraModeFromEnv, cameraMonitored, type CameraMode, type CodingKind } from '../../round-engine/coding-round';

export const DSA_PROCTOR_POLICY = Symbol('DSA_PROCTOR_POLICY');

/** All thresholds are configurable (env vars in `policyFromEnv`). One event never fails a candidate on its own. */
export interface ProctorPolicy {
  enabled: boolean;
  requireFullscreen: boolean;
  /**
   * Which coding attempts the AI camera watches (DSA_PROCTOR_CAMERA): all (default: SQL and DSA rounds), sql (SQL-only
   * rounds), off. A watched attempt needs the webcam on to start; the page reports grouped alerts (CAMERA_*).
   */
  cameraMode: CameraMode;
  /** Camera alerts use up the allowed warnings like any other violation (DSA_PROCTOR_CAMERA_STRIKES, default on). Off = review only. */
  cameraStrikes: boolean;
  /** The same camera alert again within this time is the same behaviour: ignored (server safety net; the page has its own). */
  cameraCooldownMs: number;
  /**
   * Validation of camera alerts (the page groups the frames; the server decides what is a CONFIRMED incident). An alert
   * shorter than its minimum, or less sure than `cameraMinConfidence`, is kept for HR as an observation, never a warning.
   * Looking away: continuously for more than DSA_PROCTOR_LOOK_AWAY_SECONDS (default 120 - the business rule).
   */
  lookAwayMs: number;
  faceMissingMs: number;
  multiplePersonsMs: number;
  deviceMs: number;
  cameraMinConfidence: number;
  /** A counted incident within this many seconds of the previous counted one is the same act (shared protection rule). */
  groupWindowSeconds: number;
  /** `block`: the page is unusable until full screen is re-entered. `warn`: a banner only. */
  fullscreenReentry: 'block' | 'warn';
  /** Weighted score (low 1, medium 3, high 5) at which the candidate gets a warning. */
  warnScore: number;
  /** Score at which the attempt is flagged for human review. */
  reviewScore: number;
  /** Score at which the attempt is marked disqualified. 0 = never (default). */
  disqualifyScore: number;
  /** Full-screen exits that flag the attempt for review on their own. */
  reviewFullscreenExits: number;
  /** Merged seconds away from the assessment that flag the attempt for review. */
  reviewOutsideSeconds: number;
  /** When true, reaching `disqualifyScore` also ends the attempt. Default false: HR decides. */
  autoEnd: boolean;
  /**
   * Allowed warnings: this many confirmed incidents are tolerated (Warning 1, Warning 2); the NEXT one terminates the
   * assessment immediately and keeps the work done so far. Per attempt: a DSA and a SQL round each start at 0.
   * 0 = no limit. Default 2.
   */
  maxStrikes: number;
  /** From this many full-screen exits on, each exit is recorded as high severity. */
  fullscreenHighAfter: number;
  maxEventsPerAttempt: number;
  /** The same violation type inside this window is one action reported twice. */
  dedupeMs: number;
  /** A window blur next to a tab switch is the same action; the blur is dropped. */
  mergeWindowMs: number;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = { info: 0, low: 1, medium: 3, high: 5 };

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};
const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v === '' ? fallback : ['on', 'true', '1', 'yes'].includes(v.toLowerCase()));

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ProctorPolicy {
  return {
    enabled: flag(env.DSA_PROCTORING, true),
    requireFullscreen: flag(env.DSA_PROCTOR_REQUIRE_FULLSCREEN, true),
    cameraMode: cameraModeFromEnv(env),
    cameraStrikes: flag(env.DSA_PROCTOR_CAMERA_STRIKES, true),
    cameraCooldownMs: num(env.DSA_PROCTOR_CAMERA_COOLDOWN_MS, 20_000),
    lookAwayMs: num(env.DSA_PROCTOR_LOOK_AWAY_SECONDS, CAMERA_CONFIRM_DEFAULTS.lookAwayMs / 1000) * 1000,
    faceMissingMs: num(env.DSA_PROCTOR_FACE_MISSING_SECONDS, CAMERA_CONFIRM_DEFAULTS.faceMissingMs / 1000) * 1000,
    multiplePersonsMs: num(env.DSA_PROCTOR_MULTI_PERSON_SECONDS, CAMERA_CONFIRM_DEFAULTS.multiplePersonsMs / 1000) * 1000,
    deviceMs: num(env.DSA_PROCTOR_DEVICE_SECONDS, CAMERA_CONFIRM_DEFAULTS.deviceMs / 1000) * 1000,
    cameraMinConfidence: Math.min(1, num(env.DSA_PROCTOR_CAMERA_MIN_CONFIDENCE, CAMERA_CONFIRM_DEFAULTS.minConfidence)),
    groupWindowSeconds: num(env.DSA_PROCTOR_GROUP_SECONDS, PROTECTION_GROUP_WINDOW_SECONDS),
    fullscreenReentry: env.DSA_PROCTOR_FULLSCREEN_REENTRY === 'warn' ? 'warn' : 'block',
    warnScore: num(env.DSA_PROCTOR_WARN_SCORE, 5),
    reviewScore: num(env.DSA_PROCTOR_REVIEW_SCORE, 12),
    disqualifyScore: num(env.DSA_PROCTOR_DISQUALIFY_SCORE, 0),
    reviewFullscreenExits: num(env.DSA_PROCTOR_REVIEW_FULLSCREEN_EXITS, 3),
    reviewOutsideSeconds: num(env.DSA_PROCTOR_REVIEW_OUTSIDE_SECONDS, 60),
    autoEnd: flag(env.DSA_PROCTOR_AUTO_END, false),
    maxStrikes: Math.floor(num(env.DSA_PROCTOR_MAX_STRIKES, 2)),
    fullscreenHighAfter: Math.max(1, num(env.DSA_PROCTOR_FULLSCREEN_HIGH_AFTER, 3)),
    maxEventsPerAttempt: Math.max(10, num(env.DSA_PROCTOR_MAX_EVENTS, 500)),
    dedupeMs: num(env.DSA_PROCTOR_DEDUPE_MS, 400),
    mergeWindowMs: num(env.DSA_PROCTOR_MERGE_MS, 1500),
  };
}

/** Proctoring switched off (used when a DsaService is built without one, e.g. in older tests). */
export const DISABLED_POLICY: ProctorPolicy = { ...policyFromEnv({}), enabled: false };

/** Is an attempt of this kind watched by the AI camera under the policy? */
export const cameraFor = (policy: ProctorPolicy, kind: CodingKind): boolean => policy.enabled && cameraMonitored(kind, policy.cameraMode);

/** `camera`: this attempt is camera-monitored (cameraFor). Its notice has its own consent version. */
export function clientConfig(policy: ProctorPolicy, camera = false): ClientProctoringConfig {
  const on = policy.enabled && camera;
  return {
    enabled: policy.enabled,
    requireFullscreen: policy.enabled && policy.requireFullscreen,
    requireCamera: on,
    camera: on,
    fullscreenReentry: policy.fullscreenReentry,
    autoEnd: policy.enabled && ((policy.autoEnd && policy.disqualifyScore > 0) || policy.maxStrikes > 0),
    maxStrikes: policy.enabled ? policy.maxStrikes : 0,
    consentVersion: on ? CAMERA_CONSENT_VERSION : CONSENT_VERSION,
    monitored: [...MONITORED_DESCRIPTIONS, ...(on ? CAMERA_MONITORED_DESCRIPTIONS : []), ...(policy.enabled ? [warningRuleText(policy.maxStrikes)] : [])],
  };
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** The notice line that states the warning policy. */
export function warningRuleText(max: number): string {
  if (max <= 0) return 'Possible integrity incidents are recorded for the hiring team to review';
  return `${max} warning${max === 1 ? ' is' : 's are'} allowed; the ${ordinal(max + 1)} confirmed incident automatically ends the assessment (your submitted answers are kept for review)`;
}

export function publicPolicy(policy: ProctorPolicy): PublicPolicy {
  return {
    warnScore: policy.warnScore,
    reviewScore: policy.reviewScore,
    disqualifyScore: policy.disqualifyScore,
    reviewFullscreenExits: policy.reviewFullscreenExits,
    reviewOutsideSeconds: policy.reviewOutsideSeconds,
    autoEnd: policy.autoEnd,
    maxStrikes: policy.maxStrikes,
  };
}

/** Severity of a new event. Repeated full-screen exits escalate to high. */
export function severityOf(type: ProctorEventType, priorFullscreenExits: number, policy: ProctorPolicy): Severity {
  switch (type) {
    case 'SESSION_RESUMED':
    case 'CAMERA_STOPPED':
      return 'info';
    case 'FULLSCREEN_EXIT':
      return priorFullscreenExits + 1 >= policy.fullscreenHighAfter ? 'high' : 'medium';
    case 'TAB_SWITCH':
    case 'WINDOW_BLUR':
    case 'DEVTOOLS_SHORTCUT':
    case 'SCREENSHOT_ATTEMPT':
    case 'CAMERA_OFF':
    case 'NO_FACE':
    case 'CAMERA_FACE_MISSING':
    case 'CAMERA_GAZE_AWAY':
      return 'medium';
    case 'MULTIPLE_FACES':
    case 'CAMERA_MULTIPLE_FACES':
    case 'CAMERA_DEVICE_DETECTED':
      return 'high';
    case 'CAMERA_HEAD_MOVEMENT':
      return 'low';
    case 'CAMERA_DETECTION_UNAVAILABLE':
      return 'info';
    default:
      return 'low';
  }
}

/**
 * Is a new event a candidate for a warning (a CONFIRMED incident)? Browser violations always are. Camera alerts are
 * validated: technical ones (camera stopped, check unavailable) and observations (head movement) never are; the others
 * must have lasted long enough and be sure enough. `note` says why an alert was kept for HR only.
 */
export function qualification(e: Pick<ProctorEvent, 'type' | 'severity' | 'durationMs' | 'confidence'>, policy: ProctorPolicy): { qualifies: boolean; note: string | null } {
  if (e.severity === 'info') return { qualifies: false, note: isCameraType(e.type) ? 'technical event: not counted as misconduct' : null };
  if (!isCameraType(e.type)) return { qualifies: true, note: null };
  if (!policy.cameraStrikes) return { qualifies: false, note: 'camera alerts are kept for review only (DSA_PROCTOR_CAMERA_STRIKES=off)' };
  const minMs: Partial<Record<string, number>> = {
    CAMERA_GAZE_AWAY: policy.lookAwayMs,
    CAMERA_FACE_MISSING: policy.faceMissingMs,
    CAMERA_MULTIPLE_FACES: policy.multiplePersonsMs,
    CAMERA_DEVICE_DETECTED: policy.deviceMs,
  };
  const min = minMs[e.type];
  if (min === undefined) return { qualifies: false, note: 'observation for review: not counted as a warning' };
  if ((e.durationMs ?? 0) < min) return { qualifies: false, note: `observation: shorter than ${Math.round(min / 1000)} s, not counted as a warning` };
  if ((e.confidence ?? 0) < policy.cameraMinConfidence) return { qualifies: false, note: 'observation: detection not confident enough, not counted as a warning' };
  return { qualifies: true, note: null };
}

/** Legacy rule (records made before the warning manager): every non-info event counted. */
const legacyViolation = (e: ProctorEvent, policy: ProctorPolicy) => e.severity !== 'info' && (policy.cameraStrikes || !isCameraType(e.type));

/**
 * Used up a warning (a confirmed incident). Events stored by the warning manager carry the decision; older records
 * (before it) are counted the way they were then.
 */
export const countsAsViolation = (e: ProctorEvent, policy: ProctorPolicy): boolean =>
  e.outcome !== undefined ? e.outcome === 'WARNING' || e.outcome === 'TERMINATED' : legacyViolation(e, policy);

/**
 * A violation for HR's numbers (counts by kind, weighted score): every confirmed incident, also one grouped with the
 * previous one (same act, no second warning). Observations kept for review only (RECORDED) are not violations.
 */
export const isViolation = (e: ProctorEvent, policy: ProctorPolicy): boolean =>
  e.outcome !== undefined ? e.outcome !== 'RECORDED' : legacyViolation(e, policy);

/** Time covered by at least one episode, overlaps counted once. Open episodes run until `nowMs`. */
export function mergedOutsideMs(events: ProctorEvent[], nowMs: number): number {
  const spans = events
    .filter((e) => (EPISODE_TYPES as readonly string[]).includes(e.type))
    .map((e) => [e.at, e.endedAt ?? nowMs] as const)
    .filter(([s, t]) => t > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, t] of spans) {
    if (curEnd < 0 || s > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart;
      curStart = s;
      curEnd = t;
    } else if (t > curEnd) {
      curEnd = t;
    }
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}

export function scoreOf(events: ProctorEvent[], policy?: ProctorPolicy): number {
  const counted = policy ? events.filter((e) => isViolation(e, policy)) : events.filter((e) => e.severity !== 'info');
  return counted.reduce((sum, e) => sum + SEVERITY_WEIGHT[e.severity], 0);
}

export function summarize(session: ProctorSession, policy: ProctorPolicy, nowMs: number): ProctoringSummary {
  const events = session.events;
  const violations = events.filter((e) => isViolation(e, policy));
  const count = (...types: ProctorEventType[]) => violations.filter((e) => types.includes(e.type)).length;
  // camera alerts by kind, whether or not they used up a warning (older webcam events counted in)
  const cameraCount = (...types: ProctorEventType[]) => events.filter((e) => types.includes(e.type)).length;
  const camera = {
    monitored: session.camera === true,
    gazeAway: cameraCount('CAMERA_GAZE_AWAY'),
    faceMissing: cameraCount('CAMERA_FACE_MISSING', 'NO_FACE'),
    multipleFaces: cameraCount('CAMERA_MULTIPLE_FACES', 'MULTIPLE_FACES'),
    device: cameraCount('CAMERA_DEVICE_DETECTED'),
    headMovement: cameraCount('CAMERA_HEAD_MOVEMENT'),
    stopped: cameraCount('CAMERA_STOPPED', 'CAMERA_OFF'),
    unavailable: cameraCount('CAMERA_DETECTION_UNAVAILABLE'),
  };
  // possible-misconduct alerts only (technical events are listed, but do not ask for a review on their own)
  const cameraAlerts = camera.gazeAway + camera.faceMissing + camera.multipleFaces + camera.device + camera.headMovement;
  const strikesUsed = session.warningCount ?? events.filter((e) => countsAsViolation(e, policy)).length;
  const score = scoreOf(events, policy);
  const fullscreenExitCount = count('FULLSCREEN_EXIT');
  const outside = mergedOutsideMs(events, session.endedAt ?? nowMs);

  const reasons: string[] = [];
  let status: ProctoringStatus = 'clean';
  if (session.terminatedAt) {
    status = 'disqualified';
    reasons.push(session.terminationReason ?? `Terminated after ${policy.maxStrikes} warnings.`);
  } else if (session.warningCount === undefined && policy.maxStrikes > 0 && violations.length > policy.maxStrikes) {
    // a record made before the warning manager
    status = 'disqualified';
    reasons.push(`Used all ${policy.maxStrikes} allowed warnings; suspicious event number ${policy.maxStrikes + 1} ended the assessment.`);
  }
  if (status !== 'disqualified' && policy.disqualifyScore > 0 && score >= policy.disqualifyScore) {
    status = 'disqualified';
    reasons.push(`Violation score ${score} reached the disqualification threshold (${policy.disqualifyScore}).`);
  }
  if (status !== 'disqualified') {
    if (score >= policy.reviewScore) {
      status = 'review';
      reasons.push(`Violation score ${score} reached the review threshold (${policy.reviewScore}).`);
    }
    if (policy.reviewFullscreenExits > 0 && fullscreenExitCount >= policy.reviewFullscreenExits) {
      status = 'review';
      reasons.push(`Left full screen ${fullscreenExitCount} times (review at ${policy.reviewFullscreenExits}).`);
    }
    if (policy.reviewOutsideSeconds > 0 && outside >= policy.reviewOutsideSeconds * 1000) {
      status = 'review';
      reasons.push(`${Math.round(outside / 1000)} s outside the assessment (review at ${policy.reviewOutsideSeconds} s).`);
    }
    // any AI camera alert: a person should look (the camera sees patterns, it never proves anything)
    if (cameraAlerts > 0) {
      status = 'review';
      reasons.push(`${cameraAlerts} AI camera alert${cameraAlerts === 1 ? '' : 's'} (possible incidents, not proof).`);
    }
    if (status === 'clean' && score >= policy.warnScore) {
      status = 'warning';
      reasons.push(`Violation score ${score} reached the warning threshold (${policy.warnScore}).`);
    }
  }

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    assessmentId: session.assessmentId,
    inviteRef: session.inviteRef,
    status,
    flagged: status === 'review' || status === 'disqualified',
    reasons,
    totalViolations: violations.length,
    bySeverity: {
      low: violations.filter((e) => e.severity === 'low').length,
      medium: violations.filter((e) => e.severity === 'medium').length,
      high: violations.filter((e) => e.severity === 'high').length,
    },
    score,
    tabSwitchCount: count('TAB_SWITCH'),
    windowBlurCount: count('WINDOW_BLUR'),
    fullscreenExitCount,
    copyPasteAttempts: count('COPY', 'CUT', 'PASTE'),
    contextMenuAttempts: count('CONTEXT_MENU'),
    devToolsAttempts: count('DEVTOOLS_SHORTCUT'),
    otherRestrictedActions: count('SELECT_ALL', 'VIEW_SOURCE', 'SAVE_SHORTCUT', 'PRINT_SHORTCUT'),
    screenshotAttempts: count('SCREENSHOT_ATTEMPT'),
    cameraOffCount: camera.stopped,
    noFaceCount: camera.faceMissing,
    multipleFacesCount: camera.multipleFaces,
    camera,
    strikesAllowed: policy.maxStrikes,
    strikesUsed,
    terminatedAt: iso(session.terminatedAt ?? null),
    terminationReason: session.terminationReason ?? null,
    totalTimeOutsideMs: outside,
    sessionResumes: events.filter((e) => e.type === 'SESSION_RESUMED').length,
    droppedEvents: session.dropped,
    consent: { version: session.consentVersion, at: iso(session.consentAt), fullscreenAtStart: session.fullscreenAtStart, cameraAtStart: session.cameraAtStart ?? false },
    startedAt: iso(session.startedAt),
    endedAt: iso(session.endedAt),
    policy: publicPolicy(policy),
  };
}
