/**
 * The ONE warning counter shared by every protected round (AI technical interview, online assessments). Pure: the
 * modules call it while they hold the attempt's / interview's row lock, so it always decides on the latest data.
 *
 *   1st qualifying incident -> warning 1, ..., warning maxWarnings (the final one), next one -> terminate.
 *
 * Grouping: a qualifying incident within `groupWindowSeconds` (server time) of the last COUNTED one is the same act
 * (Alt+Tab out of fullscreen fires both). The window is measured from the counted incident and never extended, so
 * rapid repeated switching keeps being counted.
 */

export type ProtectionOutcome = 'WARNING' | 'TERMINATED' | 'RECORDED' | 'GROUPED';

export interface ProtectionPriorIncident {
  outcome: ProtectionOutcome;
  warningNumber: number | null;
  occurredAt: Date;
}

export interface ProtectionCount {
  outcome: ProtectionOutcome;
  /** The warning this incident is, or the counted one it belongs to; null = not a warning. */
  warningNumber: number | null;
  /** The counter after this incident. */
  warningCount: number;
  terminate: boolean;
}

export const PROTECTION_GROUP_WINDOW_SECONDS = 3;

export function countProtectionIncident(input: {
  /** May this incident give a warning (its monitoring is on and set to warn)? */
  qualifies: boolean;
  /** An unfinished incident it continues (e.g. a device still lost): grouped into it, never counted again. */
  continues?: { warningNumber: number | null } | null;
  warningCount: number;
  maxWarnings: number;
  prior: ProtectionPriorIncident[];
  now: Date;
  groupWindowSeconds?: number;
}): ProtectionCount {
  const { warningCount, now } = input;
  const keep = (outcome: ProtectionOutcome, warningNumber: number | null): ProtectionCount => ({ outcome, warningNumber, warningCount, terminate: false });
  if (input.continues) return keep('GROUPED', input.continues.warningNumber);
  if (!input.qualifies) return keep('RECORDED', null);

  const windowMs = (input.groupWindowSeconds ?? PROTECTION_GROUP_WINDOW_SECONDS) * 1000;
  const lastCounted = input.prior
    .filter((p) => p.outcome === 'WARNING' || p.outcome === 'TERMINATED')
    .reduce<ProtectionPriorIncident | undefined>((a, b) => (!a || b.occurredAt.getTime() >= a.occurredAt.getTime() ? b : a), undefined);
  if (lastCounted && now.getTime() - lastCounted.occurredAt.getTime() < windowMs) return keep('GROUPED', lastCounted.warningNumber);

  const next = warningCount + 1;
  if (next > input.maxWarnings) return { outcome: 'TERMINATED', warningNumber: next, warningCount: next, terminate: true };
  return { outcome: 'WARNING', warningNumber: next, warningCount: next, terminate: false };
}
