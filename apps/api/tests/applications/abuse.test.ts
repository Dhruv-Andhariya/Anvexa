import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { featureFlag, isFeatureOn } from '../../src/common/feature-flags';
import { TurnstileVerifier } from '../../src/modules/applications/abuse/captcha';
import { PUBLIC_LIMITS, publicLimitsFromEnv, RateLimiter } from '../../src/modules/applications/abuse/rate-limiter';

const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as HttpException).getStatus();
  }
};

describe('RateLimiter', () => {
  it('allows up to the limit per IP, then 429, and frees up after the window', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ 'otp-send': { max: 2, windowMs: 1000 } }, () => now);
    expect(status(() => limiter.check('otp-send', '1.1.1.1'))).toBe(200);
    expect(status(() => limiter.check('otp-send', '1.1.1.1'))).toBe(200);
    expect(status(() => limiter.check('otp-send', '1.1.1.1'))).toBe(429);
    expect(status(() => limiter.check('otp-send', '2.2.2.2'))).toBe(200); // other IPs unaffected
    now += 1001;
    expect(status(() => limiter.check('otp-send', '1.1.1.1'))).toBe(200);
  });

  it('lets a whole college on one Wi-Fi IP apply with the default limits', () => {
    const limiter = new RateLimiter(publicLimitsFromEnv({}));
    for (let i = 0; i < 300; i++) {
      expect(status(() => limiter.check('otp-send', '10.0.0.1'))).toBe(200);
      expect(status(() => limiter.check('otp-verify', '10.0.0.1'))).toBe(200);
      expect(status(() => limiter.check('application', '10.0.0.1'))).toBe(200);
    }
    expect(status(() => limiter.check('application', '10.0.0.1'))).toBe(429);
  });
});

describe('publicLimitsFromEnv', () => {
  it('uses the defaults, and PUBLIC_RATE_LIMITS overrides only the named limits', () => {
    expect(publicLimitsFromEnv({})).toEqual(PUBLIC_LIMITS);
    const limits = publicLimitsFromEnv({ PUBLIC_RATE_LIMITS: ' otp-send=2000 , application=1500 ' });
    expect(limits['otp-send']).toEqual({ max: 2000, windowMs: 3_600_000 });
    expect(limits.application.max).toBe(1500);
    expect(limits['otp-verify']).toEqual(PUBLIC_LIMITS['otp-verify']);
  });

  it('refuses unknown names and bad numbers instead of silently ignoring them', () => {
    expect(() => publicLimitsFromEnv({ PUBLIC_RATE_LIMITS: 'otp=100' })).toThrow(/bad entry "otp=100"/);
    expect(() => publicLimitsFromEnv({ PUBLIC_RATE_LIMITS: 'application=0' })).toThrow();
    expect(() => publicLimitsFromEnv({ PUBLIC_RATE_LIMITS: 'application=lots' })).toThrow();
  });
});

describe('TurnstileVerifier', () => {
  const ok = (success: boolean) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success }), { status: 200 }));

  it('is off without a secret key (local dev)', async () => {
    const v = new TurnstileVerifier({});
    expect(v.enabled).toBe(false);
    await expect(v.check(undefined, '1.1.1.1')).resolves.toBeUndefined();
  });

  it('sends secret, token and IP and accepts success', async () => {
    const fetch = ok(true);
    await new TurnstileVerifier({ secretKey: 'sec', fetch }).check('tok', '1.1.1.1');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(String(init!.body)).toBe('secret=sec&response=tok&remoteip=1.1.1.1');
  });

  it('rejects missing or invalid tokens with 400, and fails closed with 503 when unreachable', async () => {
    const v = new TurnstileVerifier({ secretKey: 'sec', fetch: ok(false) });
    expect((await v.check(undefined, 'ip').catch((e) => e)).getStatus()).toBe(400);
    expect((await v.check('bad', 'ip').catch((e) => e)).getStatus()).toBe(400);
    const down = new TurnstileVerifier({ secretKey: 'sec', fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('x')) });
    expect((await down.check('tok', 'ip').catch((e) => e)).getStatus()).toBe(503);
  });
});

describe('feature flags', () => {
  it('are on by default and off with FEATURE_<NAME>=off', () => {
    expect(isFeatureOn('publisher', {})).toBe(true);
    expect(isFeatureOn('publisher', { FEATURE_PUBLISHER: 'off' })).toBe(false);
    expect(isFeatureOn('publisher', { FEATURE_PUBLISHER: 'on' })).toBe(true);
  });

  it('the guard answers 404 FEATURE_DISABLED when off', () => {
    const Guard = featureFlag('demo_flag');
    process.env.FEATURE_DEMO_FLAG = 'off';
    try {
      expect(status(() => new Guard().canActivate({} as never))).toBe(404);
    } finally {
      delete process.env.FEATURE_DEMO_FLAG;
    }
    expect(new Guard().canActivate({} as never)).toBe(true);
  });
});
