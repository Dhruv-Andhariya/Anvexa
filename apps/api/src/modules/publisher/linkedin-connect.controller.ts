import { Controller, Delete, Get, HttpCode, Inject, Query, Req, Res, UseGuards } from '@nestjs/common';
import { featureFlag } from '../../common/feature-flags';
import { RequirePermission, type AuthRequest } from '../auth';
import { readCookie, type CookieResponse } from '../auth/cookies';
import { TenantContext } from '../tenants';
import { LinkedInConnectService } from './linkedin-connect.service';
import { clearOAuthStateCookie, OAUTH_STATE_COOKIE } from './linkedin-oauth';

interface RedirectResponse extends CookieResponse {
  redirect(status: number, url: string): void;
}

/**
 * "Connect LinkedIn" for the Company Admin. connect and callback are browser navigations (not fetch calls),
 * so they answer with redirects; the session cookie identifies the admin and the company on both.
 * The callback URL (LINKEDIN_REDIRECT_URI) must be added to the LinkedIn app's "Authorized redirect URLs".
 */
@Controller('publisher/linkedin')
@UseGuards(featureFlag('publisher'))
export class LinkedInConnectController {
  constructor(
    @Inject(LinkedInConnectService) private readonly service: LinkedInConnectService,
    @Inject(TenantContext) private readonly tenant: TenantContext,
  ) {}

  /** GET /api/v1/publisher/linkedin/connect - redirects to LinkedIn's consent screen. */
  @RequirePermission('company.update')
  @Get('connect')
  async connect(@Res() res: RedirectResponse) {
    const step = this.service.start(await this.tenant.currentTenantId());
    if (step.cookie) res.setHeader('Set-Cookie', step.cookie);
    res.redirect(302, step.redirectTo);
  }

  /** GET /api/v1/publisher/linkedin/callback?code&state - LinkedIn sends the browser here; saves the token. */
  @RequirePermission('company.update')
  @Get('callback')
  async callback(
    @Req() req: AuthRequest,
    @Res() res: RedirectResponse,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    const result = await this.service.finish(
      tenantId,
      actor,
      { code: str(code), state: str(state), error: str(error) },
      readCookie(req.headers.cookie, OAUTH_STATE_COOKIE),
    );
    res.setHeader('Set-Cookie', clearOAuthStateCookie()); // one use only
    res.redirect(302, this.service.back(result));
  }

  /** DELETE /api/v1/publisher/linkedin/connection - forget the stored token (LinkedIn then shows "Not set up"). */
  @RequirePermission('company.update')
  @Delete('connection')
  @HttpCode(204)
  async disconnect() {
    const [tenantId, actor] = await Promise.all([this.tenant.currentTenantId(), this.tenant.currentActor()]);
    await this.service.disconnect(tenantId, actor);
  }
}

/** Query values are strings unless someone sends ?code=a&code=b. */
const str = (v: unknown) => (typeof v === 'string' && v.length <= 2000 ? v : undefined);
