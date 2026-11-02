import { ScreeningApiError } from './screening-api';
import type { MicProblem } from './recorder';

/** Screen states of the AI screening page. */
export type Phase =
  | { name: 'loading' }
  | { name: 'fatal'; title: string; message: string }
  | { name: 'welcome' }
  | { name: 'paused'; ended: boolean }
  | { name: 'mic'; problem: MicProblem }
  | { name: 'speaking' }
  | { name: 'listening' }
  | { name: 'processing' }
  | { name: 'error'; message: string; retry: RetryKind }
  | { name: 'done' };

/** resend = send the same recording again (same id, saved once); record = answer again; reload = start over. */
export type RetryKind = 'resend' | 'record' | 'reload';

export const MIN_ANSWER_MS = 800;
export const MAX_ANSWER_MS = 3 * 60_000;

export const PHASE_LABEL: Partial<Record<Phase['name'], string>> = {
  speaking: 'The interviewer is speaking…',
  listening: 'Listening - answer now',
  processing: 'Thinking about your answer…',
  error: 'Something went wrong',
};

/** What to tell the candidate for an error, and what the retry button should do. Never shows raw server details. */
export function describeError(err: unknown): { fatal: boolean; title: string; message: string; retry: RetryKind } {
  if (err instanceof ScreeningApiError) {
    if (err.code === 'SCREENING_LINK_INVALID' || err.status === 404) {
      return { fatal: true, title: 'This link does not work', message: err.message, retry: 'reload' };
    }
    if (err.code === 'SCREENING_LINK_EXPIRED' || err.status === 410) {
      return { fatal: true, title: 'This link has expired', message: err.message, retry: 'reload' };
    }
    if (err.code === 'SCREENING_COMPLETED') {
      return { fatal: true, title: 'Screening already completed', message: 'Your answers were already saved. Thank you!', retry: 'reload' };
    }
    if (err.code === 'AUDIO_UNREADABLE' || err.code === 'AUDIO_EMPTY' || err.code === 'AUDIO_FORMAT' || err.code === 'AUDIO_TOO_LARGE') {
      return { fatal: false, title: '', message: err.message, retry: 'record' };
    }
    if (err.code === 'FEATURE_DISABLED') {
      return { fatal: true, title: 'Screening is not available', message: 'The screening round is switched off right now. Please contact the HR team.', retry: 'reload' };
    }
    if (err.retryable || err.status === 0) return { fatal: false, title: '', message: err.message, retry: 'resend' };
    if (err.code === 'RATE_LIMITED') return { fatal: false, title: '', message: err.message, retry: 'resend' };
    return { fatal: false, title: '', message: err.message, retry: 'reload' };
  }
  return { fatal: false, title: '', message: 'Something went wrong. Please try again.', retry: 'reload' };
}
