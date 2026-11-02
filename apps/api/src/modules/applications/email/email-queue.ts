import { Logger } from '@nestjs/common';
import type { EmailMessage } from './confirmation-email';
import { MailError, type Mailer } from './mailer';

export interface EmailJob {
  to: string;
  message: EmailMessage;
  /** For logs only (never the address or the message). */
  ref: string;
  /** Groups jobs so they can be cancelled together (e.g. all emails of a candidate who deleted their data). */
  key?: string;
  /** Runs once the email is accepted by the mail server, e.g. to set confirmation_email_sent_at. */
  onSent?: () => Promise<unknown>;
}

export interface EmailQueueOptions {
  /** Emails sent at the same time. Gmail refuses many parallel connections from one account. */
  concurrency?: number;
  /** Wait before each retry of a temporary failure (ms). Its length = number of retries. */
  retryDelaysMs?: number[];
}

/** Temporary problems worth retrying; a refused address or bad login will not fix itself. */
const RETRYABLE = /^(ECONNECTION|ESOCKET|ETIMEDOUT|EDNS)\b/;

/** How long a cancelled key keeps blocking new emails: covers an intake that committed just before the cancel. */
const CANCELLED_KEY_TTL_MS = 10 * 60_000;

/** Network trouble, or an SMTP 4xx reply ("try again later": greylisting, 421 busy, 451/452 temporary errors). */
function isTemporary(err: unknown, reason: string): boolean {
  const reply = err instanceof MailError ? err.responseCode : undefined;
  return RETRYABLE.test(reason) || (reply !== undefined && reply >= 400 && reply < 500);
}

interface Item {
  job: EmailJob;
  attempt: number;
  cancelled?: boolean;
}

/**
 * Sends emails in the background, a few at a time, so a burst of applications never waits for the mail server.
 * In memory: emails still queued when the API stops are not sent (their confirmation_email_sent_at stays empty).
 * TODO(M24): move to the notifications service / outbox once it exists.
 */
export class EmailQueue {
  private readonly logger = new Logger('EmailQueue');
  private readonly waiting: Item[] = [];
  private readonly sending = new Set<Item>();
  /** Failed items waiting for their retry timer. */
  private readonly retrying = new Map<Item, NodeJS.Timeout>();
  /** Recently cancelled keys -> when they stop blocking. An email enqueued late for such a key is dropped. */
  private readonly cancelledKeys = new Map<string, number>();
  private readonly concurrency: number;
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly mailer: Mailer,
    options: EmailQueueOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 30_000, 120_000];
  }

  get enabled(): boolean {
    return this.mailer.enabled;
  }

  /** Emails waiting or being sent right now. */
  get pending(): number {
    return this.waiting.length + this.sending.size;
  }

  /** Returns at once; the email goes out in the background. No-op when email is switched off. */
  enqueue(job: EmailJob): void {
    if (!this.mailer.enabled) return;
    if (job.key && this.recentlyCancelled(job.key)) {
      this.logger.warn(`email ${job.ref} dropped (its key was cancelled)`);
      return;
    }
    this.waiting.push({ job, attempt: 0 });
    this.next();
  }

  /**
   * Drops every not-yet-sent email with this key (waiting, or waiting for a retry) and stops retries of one being
   * sent right now. Emails enqueued with this key in the next 10 minutes are dropped too (an intake that committed
   * just before a DPDP erase). An email the mail server already accepted cannot be called back. Returns how many were dropped.
   */
  cancel(key: string): number {
    this.cancelledKeys.set(key, Date.now() + CANCELLED_KEY_TTL_MS);
    let dropped = 0;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      if (this.waiting[i]!.job.key === key) {
        this.waiting.splice(i, 1);
        dropped++;
      }
    }
    for (const [item, timer] of this.retrying) {
      if (item.job.key !== key) continue;
      clearTimeout(timer);
      this.retrying.delete(item);
      dropped++;
    }
    for (const item of this.sending) if (item.job.key === key) item.cancelled = true;
    return dropped;
  }

  private recentlyCancelled(key: string): boolean {
    const now = Date.now();
    for (const [k, until] of this.cancelledKeys) if (until <= now) this.cancelledKeys.delete(k);
    return this.cancelledKeys.has(key);
  }

  private next(): void {
    while (this.sending.size < this.concurrency && this.waiting.length) {
      const item = this.waiting.shift()!;
      this.sending.add(item);
      void this.send(item).finally(() => {
        this.sending.delete(item);
        this.next();
      });
    }
  }

  private async send(item: Item): Promise<void> {
    const { job, attempt } = item;
    try {
      await this.mailer.send(job.to, job.message);
    } catch (err) {
      const reason = err instanceof MailError ? err.reason : 'unknown';
      const delay = this.retryDelaysMs[attempt];
      if (reason.startsWith('EAUTH')) {
        // Wrong SMTP login: no email can go out until the owner fixes the configuration.
        this.logger.error(`email ${job.ref} not sent - SMTP CONFIGURATION PROBLEM (${reason})`);
      }
      if (item.cancelled) {
        this.logger.warn(`email ${job.ref} not sent and cancelled (${reason})`);
      } else if (delay !== undefined && isTemporary(err, reason)) {
        this.logger.warn(`email ${job.ref} failed, retry ${attempt + 1} in ${delay / 1000}s (${reason})`);
        const retry: Item = { job, attempt: attempt + 1 };
        const timer = setTimeout(() => {
          this.retrying.delete(retry);
          this.waiting.push(retry);
          this.next();
        }, delay);
        timer.unref();
        this.retrying.set(retry, timer);
      } else if (!reason.startsWith('EAUTH')) {
        this.logger.warn(`email ${job.ref} not sent (${reason})`);
      }
      return;
    }
    try {
      await job.onSent?.();
    } catch {
      this.logger.warn(`email ${job.ref} sent, but recording it failed`);
    }
  }
}
