import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications';
import { TenantsModule } from '../tenants';
import { flowLimitsFromEnv } from './flow';
import { HrScreeningController } from './hr-screening.controller';
import { HrScreeningService } from './hr-screening.service';
import { PublicScreeningController } from './public-screening.controller';
import { SCREENING_CLOCK, SCREENING_FLOW_LIMITS, ScreeningService } from './screening.service';
import { PrismaScreeningStore, ScreeningStore } from './screening.store';
import { ScreeningWorkerClient, screeningWorkerOptionsFromEnv } from './screening-worker.client';
import { SpeechCache } from './speech-cache';

/** M12 AI screening round (voice): public candidate flow + HR results. Off with FEATURE_SCREENING=off. */
@Module({
  imports: [ApplicationsModule, TenantsModule],
  controllers: [PublicScreeningController, HrScreeningController],
  providers: [
    ScreeningService,
    HrScreeningService,
    { provide: ScreeningStore, useClass: PrismaScreeningStore },
    { provide: ScreeningWorkerClient, useFactory: () => new ScreeningWorkerClient(screeningWorkerOptionsFromEnv()) },
    { provide: SpeechCache, useFactory: () => new SpeechCache() },
    { provide: SCREENING_FLOW_LIMITS, useFactory: () => flowLimitsFromEnv() },
    { provide: SCREENING_CLOCK, useValue: () => new Date() },
  ],
})
export class ScreeningModule {}
