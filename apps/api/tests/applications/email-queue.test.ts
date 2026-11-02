import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EmailQueue } from '../../src/modules/applications/email/email-queue';
import { DisabledMailer, MailError, type Mailer } from '../../src/modules/applications/email/mailer';

const message = { subject: 's', text: 't', html: '<p>t</p>' };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A mail server we control: every send waits until the test releases it (or fails it). */
function fakeMailer() {
  const calls: { to: string; done: () => void; fail: (reason: string, responseCode?: number) => void }[] = [];
  const mailer: Mailer = {
    enabled: true,
    send: (to) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ to, done: resolve, fail: (reason, responseCode) => reject(new MailError(reason, responseCode)) });
      }),
  };
  return { mailer, calls };
}

describe('EmailQueue', () => {
  it('returns at once and never sends more than `concurrency` emails at the same time', async () => {
    const { mailer, calls } = fakeMailer();
    const queue = new EmailQueue(mailer, { concurrency: 2 });
    for (let i = 0; i < 5; i++) queue.enqueue({ to: `s${i}@x.in`, message, ref: `a${i}` });

    await tick();
    expect(calls.map((c) => c.to)).toEqual(['s0@x.in', 's1@x.in']);
    expect(queue.pending).toBe(5);

    calls[0]!.done();
    await tick();
    expect(calls).toHaveLength(3);

    for (const c of calls.slice(1)) c.done();
    await tick();
    for (const c of calls.slice(3)) c.done();
    await tick();
    expect(calls.map((c) => c.to)).toEqual(['s0@x.in', 's1@x.in', 's2@x.in', 's3@x.in', 's4@x.in']);
    expect(queue.pending).toBe(0);
  });

  it('records the email only after the mail server accepted it', async () => {
    const { mailer, calls } = fakeMailer();
    const onSent = vi.fn().mockResolvedValue(undefined);
    new EmailQueue(mailer).enqueue({ to: 'a@x.in', message, ref: 'a', onSent });
    await tick();
    expect(onSent).not.toHaveBeenCalled();
    calls[0]!.done();
    await tick();
    expect(onSent).toHaveBeenCalledOnce();
  });

  it('retries a temporary failure (timeout), but not a refused address', async () => {
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      const onSent = vi.fn().mockResolvedValue(undefined);
      const queue = new EmailQueue(mailer, { retryDelaysMs: [1000] });
      queue.enqueue({ to: 'slow@x.in', message, ref: 'a', onSent });
      queue.enqueue({ to: 'bad@x.in', message, ref: 'b', onSent });
      await vi.advanceTimersByTimeAsync(0);

      calls[0]!.fail('ETIMEDOUT: could not reach the mail server');
      calls[1]!.fail('EENVELOPE: the recipient address was refused');
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.map((c) => c.to)).toEqual(['slow@x.in', 'bad@x.in', 'slow@x.in']); // only the timeout is retried

      calls[2]!.done();
      await vi.advanceTimersByTimeAsync(0);
      expect(onSent).toHaveBeenCalledOnce();
      expect(queue.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the last retry', async () => {
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      const queue = new EmailQueue(mailer, { retryDelaysMs: [10, 10] });
      queue.enqueue({ to: 'a@x.in', message, ref: 'a' });
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(10);
        calls[i]!.fail('ECONNECTION: could not reach the mail server');
      }
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(3); // 1 try + 2 retries
      expect(queue.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries temporary SMTP replies (4xx), not permanent ones (5xx)', async () => {
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      const queue = new EmailQueue(mailer, { retryDelaysMs: [1000], concurrency: 4 });
      for (const to of ['greylisted@x.in', 'busy@x.in', 'full@x.in', 'unknown@x.in']) queue.enqueue({ to, message, ref: to });
      await vi.advanceTimersByTimeAsync(0);

      calls[0]!.fail('EENVELOPE: the recipient address was refused (SMTP 450)', 450);
      calls[1]!.fail('EPROTOCOL (SMTP 421)', 421);
      calls[2]!.fail('EMESSAGE: the mail server refused the message (SMTP 452)', 452);
      calls[3]!.fail('EENVELOPE: the recipient address was refused (SMTP 550)', 550);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.slice(4).map((c) => c.to)).toEqual(['greylisted@x.in', 'busy@x.in', 'full@x.in']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a wrong SMTP login as an error (configuration problem), and does not retry it', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      new EmailQueue(mailer, { retryDelaysMs: [10] }).enqueue({ to: 'a@x.in', message, ref: 'tenant=t application=a' });
      await vi.advanceTimersByTimeAsync(0);
      calls[0]!.fail('EAUTH: SMTP login failed (SMTP 535)', 535);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toHaveLength(1);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/tenant=t application=a.*SMTP CONFIGURATION PROBLEM.*EAUTH/));
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });

  it("cancels a candidate's queued and retrying emails by key, and never retries one cancelled while sending", async () => {
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      const onSent = vi.fn().mockResolvedValue(undefined);
      const queue = new EmailQueue(mailer, { retryDelaysMs: [1000], concurrency: 2 });
      queue.enqueue({ to: 'sending@x.in', message, ref: 'a', key: 'candidate:t:1', onSent });
      queue.enqueue({ to: 'retrying@x.in', message, ref: 'b', key: 'candidate:t:1' });
      queue.enqueue({ to: 'waiting@x.in', message, ref: 'c', key: 'candidate:t:1' });
      queue.enqueue({ to: 'other@x.in', message, ref: 'd', key: 'candidate:t:2' });
      await vi.advanceTimersByTimeAsync(0);
      calls[1]!.fail('ETIMEDOUT: could not reach the mail server');
      await vi.advanceTimersByTimeAsync(0); // 'retrying' now waits for its timer, 'waiting' is being sent
      expect(calls.map((c) => c.to)).toEqual(['sending@x.in', 'retrying@x.in', 'waiting@x.in']);

      expect(queue.cancel('candidate:t:1')).toBe(1); // the retry; 'sending' and 'waiting' are in flight
      calls[0]!.fail('ETIMEDOUT: could not reach the mail server'); // in flight when cancelled: not retried
      calls[2]!.done(); // too late to call back
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.map((c) => c.to)).toEqual(['sending@x.in', 'retrying@x.in', 'waiting@x.in', 'other@x.in']);

      queue.enqueue({ to: 'later@x.in', message, ref: 'e', key: 'candidate:t:3' });
      queue.enqueue({ to: 'later2@x.in', message, ref: 'f', key: 'candidate:t:3' });
      expect(queue.cancel('candidate:t:3')).toBe(1); // one already started (concurrency 2, 'other' still open)
      expect(queue.cancel('nobody')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an email enqueued just after its key was cancelled, until the block expires', async () => {
    vi.useFakeTimers();
    try {
      const { mailer, calls } = fakeMailer();
      const queue = new EmailQueue(mailer);
      queue.cancel('candidate:t:1'); // DPDP erase ran before the intake queued its email
      queue.enqueue({ to: 'late@x.in', message, ref: 'a', key: 'candidate:t:1' });
      queue.enqueue({ to: 'other@x.in', message, ref: 'b', key: 'candidate:t:2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.to)).toEqual(['other@x.in']);

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      queue.enqueue({ to: 'new@x.in', message, ref: 'c', key: 'candidate:t:1' }); // a new application later
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((c) => c.to)).toEqual(['other@x.in', 'new@x.in']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when email is switched off', () => {
    const queue = new EmailQueue(new DisabledMailer());
    queue.enqueue({ to: 'a@x.in', message, ref: 'a' });
    expect(queue.enabled).toBe(false);
    expect(queue.pending).toBe(0);
  });
});
