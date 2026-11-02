import { describe, expect, it } from 'vitest';
import { MIC_MESSAGES, micProblemOf, pickMimeType } from '../src/lib/recorder';
import { ScreeningApiError, extensionFor, newClientTurnId } from '../src/lib/screening-api';
import { describeError } from '../src/lib/screening-ui';

describe('recording format', () => {
  it('prefers WebM-Opus, falls back to MP4 (older Safari / iOS), or reports no support', () => {
    expect(pickMimeType(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t.startsWith('audio/mp4'))).toBe('audio/mp4');
    expect(pickMimeType(() => false)).toBeNull();
    expect(
      pickMimeType(() => {
        throw new Error('unknown');
      }),
    ).toBeNull();
  });

  it('names the upload so the server knows the container', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('audio/ogg;codecs=opus')).toBe('ogg');
  });
});

describe('microphone problems', () => {
  it('maps browser errors to a clear message', () => {
    expect(micProblemOf({ name: 'NotAllowedError' })).toBe('DENIED');
    expect(micProblemOf({ name: 'NotFoundError' })).toBe('NOT_FOUND');
    expect(micProblemOf({ name: 'NotReadableError' })).toBe('BUSY');
    expect(micProblemOf(new Error('x'))).toBe('UNKNOWN');
    expect(MIC_MESSAGES.DENIED).toContain('Allow the microphone');
  });
});

describe('errors shown to the candidate', () => {
  const err = (status: number, code: string, retryable = false) => new ScreeningApiError(status, code, 'msg', retryable);

  it('expired and invalid links end the page with a clear title', () => {
    expect(describeError(err(410, 'SCREENING_LINK_EXPIRED'))).toMatchObject({ fatal: true, title: 'This link has expired' });
    expect(describeError(err(404, 'SCREENING_LINK_INVALID'))).toMatchObject({ fatal: true, title: 'This link does not work' });
  });

  it('AI or network trouble re-sends the SAME recording (saved once)', () => {
    expect(describeError(err(503, 'AI_UNAVAILABLE', true))).toMatchObject({ fatal: false, retry: 'resend' });
    expect(describeError(err(0, 'NETWORK_ERROR', true))).toMatchObject({ fatal: false, retry: 'resend' });
  });

  it('an unusable recording asks for a new answer', () => {
    expect(describeError(err(422, 'AUDIO_UNREADABLE'))).toMatchObject({ fatal: false, retry: 'record' });
    expect(describeError(err(400, 'AUDIO_EMPTY'))).toMatchObject({ retry: 'record' });
  });

  it('unknown errors never show raw details', () => {
    expect(describeError(new TypeError('stack trace here')).message).toBe('Something went wrong. Please try again.');
  });
});

describe('answer ids', () => {
  it('are random and URL-safe (the server accepts 8-64 [A-Za-z0-9_-])', () => {
    const a = newClientTurnId();
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(newClientTurnId()).not.toBe(a);
  });
});
