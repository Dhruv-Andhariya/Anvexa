import { renderPost } from '../post-formatter';
import type { ChannelAdapter, ChannelContext, PublishedRef } from './channel-adapter';

/**
 * Our own careers site. The job page reads the approved JD version straight from the database,
 * so "publishing" here only records the live URL. Always available - the most reliable channel.
 */
export class CareersSiteAdapter implements ChannelAdapter {
  readonly key = 'careers';
  readonly label = 'Anvexa careers page';
  readonly showsLatestVersion = true;

  render(ctx: ChannelContext): string {
    return renderPost(ctx.source, ctx.links);
  }

  blockers(): string[] {
    return [];
  }

  async publish(ctx: ChannelContext): Promise<PublishedRef> {
    return { externalId: ctx.slug, url: ctx.jobPageUrl };
  }

  /** Nothing to call: the job page disappears when the publisher deletes the listing. */
  async remove(): Promise<void> {}
}
