import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { forgotPasswordRequestSchema, resetPasswordRequestSchema } from '@hireflow/contracts';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import type { Mailer } from '../applications/email/mailer'; // leaf file; the module index would be an import cycle
import { AuditService } from '../audit';
import { hashPassword } from './password';
import { buildPasswordResetEmail } from './password-reset-email';
import { RateLimiter } from './rate-limit';
import { appUrl, hashToken, newToken } from './tokens';

/** Sends the "reset your password" emails (same SMTP / Gmail settings as the application emails). */
export const AUTH_MAILER = Symbol('AUTH_MAILER');

const MINUTES_15 = 15 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const validMinutes = () => Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 60;

const invalidLink = () =>
  apiError(HttpStatus.NOT_FOUND, 'PASSWORD_RESET_INVALID', 'This reset link is invalid, expired, or was already used. Ask for a new one.');

/**
 * "Forgot password": emails a one-time link (only its hash is stored), then sets the new password and logs the
 * account out everywhere. Never reveals whether an email has an account.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');
  private readonly requestPerIp = new RateLimiter(20, MINUTES_15);
  /** Emails per account: nobody can flood someone's inbox with reset links. */
  private readonly emailsPerAccount = new RateLimiter(3, HOUR);
  private readonly resetPerIp = new RateLimiter(30, MINUTES_15);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUTH_MAILER) private readonly mailer: Mailer,
  ) {}

  /** Same answer for every email; the link is only sent when an active account has it. */
  async requestReset(input: unknown, ip: string): Promise<void> {
    const { email } = parseBody(forgotPasswordRequestSchema, input, 'INVALID_EMAIL', 'Enter a valid email address.');
    this.requestPerIp.consume(ip);
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return;
    try {
      this.emailsPerAccount.consume(user.id);
    } catch {
      return; // silently: a 429 here would reveal that the account exists
    }

    const token = newToken();
    const now = new Date();
    await this.prisma.$transaction([
      // only the newest link works
      this.prisma.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } }),
      this.prisma.passwordReset.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + validMinutes() * 60_000) },
      }),
    ]);
    await this.audit.record({ tenantId: null, actorUserId: user.id, action: 'auth.password_reset_requested', metadata: { ip } });
    // in the background, so the response time does not depend on the mail server (or reveal the account)
    void this.send(user.email, user.name, `${appUrl()}/reset-password/${token}`);
  }

  /** Sets the new password, uses up the link and ends every session of the account. */
  async resetPassword(input: unknown, ip: string): Promise<void> {
    this.resetPerIp.consume(ip);
    const req = parseBody(resetPasswordRequestSchema, input, 'INVALID_PASSWORD_RESET', 'Check the highlighted fields.');
    const passwordHash = await hashPassword(req.password);

    const userId = await this.prisma.$transaction(async (tx) => {
      const reset = await tx.passwordReset.findUnique({ where: { tokenHash: hashToken(req.token) }, include: { user: true } });
      if (!reset || reset.usedAt || reset.expiresAt <= new Date() || !reset.user.isActive) throw invalidLink();
      // single use: only the first concurrent reset wins
      const { count } = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null }, data: { usedAt: new Date() } });
      if (count !== 1) throw invalidLink();
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: reset.userId } }); // log out everywhere
      return reset.userId;
    });
    await this.audit.record({ tenantId: null, actorUserId: userId, action: 'auth.password_reset', metadata: { ip } });
  }

  private async send(to: string, name: string, link: string): Promise<void> {
    if (!this.mailer.enabled) {
      if (process.env.NODE_ENV === 'production') this.logger.error('email is not configured: password reset link NOT sent');
      // local dev without SMTP: the link is only printed to this console
      else this.logger.warn(`email is off - password reset link: ${link}`);
      return;
    }
    try {
      await this.mailer.send(to, buildPasswordResetEmail({ name, link, validMinutes: validMinutes() }));
    } catch (err) {
      this.logger.warn(`password reset email not sent (${err instanceof Error ? err.message : 'unknown'})`);
    }
  }
}
