import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { isFeatureOn } from '../../common/feature-flags';
import { ApplicationsModule } from '../applications';
import { AssessmentsModule } from '../assessments';
import { PipelineModule } from '../pipeline';
import { RoundEngineModule } from '../round-engine';
import { RoundModules, RoundsConfigModule } from '../rounds-config';
import { TenantsModule } from '../tenants';
import { GdLiveService } from './gd-live.service';
import { GD_MAIL_CONFIG, GdMailService, gdMailConfigFromEnv } from './gd-mail.service';
import { GD_RESULTS_CONFIG, GdResultsService, gdResultsConfigFromEnv } from './gd-results.service';
import { GdWorkerClient, HttpGdWorkerClient } from './gd-worker.client';
import { GD_CLOCK, GdService } from './gd.service';
import { GdStore, PrismaGdStore } from './gd.store';
import { GD_WORKER_CONFIG, GdWorker, gdWorkerConfigFromEnv } from './gd.worker';
import { HrGdController } from './hr-gd.controller';
import { LiveKitCloudGateway, LiveKitGateway } from './livekit';
import { PublicGdController } from './public-gd.controller';
import { GdAudioStorage, LocalGdAudioStorage } from './storage';

/**
 * M18 AI group discussion: students who pass the round before a GD round wait in its pool; HR schedules groups; each
 * group runs live on LiveKit with an AI moderator; afterwards Whisper + an LLM rubric evaluate every student and HR
 * confirms the selection. Off with FEATURE_GROUP_DISCUSSION=off.
 */
@Module({
  imports: [TenantsModule, RoundsConfigModule, ApplicationsModule, AssessmentsModule, PipelineModule, RoundEngineModule],
  controllers: [HrGdController, PublicGdController],
  providers: [
    GdService,
    GdLiveService,
    GdMailService,
    GdResultsService,
    GdWorker,
    { provide: GdStore, useClass: PrismaGdStore },
    { provide: LiveKitGateway, useFactory: () => LiveKitCloudGateway.fromEnv() },
    { provide: GdAudioStorage, useFactory: () => LocalGdAudioStorage.fromEnv() },
    { provide: GdWorkerClient, useFactory: () => HttpGdWorkerClient.fromEnv() },
    { provide: GD_WORKER_CONFIG, useFactory: () => gdWorkerConfigFromEnv() },
    { provide: GD_MAIL_CONFIG, useFactory: () => gdMailConfigFromEnv() },
    { provide: GD_RESULTS_CONFIG, useFactory: () => gdResultsConfigFromEnv() },
    { provide: GD_CLOCK, useValue: () => new Date() },
  ],
  // the coding page (dsa module) takes a student who qualified straight to their GD page
  exports: [GdMailService],
})
export class GroupDiscussionModule implements OnModuleInit {
  constructor(@Inject(RoundModules) private readonly roundModules: RoundModules) {}

  onModuleInit() {
    if (isFeatureOn('group_discussion')) this.roundModules.connect('GROUP_DISCUSSION');
  }
}
