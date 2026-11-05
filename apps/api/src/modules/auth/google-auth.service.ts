import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit';
import { GOOGLE_OAUTH_CONFIG, GoogleOAuthClient, GoogleOAuthError, newGoogleState, readGoogleState, type GoogleIdentity, type GoogleOAuthConfig } from './google-oauth';
import { hashPassword } from './password';
import { RateLimiter } from './rate-limit';
import { SessionsService } from './sessions.service';

const MINUTES_15 = 15 * 60 * 1000;

/**
 * "Continue with Google" on the login and sign-up pages. One flow for both:
 *  - a Google account seen before (users.google_sub) logs in;
 *  - else an account with the same (Google-verified) email is linked to it and logs in;
 *  - else a new account is created (no company yet, never Platform Admin) - like POST /auth/signup.
 * Google already verified the email and runs its own 2-step verification, so no emailed code is asked for.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger('GoogleAuth');
  private readonly startsPerIp = new RateLimiter(30, MINUTES_15);
  private readonly google: GoogleOAuthClient;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GOOGLE_OAUTH_CONFIG) config: GoogleOAuthConfig,
  ) {
    this.google = new GoogleOAuthClient(config);
  }

  get enabled(): boolean {
    return this.google.configured;
  }

  /** Redirect to Google's account chooser; the cookie remembers state, PKCE verifier and where to go afterwards. */
  start(next: string | undefined, ip: string, httpsRequest: boolean, forwardedHost?: string): { redirectTo: string; cookie?: string } {
    const flow = this.google.flowFor(forwardedHost);
    if (!this.google.configured) return { redirectTo: this.failed('not_configured', flow.dashboardUrl) };
    try {
      this.startsPerIp.consume(ip);
    } catch {
      return { redirectTo: this.failed('rejected', flow.dashboardUrl) };
    }
    // the cookie also remembers which dashboard address this sign-in belongs to (Google's return address + landing)
    const { state, verifier, cookie } = newGoogleState(next, httpsRequest, flow);
    return { redirectTo: this.google.authorizeUrl(state, verifier, flow.redirectUri), cookie };
  }

  /** Google sent the browser back: on success a new session token and the dashboard page to open. */
  async finish(
    q: { code?: string; state?: string; error?: string },
    cookieValue: string | undefined,
    ip: string,
  ): Promise<{ session?: { token: string; expiresAt: Date }; redirectTo: string }> {
    let dashboardUrl = this.google.dashboardUrl;
    try {
      const st = readGoogleState(cookieValue, q.state);
      const flow = this.google.knownFlow(st?.flow);
      if (flow) dashboardUrl = flow.dashboardUrl;
      if (q.error) throw new GoogleOAuthError('cancelled');
      if (!st || !q.code) throw new GoogleOAuthError('expired');
      const identity = await this.google.identity(q.code, st.verifier, Date.now(), flow?.redirectUri);
      const userId = await this.userFor(identity, ip);

      const session = await this.sessions.create(userId);
      await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
      await this.audit.record({ tenantId: null, actorUserId: userId, action: 'auth.login', metadata: { ip, method: 'google' } });
      return { session, redirectTo: `${dashboardUrl}${st.next ?? (await this.landingPage(session.token))}` };
    } catch (err) {
      if (err instanceof GoogleOAuthError) {
        if (err.reason !== 'cancelled') this.logger.warn(`Google sign-in failed: ${err.reason}`);
        return { redirectTo: this.failed(err.reason, dashboardUrl) };
      }
      throw err;
    }
  }

  private async userFor(g: GoogleIdentity, ip: string): Promise<string> {
    const known = await this.prisma.user.findUnique({ where: { googleSub: g.sub } });
    if (known) {
      if (!known.isActive) throw new GoogleOAuthError('account_disabled');
      return known.id;
    }

    const sameEmail = await this.prisma.user.findUnique({ where: { email: g.email } });
    if (sameEmail) {
      if (!sameEmail.isActive) throw new GoogleOAuthError('account_disabled');
      // the email already belongs to ANOTHER Google account: never re-link silently
      if (sameEmail.googleSub) throw new GoogleOAuthError('account_mismatch');
      await this.prisma.user.update({ where: { id: sameEmail.id }, data: { googleSub: g.sub } });
      await this.audit.record({ tenantId: null, actorUserId: sameEmail.id, action: 'auth.google_linked', metadata: { ip } });
      return sameEmail.id;
    }

    // New account. It gets a random password nobody knows; "Forgot password?" can set a real one later.
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
    try {
      // only these fields are ever written: never isPlatformAdmin, never a membership
      const { id } = await this.prisma.user.create({ data: { email: g.email, name: g.name, passwordHash, googleSub: g.sub }, select: { id: true } });
      await this.audit.record({ tenantId: null, actorUserId: id, action: 'auth.signup', metadata: { ip, method: 'google' } });
      return id;
    } catch (err) {
      // a parallel sign-in of the same person created it first: use that one
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const again = await this.prisma.user.findUnique({ where: { googleSub: g.sub } });
        if (again?.isActive) return again.id;
      }
      throw err;
    }
  }

  /** Same choice as the login form: no company yet -> register one; Platform Admin -> admin; else jobs. */
  private async landingPage(token: string): Promise<string> {
    const auth = await this.sessions.resolve(token);
    if (!auth) return '/login';
    const s = await this.sessions.describe(auth);
    return s.company ? '/jobs' : s.user.isPlatformAdmin ? '/admin' : s.companies.length ? '/jobs' : '/register-company';
  }

  private failed(reason: string, dashboardUrl: string = this.google.dashboardUrl): string {
    return `${dashboardUrl}/login?oauth_error=${encodeURIComponent(reason)}`;
  }
}
