import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../../common/prisma.service';
import { uuidv7 } from '../../../common/uuidv7';
import { applicationsError } from '../applications.errors';
import { hashOtp, sameHash, signPhoneProof, verifyPhoneProof, type PhoneProof } from './otp-token';
import { MAILER, type Mailer } from '../email/mailer';
import { buildOtpEmail } from './otp-email';
import { OTP_SENDER, type OtpSender } from './otp-sender';

export const OTP_RULES = {
  ttlMs: 10 * 60_000,
  resendAfterMs: 30_000,
  maxPerHour: 5,
  maxAttempts: 5,
  /** How long a verified phone stays valid for submitting applications. */
  proofTtlMs: 30 * 60_000,
} as const;

export const OTP_SECRET = Symbol('OTP_SECRET');

const DEV_SECRET = 'dev-only-otp-secret-change-me';

export function otpSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.OTP_SIGNING_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (env.NODE_ENV === 'production') throw new Error('OTP_SIGNING_SECRET (32+ chars) is required in production');
  return DEV_SECRET;
}

/**
 * The verification code is sent to the student's EMAIL whenever email is configured (Gmail / SMTP): the apply form
 * sends the email typed in the form, the "my data" page uses the email saved with the student's application.
 * The code and the signed proof are bound to that email, so a code for one email cannot unlock another.
 * Without any email setup it falls back to the dev sender (code shown on screen, never in production).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('OtpService');

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
    @Inject(OTP_SECRET) private readonly secret: string,
    @Optional() @Inject(MAILER) private readonly mailer?: Mailer,
  ) {}

  /** Where the code goes: the given email, else the email saved for this phone. undefined = email is switched off. */
  private async emailFor(tenantId: string, phone: string, email?: string): Promise<string | undefined> {
    if (!this.mailer?.enabled) return undefined;
    const to =
      email ?? (await this.db.candidate.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { email: true } }))?.email;
    if (!to) throw applicationsError(HttpStatus.NOT_FOUND, 'NO_APPLICATION', 'We could not find an application with this number.');
    return to.trim().toLowerCase();
  }

  async send(tenantId: string, phone: string, email?: string): Promise<{ expiresInSeconds: number; devCode?: string; sentTo?: 'email' }> {
    const to = await this.emailFor(tenantId, phone, email);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challengeId = uuidv7();
    // Check the limits and save the challenge under a per-phone lock, so parallel "send" clicks cannot all pass
    // the 30 s / 5-per-hour check before any of them is saved. The lock ends with the transaction.
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':' || ${phone}::text))`;
      const now = Date.now();
      const recent = await tx.phoneOtpChallenge.findMany({
        where: { tenantId, phone, createdAt: { gt: new Date(now - 60 * 60_000) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (recent[0] && now - recent[0].createdAt.getTime() < OTP_RULES.resendAfterMs) {
        throw applicationsError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_TOO_SOON', 'Please wait 30 seconds before asking for a new code.');
      }
      if (recent.length >= OTP_RULES.maxPerHour) {
        throw applicationsError(HttpStatus.TOO_MANY_REQUESTS, 'OTP_LIMIT', 'Too many codes requested. Please try again in an hour.');
      }
      await tx.phoneOtpChallenge.create({
        data: {
          id: challengeId,
          tenantId,
          phone,
          codeHash: hashOtp(this.secret, tenantId, phone, bound(code, to)),
          expiresAt: new Date(now + OTP_RULES.ttlMs),
          createdAt: new Date(now),
        },
      });
    });
    // after commit: the lock is never held while the code goes out
    if (to && this.mailer) {
      try {
        await this.mailer.send(to, buildOtpEmail(code, OTP_RULES.ttlMs / 60_000));
      } catch (err) {
        // A code that never arrived must not block "send again" for 30 s.
        await this.db.phoneOtpChallenge.delete({ where: { id: challengeId } }).catch(() => undefined);
        this.logger.warn(`OTP email not sent tenant=${tenantId} (${err instanceof Error ? err.message : 'unknown'})`);
        throw applicationsError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'OTP_EMAIL_FAILED',
          'We could not send the code to your email. Please check the email address and try again.',
        );
      }
      return { expiresInSeconds: OTP_RULES.ttlMs / 1000, sentTo: 'email' };
    }
    await this.sender.send(phone, code);
    return {
      expiresInSeconds: OTP_RULES.ttlMs / 1000,
      ...(this.sender.kind === 'dev' ? { devCode: code } : {}),
    };
  }

  /** Checks the code against the latest challenge; on success returns a short-lived signed proof. */
  async verify(tenantId: string, phone: string, code: string, email?: string): Promise<{ otpToken: string; expiresInSeconds: number }> {
    const to = await this.emailFor(tenantId, phone, email);
    const challenge = await this.db.phoneOtpChallenge.findFirst({
      where: { tenantId, phone, verifiedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const invalid = () => applicationsError(HttpStatus.BAD_REQUEST, 'OTP_INVALID', 'That code is wrong or has expired. Ask for a new code.');
    if (!challenge || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= OTP_RULES.maxAttempts) throw invalid();

    // Count the attempt BEFORE comparing, so parallel guesses cannot bypass the limit.
    const { count } = await this.db.phoneOtpChallenge.updateMany({
      where: { id: challenge.id, attempts: { lt: OTP_RULES.maxAttempts }, verifiedAt: null },
      data: { attempts: { increment: 1 } },
    });
    if (count !== 1 || !sameHash(challenge.codeHash, hashOtp(this.secret, tenantId, phone, bound(code, to)))) throw invalid();

    await this.db.phoneOtpChallenge.update({ where: { id: challenge.id }, data: { verifiedAt: new Date() } });
    const exp = Math.floor((Date.now() + OTP_RULES.proofTtlMs) / 1000);
    return { otpToken: signPhoneProof(this.secret, { tenantId, phone, exp, ...(to ? { email: to } : {}) }), expiresInSeconds: OTP_RULES.proofTtlMs / 1000 };
  }

  /**
   * The verified proof inside a request, if it is valid for this company and phone. When the code went by email,
   * `email` (if given) must be that same email, e.g. the email in the application form.
   */
  checkProof(token: string, tenantId: string, phone: string, email?: string): PhoneProof | undefined {
    const proof = verifyPhoneProof(this.secret, token);
    if (!proof || proof.tenantId !== tenantId || proof.phone !== phone) return undefined;
    if (proof.email && email !== undefined && proof.email !== email.trim().toLowerCase()) return undefined;
    return proof;
  }
}

/** A code sent by email only works together with that email. */
const bound = (code: string, email: string | undefined) => (email ? `${email}:${code}` : code);
