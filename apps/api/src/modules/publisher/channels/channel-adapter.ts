import type { PostLinks } from '@hireflow/contracts';
import type { PostSource } from '../post-formatter';

/** Everything an adapter needs for one job on one channel. */
export interface ChannelContext {
  tenantId: string;
  jobId: string;
  slug: string;
  /** Exactly the two links every post carries. */
  links: PostLinks;
  /** Public URL of the job page on our careers site (no tracking params). */
  jobPageUrl: string;
  source: PostSource;
  /** Non-secret per-company settings for this channel (publisher_channel_settings.config). */
  settings: Record<string, unknown>;
  /** This company's OAuth access token for the channel (channel_credentials, decrypted). Secret: never render or log it. */
  accessToken?: string;
  /**
   * The company connected this channel but the stored token is expired or unreadable. Adapters must then report
   * "reconnect" and never fall back to a server-wide token.
   */
  reconnectNeeded?: boolean;
}

export interface PublishedRef {
  externalId: string | null;
  url: string | null;
}

/**
 * M07: one adapter per platform, all with the same shape, so the publisher (M06) never has
 * platform-specific code. To add a platform: implement this, register it in channels/index.ts,
 * and remove it from COMING_SOON_CHANNELS.
 */
export interface ChannelAdapter {
  /** Stable key stored in job_posts.channel, e.g. 'linkedin'. */
  readonly key: string;
  readonly label: string;
  /** The channel always shows the listing's current approved version (our careers page): publishing again updates it. */
  readonly showsLatestVersion?: boolean;
  /** The post exactly as this channel will show it (used for the HR preview AND for publishing). */
  render(ctx: ChannelContext): string;
  /** Why this channel cannot publish right now (missing token, private URL...). Empty = ready. */
  blockers(ctx: ChannelContext): string[];
  publish(ctx: ChannelContext): Promise<PublishedRef>;
  /** Optional: take the post down when the job closes, where the platform allows it. */
  close?(ctx: ChannelContext, post: PublishedRef): Promise<void>;
  /**
   * Optional: delete the post for good (HR "Delete" on the publish page). A post that is already gone counts as
   * removed. Channels without it are reported to HR as "remove it by hand".
   */
  remove?(ctx: ChannelContext, post: PublishedRef): Promise<void>;
  /**
   * Optional: replace the text of an existing post with render(ctx), keeping the same post (HR "Update apply links",
   * e.g. after the careers-site URL changed). Must be safe to call again with the same text.
   */
  update?(ctx: ChannelContext, post: PublishedRef): Promise<void>;
}

/**
 * Adapter failure with a message that is safe to store and show (never tokens or raw payloads).
 * retryable = the platform surely did NOT create anything (connection refused, 429...), so posting again cannot
 * duplicate it. An unknown outcome (timeout, 5xx after sending) must be retryable=false.
 */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}

export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
