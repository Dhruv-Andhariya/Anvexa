import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { InvitationPreview, LoginResponse, Session, SignupResponse } from '@hireflow/contracts';
import { Authenticated, Public, type AuthInfo, type AuthRequest } from './access';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, clearSessionCookie, readCookie, sessionCookie, type CookieResponse } from './cookies';
import { GoogleAuthService } from './google-auth.service';
import { GOOGLE_STATE_COOKIE, clearGoogleStateCookie, safeNextPath } from './google-oauth';
import { PasswordResetService } from './password-reset.service';
import { SessionsService } from './sessions.service';

const clientIp = (req: AuthRequest) => req.ip ?? 'unknown';
interface RedirectResponse extends CookieResponse {
  redirect(status: number, url: string): void;
}

/** Query values are strings unless someone sends ?code=a&code=b. */
const str = (v: unknown) => (typeof v === 'string' && v.length <= 2000 ? v : undefined);

/** HTTPS request (Express sets req.secure, also behind a proxy covered by TRUST_PROXY): the cookie gets Secure. */
const overHttps = (req: AuthRequest) => req.secure === true;

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PasswordResetService) private readonly passwordReset: PasswordResetService,
    @Inject(GoogleAuthService) private readonly google: GoogleAuthService,
  ) {}

  /** GET /api/v1/auth/providers - which "Continue with ..." buttons the login and sign-up pages show. */
  @Public()
  @Get('providers')
  providers(): { google: boolean } {
    return { google: this.google.enabled };
  }

  /** GET /api/v1/auth/google/start?next=/path - browser navigation: redirects to Google's account chooser. */
  @Public()
  @Get('google/start')
  googleStart(@Req() req: AuthRequest, @Res() res: RedirectResponse, @Query('next') next?: string) {
    const step = this.google.start(safeNextPath(str(next)), clientIp(req), overHttps(req));
    if (step.cookie) res.setHeader('Set-Cookie', step.cookie);
    res.redirect(302, step.redirectTo);
  }

  /** GET /api/v1/auth/google/callback?code&state - Google sends the browser here; logs in (or signs up) and redirects. */
  @Public()
  @Get('google/callback')
  async googleCallback(
    @Req() req: AuthRequest,
    @Res() res: RedirectResponse,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const result = await this.google.finish(
      { code: str(code), state: str(state), error: str(error) },
      readCookie(req.headers.cookie, GOOGLE_STATE_COOKIE),
      clientIp(req),
    );
    const cookies = [clearGoogleStateCookie(overHttps(req))]; // one use only
    if (result.session) {
      cookies.push(sessionCookie(result.session.token, result.session.expiresAt.getTime() - Date.now(), overHttps(req)));
    }
    res.setHeader('Set-Cookie', cookies);
    res.redirect(302, result.redirectTo);
  }

  /**
   * POST /api/v1/auth/login - body: { email, password }. Sets the httpOnly session cookie, or - with login 2FA on -
   * emails a code and answers { codeRequired, challenge, emailHint, expiresAt } (no cookie yet).
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<LoginResponse> {
    const result = await this.auth.login(body, clientIp(req));
    if (result.kind === 'code') {
      const { kind: _kind, ...codeRequired } = result;
      return codeRequired;
    }
    return this.startSession(result.token, result.expiresAt, req, res);
  }

  /** POST /api/v1/auth/login/verify - body: { challenge, code }. Second login step (2FA); sets the session cookie. */
  @Public()
  @Post('login/verify')
  @HttpCode(200)
  async verifyLoginCode(@Body() body: unknown, @Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<Session> {
    const { token, expiresAt } = await this.auth.verifyLoginCode(body, clientIp(req));
    return this.startSession(token, expiresAt, req, res);
  }

  /**
   * POST /api/v1/auth/signup - body: { name, email, password }. New account (no company yet), logged in - or, with
   * sign-up email verification on, a code is emailed and the answer is { codeRequired, challenge, emailHint, expiresAt }.
   */
  @Public()
  @Post('signup')
  async signup(@Body() body: unknown, @Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<SignupResponse> {
    const result = await this.auth.signup(body, clientIp(req));
    if (result.kind === 'code') {
      const { kind: _kind, ...codeRequired } = result;
      return codeRequired;
    }
    return this.startSession(result.token, result.expiresAt, req, res);
  }

  /** POST /api/v1/auth/signup/verify - body: { challenge, code }. Creates the account from the emailed code, logged in. */
  @Public()
  @Post('signup/verify')
  async verifySignupCode(@Body() body: unknown, @Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<Session> {
    const { token, expiresAt } = await this.auth.verifySignupCode(body, clientIp(req));
    return this.startSession(token, expiresAt, req, res);
  }

  /** POST /api/v1/auth/logout - always succeeds and clears the cookie. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? ((await this.sessions.resolve(token)) ?? undefined) : undefined;
    await this.auth.logout(token, auth);
    res.setHeader('Set-Cookie', clearSessionCookie(overHttps(req)));
  }

  /** POST /api/v1/auth/password/forgot - body: { email }. Always 204: never reveals whether the account exists. */
  @Public()
  @Post('password/forgot')
  @HttpCode(204)
  async forgotPassword(@Body() body: unknown, @Req() req: AuthRequest): Promise<void> {
    await this.passwordReset.requestReset(body, clientIp(req));
  }

  /** POST /api/v1/auth/password/reset - body: { token, password }. Logs the account out on every device. */
  @Public()
  @Post('password/reset')
  @HttpCode(204)
  async resetPassword(@Body() body: unknown, @Req() req: AuthRequest): Promise<void> {
    await this.passwordReset.resetPassword(body, clientIp(req));
  }

  /** GET /api/v1/auth/me - the logged-in user, their current company and role. 401 when not logged in. */
  @Authenticated()
  @Get('me')
  me(@Req() req: AuthRequest): Promise<Session> {
    return this.sessions.describe(req.auth as AuthInfo);
  }

  /** POST /api/v1/auth/company - body: { companyId }. Only companies the user is an active member of. */
  @Authenticated()
  @Post('company')
  @HttpCode(200)
  switchCompany(@Req() req: AuthRequest, @Body() body: unknown): Promise<Session> {
    return this.auth.switchCompany(req.auth as AuthInfo, body);
  }

  /** GET /api/v1/auth/invitations/:token - company name, role and email for the invite page. */
  @Public()
  @Get('invitations/:token')
  previewInvitation(@Param('token') token: string, @Req() req: AuthRequest): Promise<InvitationPreview> {
    return this.auth.previewInvitation(token, clientIp(req));
  }

  /** POST /api/v1/auth/invitations/accept - body: { token, name?, password }. Joins the company and logs in. */
  @Public()
  @Post('invitations/accept')
  @HttpCode(200)
  async acceptInvitation(@Body() body: unknown, @Req() req: AuthRequest, @Res({ passthrough: true }) res: CookieResponse): Promise<Session> {
    const { token, expiresAt } = await this.auth.acceptInvitation(body, clientIp(req));
    return this.startSession(token, expiresAt, req, res);
  }

  private async startSession(token: string, expiresAt: Date, req: AuthRequest, res: CookieResponse): Promise<Session> {
    res.setHeader('Set-Cookie', sessionCookie(token, expiresAt.getTime() - Date.now(), overHttps(req)));
    const auth = await this.sessions.resolve(token);
    return this.sessions.describe(auth!);
  }
}
