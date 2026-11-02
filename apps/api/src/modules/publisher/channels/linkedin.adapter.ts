import { fitPost } from '../post-formatter';
import { ChannelError, type ChannelAdapter, type ChannelContext, type PublishedRef } from './channel-adapter';

/**
 * Who the post is published as (env LINKEDIN_POST_AS):
 *  - 'organization' (default): the company PAGE. Needs the Community Management API product + `w_organization_social`.
 *  - 'member': the personal profile of whoever connected LinkedIn. Demo / until the page access is approved. Needs the
 *    self-serve products "Share on LinkedIn" (`w_member_social`) + "Sign In with LinkedIn using OpenID Connect"
 *    (`openid profile`, to learn the member id).
 */
export type LinkedInPostAs = 'organization' | 'member';

export const linkedInPostAsFromEnv = (env: NodeJS.ProcessEnv = process.env): LinkedInPostAs =>
  env.LINKEDIN_POST_AS === 'member' ? 'member' : 'organization';

export interface LinkedInOptions {
  postAs?: LinkedInPostAs;
  /**
   * Fallback OAuth token of a LinkedIn page admin (env LINKEDIN_ACCESS_TOKEN). Used ONLY for the one company named by
   * fallbackTenantId, and only while that company has no own connection (ctx.accessToken / ctx.reconnectNeeded).
   * Never logged.
   */
  accessToken?: string;
  /** env LINKEDIN_FALLBACK_TENANT_ID: the single tenant allowed to use accessToken. Unset = the fallback is off. */
  fallbackTenantId?: string;
  /** env LINKEDIN_ALLOWED_MEMBER_ID: in member mode, refuse to post with any other LinkedIn account. */
  allowedMemberId?: string;
  /** Value for the `LinkedIn-Version` header, format YYYYMM (env LINKEDIN_API_VERSION). Not guessed - must be set. */
  apiVersion?: string;
  apiBase?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Post text limit used here. VERIFY against LinkedIn's current Posts API docs. */
export const LINKEDIN_TEXT_MAX = 3000;

/**
 * Posts the job on the company's LinkedIn PAGE through the LinkedIn Posts API (an organization post).
 * This is NOT a LinkedIn Jobs listing - the Jobs API is only for LinkedIn partners.
 * The page is set per company in publisher_channel_settings.config.organizationId (numeric page id).
 *
 * VERIFY (owner) against https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api
 * before going live:
 *  - your LinkedIn app has the Community Management API product and the token has `w_organization_social`
 *  - endpoint POST /rest/posts, headers `LinkedIn-Version` + `X-Restli-Protocol-Version: 2.0.0`
 *  - body fields used: author, commentary, visibility, distribution, lifecycleState, isReshareDisabledByAuthor
 *  - the new post id comes back in the `x-restli-id` response header
 *  - "little text" escaping of reserved characters in `commentary` (see escapeLittleText)
 *  - the 3000 character limit
 */
export class LinkedInAdapter implements ChannelAdapter {
  readonly key = 'linkedin';
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly asMember: boolean;

  constructor(private readonly options: LinkedInOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.asMember = options.postAs === 'member';
    this.label = this.asMember ? 'LinkedIn (personal profile)' : 'LinkedIn company page';
  }

  render(ctx: ChannelContext): string {
    // Shorten long JDs / company profiles so the post always fits; the apply page always has the full JD.
    // Escaping (escapeLittleText) adds backslashes, so the limit is checked on the escaped text that is sent.
    let limit = LINKEDIN_TEXT_MAX;
    for (;;) {
      const text = fitPost(ctx.source, ctx.links, limit);
      const over = escapeLittleText(text).length - LINKEDIN_TEXT_MAX;
      if (over <= 0 || limit <= 500) return text;
      limit -= over;
    }
  }

  blockers(ctx: ChannelContext): string[] {
    const out: string[] = [];
    if (!this.tokenFor(ctx)) {
      out.push(
        ctx.reconnectNeeded
          ? 'The LinkedIn connection expired or cannot be read. A Company Admin must reconnect it on the Publish page.'
          : 'LinkedIn is not connected. A Company Admin can connect it on the Publish page.',
      );
    }
    if (!this.options.apiVersion || !/^\d{6}$/.test(this.options.apiVersion)) {
      out.push('LINKEDIN_API_VERSION (YYYYMM) is not set on the server.');
    }
    if (!this.asMember && !organizationIdOf(ctx)) out.push('No LinkedIn page set for this company (channel settings: organizationId).');
    if (!out.length && this.render(ctx).length > LINKEDIN_TEXT_MAX) out.push('The post is too long for LinkedIn.');
    return out;
  }

  async publish(ctx: ChannelContext): Promise<PublishedRef> {
    const orgId = organizationIdOf(ctx);
    const token = this.tokenFor(ctx);
    if (!token || !this.options.apiVersion || (!this.asMember && !orgId)) {
      throw new ChannelError('LinkedIn is not configured.', false);
    }
    const author = this.asMember ? await this.memberUrn(token) : `urn:li:organization:${orgId}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.apiBase ?? 'https://api.linkedin.com'}/rest/posts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'linkedin-version': this.options.apiVersion,
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify({
          author,
          commentary: escapeLittleText(this.render(ctx)),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      // Never include the original error: it could carry request details (the token is in a header).
      // POST /rest/posts is not idempotent: only retry when the request surely never reached LinkedIn.
      if (neverConnected(err)) throw new ChannelError('Could not reach LinkedIn.', true);
      throw new ChannelError(UNKNOWN_OUTCOME, false);
    }

    if (!res.ok) {
      // A 5xx may come after LinkedIn already created the post: do not post again automatically.
      if (res.status >= 500) throw new ChannelError(`LinkedIn answered with an error (${res.status}). ${UNKNOWN_OUTCOME}`, false);
      const body = (await res.json().catch(() => undefined)) as { message?: unknown } | undefined;
      const message = typeof body?.message === 'string' ? body.message.slice(0, 200) : 'unknown error';
      throw new ChannelError(`LinkedIn rejected the post (${res.status}): ${message}`, res.status === 429);
    }

    const urn = res.headers.get('x-restli-id');
    return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  }

  /**
   * Deletes the post (HR "Delete" on the publish page). Same token as publishing. Deleting is idempotent, so a
   * post LinkedIn no longer has (404 / 410, e.g. removed by hand) counts as removed.
   *
   * VERIFY (owner) against the Posts API docs: DELETE /rest/posts/{url-encoded post urn} with the same
   * `LinkedIn-Version` + `X-Restli-Protocol-Version: 2.0.0` headers answers 204, and works for both
   * urn:li:share and urn:li:ugcPost ids with the w_member_social / w_organization_social scope.
   */
  async remove(ctx: ChannelContext, post: PublishedRef): Promise<void> {
    const urn = post.externalId;
    if (!urn) throw new ChannelError('LinkedIn did not give this post an id, so it cannot be removed automatically.', false);
    const token = this.tokenFor(ctx);
    if (!token || !this.options.apiVersion) {
      throw new ChannelError('LinkedIn is not connected, so the post could not be removed. Reconnect LinkedIn or delete it on LinkedIn.', false);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.apiBase ?? 'https://api.linkedin.com'}/rest/posts/${encodeURIComponent(urn)}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
          'linkedin-version': this.options.apiVersion,
          'x-restli-protocol-version': '2.0.0',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      // Never include the original error (the token is in a header).
      throw new ChannelError('Could not reach LinkedIn to remove the post.', true);
    }
    if (res.ok || res.status === 404 || res.status === 410) return;
    if (res.status === 401 || res.status === 403) {
      throw new ChannelError('LinkedIn did not allow removing this post (the connected account may not own it). Delete it on LinkedIn.', false);
    }
    throw new ChannelError(`LinkedIn could not remove the post (${res.status}).`, res.status === 429 || res.status >= 500);
  }

  /**
   * Edits the post's text in place (HR "Update apply links"), so the same post carries the current apply link.
   * Setting the same text twice changes nothing, so every failure where LinkedIn did not answer is safe to retry.
   *
   * VERIFY (owner) against the Posts API docs: POST /rest/posts/{url-encoded post urn} with
   * `X-RestLi-Method: PARTIAL_UPDATE` and body {"patch":{"$set":{"commentary":"..."}}} answers 204, for both
   * urn:li:share and urn:li:ugcPost ids, with the w_member_social / w_organization_social scope.
   */
  async update(ctx: ChannelContext, post: PublishedRef): Promise<void> {
    const urn = post.externalId;
    if (!urn) throw new ChannelError('LinkedIn did not give this post an id, so it cannot be edited automatically.', false);
    const token = this.tokenFor(ctx);
    if (!token || !this.options.apiVersion) {
      throw new ChannelError('LinkedIn is not connected, so the post could not be edited. Reconnect LinkedIn and try again.', false);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.apiBase ?? 'https://api.linkedin.com'}/rest/posts/${encodeURIComponent(urn)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'linkedin-version': this.options.apiVersion,
          'x-restli-protocol-version': '2.0.0',
          'x-restli-method': 'PARTIAL_UPDATE',
        },
        body: JSON.stringify({ patch: { $set: { commentary: escapeLittleText(this.render(ctx)) } } }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      // Never include the original error (the token is in a header).
      throw new ChannelError('Could not reach LinkedIn to edit the post.', true);
    }
    if (res.ok) return;
    if (res.status === 404 || res.status === 410) {
      throw new ChannelError('This post no longer exists on LinkedIn. Delete the job here and publish it again.', false);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ChannelError('LinkedIn did not allow editing this post (the connected account may not own it). Reconnect LinkedIn or edit it on LinkedIn.', false);
    }
    const body = (await res.json().catch(() => undefined)) as { message?: unknown } | undefined;
    const message = typeof body?.message === 'string' ? `: ${body.message.slice(0, 200)}` : '';
    throw new ChannelError(`LinkedIn could not edit the post (${res.status})${message}`, res.status === 429 || res.status >= 500);
  }

  /**
   * 'member' mode: urn:li:person:<id> of the token's owner, from the OpenID Connect userinfo endpoint (`sub`).
   * VERIFY: GET /v2/userinfo needs the `openid profile` scopes; a w_member_social-only token gets 401/403.
   */
  private async memberUrn(token: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.apiBase ?? 'https://api.linkedin.com'}/v2/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new ChannelError('Could not reach LinkedIn.', true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ChannelError('The LinkedIn login cannot read your profile id. Click "Connect LinkedIn" again (needs openid + profile).', false);
    }
    if (!res.ok) throw new ChannelError(`LinkedIn profile lookup failed (${res.status}).`, res.status === 429 || res.status >= 500);
    const sub = ((await res.json().catch(() => undefined)) as { sub?: unknown } | undefined)?.sub;
    if (typeof sub !== 'string' || !/^[\w-]{1,100}$/.test(sub)) throw new ChannelError('LinkedIn returned no profile id.', false);
    if (this.options.allowedMemberId && sub !== this.options.allowedMemberId) {
      throw new ChannelError('This LinkedIn account is not the one allowed to post. Disconnect it and connect the allowed account.', false);
    }
    return `urn:li:person:${sub}`;
  }

  /**
   * The company's connected token. The server-wide env token only for the one opted-in tenant, and never for a
   * company whose own connection expired or broke (it must reconnect, not post with someone else's account).
   */
  private tokenFor(ctx: ChannelContext): string | undefined {
    if (ctx.accessToken) return ctx.accessToken;
    if (ctx.reconnectNeeded || !this.options.fallbackTenantId || ctx.tenantId !== this.options.fallbackTenantId) return undefined;
    return this.options.accessToken;
  }
}

const UNKNOWN_OUTCOME =
  'LinkedIn did not confirm the post, so it may or may not have been created. Check the LinkedIn page before retrying.';

/** Connection errors where the request surely never reached LinkedIn (safe to send again). Timeouts are NOT in here. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function neverConnected(err: unknown): boolean {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' && NEVER_CONNECTED.has(cause.code);
}

/**
 * LinkedIn "little text": these characters have special meaning in `commentary` and must be
 * backslash-escaped to show literally. VERIFY the list against LinkedIn's docs.
 */
export function escapeLittleText(text: string): string {
  // Links are left untouched so the two URLs stay clickable; only the words around them are escaped.
  return text
    .split(/(https?:\/\/\S+)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`)))
    .join('');
}

function organizationIdOf(ctx: ChannelContext): string | undefined {
  const v = ctx.settings.organizationId;
  return typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : undefined;
}
