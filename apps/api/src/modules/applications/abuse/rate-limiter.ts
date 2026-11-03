import { HttpStatus, Inject, Injectable, mixin, type CanActivate, type ExecutionContext, type Type } from '@nestjs/common';
import { applicationsError } from '../applications.errors';

export interface Limit {
  max: number;
  windowMs: number;
}

/**
 * Per-IP limits for the public endpoints (doc M08 spam protection), per hour.
 * Generous on purpose: a whole college on one Wi-Fi (or one mobile carrier NAT) shares a single IP, and every
 * student must still get through. The per-phone OTP limits (otp.service) and CAPTCHA stop abuse of one number.
 * Override per environment: PUBLIC_RATE_LIMITS="otp-send=1000,application=1000" (requests per IP per hour).
 */
export const PUBLIC_LIMITS = {
  'otp-send': { max: 300, windowMs: 60 * 60_000 },
  'otp-verify': { max: 900, windowMs: 60 * 60_000 },
  application: { max: 300, windowMs: 60 * 60_000 },
  'my-data': { max: 60, windowMs: 60 * 60_000 },
  // M12 AI screening round (screening module): page loads, spoken questions, start/end; and the uploaded answers.
  // One full screening is ~40 calls and ~12 answers; a college lab on one IP must still get through.
  screening: { max: 3000, windowMs: 60 * 60_000 },
  'screening-answer': { max: 600, windowMs: 60 * 60_000 },
  // M13 online test rounds (round-engine module): page loads, autosaves (one per answer change) and proctoring
  // events. A 100-question test is a few hundred calls; a whole college lab on one IP must still get through.
  assessment: { max: 20000, windowMs: 60 * 60_000 },
  // M18 group discussion (group-discussion module): lobby / join / state polls / events, and the audio chunks (one
  // per student every 5 s). A whole college lab on one IP must still get through.
  gd: { max: 30000, windowMs: 60 * 60_000 },
  'gd-audio': { max: 40000, windowMs: 60 * 60_000 },
} satisfies Record<string, Limit>;

export type LimitName = keyof typeof PUBLIC_LIMITS;

/** PUBLIC_LIMITS with PUBLIC_RATE_LIMITS overrides ("name=max,name=max"). Unknown names or bad numbers fail startup. */
export function publicLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<LimitName, Limit> {
  const limits: Record<LimitName, Limit> = { ...PUBLIC_LIMITS };
  for (const part of (env.PUBLIC_RATE_LIMITS ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, value] = part.split('=').map((s) => s.trim());
    const max = Number(value);
    if (!name || !(name in PUBLIC_LIMITS) || !Number.isInteger(max) || max < 1) {
      throw new Error(`PUBLIC_RATE_LIMITS: bad entry "${part}" (use e.g. otp-send=1000,application=1000)`);
    }
    limits[name as LimitName] = { ...PUBLIC_LIMITS[name as LimitName], max };
  }
  return limits;
}

/**
 * In-memory sliding-window limiter, keyed by "<limit>:<ip>".
 * Good for one API instance. TODO(scale): move to Redis (REDIS_URL) when the API runs on several instances.
 * req.ip is the student's IP only when TRUST_PROXY matches the proxies in front of the API (see main.ts).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limits: Record<string, Limit> = PUBLIC_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws 429 when this IP used up the limit. */
  check(name: LimitName, ip: string | undefined): void {
    const limit = this.limits[name]!;
    const t = this.now();
    this.sweep(t);
    const key = `${name}:${ip || 'unknown'}`;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > t - limit.windowMs);
    if (recent.length >= limit.max) {
      this.hits.set(key, recent);
      throw applicationsError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests from your network. Please try again later.');
    }
    recent.push(t);
    this.hits.set(key, recent);
  }

  /** Drops old keys now and then so memory stays small. */
  private sweep(t: number) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    const longest = Math.max(...Object.values(this.limits).map((l) => l.windowMs));
    for (const [key, times] of this.hits) {
      if (!times.some((at) => at > t - longest)) this.hits.delete(key);
    }
  }
}

/**
 * The same per-IP check as a guard: guards run BEFORE interceptors, so an over-limit upload is refused before
 * FileInterceptor reads (and buffers) the multipart body. req.ip is what @Ip() returns.
 *
 *   @UseGuards(rateLimit('application'))   // do not also call limiter.check() in the handler (counted twice)
 */
export function rateLimit(name: LimitName): Type<CanActivate> {
  @Injectable()
  class RateLimitGuard implements CanActivate {
    constructor(@Inject(RateLimiter) private readonly limiter: RateLimiter) {}
    canActivate(ctx: ExecutionContext): boolean {
      this.limiter.check(name, ctx.switchToHttp().getRequest<{ ip?: string }>().ip);
      return true;
    }
  }
  return mixin(RateLimitGuard);
}
