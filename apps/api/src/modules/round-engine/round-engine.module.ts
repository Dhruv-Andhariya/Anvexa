import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications';
import { AssessmentsModule } from '../assessments';
import { RoundsConfigModule } from '../rounds-config';
import { TenantsModule } from '../tenants';
import { HrRoundEngineController } from './hr-round-engine.controller';
import { PublicAssessmentController } from './public-assessment.controller';
import { ROUND_ENGINE_CLOCK, ROUND_ENGINE_CONFIG, RoundEngineService, roundEngineConfigFromEnv } from './round-engine.service';
import { PrismaRoundEngineStore, RoundEngineStore } from './round-engine.store';
import { ROUND_ENGINE_WORKER_CONFIG, RoundEngineWorker, roundEngineWorkerConfigFromEnv } from './round-engine.worker';

/**
 * M13 round engine: runs the online test rounds HR configured (rounds-config), records results through the
 * assessments module, and moves each candidate on (next invite / outcome email). Off with FEATURE_ROUND_ENGINE=off.
 */
@Module({
  imports: [ApplicationsModule, TenantsModule, RoundsConfigModule, AssessmentsModule],
  controllers: [PublicAssessmentController, HrRoundEngineController],
  providers: [
    RoundEngineService,
    RoundEngineWorker,
    { provide: RoundEngineStore, useClass: PrismaRoundEngineStore },
    { provide: ROUND_ENGINE_CONFIG, useFactory: () => roundEngineConfigFromEnv() },
    { provide: ROUND_ENGINE_WORKER_CONFIG, useFactory: () => roundEngineWorkerConfigFromEnv() },
    { provide: ROUND_ENGINE_CLOCK, useValue: () => new Date() },
  ],
  // the dsa module runs coding rounds through the engine service (index.ts), never through its store
  exports: [RoundEngineService],
})
export class RoundEngineModule {}
