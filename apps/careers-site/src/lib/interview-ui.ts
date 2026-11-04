import { InterviewApiError } from './interview-api';

/** Screen states of the AI technical interview page. */
export type Phase =
  | { name: 'loading' }
  | { name: 'fatal'; title: string; message: string }
  | { name: 'welcome' }
  | { name: 'setup' }
  | { name: 'speaking' }
  | { name: 'listening' }
  | { name: 'processing' }
  | { name: 'error'; message: string; retry: RetryKind }
  | { name: 'paused'; reason: PauseReason }
  | { name: 'done'; incomplete: boolean }
  /** Ended by the server: more warnings than allowed. Nothing more can be sent; the answers so far are kept. */
  | { name: 'terminated' };

/** resend = send the same recording again (same id, saved once); record = answer again; reload = start over. */
export type RetryKind = 'resend' | 'record' | 'reload';

/** Why the interview is on hold. `returning` = the page was reopened / refreshed during the interview. */
export type PauseReason = 'CAMERA_LOST' | 'MIC_LOST' | 'CONNECTION_LOST' | 'returning';

export const MIN_ANSWER_MS = 1200;
export const MAX_ANSWER_MS = 4 * 60_000;

export const PHASE_LABEL: Partial<Record<Phase['name'], string>> = {
  speaking: 'The interviewer is speaking',
  listening: 'Listening - answer out loud',
  processing: 'Saving your answer and preparing the next question',
  error: 'Something went wrong',
};

export const PAUSE_TEXT: Record<PauseReason, { title: string; message: string }> = {
  CAMERA_LOST: { title: 'Your camera turned off', message: 'The interview is paused and the clock is stopped. Turn your camera back on to continue.' },
  MIC_LOST: { title: 'Your microphone stopped working', message: 'The interview is paused and the clock is stopped. Reconnect your microphone to continue.' },
  CONNECTION_LOST: { title: 'Connection lost', message: 'Your answers so far are saved. The interview continues when your internet is back.' },
  returning: { title: 'Welcome back', message: 'Your answers so far are saved. Turn on your camera and microphone to continue where you left off.' },
};

/** What to tell the candidate for an error, and what the retry button should do. Never shows raw server details. */
export function describeError(err: unknown): { fatal: boolean; title: string; message: string; retry: RetryKind } {
  if (err instanceof InterviewApiError) {
    if (err.code === 'INTERVIEW_LINK_INVALID' || err.status === 404) {
      return { fatal: true, title: 'This link does not work', message: err.message, retry: 'reload' };
    }
    if (err.code === 'INTERVIEW_LINK_EXPIRED' || err.status === 410) {
      return { fatal: true, title: 'This link has expired', message: err.message, retry: 'reload' };
    }
    if (err.code === 'INTERVIEW_TERMINATED') {
      return { fatal: true, title: 'Interview Terminated', message: err.message, retry: 'reload' };
    }
    if (err.code === 'INTERVIEW_ENDED') {
      return { fatal: true, title: 'Interview already completed', message: 'Your answers were already saved. Thank you!', retry: 'reload' };
    }
    if (err.code === 'FEATURE_DISABLED') {
      return { fatal: true, title: 'Interview not available', message: 'The AI interview is switched off right now. Please contact the HR team.', retry: 'reload' };
    }
    if (['AUDIO_UNREADABLE', 'AUDIO_EMPTY', 'AUDIO_FORMAT', 'AUDIO_TOO_LARGE'].includes(err.code)) {
      return { fatal: false, title: '', message: err.message, retry: 'record' };
    }
    if (err.retryable || err.status === 0 || err.code === 'RATE_LIMITED') return { fatal: false, title: '', message: err.message, retry: 'resend' };
    return { fatal: false, title: '', message: err.message, retry: 'reload' };
  }
  return { fatal: false, title: '', message: 'Something went wrong. Please try again.', retry: 'reload' };
}

export type DeviceProblem = 'insecure' | 'unsupported' | 'denied' | 'not_found' | 'in_use' | 'unknown';

/** Camera and microphone are asked for together (one permission prompt). */
export const DEVICE_MESSAGES: Record<DeviceProblem, string> = {
  insecure: 'The camera and microphone only work on a secure (https) page. Please open the link from your email exactly as it is.',
  unsupported: 'This browser cannot use a camera and microphone for the interview. Please use a recent Chrome or Edge (Firefox and Safari also work).',
  denied: 'Camera or microphone access is blocked. Allow both for this site (the camera icon in the address bar, or your browser settings), then try again.',
  not_found: 'No camera or no microphone was found. Connect a webcam and a microphone (or a headset), or use a laptop or phone that has both.',
  in_use: 'Your camera or microphone is being used by another app (for example a video call). Close that app, then try again.',
  unknown: 'The camera or microphone could not be started. Please try again, or try another browser.',
};

export function deviceProblemOf(err: unknown): DeviceProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'unknown';
}

/** "18:05" for a number of seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- end of an answer (voice activity)

/** Loudness (0..1) above which the microphone hears speech. Below it: silence or background noise. */
export const SPEECH_LEVEL = 0.1;
/** The candidate must have spoken this long before a silence can end the answer (a pause to think never does). */
export const MIN_SPEECH_MS = 2500;
/** Silence this long after speaking ends the answer. A countdown is shown from SILENCE_HINT_MS on. */
export const SILENCE_END_MS = 4500;
export const SILENCE_HINT_MS = 2000;

export type TurnState = { kind: 'waiting' } | { kind: 'speaking' } | { kind: 'pause'; silentMs: number } | { kind: 'end' };

/**
 * Decides when the candidate finished answering from microphone loudness samples. Pure (no browser APIs) so it is
 * tested. The candidate can always press "Done answering" instead; any sound during the countdown cancels it.
 */
export class EndOfAnswer {
  private spokenMs = 0;
  private silentSince: number | null = null;
  private last: number | null = null;

  sample(level: number, at: number): TurnState {
    const dt = this.last === null ? 0 : Math.min(500, at - this.last);
    this.last = at;
    if (level >= SPEECH_LEVEL) {
      this.spokenMs += dt;
      this.silentSince = null;
      return { kind: 'speaking' };
    }
    if (this.spokenMs < MIN_SPEECH_MS) return { kind: 'waiting' };
    this.silentSince ??= at;
    const silentMs = at - this.silentSince;
    return silentMs >= SILENCE_END_MS ? { kind: 'end' } : { kind: 'pause', silentMs };
  }
}

/** Countdown seconds to show ("finishing in 2..."), or null while none should be shown. */
export function finishingIn(state: TurnState): number | null {
  if (state.kind !== 'pause' || state.silentMs < SILENCE_HINT_MS) return null;
  return Math.max(1, Math.ceil((SILENCE_END_MS - state.silentMs) / 1000));
}
