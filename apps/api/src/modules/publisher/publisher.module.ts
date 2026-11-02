import { Module } from '@nestjs/common';
import { ScreeningSettingsModule } from '../ats/settings';
import { RoundsConfigModule } from '../rounds-config';
import { TenantsModule } from '../tenants';
import { ChannelCredentials, PrismaChannelCredentials } from './channel-credentials';
import { channelAdaptersProvider } from './channels';
import { JdValidatorClient, jdValidatorOptionsFromEnv } from './jd-checks';
import { LinkedInConnectController } from './linkedin-connect.controller';
import { LinkedInConnectService } from './linkedin-connect.service';
import { LinkedInOAuthClient, linkedInOAuthConfigFromEnv } from './linkedin-oauth';
import { PublicJobsReader } from './public-jobs.reader';
import { PublisherController } from './publisher.controller';
import { PublisherEvents } from './publisher.events';
import { PUBLISHER_CONFIG, PublisherService, publisherConfigFromEnv } from './publisher.service';
import { PrismaPublisherStore, PublisherStore } from './publisher.store';

/** M06 job publisher + M07 channel adapters. Reads approved JDs from Intern 1's jobs module tables. */
@Module({
  imports: [TenantsModule, ScreeningSettingsModule, RoundsConfigModule],
  controllers: [PublisherController, LinkedInConnectController],
  providers: [
    PublisherService,
    PublisherEvents,
    PublicJobsReader,
    channelAdaptersProvider,
    LinkedInConnectService,
    { provide: ChannelCredentials, useClass: PrismaChannelCredentials },
    { provide: LinkedInOAuthClient, useFactory: () => new LinkedInOAuthClient(linkedInOAuthConfigFromEnv()) },
    { provide: PublisherStore, useClass: PrismaPublisherStore },
    { provide: JdValidatorClient, useFactory: () => new JdValidatorClient(jdValidatorOptionsFromEnv()) },
    { provide: PUBLISHER_CONFIG, useFactory: publisherConfigFromEnv },
  ],
  // PublisherService: the jobs module unpublishes a job before deleting it.
  exports: [PublicJobsReader, PublisherService],
})
export class PublisherModule {}
