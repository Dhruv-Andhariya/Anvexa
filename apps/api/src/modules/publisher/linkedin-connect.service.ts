import { Inject, Injectable, Logger } from '@nestjs/common';
import { SecretBox } from '../../common/secret-box';
import { AuditService } from '../audit';
import type { Actor } from '../tenants';
import { ChannelCredentials, EncryptionNotConfiguredError } from './channel-credentials';
import { checkOAuthState, LinkedInOAuthClient, LinkedInOAuthError, newOAuthState } from './linkedin-oauth';

/** Result codes shown on the dashboard as /publish?linkedin=<code>. Never contain details or secrets. */
export type LinkedInConnectResult =
  | 'connected'
  | 'denied'
  | 'not_configured'
  | 'invalid_state'
  | 'wrong_account'
  | 'failed';

/** What the controller should do with the browser: set this cookie, then redirect there. */
export interface BrowserStep {
  redirectTo: string;
  cookie?: string;
}

/**
 * Company Admin connects the company's LinkedIn page (OAuth). The token is stored encrypted per company in
 * channel_credentials and used by the LinkedIn adapter instead of the LINKEDIN_ACCESS_TOKEN env fallback.
 */
@Injectable()
export class LinkedInConnectService {
  private readonly logger = new Logger('LinkedInConnect');

  constructor(
    @Inject(LinkedInOAuthClient) private readonly oauth: LinkedInOAuthClient,
    @Inject(ChannelCredentials) private readonly credentials: ChannelCredentials,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Step 1: send the admin to LinkedIn's consent screen. */
  start(tenantId: string): BrowserStep {
    if (!this.oauth.configured || !SecretBox.fromEnv()) return { redirectTo: this.back('not_configured') };
    const { state, cookie } = newOAuthState(tenantId);
    return { redirectTo: this.oauth.authorizeUrl(state), cookie };
  }

  /** Step 2: LinkedIn sent the browser back with ?code&state (or ?error). */
  async finish(
    tenantId: string,
    actor: Actor,
    q: { code?: string; state?: string; error?: string },
    stateCookie: string | undefined,
  ): Promise<LinkedInConnectResult> {
    if (q.error) return q.error.startsWith('user_cancelled') ? 'denied' : 'failed';
    if (!checkOAuthState(stateCookie, q.state, tenantId) || !q.code) return 'invalid_state';

    try {
      const tokens = await this.oauth.exchangeCode(q.code);
      const account = await this.oauth.account(tokens.accessToken);
      const allowed = this.oauth.allowedMemberId;
      if (allowed && account?.id !== allowed) {
        // Only the one configured LinkedIn account may ever post: this token is dropped, never saved.
        this.logger.warn(`linkedin connect refused tenant=${tenantId}: account ${account?.id ?? 'unknown'} is not LINKEDIN_ALLOWED_MEMBER_ID`);
        await this.record(tenantId, actor, 'publisher.channel_connect_refused', { accountId: account?.id ?? null });
        return 'wrong_account';
      }
      await this.credentials.save(tenantId, 'linkedin', {
        ...tokens,
        connectedBy: actor.id,
        accountId: account?.id ?? null,
        accountName: account?.name ?? null,
      });
      await this.record(tenantId, actor, 'publisher.channel_connected', {
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt?.toISOString() ?? null,
        hasRefreshToken: tokens.refreshToken !== null,
        accountId: account?.id ?? null,
      });
      // the id to put in LINKEDIN_ALLOWED_MEMBER_ID (not a secret)
      this.logger.log(`linkedin connected tenant=${tenantId} account=${account?.id ?? 'unknown'}`);
      return 'connected';
    } catch (err) {
      if (err instanceof EncryptionNotConfiguredError) return 'not_configured';
      if (err instanceof LinkedInOAuthError) {
        this.logger.warn(`linkedin connect failed tenant=${tenantId} reason=${err.reason}`);
        return err.reason === 'not_configured' ? 'not_configured' : 'failed';
      }
      throw err;
    }
  }

  async disconnect(tenantId: string, actor: Actor) {
    await this.credentials.remove(tenantId, 'linkedin');
    await this.record(tenantId, actor, 'publisher.channel_disconnected', {});
  }

  /** HR dashboard Publish page with the result code. */
  back(result: LinkedInConnectResult): string {
    return `${this.oauth.dashboardUrl}/publish?linkedin=${result}`;
  }

  private record(tenantId: string, actor: Actor, action: string, metadata: Record<string, unknown>) {
    return this.audit.record({ tenantId, actorUserId: actor.id, action, subjectType: 'channel', subjectId: 'linkedin', metadata });
  }
}
