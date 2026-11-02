/**
 * Delivers an OTP to a phone. Implementations must NEVER log the code.
 *
 * Only the dev sender exists today. A real SMS provider (MSG91 / Exotel / Plivo...) needs DLT
 * registration of the sender id and template in India.
 * VERIFY (owner): pick the provider, finish DLT registration, then add an SmsOtpSender here.
 */
export interface OtpSender {
  readonly kind: 'dev' | 'sms';
  send(phone: string, code: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * LOCAL DEMO ONLY: sends nothing. The API returns the code in the response as `devCode`
 * so the apply form can show it. Refused when NODE_ENV=production.
 */
export class DevOtpSender implements OtpSender {
  readonly kind = 'dev' as const;
  async send(): Promise<void> {}
}

export function otpSenderFromEnv(env: NodeJS.ProcessEnv = process.env): OtpSender {
  const provider = env.OTP_PROVIDER || 'dev';
  if (provider === 'dev') {
    if (env.NODE_ENV === 'production') throw new Error('OTP_PROVIDER=dev is not allowed in production');
    return new DevOtpSender();
  }
  throw new Error(`OTP_PROVIDER "${provider}" is not implemented yet (only "dev")`);
}
