import { describe, expect, it } from 'vitest';
import { InterviewApiError } from '../src/lib/interview-api';
import {
  EndOfAnswer,
  MIN_SPEECH_MS,
  SILENCE_END_MS,
  SILENCE_HINT_MS,
  describeError,
  deviceProblemOf,
  finishingIn,
  formatClock,
} from '../src/lib/interview-ui';
import { liveTranscriptSupported, startLiveTranscript } from '../src/lib/live-transcript';

/** Feeds loudness samples every 100 ms; returns the last state. */
function run(detector: EndOfAnswer, from: number, ms: number, level: number) {
  let state = detector.sample(level, from);
  for (let t = from + 100; t <= from + ms; t += 100) state = detector.sample(level, t);
  return state;
}

describe('end of an answer (voice activity)', () => {
  it('never ends while the candidate has not really spoken yet (thinking before answering)', () => {
    const d = new EndOfAnswer();
    expect(run(d, 0, 20_000, 0.01).kind).toBe('waiting');
  });

  it('ends after a long silence that follows real speech, with a countdown first', () => {
    const d = new EndOfAnswer();
    run(d, 0, MIN_SPEECH_MS + 500, 0.4);
    const t0 = MIN_SPEECH_MS + 600;
    const hint = run(d, t0, SILENCE_HINT_MS + 200, 0.02);
    expect(hint.kind).toBe('pause');
    expect(finishingIn(hint)).toBeGreaterThanOrEqual(1);
    expect(run(d, t0 + SILENCE_HINT_MS + 300, SILENCE_END_MS, 0.02).kind).toBe('end');
  });

  it('a short pause to think does not end the answer, and speaking again resets the countdown', () => {
    const d = new EndOfAnswer();
    run(d, 0, MIN_SPEECH_MS + 500, 0.4);
    const t0 = MIN_SPEECH_MS + 600;
    expect(finishingIn(run(d, t0, 1000, 0.02))).toBeNull(); // no countdown yet
    expect(run(d, t0 + 1100, 500, 0.5).kind).toBe('speaking');
    expect(run(d, t0 + 1700, SILENCE_END_MS - 600, 0.02).kind).toBe('pause');
  });
});

describe('errors and devices', () => {
  it('maps link problems to a final screen, AI hiccups to "send again"', () => {
    expect(describeError(new InterviewApiError(404, 'INTERVIEW_LINK_INVALID', 'bad', false))).toMatchObject({ fatal: true, title: 'This link does not work' });
    expect(describeError(new InterviewApiError(410, 'INTERVIEW_LINK_EXPIRED', 'old', false))).toMatchObject({ fatal: true, title: 'This link has expired' });
    expect(describeError(new InterviewApiError(429, 'AI_UNAVAILABLE', 'busy', true))).toMatchObject({ fatal: false, retry: 'resend' });
    expect(describeError(new InterviewApiError(0, 'NETWORK_ERROR', 'offline', true))).toMatchObject({ retry: 'resend' });
    expect(describeError(new InterviewApiError(422, 'AUDIO_UNREADABLE', 'again', true))).toMatchObject({ retry: 'record' });
    expect(describeError(new Error('x'))).toMatchObject({ fatal: false, retry: 'reload' });
  });

  it('maps camera / microphone errors to a clear message', () => {
    expect(deviceProblemOf({ name: 'NotAllowedError' })).toBe('denied');
    expect(deviceProblemOf({ name: 'NotFoundError' })).toBe('not_found');
    expect(deviceProblemOf({ name: 'NotReadableError' })).toBe('in_use');
    expect(deviceProblemOf(new Error('x'))).toBe('unknown');
  });

  it('formats the clock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(1199)).toBe('19:59');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('live transcript', () => {
  it('is simply absent where the browser has no speech recognition (the interview still works)', () => {
    expect(liveTranscriptSupported()).toBe(false); // node: no window
    expect(startLiveTranscript(() => undefined)).toBeNull();
  });
});
