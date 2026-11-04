import type { AiInterviewViolationType } from '@hireflow/contracts';

/**
 * Turns the browser's raw signals into INCIDENTS for the interview protection. Pure (no DOM access): the page feeds it
 * `visibilitychange` / `blur` / `focus` / `fullscreenchange` / `pagehide` signals and a clock, so it is unit-tested.
 *
 * One act of leaving fires several events (Alt+Tab out of fullscreen: blur, fullscreenchange, visibilitychange
 * hidden; coming back: visible, focus). They become ONE incident; coming back never makes a new one. The incident id
 * is made here, so the server counts the incident once even when it is sent twice. The SERVER decides whether an
 * incident is a warning; this class never counts warnings.
 *
 * What browsers can tell a page: that it was hidden (other tab, minimised, screen locked) or lost focus (another
 * window / app). Never what was opened or looked at.
 */

export type ProtectionSignal = 'hidden' | 'visible' | 'blur' | 'focus' | 'fullscreen-exit' | 'fullscreen-enter' | 'unloading' | 'restored';

export interface Incident {
  id: string;
  type: Extract<AiInterviewViolationType, 'TAB_SWITCH' | 'WINDOW_BLUR' | 'FULLSCREEN_EXIT' | 'MULTIPLE_FACES'>;
  /** Short, non-personal: which browser event started it. */
  detail: string;
}

export interface MonitorOptions {
  tabSwitch: boolean;
  fullscreen: boolean;
  /**
   * Focus lost while the page stays visible counts only after this long: clicking the browser's address bar, an
   * extension pop-up or a permission bubble also takes focus for a moment.
   */
  blurGraceMs?: number;
  /** Signals of different kinds this close together are one act (e.g. fullscreen exit + hidden). */
  groupMs?: number;
  newId: () => string;
}

export const BLUR_GRACE_MS = 2000;
export const GROUP_MS = 1500;

export class ProtectionMonitor {
  private active = false;
  private hidden = false;
  private unloading = false;
  private blurredSince: number | null = null;
  /** The away incident (hidden / blurred) that is still going on. */
  private away: { id: string; at: number } | null = null;
  private outOfFullscreen = false;
  private lastIncidentAt = -Infinity;

  constructor(private readonly opts: MonitorOptions) {}

  /** Monitoring runs only while the interview runs (not on the setup / pause / end screens). */
  setActive(active: boolean, now: number, state: { hidden: boolean; focused: boolean; fullscreen: boolean }) {
    if (active === this.active) return;
    this.active = active;
    // start from what is true now: being out of fullscreen at the start is not an incident (the page asks for it)
    this.hidden = state.hidden;
    this.blurredSince = !state.focused && !state.hidden ? now : null;
    this.away = null;
    this.outOfFullscreen = !state.fullscreen;
    if (!active) this.blurredSince = null;
  }

  /** True while the candidate is away from the page (a warning is shown when they are back). */
  get isAway(): boolean {
    return this.hidden || this.away !== null;
  }

  get isOutOfFullscreen(): boolean {
    return this.outOfFullscreen;
  }

  signal(s: ProtectionSignal, now: number): Incident | null {
    // a reload / close hides the page too: that is not leaving the interview (the server pauses it instead)
    if (s === 'unloading') {
      this.unloading = true;
      return null;
    }
    if (s === 'restored') {
      this.unloading = false;
      return null;
    }
    if (!this.active || this.unloading) {
      if (s === 'hidden') this.hidden = true;
      if (s === 'visible') this.hidden = false;
      return null;
    }
    switch (s) {
      case 'hidden':
        this.hidden = true;
        this.blurredSince = null;
        return this.openAway(now, 'TAB_SWITCH', 'visibilitychange');
      case 'blur':
        if (!this.hidden && !this.away) this.blurredSince ??= now;
        return null;
      case 'visible':
        this.hidden = false;
        this.away = null;
        return null;
      case 'focus':
        this.blurredSince = null;
        if (!this.hidden) this.away = null;
        return null;
      case 'fullscreen-enter':
        this.outOfFullscreen = false;
        return null;
      case 'fullscreen-exit': {
        if (this.outOfFullscreen) return null; // already out: the same incident
        this.outOfFullscreen = true;
        if (!this.opts.fullscreen) return null;
        // left fullscreen as part of switching away (Alt+Tab, Cmd+Tab): one act, already reported
        if (this.away || this.hidden || now - this.lastIncidentAt < this.groupMs) return null;
        return this.emit(now, 'FULLSCREEN_EXIT', 'fullscreenchange');
      }
      default:
        return null;
    }
  }

  /** Called by the page's timer: focus lost for longer than the grace becomes an incident. */
  tick(now: number): Incident | null {
    if (!this.active || this.unloading || this.blurredSince === null || this.hidden || this.away) return null;
    if (now - this.blurredSince < (this.opts.blurGraceMs ?? BLUR_GRACE_MS)) return null;
    return this.openAway(now, 'WINDOW_BLUR', 'blur');
  }

  private get groupMs() {
    return this.opts.groupMs ?? GROUP_MS;
  }

  private openAway(now: number, type: 'TAB_SWITCH' | 'WINDOW_BLUR', detail: string): Incident | null {
    if (this.away) return null; // still the same time away
    if (!this.opts.tabSwitch) {
      this.away = { id: '', at: now };
      return null;
    }
    // fullscreen was left a moment ago as part of the same act: one incident
    if (now - this.lastIncidentAt < this.groupMs) {
      this.away = { id: '', at: now };
      return null;
    }
    const incident = this.emit(now, type, detail);
    this.away = { id: incident.id, at: now };
    return incident;
  }

  private emit(now: number, type: Incident['type'], detail: string): Incident {
    this.lastIncidentAt = now;
    return { id: this.opts.newId(), type, detail };
  }
}

// ---------------------------------------------------------------- multiple faces

/** Two or more faces must be seen this long before it is an incident (a person walking past is not). */
export const FACES_MIN_MS = 5000;
/** One episode ends after this long with one face or none; a later crowd is a new incident. */
export const FACES_END_MS = 3000;
/** One frame where the detector misses the second face (samples are ~1 s apart) does not restart the 5 s. */
export const FACES_GAP_MS = 2500;

/**
 * Turns face COUNTS (from the on-device detector, about one per second) into incidents: one per continuous episode of
 * 2+ faces lasting FACES_MIN_MS. Pure, so it is unit-tested. Only the number of faces is ever used - no image, no
 * identity, no expression.
 */
export class FaceEpisodeTracker {
  private multiSince: number | null = null;
  private lastMultiAt = -Infinity;
  private fewSince: number | null = null;
  private episode = false;

  constructor(private readonly newId: () => string) {}

  reset() {
    this.multiSince = null;
    this.lastMultiAt = -Infinity;
    this.fewSince = null;
    this.episode = false;
  }

  /** `faces` = null when the frame could not be read (camera warming up): no evidence either way. */
  sample(faces: number | null, at: number): Incident | null {
    if (faces === null) return null;
    if (faces >= 2) {
      this.fewSince = null;
      // start counting, or start again after a real gap (a single missed frame keeps the count going)
      if (this.multiSince === null || at - this.lastMultiAt > FACES_GAP_MS) this.multiSince = at;
      this.lastMultiAt = at;
      if (!this.episode && at - this.multiSince >= FACES_MIN_MS) {
        this.episode = true;
        return { id: this.newId(), type: 'MULTIPLE_FACES', detail: `${Math.min(faces, 9)} faces` };
      }
      return null;
    }
    if (this.multiSince !== null && at - this.lastMultiAt > FACES_GAP_MS) this.multiSince = null;
    if (this.episode) {
      this.fewSince ??= at;
      if (at - this.fewSince >= FACES_END_MS) {
        this.episode = false;
        this.fewSince = null;
      }
    }
    return null;
  }
}

/** A random incident id (the server keeps one entry per id per interview). */
export function newIncidentId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `inc_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Fullscreen in this browser (iPhone Safari has none for pages: then it is not monitored). */
export function fullscreenSupported(doc: Pick<Document, 'fullscreenEnabled'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  return !!doc?.fullscreenEnabled;
}

/** The same wording for the AI interview and the online assessments ("interview" / "assessment"). */
export type ProtectedThing = 'interview' | 'assessment';
const cap = (w: string) => w[0]!.toUpperCase() + w.slice(1);

export const warningTexts = (thing: ProtectedThing) =>
  ({
    first: (n: number, max: number) => ({
      title: `Warning ${n} of ${max}`,
      message: `We detected that you left the active ${thing} screen or triggered another monitored activity. Please remain on the ${thing} screen and follow the ${thing} instructions. Further violations may result in ${thing} termination.`,
    }),
    final: (max: number) => ({
      title: `Final Warning — ${max} of ${max}`,
      message: `This is your final warning. Any further qualifying violation will automatically terminate your ${thing}.`,
    }),
    terminated: {
      title: `${cap(thing)} Terminated`,
      message: `Your ${thing} has been terminated because the maximum permitted number of warnings was exceeded. Your ${thing} activity has been recorded.`,
    },
  }) as const;

export const WARNING_TEXT = warningTexts('interview');

export function warningText(warningNumber: number, maxWarnings: number, final: boolean, thing: ProtectedThing = 'interview') {
  const t = warningTexts(thing);
  return final ? t.final(maxWarnings) : t.first(warningNumber, maxWarnings);
}

/** "Left the interview tab" etc. for the warning dialog. */
export const INCIDENT_LABEL: Record<AiInterviewViolationType, string> = {
  TAB_SWITCH: 'You left the interview tab or minimised the browser.',
  WINDOW_BLUR: 'You switched to another window or app.',
  FULLSCREEN_EXIT: 'You left fullscreen.',
  CAMERA_LOST: 'Your camera stopped.',
  MIC_LOST: 'Your microphone stopped.',
  MULTIPLE_FACES: 'More than one person was visible in your camera.',
};
/** The assessment page's own wording for "left the tab". */
export const ASSESSMENT_INCIDENT_TEXT: Record<'TAB_SWITCH' | 'WINDOW_BLUR' | 'FULLSCREEN_EXIT' | 'MULTIPLE_FACES', string> = {
  TAB_SWITCH: 'You left the test tab or minimised the browser.',
  WINDOW_BLUR: 'You switched to another window or app.',
  FULLSCREEN_EXIT: 'You left full screen.',
  MULTIPLE_FACES: 'More than one person was visible in your camera.',
};
