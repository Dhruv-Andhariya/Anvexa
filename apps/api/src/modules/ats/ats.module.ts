import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications';
import { TenantsModule } from '../tenants';
import { ATS_PROCESSOR_CONFIG, AtsProcessor, atsProcessorConfigFromEnv } from './ats-processor.service';
import { AtsWorkerClient, atsWorkerOptionsFromEnv } from './ats-worker.client';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { DecisionEmailSender } from './decision-email.sender';
import { DecisionController } from './decision.controller';
import { DecisionService, SCREENING_BASE_URL } from './decision.service';
import { screeningBaseUrlFromEnv } from './screening-link';
import { ScreeningSettingsModule } from './screening-settings.module';

/** M10/M11: background resume parsing + ATS scoring (AI worker), HR decisions and the decision emails. */
@Module({
  imports: [ApplicationsModule, ScreeningSettingsModule, TenantsModule],
  controllers: [DecisionController, CandidatesController],
  providers: [
    AtsProcessor,
    CandidatesService,
    DecisionService,
    DecisionEmailSender,
    { provide: AtsWorkerClient, useFactory: () => new AtsWorkerClient(atsWorkerOptionsFromEnv()) },
    { provide: ATS_PROCESSOR_CONFIG, useFactory: atsProcessorConfigFromEnv },
    { provide: SCREENING_BASE_URL, useFactory: () => screeningBaseUrlFromEnv() },
  ],
})
export class AtsModule {}
