import {
  AI_INTERVIEW_PROTECTION_LIMITS,
  AI_INTERVIEW_VIOLATION_LABEL,
  DEFAULT_AI_INTERVIEW_PROTECTION,
  aiInterviewProtectionSettingsSchema,
  countProtectionIncident,
  type AiInterviewProtectionSettings,
  type ProtectionCount,
  type ProtectionOutcome,
  type AiInterviewProtectionState,
  type AiInterviewViolationType,
} from '@hireflow/contracts';

/**
 * Pure rules of the interview protection (no I/O). The store runs `classifyViolation` while it holds the interview's
 * row lock, so the warning counter is decided on the latest data and changed by exactly one writer at a time.
 *
 * One counter for everything: a tab switch, a fullscreen exit and (when HR chose WARN) a lost device all add to the
 * same `warningCount`. Going over `maxWarnings` terminates the interview. Things that are not misconduct - a camera
 * driver dropping, the network, a reload - never count unless HR explicitly chose WARN for devices.
 */

export type StoredOutcome = ProtectionOutcome;

/** An incident already stored for this interview (only what the rules need). */
export interface PriorIncident {
  type: AiInterviewViolationType;
  outcome: StoredOutcome;
  warningNumber: number | null;
  occurredAt: Date;
  resolvedAt: Date | null;
  acknowledgedAt: Date | null;
}

/** Shared with the online assessments: the one counter lives in @hireflow/contracts (countProtectionIncident). */
export type ViolationDecision = ProtectionCount;

const DEVICE_TYPES: ReadonlySet<AiInterviewViolationType> = new Set(['CAMERA_LOST', 'MIC_LOST']);
export const isDeviceIncident = (type: AiInterviewViolationType) => DEVICE_TYPES.has(type);

/**
 * A stored snapshot read back. null = the interview was opened before protection existed (or it was switched off):
 * nothing is monitored, because the candidate was never told about warnings. A damaged snapshot falls back to the
 * defaults (the candidate was told about a policy; the defaults are the fairest reading of it).
 */
export function parseProtection(raw: unknown): AiInterviewProtectionSettings | null {
  if (raw === null || raw === undefined) return null;
  const parsed = aiInterviewProtectionSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { ...DEFAULT_AI_INTERVIEW_PROTECTION };
}

/** Whether this type of incident may give a warning under these settings. */
export function qualifies(type: AiInterviewViolationType, s: AiInterviewProtectionSettings): boolean {
  switch (type) {
    case 'TAB_SWITCH':
    case 'WINDOW_BLUR':
      return s.tabSwitchMonitoring;
    case 'FULLSCREEN_EXIT':
      return s.fullscreenRequired;
    case 'CAMERA_LOST':
      return s.cameraPolicy === 'WARN';
    case 'MIC_LOST':
      return s.microphonePolicy === 'WARN';
    case 'MULTIPLE_FACES':
      return s.multipleFacesPolicy === 'WARN';
  }
}

/**
 * What a NEW incident (its incidentId was never seen) does to the counter:
 *  1. a device that is still lost from an earlier report is the same incident (one continuous failure = one entry);
 *  2. a type that does not qualify is recorded for HR only;
 *  3. a qualifying incident within `groupWindowSeconds` of the last counted one is grouped into it (one Alt+Tab out
 *     of fullscreen fires both "fullscreen exit" and "hidden"); the window is measured from the counted incident and
 *     never extended, so rapid repeated switching keeps being counted;
 *  4. otherwise it is counted: warning N, or termination when N > maxWarnings.
 */
export function classifyViolation(input: {
  type: AiInterviewViolationType;
  settings: AiInterviewProtectionSettings;
  warningCount: number;
  prior: PriorIncident[];
  now: Date;
  groupWindowSeconds?: number;
}): ViolationDecision {
  const { type, settings, prior } = input;
  return countProtectionIncident({
    qualifies: qualifies(type, settings),
    // a device still lost from an earlier report: the same continuous failure
    continues: isDeviceIncident(type) ? (latest(prior.filter((p) => p.type === type && !p.resolvedAt)) ?? null) : null,
    warningCount: input.warningCount,
    maxWarnings: settings.maxWarnings,
    prior,
    now: input.now,
    groupWindowSeconds: input.groupWindowSeconds ?? AI_INTERVIEW_PROTECTION_LIMITS.groupWindowSeconds,
  });
}

/** Which incident types the interview accepts in each state (a paused interview only hears about its devices). */
export function accepts(status: string, type: AiInterviewViolationType, s: AiInterviewProtectionSettings): boolean {
  // faces are not counted at all when HR switched it off (the page does not run the detector then either)
  if (type === 'MULTIPLE_FACES' && s.multipleFacesPolicy === 'OFF') return false;
  if (status === 'IN_PROGRESS') return true;
  // while paused for a device / connection problem the candidate may need browser or system settings: only device
  // incidents count then (the clock is stopped and the question is asked again on resume)
  return status === 'PAUSED' && isDeviceIncident(type);
}

/** The protection part of the candidate's page data. */
export function protectionState(settings: AiInterviewProtectionSettings | null, warningCount: number, prior: PriorIncident[]): AiInterviewProtectionState {
  const s = settings ?? DEFAULT_AI_INTERVIEW_PROTECTION;
  const lastWarning = latest(prior.filter((p) => p.outcome === 'WARNING' && p.warningNumber === warningCount));
  return {
    enabled: settings !== null,
    maxWarnings: settings ? s.maxWarnings : 0,
    warningCount,
    tabSwitchMonitoring: !!settings && s.tabSwitchMonitoring,
    fullscreenRequired: !!settings && s.fullscreenRequired,
    cameraPolicy: s.cameraPolicy,
    microphonePolicy: s.microphonePolicy,
    multipleFacesPolicy: settings ? s.multipleFacesPolicy : 'OFF',
    pendingWarning:
      settings && lastWarning && !lastWarning.acknowledgedAt
        ? { warningNumber: lastWarning.warningNumber!, type: lastWarning.type, final: lastWarning.warningNumber === s.maxWarnings }
        : null,
  };
}

/** Short, safe text stored as the termination reason (shown to HR). */
export function terminationReason(type: AiInterviewViolationType, maxWarnings: number): string {
  return `${ordinal(maxWarnings + 1)} qualifying incident (${AI_INTERVIEW_VIOLATION_LABEL[type].toLowerCase()}) after ${maxWarnings} warning${maxWarnings === 1 ? '' : 's'}`;
}

export const TERMINATED_TEXT = 'This interview was ended because the maximum number of warnings was exceeded.';

function latest(list: PriorIncident[]): PriorIncident | undefined {
  return list.reduce<PriorIncident | undefined>((a, b) => (!a || b.occurredAt.getTime() >= a.occurredAt.getTime() ? b : a), undefined);
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}
