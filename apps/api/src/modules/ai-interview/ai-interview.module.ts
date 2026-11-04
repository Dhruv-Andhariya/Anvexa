import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { isFeatureOn } from '../../common/feature-flags';
import { ApplicationsModule } from '../applications';
import { RoundEngineModule } from '../round-engine';
import { RoundModules, RoundsConfigModule } from '../rounds-config';
import { SpeechCache } from '../screening';
import { TenantsModule } from '../tenants';
import { AiInterviewHrService } from './ai-interview-hr.service';
import { InterviewWorkerClient, interviewWorkerOptionsFromEnv } from './ai-interview-worker.client';
import { AI_INTERVIEW_CLOCK, AiInterviewService } from './ai-interview.service';
import { AiInterviewStore, PrismaAiInterviewStore } from './ai-interview.store';
import { AI_INTERVIEW_WORKER_CONFIG, AiInterviewWorker, aiInterviewWorkerConfigFromEnv } from './ai-interview.worker';
import { HrInterviewController } from './hr-interview.controller';
import { InterviewProtectionService } from './protection.service';
import { PublicInterviewController } from './public-interview.controller';

/**
 * AI technical interview round: runs the job rounds of type AI_INTERVIEW. The round engine hands over every student
 * who passed the rounds before (whichever rounds HR chose, in HR's order); this module invites them, runs the voice
 * interview on the careers site (/interview/[token]), writes the report, and records HR's decision back through the
 * round engine (next round or outcome email). Off with FEATURE_AI_INTERVIEW=off (HR then runs the round).
 */
@Module({
  imports: [ApplicationsModule, TenantsModule, RoundsConfigModule, RoundEngineModule],
  controllers: [PublicInterviewController, HrInterviewController],
  providers: [
    AiInterviewService,
    AiInterviewHrService,
    AiInterviewWorker,
    InterviewProtectionService,
    { provide: AiInterviewStore, useClass: PrismaAiInterviewStore },
    { provide: InterviewWorkerClient, useFactory: () => new InterviewWorkerClient(interviewWorkerOptionsFromEnv()) },
    { provide: SpeechCache, useFactory: () => new SpeechCache() },
    { provide: AI_INTERVIEW_WORKER_CONFIG, useFactory: () => aiInterviewWorkerConfigFromEnv() },
    { provide: AI_INTERVIEW_CLOCK, useValue: () => new Date() },
  ],
})
export class AiInterviewModule implements OnModuleInit {
  constructor(@Inject(RoundModules) private readonly roundModules: RoundModules) {}

  /** Connected = the round engine hands AI interview rounds to this module instead of "HR runs this round". */
  onModuleInit() {
    if (isFeatureOn('ai_interview')) this.roundModules.connect('AI_INTERVIEW');
  }
}
