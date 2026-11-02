import type { Provider } from '@nestjs/common';
import { CareersSiteAdapter } from './careers-site.adapter';
import { CHANNEL_ADAPTERS, type ChannelAdapter } from './channel-adapter';
import { LinkedInAdapter, linkedInPostAsFromEnv } from './linkedin.adapter';

export * from './channel-adapter';
export { CareersSiteAdapter, LinkedInAdapter };

/** Live channels. Add a new platform here (one line) after writing its adapter. */
export const channelAdaptersProvider: Provider = {
  provide: CHANNEL_ADAPTERS,
  useFactory: (): ChannelAdapter[] => [
    // Our own careers page: the "Apply here" link of every post opens it, so it is always on.
    new CareersSiteAdapter(),
    new LinkedInAdapter({
      postAs: linkedInPostAsFromEnv(),
      accessToken: process.env.LINKEDIN_ACCESS_TOKEN || undefined,
      fallbackTenantId: process.env.LINKEDIN_FALLBACK_TENANT_ID || undefined,
      allowedMemberId: process.env.LINKEDIN_ALLOWED_MEMBER_ID?.trim() || undefined,
      apiVersion: process.env.LINKEDIN_API_VERSION || undefined,
    }),
  ],
};

/** Shown to HR as "coming soon". Move an entry out of this list when its adapter is registered above. */
export const COMING_SOON_CHANNELS: { key: string; label: string }[] = [
  { key: 'naukri', label: 'Naukri' },
  { key: 'indeed', label: 'Indeed' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook Page' },
  { key: 'x', label: 'X (Twitter)' },
  { key: 'whatsapp', label: 'WhatsApp channel' },
];
