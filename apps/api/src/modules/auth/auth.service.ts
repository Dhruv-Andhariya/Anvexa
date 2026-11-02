import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  acceptInvitationRequestSchema,
  loginRequestSchema,
  signupRequestSchema,
  switchCompanyRequestSchema,
  type InvitationPreview,
  type LoginCodeRequired,
  type Session,
} from '@hireflow/contracts';
import { Prisma } from '@prisma/client';
import { apiError, parseBody } from '../../common/api-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import type { AuthInfo } from './access';
import { LoginCodeService, loginTwoFactorEnabled } from './login-code.service';
import { SignupCodeService, emailTaken, signupEmailVerificationEnabled, type VerifiedSignup } from './signup-code.service';
import { dummyPasswordHash, hashPassword, verifyPassword } from './password';
import { RateLimiter } from './rate-limit';
import { SessionsService } from './sessions.service';
import { hashToken } from './tokens';

const invalidCredentials = () => apiError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
const invalidInvitation = () =>
  apiError(HttpStatus.NOT_FOUND, 'INVITATION_INVALID', 'This invitation link is invalid, expired, or was already used.');

const MINUTES_15 = 15 * 60 * 1000;

/** A started session, or (login 2FA on) "the code was emailed, ask for it". */
export type LoginResult = { kind: 'session'; token: string; expiresAt: Date; userId: string } | ({ kind: 'code' } & LoginCodeRequired);
/** A new account, logged in, or (sign-up email verification on) "the code was emailed, ask for it". */
export type SignupResult = { kind: 'session'; token: string; expiresAt: Date } | ({ kind: 'code' } & LoginCodeRequired);

/**
 * Sign-up, login, logout and invitation acceptance.
 * Sign-up creates a plain account with no company and no platform role; the user then registers their own company
 * (tenants/companies.service.ts). Joining an EXISTING company always needs an invitation from its Company Admin.
 */
@Injectable()
export class AuthService {
  // per IP+email (guessing one password) and per IP (spraying many accounts)
  private readonly loginPerAccount = new RateLimiter(Number(process.env.LOGIN_MAX_ATTEMPTS) || 10, MINUTES_15);
  private readonly loginPerIp = new RateLimiter(100, MINUTES_15);
  private readonly invitePerIp = new RateLimiter(30, MINUTES_15);
  private readonly signupPerIp = new RateLimiter(Number(process.env.SIGNUP_MAX_PER_IP) || 10, 60 * 60 * 1000);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LoginCodeService) private readonly loginCodes: LoginCodeService,
    @Inject(SignupCodeService) private readonly signupCodes: SignupCodeService,
  ) {}

  async login(input: unknown, ip: string): Promise<LoginResult> {
    const { email, password } = parseBody(loginRequestSchema, input, 'INVALID_LOGIN', 'Enter your email and password.');
    const accountKey = `${ip}|${email}`;
    this.loginPerIp.consume(ip);
    this.loginPerAccount.consume(accountKey);

    const user = await this.prisma.user.findUnique({ where: { email } });
    // always run scrypt so response time does not reveal whether the email exists
    const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok || !user.isActive) {
      await this.audit.record({ tenantId: null, actorUserId: user?.id ?? null, action: 'auth.login_failed', metadata: { email, ip } });
      throw invalidCredentials();
    }

    this.loginPerAccount.reset(accountKey);
    // 2FA: the right password alone is not enough - the session starts in verifyLoginCode()
    if (loginTwoFactorEnabled()) return { kind: 'code', ...(await this.loginCodes.start(user, ip)) };
    return { kind: 'session', ...(await this.startLogin(user.id, ip, 'password')) };
  }

  /** Second login step (2FA): the code from the email. */
  async verifyLoginCode(input: unknown, ip: string): Promise<{ token: string; expiresAt: Date; userId: string }> {
    const userId = await this.loginCodes.verify(input, ip);
    return this.startLogin(userId, ip, 'password+email_code');
  }

  private async startLogin(userId: string, ip: string, method: string) {
    const session = await this.sessions.create(userId);
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ tenantId: null, actorUserId: userId, action: 'auth.login', metadata: { ip, method } });
    return { ...session, userId };
  }

  /**
   * New HR person: creates the account and logs in. Next step for the UI: register the company.
   * With sign-up email verification on, nothing is created yet: a code is emailed and verifySignupCode() creates it.
   */
  async signup(input: unknown, ip: string): Promise<SignupResult> {
    const req = parseBody(signupRequestSchema, input, 'INVALID_SIGNUP', 'Check the highlighted fields.');
    this.signupPerIp.consume(ip);
    if (signupEmailVerificationEnabled()) return { kind: 'code', ...(await this.signupCodes.start(req)) };
    const userId = await this.createUser({ email: req.email, name: req.name, passwordHash: await hashPassword(req.password) }, ip, false);
    return { kind: 'session', ...(await this.sessions.create(userId)) };
  }

  /** Second sign-up step: the code emailed to the new address. Creates the account and logs in. */
  async verifySignupCode(input: unknown, ip: string): Promise<{ token: string; expiresAt: Date }> {
    const verified = await this.signupCodes.verify(input, ip);
    return this.sessions.create(await this.createUser(verified, ip, true));
  }

  private async createUser(u: VerifiedSignup, ip: string, emailVerified: boolean): Promise<string> {
    let userId: string;
    try {
      // only these three fields are ever written: never isPlatformAdmin, never a membership
      ({ id: userId } = await this.prisma.user.create({ data: { email: u.email, name: u.name, passwordHash: u.passwordHash } }));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw emailTaken();
      throw err;
    }
    await this.audit.record({ tenantId: null, actorUserId: userId, action: 'auth.signup', metadata: { ip, emailVerified } });
    return userId;
  }

  async logout(token: string | undefined, auth?: AuthInfo): Promise<void> {
    if (!token) return;
    await this.sessions.destroy(token);
    if (auth) await this.audit.record({ tenantId: null, actorUserId: auth.user.id, action: 'auth.logout' });
  }

  async switchCompany(auth: AuthInfo, input: unknown): Promise<Session> {
    const { companyId } = parseBody(switchCompanyRequestSchema, input, 'INVALID_COMPANY', 'Choose a company.');
    const company = await this.sessions.switchCompany(auth.sessionId, auth.user.id, companyId);
    if (!company) throw apiError(HttpStatus.FORBIDDEN, 'NOT_A_MEMBER', 'You are not a member of that company.');
    await this.audit.record({ tenantId: company.id, actorUserId: auth.user.id, action: 'auth.company_switched' });
    return this.sessions.describe({ ...auth, company });
  }

  async previewInvitation(token: string, ip: string): Promise<InvitationPreview> {
    this.invitePerIp.consume(ip);
    const invitation = await this.findLiveInvitation(token);
    const existing = await this.prisma.user.count({ where: { email: invitation.email } });
    return {
      email: invitation.email,
      companyName: invitation.tenant.name,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      existingUser: existing > 0,
    };
  }

  /**
   * Accept an invitation: creates the account (new email) or, for an existing account, requires its password
   * so an invitation link can never be used to take over someone else's account. Then logs the user in.
   */
  async acceptInvitation(input: unknown, ip: string): Promise<{ token: string; expiresAt: Date }> {
    this.invitePerIp.consume(ip);
    const req = parseBody(acceptInvitationRequestSchema, input, 'INVALID_INVITATION_ACCEPT', 'Check the highlighted fields.');
    const invitation = await this.findLiveInvitation(req.token);

    let user = await this.prisma.user.findUnique({ where: { email: invitation.email } });
    if (user) {
      if (!user.isActive || !(await verifyPassword(req.password, user.passwordHash))) throw invalidCredentials();
    } else if (!req.name) {
      throw apiError(HttpStatus.BAD_REQUEST, 'NAME_REQUIRED', 'Enter your name to create your account.');
    }
    const passwordHash = user ? null : await hashPassword(req.password);

    user = await this.prisma.$transaction(async (tx) => {
      // single use: only the first concurrent accept wins
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (count !== 1) throw invalidInvitation();
      const account =
        user ?? (await tx.user.create({ data: { email: invitation.email, name: req.name!, passwordHash: passwordHash! } }));
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: invitation.tenantId, userId: account.id } },
        create: { tenantId: invitation.tenantId, userId: account.id, role: invitation.role },
        update: { role: invitation.role, status: 'ACTIVE' }, // re-inviting a disabled member re-activates them
      });
      return account;
    });

    await this.audit.record({
      tenantId: invitation.tenantId,
      actorUserId: user.id,
      action: 'invitation.accepted',
      subjectType: 'invitation',
      subjectId: invitation.id,
      metadata: { role: invitation.role },
    });
    return this.sessions.create(user.id, invitation.tenantId);
  }

  private async findLiveInvitation(token: string) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw invalidInvitation();
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { tenant: true } });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) throw invalidInvitation();
    return invitation;
  }
}
