import { HttpStatus } from '@nestjs/common';
import { apiError } from '../../common/api-error';

/**
 * Fixed-window, in-memory limiter for the public auth endpoints (login, invitation accept).
 * Per API process: with several API replicas, move this to Redis.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Throws 429 TOO_MANY_ATTEMPTS once `key` used up its attempts in the current window. */
  consume(key: string, now = Date.now()): void {
    if (this.hits.size > 10_000) this.prune(now);
    const hit = this.hits.get(key);
    if (!hit || hit.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    hit.count += 1;
    if (hit.count > this.limit) {
      throw apiError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a few minutes and try again.');
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number) {
    for (const [key, hit] of this.hits) if (hit.resetAt <= now) this.hits.delete(key);
  }
}
