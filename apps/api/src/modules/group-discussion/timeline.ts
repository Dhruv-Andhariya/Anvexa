import { GD_CLOSE_SECONDS, type GdPhase, type GdSettings } from '@hireflow/contracts';

/**
 * The moderator's timeline as pure functions (no I/O, no clock of its own). The API's live loop calls step() about
 * once a second; HR speaking during the discussion calls pause() / resume(). Every client and the bot only follow.
 *
 *   INTRO -> THINKING -> DISCUSSION -> SUMMARY (summarySeconds x students) -> HR_QUESTIONS (optional) -> CLOSE -> ENDED
 */

export interface Timeline {
  phase: GdPhase;
  phaseStartedAt: Date | null;
  phaseEndsAt: Date | null;
  pausedAt: Date | null;
  /** Summary round: index into the speaking order. */
  summaryIndex: number;
}

export interface PlannedPhase {
  phase: GdPhase;
  seconds: number;
}

/** The phases of one group, in order. A summary round with no students and a switched-off HR phase are left out. */
export function planOf(settings: GdSettings, students: number): PlannedPhase[] {
  const plan: PlannedPhase[] = [
    { phase: 'INTRO', seconds: settings.introSeconds },
    { phase: 'THINKING', seconds: settings.thinkingSeconds },
    { phase: 'DISCUSSION', seconds: settings.discussionMinutes * 60 },
  ];
  if (students > 0) plan.push({ phase: 'SUMMARY', seconds: settings.summarySeconds * students });
  if (settings.hrQuestionsEnabled) plan.push({ phase: 'HR_QUESTIONS', seconds: settings.hrQuestionsMinutes * 60 });
  plan.push({ phase: 'CLOSE', seconds: GD_CLOSE_SECONDS });
  return plan;
}

export const NOT_STARTED: Timeline = { phase: 'NOT_STARTED', phaseStartedAt: null, phaseEndsAt: null, pausedAt: null, summaryIndex: 0 };

/** The room locked: the introduction starts now. */
export function start(plan: PlannedPhase[], now: Date): Timeline {
  const first = plan[0]!;
  return { phase: first.phase, phaseStartedAt: now, phaseEndsAt: new Date(now.getTime() + first.seconds * 1000), pausedAt: null, summaryIndex: 0 };
}

/**
 * The timeline at `now`, or null when nothing changed. Moves past every phase whose time is over (each next phase
 * starts exactly when the previous one ended, so a late tick never stretches the GD), and moves the summary round on
 * to the next student. A paused timeline does not move.
 */
export function step(t: Timeline, plan: PlannedPhase[], summarySeconds: number, now: Date): Timeline | null {
  if (t.phase === 'NOT_STARTED' || t.phase === 'ENDED' || t.pausedAt || !t.phaseEndsAt || !t.phaseStartedAt) return null;
  let next: Timeline = t;
  while (next.phase !== 'ENDED' && next.phaseEndsAt && now.getTime() >= next.phaseEndsAt.getTime()) {
    const at = plan.findIndex((p) => p.phase === next.phase);
    const following = plan[at + 1];
    const startedAt = next.phaseEndsAt;
    next = following
      ? { phase: following.phase, phaseStartedAt: startedAt, phaseEndsAt: new Date(startedAt.getTime() + following.seconds * 1000), pausedAt: null, summaryIndex: 0 }
      : { phase: 'ENDED', phaseStartedAt: startedAt, phaseEndsAt: null, pausedAt: null, summaryIndex: 0 };
  }
  if (next.phase === 'SUMMARY' && next.phaseStartedAt) {
    const index = Math.max(0, Math.floor((now.getTime() - next.phaseStartedAt.getTime()) / (summarySeconds * 1000)));
    const students = Math.round((plan.find((p) => p.phase === 'SUMMARY')?.seconds ?? 0) / summarySeconds);
    const capped = Math.min(index, Math.max(0, students - 1));
    if (capped !== next.summaryIndex) next = { ...next, summaryIndex: capped };
  }
  return next === t ? null : next;
}

/** HR started speaking to the group. Only the discussion's timer pauses; other phases run on. */
export function pause(t: Timeline, now: Date): Timeline | null {
  if (t.phase !== 'DISCUSSION' || t.pausedAt) return null;
  return { ...t, pausedAt: now };
}

/** HR stopped speaking: the discussion gets the paused time back. */
export function resume(t: Timeline, now: Date): { timeline: Timeline; pausedMs: number } | null {
  if (!t.pausedAt || !t.phaseEndsAt) return null;
  const pausedMs = Math.max(0, now.getTime() - t.pausedAt.getTime());
  return { timeline: { ...t, pausedAt: null, phaseEndsAt: new Date(t.phaseEndsAt.getTime() + pausedMs) }, pausedMs };
}
