import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { verifyLoginCodeRequestSchema, type LoginCodeRequired } from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import type { Mailer } from '../applications/email/mailer'; // leaf file; the module index would be an import cycle
import { AuditService } from '../audit';
import { codeHash, codeMaxAttempts, codeValidMinutes, emailCodeSwitch, maskEmail, newCode, sameHash, wrongCodeMessage } from './email-code';
import { buildLoginCodeEmail } from './login-code-email';
import { AUTH_MAILER } from './password-reset.service';
import { RateLimiter } from './rate-limit';
import { hashToken, newToken } from './tokens';

const MINUTES_15 = 15 * 60 * 1000;

/**
 * LOGIN_2FA=email: after the right password a code is emailed and the session starts only when it is entered.
 * LOGIN_2FA=off: password only. Unset: on in production, off elsewhere (local dev, tests).
 */
export const loginTwoFactorEnabled = () => emailCodeSwitch('LOGIN_2FA');

const invalidChallenge = () =>
  apiError(HttpStatus.UNAUTHORIZED, 'LOGIN_CODE_EXPIRED', 'This code has expired or was already used. Log in again to get a new one.');

/** Login 2FA by emailed 6-digit code (same SMTP / Gmail settings as the password-reset emails). */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger('LoginCode');
  /** Codes emailed per account: nobody can flood an inbox, even with the right password. */
  private readonly codesPerAccount = new RateLimiter(5, MINUTES_15);
  private readonly verifyPerIp = new RateLimiter(50, MINUTES_15);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH_MAILER) private readonly mailer: Mailer,
  ) {}

  /** The password was right: email a fresh code (older ones stop working) and tell the browser to ask for it. */
  async start(user: { id: string; email: string; name: string }, ip: string): Promise<LoginCodeRequired> {
    this.codesPerAccount.consume(user.id);
    const challenge = newToken();
    const code = newCode();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + codeValidMinutes() * 60_000);
    const [, created] = await this.prisma.$transaction([
      this.prisma.loginChallenge.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      this.prisma.loginChallenge.create({
        data: { userId: user.id, tokenHash: hashToken(challenge), codeHash: codeHash(challenge, code), expiresAt },
        select: { id: true },
      }),
    ]);

    await this.send(user, code, created.id);
    await this.audit.record({ tenantId: null, actorUserId: user.id, action: 'auth.login_code_sent', metadata: { ip } });
    return { codeRequired: true, challenge, emailHint: maskEmail(user.email), expiresAt: expiresAt.toISOString() };
  }

  /** Checks the emailed code; returns the user to start a session for. Each try (right or wrong) uses one attempt. */
  async verify(input: unknown, ip: string): Promise<string> {
    this.verifyPerIp.consume(ip);
    const { challenge, code } = parseBody(verifyLoginCodeRequestSchema, input, 'INVALID_LOGIN_CODE', 'Enter the 6-digit code from the email.');
    const tokenHash = hashToken(challenge);
    const now = new Date();

    // Claim one attempt atomically first, so parallel guesses can never go past the limit.
    const claimed = await this.prisma.loginChallenge.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now }, attempts: { lt: codeMaxAttempts() }, user: { isActive: true } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) throw invalidChallenge();
    const row = await this.prisma.loginChallenge.findUniqueOrThrow({ where: { tokenHash } });

    if (!sameHash(row.codeHash, codeHash(challenge, code))) {
      await this.audit.record({ tenantId: null, actorUserId: row.userId, action: 'auth.login_code_failed', metadata: { ip } });
      const left = codeMaxAttempts() - row.attempts;
      throw apiError(HttpStatus.UNAUTHORIZED, left > 0 ? 'LOGIN_CODE_WRONG' : 'LOGIN_CODE_EXPIRED', wrongCodeMessage(left));
    }

    // single use: only the first concurrent correct entry wins
    const used = await this.prisma.loginChallenge.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
    if (used.count !== 1) throw invalidChallenge();
    return row.userId;
  }

  private async send(user: { id: string; email: string; name: string }, code: string, challengeId: string): Promise<void> {
    const production = process.env.NODE_ENV === 'production';
    // Local dev only: test accounts often have made-up addresses, so the code is also printed to this console.
    if (!production) this.logger.warn(`dev only - login code for user ${user.id}: ${code}`);
    try {
      if (!this.mailer.enabled) throw new Error('email is not configured');
      await this.mailer.send(user.email, buildLoginCodeEmail({ name: user.name, code, validMinutes: codeValidMinutes() }));
    } catch (err) {
      this.logger.warn(`login code email not sent (${err instanceof Error ? err.message : 'unknown'})`);
      if (!production) return;
      // Without the email nobody can finish this login: retire the challenge and say so.
      await this.prisma.loginChallenge.updateMany({ where: { id: challengeId }, data: { usedAt: new Date() } });
      throw apiError(HttpStatus.SERVICE_UNAVAILABLE, 'LOGIN_CODE_NOT_SENT', 'We could not email your login code right now. Please try again in a few minutes.');
    }
  }
}
