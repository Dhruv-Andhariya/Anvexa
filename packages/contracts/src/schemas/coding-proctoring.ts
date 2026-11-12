import { z } from 'zod';
import type { ProtectionOutcome } from './protection';

/**
 * Proctoring of the SQL and DSA coding rounds: the vocabulary shared by the API (which decides), the candidate's
 * coding page (which shows the warnings) and the HR dashboard (which reviews the incidents). See docs/PROCTORING.md.
 *
 * Warning policy (enforced only on the server, per assessment attempt - a DSA round and a SQL round each start at 0):
 *   1st confirmed incident -> Warning 1, 2nd -> Warning 2, 3rd -> the assessment is terminated.
 * The counting itself is the one shared by every protected round (countProtectionIncident, protection.ts).
 */

/** Incident categories HR sees. A record's raw event type maps to one of them (proctorIncidentTypeOf). */
export const PROCTOR_INCIDENT_TYPES = [
  'MULTIPLE_PERSONS',
  'LOOKING_AWAY',
  'DEVICE_DETECTED',
  'FACE_NOT_VISIBLE',
  /** Technical: never misconduct, never a warning. */
  'CAMERA_INTERRUPTED',
  /** Technical (poor lighting, model failed): never misconduct, never a warning. */
  'DETECTION_UNAVAILABLE',
  /** Frequent head turning, repeated short looks: kept for HR as context, never a warning. */
  'CAMERA_OBSERVATION',
  /** Full screen left, tab / window switched, clipboard or restricted shortcut. */
  'BROWSER_ACTIVITY',
  /** Recorded for context only (the page was reloaded). */
  'SESSION',
] as const;
export type ProctorIncidentType = (typeof PROCTOR_INCIDENT_TYPES)[number];

export const PROCTOR_INCIDENT_LABEL: Record<ProctorIncidentType, string> = {
  MULTIPLE_PERSONS: 'More than one person in view',
  LOOKING_AWAY: 'Looking away from the screen',
  DEVICE_DETECTED: 'Phone visible',
  FACE_NOT_VISIBLE: 'Face not visible',
  CAMERA_INTERRUPTED: 'Camera interrupted',
  DETECTION_UNAVAILABLE: 'Camera check unavailable',
  CAMERA_OBSERVATION: 'Camera observation',
  BROWSER_ACTIVITY: 'Browser activity',
  SESSION: 'Session',
};

/** The incident category of a stored proctoring event type (camera or browser). */
export function proctorIncidentTypeOf(eventType: string): ProctorIncidentType {
  switch (eventType) {
    case 'CAMERA_MULTIPLE_FACES':
    case 'MULTIPLE_FACES':
      return 'MULTIPLE_PERSONS';
    case 'CAMERA_GAZE_AWAY':
      return 'LOOKING_AWAY';
    case 'CAMERA_DEVICE_DETECTED':
      return 'DEVICE_DETECTED';
    case 'CAMERA_FACE_MISSING':
    case 'NO_FACE':
      return 'FACE_NOT_VISIBLE';
    case 'CAMERA_STOPPED':
    case 'CAMERA_OFF':
      return 'CAMERA_INTERRUPTED';
    case 'CAMERA_DETECTION_UNAVAILABLE':
      return 'DETECTION_UNAVAILABLE';
    case 'CAMERA_HEAD_MOVEMENT':
      return 'CAMERA_OBSERVATION';
    case 'SESSION_RESUMED':
      return 'SESSION';
    default:
      return 'BROWSER_ACTIVITY';
  }
}

/** What the server did with one reported event (the shared protection outcomes). */
export type ProctorIncidentOutcome = ProtectionOutcome;

/** HR's review of one incident. Reviewing never changes the score or the warning count (an audit trail only). */
export const proctorReviewStatusSchema = z.enum(['CONFIRMED', 'DISMISSED', 'NEEDS_REVIEW']);
export type ProctorReviewStatus = z.infer<typeof proctorReviewStatusSchema>;

export const PROCTOR_REVIEW_LABEL: Record<ProctorReviewStatus, string> = {
  CONFIRMED: 'Confirmed',
  DISMISSED: 'Dismissed',
  NEEDS_REVIEW: 'Requires further review',
};

/** PUT /dsa-hr/applications/:applicationId/proctoring/:roundId/incidents/:incidentId/review */
export const proctorIncidentReviewRequestSchema = z
  .object({
    status: proctorReviewStatusSchema,
    reason: z.string().trim().min(5, 'Write why (at least 5 characters).').max(500),
  })
  .strict();
export type ProctorIncidentReviewRequest = z.input<typeof proctorIncidentReviewRequestSchema>;

export interface ProctorIncidentReview {
  status: ProctorReviewStatus;
  reason: string;
  by: string | null;
  at: string;
}

// ---------------------------------------------------------------- candidate messages

/** The candidate's warning text. `max` = warnings allowed before termination (2 by default). */
export function proctorWarningMessage(warningNumber: number, max: number): string {
  if (warningNumber >= max) {
    return `Warning ${warningNumber} of ${max}: Another potential assessment integrity incident has been detected. One more confirmed incident will automatically terminate this assessment.`;
  }
  return `Warning ${warningNumber} of ${max}: Potential suspicious activity has been detected during your assessment. Please remain alone in the assessment area and keep your attention on the assessment screen. Further confirmed incidents may result in assessment termination.`;
}

export const PROCTOR_TERMINATION_MESSAGE =
  'Your assessment has been terminated because the maximum number of permitted warnings was exceeded. Your assessment activity and incident history have been recorded for review.';

/** The reason shown with a warning (what was detected), worded as an observation. */
export const PROCTOR_REASON_TEXT: Record<string, string> = {
  CAMERA_MULTIPLE_FACES: 'More than one person was visible in your camera.',
  MULTIPLE_FACES: 'More than one person was visible in your camera.',
  CAMERA_GAZE_AWAY: 'You appeared to look away from the screen continuously for more than 2 minutes.',
  CAMERA_DEVICE_DETECTED: 'A phone was visible in your camera.',
  CAMERA_FACE_MISSING: 'Your face was not visible to the camera for a sustained time.',
  FULLSCREEN_EXIT: 'You left full-screen mode.',
  TAB_SWITCH: 'You switched away from the assessment tab.',
  WINDOW_BLUR: 'The assessment window lost focus.',
  COPY: 'A copy action was attempted.',
  CUT: 'A cut action was attempted.',
  PASTE: 'A paste action was attempted.',
  SELECT_ALL: 'Select-all was used outside the code editor.',
  CONTEXT_MENU: 'The right-click menu was opened.',
  DEVTOOLS_SHORTCUT: 'A developer-tools shortcut was used.',
  VIEW_SOURCE: 'A view-source shortcut was used.',
  SAVE_SHORTCUT: 'A save shortcut was used.',
  PRINT_SHORTCUT: 'A print shortcut was used.',
  SCREENSHOT_ATTEMPT: 'A screenshot key was pressed.',
};

/** The warning the candidate must see (the latest one the server issued). */
export interface ProctorCandidateWarning {
  warningNumber: number;
  maxWarnings: number;
  /** The last allowed warning: the next confirmed incident terminates the assessment. */
  final: boolean;
  message: string;
  reason: string;
}
