/**
 * Browser-level integrity events for the DSA assessment.
 *
 * Names that overlap with the round-engine's online-test events (TAB_SWITCH, FULLSCREEN_EXIT) are kept identical
 * so HR can show both on one timeline later. These events are observations, never proof of cheating.
 */

import { CAMERA_EVENT_TYPES, type CameraEventType } from '@hireflow/contracts';

/** Shown to the candidate before monitoring starts (attempts without the camera); bump when the notice changes. */
export const CONSENT_VERSION = 'dsa-proctoring-v2';
/** The notice of a camera-monitored attempt (AI camera: gaze, face in view, one person). Bump when it changes. */
export const CAMERA_CONSENT_VERSION = 'dsa-proctoring-camera-v3';

/** AI camera alerts (contracts camera-proctoring.ts) and the older webcam events, still accepted from older pages. */
export const LEGACY_CAMERA_TYPES = ['CAMERA_OFF', 'NO_FACE', 'MULTIPLE_FACES'] as const;
export const isCameraType = (type: string): boolean =>
  (CAMERA_EVENT_TYPES as readonly string[]).includes(type) || (LEGACY_CAMERA_TYPES as readonly string[]).includes(type);
export type { CameraEventType };

/** Things the page can report as a violation. */
export const VIOLATION_TYPES = [
  'FULLSCREEN_EXIT',
  'TAB_SWITCH',
  'WINDOW_BLUR',
  'COPY',
  'CUT',
  'PASTE',
  'SELECT_ALL',
  'CONTEXT_MENU',
  'DEVTOOLS_SHORTCUT',
  'VIEW_SOURCE',
  'SAVE_SHORTCUT',
  'PRINT_SHORTCUT',
  /** The PrintScreen key (or a macOS screenshot shortcut) reached the page. It cannot be blocked, only noticed. */
  'SCREENSHOT_ATTEMPT',
  /** Webcam (camera required): the camera stopped, was unplugged or its permission was withdrawn. */
  'CAMERA_OFF',
  /** Webcam: no face in view for several seconds (the page decides on the device; no video leaves the browser). */
  'NO_FACE',
  /** Webcam: more than one face in view for several seconds. */
  'MULTIPLE_FACES',
  /** AI camera alerts, already grouped on the device (a single glance never becomes one). */
  ...CAMERA_EVENT_TYPES,
] as const;
export type ViolationType = (typeof VIOLATION_TYPES)[number];

/** Recorded for the reviewer but never counted as a violation. */
export const INFO_TYPES = ['SESSION_RESUMED'] as const;
export type InfoType = (typeof INFO_TYPES)[number];

/** Violations that last for a while: they open on exit and close when the matching return event arrives. */
export const EPISODE_TYPES = ['FULLSCREEN_EXIT', 'TAB_SWITCH', 'WINDOW_BLUR'] as const;
export type EpisodeType = (typeof EPISODE_TYPES)[number];

/** Signals that close an episode. They are never stored as events of their own. */
export const RETURN_TYPES = ['FULLSCREEN_RETURN', 'TAB_RETURN', 'WINDOW_RETURN'] as const;
export type ReturnType = (typeof RETURN_TYPES)[number];

export const RETURN_CLOSES: Record<ReturnType, EpisodeType> = {
  FULLSCREEN_RETURN: 'FULLSCREEN_EXIT',
  TAB_RETURN: 'TAB_SWITCH',
  WINDOW_RETURN: 'WINDOW_BLUR',
};

export type ProctorEventType = ViolationType | InfoType;
export type ProctorInputType = ProctorEventType | ReturnType;

export const ALL_INPUT_TYPES: readonly string[] = [...VIOLATION_TYPES, ...INFO_TYPES, ...RETURN_TYPES];

export type Severity = 'info' | 'low' | 'medium' | 'high';

export interface ProctorEvent {
  id: number;
  type: ProctorEventType;
  severity: Severity;
  /** Epoch ms, taken from the server clock (a client time is only accepted inside the attempt window). */
  at: number;
  /** Episodes only: when the candidate came back. Null while still away. */
  endedAt: number | null;
  durationMs: number | null;
  /** Short, sanitised label such as "Ctrl+Shift+I". Never free text from the page's content. */
  detail: string | null;
  /** AI camera alerts: how sure the model was (0..1). Missing on older records. */
  confidence?: number | null;
}

export interface ProctorSession {
  /** Hash of the invitation token. The raw token is never stored with proctoring data. */
  inviteRef: string;
  assessmentId: string;
  consentVersion: string | null;
  consentAt: number | null;
  /** Candidate said full screen was active when consenting (a claim from the page; the server cannot see it). */
  fullscreenAtStart: boolean;
  /** Candidate said the webcam was on when consenting (a claim from the page). Missing on records made before v2. */
  cameraAtStart?: boolean;
  /** This attempt is watched by the AI camera (decided from the round when the candidate consented). */
  camera?: boolean;
  startedAt: number | null;
  endedAt: number | null;
  nextId: number;
  events: ProctorEvent[];
  /** Events dropped because the per-attempt cap was reached. */
  dropped: number;
}

export type ProctoringStatus = 'clean' | 'warning' | 'review' | 'disqualified';

export interface ProctoringSummary {
  assessmentId: string;
  inviteRef: string;
  status: ProctoringStatus;
  /** True when a person should look at this attempt (review or disqualified). */
  flagged: boolean;
  reasons: string[];
  totalViolations: number;
  bySeverity: { low: number; medium: number; high: number };
  score: number;
  tabSwitchCount: number;
  windowBlurCount: number;
  fullscreenExitCount: number;
  copyPasteAttempts: number;
  contextMenuAttempts: number;
  devToolsAttempts: number;
  otherRestrictedActions: number;
  screenshotAttempts: number;
  cameraOffCount: number;
  noFaceCount: number;
  multipleFacesCount: number;
  /** AI camera alerts by kind (suspicious patterns for HR to review, never proof). Older webcam events counted in. */
  camera: { monitored: boolean; gazeAway: number; faceMissing: number; multipleFaces: number; headMovement: number; stopped: number };
  /** Allowed warnings (0 = no limit) and how many suspicious events have been used up. */
  strikesAllowed: number;
  strikesUsed: number;
  /** Merged time away from the assessment (tab hidden, window unfocused or full screen left), overlaps counted once. */
  totalTimeOutsideMs: number;
  sessionResumes: number;
  droppedEvents: number;
  consent: { version: string | null; at: string | null; fullscreenAtStart: boolean; cameraAtStart: boolean };
  startedAt: string | null;
  endedAt: string | null;
  policy: PublicPolicy;
}

/** What the candidate is allowed to learn: how they are doing, not the thresholds. */
export interface CandidateProctorState {
  violationCount: number;
  level: 'ok' | 'warning' | 'final_warning';
  /** Warnings the candidate is allowed before the next suspicious event ends the assessment (0 = no limit). */
  strikesAllowed: number;
  strikesUsed: number;
}

/** Policy values safe to show HR. */
export interface PublicPolicy {
  warnScore: number;
  reviewScore: number;
  disqualifyScore: number;
  reviewFullscreenExits: number;
  reviewOutsideSeconds: number;
  autoEnd: boolean;
  maxStrikes: number;
}

/** What the candidate's browser needs to know to run the assessment (no thresholds). */
export interface ClientProctoringConfig {
  enabled: boolean;
  requireFullscreen: boolean;
  /** The webcam must be on for the whole attempt; the page checks that a face (and only one) is in view. */
  requireCamera: boolean;
  /** This attempt is watched by the AI camera (same as requireCamera; the name the SQL / DSA page reads). */
  camera: boolean;
  fullscreenReentry: 'block' | 'warn';
  autoEnd: boolean;
  /** Suspicious events tolerated as warnings; the next one ends the assessment. 0 = no limit. */
  maxStrikes: number;
  consentVersion: string;
  monitored: string[];
}

export const MONITORED_DESCRIPTIONS = [
  'Leaving full-screen mode',
  'Switching to another browser tab or window, or the window losing focus',
  'Copy, cut and paste attempts, and select-all outside the code editor',
  'Right-click menu, view-source, save and print shortcuts, and the PrintScreen (screenshot) key',
  'Developer-tools shortcuts such as F12',
];

/** Added to the list when the attempt is camera-monitored. */
export const CAMERA_MONITORED_DESCRIPTIONS = [
  'Your webcam must stay on for the whole test; turning it off or withdrawing its permission pauses the test',
  'Repeated or long looks away from the screen, your face leaving the camera view, more than one face in view, and very frequent head turning (a single glance never counts)',
  'These are suspicious patterns for the hiring team to review, never proof on their own. No video, image or face data leaves your computer: only short alerts such as "looked left 4 times in 60 s" are sent',
];
