import {
  ASSESSMENT_INCIDENT_LABEL,
  assessmentProtectionSettingsSchema,
  type AssessmentIncidentType,
  type AssessmentProtectionSettings,
  type AssessmentProtectionState,
  type ProtectionOutcome,
} from '@hireflow/contracts';

/**
 * Pure rules of the online assessment protection (no I/O). The counting itself is the one shared with the AI
 * interview (`countProtectionIncident`, contracts); this file says what an assessment monitors and what the page shows.
 *
 *   1st incident -> Warning 1, 2nd -> Final warning, 3rd -> the test ends with the saved answers and the result waits
 *   for HR (INTEGRITY_VIOLATION_REVIEW): no automatic rejection.
 */

const flag = (v: string | undefined, fallback: boolean) => (v === undefined || v.trim() === '' ? fallback : !['off', 'false', '0', 'no'].includes(v.trim().toLowerCase()));

/**
 * Server-wide rules (env), copied onto each attempt when it starts. null = protection off (ASSESSMENT_PROTECTION=off).
 * Faces are only counted when the webcam is required (no camera = nothing to count).
 */
export function assessmentProtectionFromEnv(env: NodeJS.ProcessEnv = process.env, cameraRequired = true): AssessmentProtectionSettings | null {
  if (!flag(env.ASSESSMENT_PROTECTION, true)) return null;
  const max = Number(env.ASSESSMENT_MAX_WARNINGS);
  const face = (env.ASSESSMENT_FACE_POLICY ?? '').trim().toUpperCase();
  return {
    maxWarnings: Number.isInteger(max) && max >= 1 && max <= 5 ? max : 2,
    tabSwitchMonitoring: flag(env.ASSESSMENT_TAB_MONITORING, true),
    fullscreenRequired: flag(env.ASSESSMENT_FULLSCREEN_REQUIRED, true),
    multipleFacesPolicy: !cameraRequired ? 'OFF' : face === 'RECORD' || face === 'OFF' ? face : 'WARN',
  };
}

/** A stored snapshot read back; null = this attempt is not monitored. A damaged one falls back to the strictest safe reading. */
export function parseAssessmentProtection(raw: unknown): AssessmentProtectionSettings | null {
  if (raw === null || raw === undefined) return null;
  const parsed = assessmentProtectionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { maxWarnings: 2, tabSwitchMonitoring: true, fullscreenRequired: true, multipleFacesPolicy: 'RECORD' };
}

export function qualifiesInAssessment(type: AssessmentIncidentType, s: AssessmentProtectionSettings): boolean {
  switch (type) {
    case 'TAB_SWITCH':
    case 'WINDOW_BLUR':
      return s.tabSwitchMonitoring;
    case 'FULLSCREEN_EXIT':
      return s.fullscreenRequired;
    case 'MULTIPLE_FACES':
      return s.multipleFacesPolicy === 'WARN';
  }
}

/** Incidents count only while the test runs (and faces only when they are checked at all). */
export function acceptedInAssessment(status: string, type: AssessmentIncidentType, s: AssessmentProtectionSettings): boolean {
  if (type === 'MULTIPLE_FACES' && s.multipleFacesPolicy === 'OFF') return false;
  return status === 'IN_PROGRESS';
}

export function assessmentTerminationReason(type: AssessmentIncidentType, maxWarnings: number): string {
  const n = maxWarnings + 1;
  const ordinal = `${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  return `${ordinal} qualifying incident (${ASSESSMENT_INCIDENT_LABEL[type].toLowerCase()}) after ${maxWarnings} warning${maxWarnings === 1 ? '' : 's'}`;
}

/** The protection part of the candidate's page. */
export function assessmentProtectionState(
  settings: AssessmentProtectionSettings | null,
  warningCount: number,
  incidents: { type: AssessmentIncidentType; outcome: ProtectionOutcome; warningNumber: number | null; acknowledgedAt: Date | null }[],
): AssessmentProtectionState {
  const last = incidents.filter((i) => i.outcome === 'WARNING' && i.warningNumber === warningCount).at(-1);
  return {
    enabled: settings !== null,
    maxWarnings: settings?.maxWarnings ?? 0,
    warningCount,
    tabSwitchMonitoring: !!settings?.tabSwitchMonitoring,
    fullscreenRequired: !!settings?.fullscreenRequired,
    multipleFacesPolicy: settings?.multipleFacesPolicy ?? 'OFF',
    pendingWarning: settings && last && !last.acknowledgedAt ? { warningNumber: last.warningNumber!, type: last.type, final: last.warningNumber === settings.maxWarnings } : null,
  };
}
