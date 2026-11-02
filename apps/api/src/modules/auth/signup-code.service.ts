import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { verifySignupCodeRequestSchema, type LoginCodeRequired, type SignupRequest } from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import type { Mailer } from '../applications/email/mailer'; // leaf file; the module index would be an import cycle
import { codeHash, codeMaxAttempts, codeValidMinutes, emailCodeSwitch, maskEmail, newCode, sameHash, wrongCodeMessage } from './email-code';
import { buildSignupCodeEmail } from './login-code-email';
import { hashPassword } from './password';
import { AUTH_MAILER } from './password-reset.service';
import { RateLimiter } from './rate-limit';
import { hashToken, newToken } from './tokens';

const MINUTES_15 = 15 * 60 * 1000;

/**
 * SIGNUP_VERIFY_EMAIL=email: a new account is created only after the code emailed to its address is entered.
 * SIGNUP_VERIFY_EMAIL=off: created at once. Unset: on in production, off elsewhere (local dev, tests).
 */
export const signupEmailVerificationEnabled = () => emailCodeSwitch('SIGNUP_VERIFY_EMAIL');

export const emailTaken = () => apiError(HttpStatus.CONFLICT, 'EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');

const invalidChallenge = () =>
  apiError(HttpStatus.UNAUTHORIZED, 'SIGNUP_CODE_EXPIRED', 'This code has expired or was already used. Submit the form again to get a new one.');

/** What a verified sign-up creates. */
export interface VerifiedSignup {
  email: string;
  name: string;
  passwordHash: string;
}

/** Sign-up email verification by 6-digit code (same SMTP / Gmail settings as the other auth emails). */
@Injectable()
export class SignupCodeService {
  private readonly logger = new Logger('SignupCode');
  /** Codes per email address: nobody can flood someone's inbox through the sign-up form. */
  private readonly codesPerEmail = new RateLimiter(5, MINUTES_15);
  private readonly verifyPerIp = new RateLimiter(50, MINUTES_15);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_MAILER) private readonly mailer: Mailer,
  ) {}

  /** Valid form: keep the details (password hashed) and email a code. Nothing is created in `users` yet. */
  async start(req: SignupRequest): Promise<LoginCodeRequired> {
    if (await this.prisma.user.findUnique({ where: { email: req.email }, select: { id: true } })) throw emailTaken();
    this.codesPerEmail.consume(req.email);

    const challenge = newToken();
    const code = newCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + codeValidMinutes() * 60_000);
    const passwordHash = await hashPassword(req.password);
    const [, created] = await this.prisma.$transaction([
      this.prisma.signupChallenge.updateMany({ where: { email: req.email, usedAt: null }, data: { usedAt: now } }),
      this.prisma.signupChallenge.create({
        data: {
          email: req.email,
          name: req.name,
          passwordHash,
          tokenHash: hashToken(challenge),
          codeHash: codeHash(challenge, code),
          expiresAt,
        },
        select: { id: true },
      }),
    ]);

    await this.send(req.email, req.name, code, created.id);
    return { codeRequired: true, challenge, emailHint: maskEmail(req.email), expiresAt: expiresAt.toISOString() };
  }

  /** Checks the emailed code; returns the details to create the account with. Each try uses one attempt. */
  async verify(input: unknown, ip: string): Promise<VerifiedSignup> {
    this.verifyPerIp.consume(ip);
    const { challenge, code } = parseBody(verifySignupCodeRequestSchema, input, 'INVALID_SIGNUP_CODE', 'Enter the 6-digit code from the email.');
    const tokenHash = hashToken(challenge);
    const now = new Date();

    // Claim one attempt atomically first, so parallel guesses can never go past the limit.
    const claimed = await this.prisma.signupChallenge.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now }, attempts: { lt: codeMaxAttempts() } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw invalidChallenge();
    const row = await this.prisma.signupChallenge.findUniqueOrThrow({ where: { tokenHash } });

    if (!sameHash(row.codeHash, codeHash(challenge, code))) {
      const left = codeMaxAttempts() - row.attempts;
      throw apiError(HttpStatus.UNAUTHORIZED, left > 0 ? 'SIGNUP_CODE_WRONG' : 'SIGNUP_CODE_EXPIRED', wrongCodeMessage(left));
    }

    // single use: only the first concurrent correct entry wins
    const used = await this.prisma.signupChallenge.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw invalidChallenge();
    return { email: row.email, name: row.name, passwordHash: row.passwordHash };
  }

  private async send(email: string, name: string, code: string, challengeId: string): Promise<void> {
    const production = process.env.NODE_ENV === 'production';
    // Local dev only: test sign-ups often use made-up addresses, so the code is also printed to this console.
    if (!production) this.logger.warn(`dev only - sign-up code for ${maskEmail(email)}: ${code}`);
    try {
      if (!this.mailer.enabled) throw new Error('email is not configured');
      await this.mailer.send(email, buildSignupCodeEmail({ name, code, validMinutes: codeValidMinutes() }));
    } catch (err) {
      this.logger.warn(`sign-up code email not sent (${err instanceof Error ? err.message : 'unknown'})`);
      if (!production) return;
      await this.prisma.signupChallenge.updateMany({ where: { id: challengeId }, data: { usedAt: new Date() } });
      throw apiError(HttpStatus.SERVICE_UNAVAILABLE, 'SIGNUP_CODE_NOT_SENT', 'We could not email your code right now. Please try again in a few minutes.');
    }
  }
}
