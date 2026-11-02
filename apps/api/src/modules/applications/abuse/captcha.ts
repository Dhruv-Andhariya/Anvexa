import { HttpStatus } from '@nestjs/common';
import { applicationsError } from '../applications.errors';

export interface TurnstileOptions {
  /** Env TURNSTILE_SECRET_KEY. When empty, CAPTCHA is OFF (local dev / demo). Never logged. */
  secretKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const CAPTCHA = Symbol('CAPTCHA');

/**
 * Cloudflare Turnstile check on "send OTP" (the step that costs money once SMS is real).
 * The apply step needs a verified phone, so it is protected through the OTP step.
 *
 * VERIFY (owner) against https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ :
 *  - POST https://challenges.cloudflare.com/turnstile/v0/siteverify, form fields secret / response / remoteip
 *  - JSON reply { success: boolean, ... }
 */
export class TurnstileVerifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TurnstileOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get enabled(): boolean {
    return !!this.options.secretKey;
  }

  /** Throws 400 CAPTCHA_FAILED when the token is missing or invalid; 503 when Cloudflare cannot be reached (fail closed). */
  async check(token: string | undefined, ip: string | undefined): Promise<void> {
    if (!this.enabled) return;
    const failed = () => applicationsError(HttpStatus.BAD_REQUEST, 'CAPTCHA_FAILED', 'Please complete the "I am human" check and try again.');
    if (!token) throw failed();

    const body = new URLSearchParams({ secret: this.options.secretKey!, response: token });
    if (ip) body.set('remoteip', ip);
    let ok: boolean;
    try {
      const res = await this.fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      const json = (await res.json().catch(() => undefined)) as { success?: unknown } | undefined;
      ok = res.ok && json?.success === true;
    } catch {
      throw applicationsError(HttpStatus.SERVICE_UNAVAILABLE, 'CAPTCHA_UNAVAILABLE', 'We could not check the "I am human" step. Please try again.');
    }
    if (!ok) throw failed();
  }
}

export const turnstileFromEnv = () => new TurnstileVerifier({ secretKey: process.env.TURNSTILE_SECRET_KEY || undefined });
