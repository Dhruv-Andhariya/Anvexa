import { Module } from '@nestjs/common';
import { RoundEngineModule } from '../round-engine';
import { DsaController } from './dsa.controller';
import { DsaService } from './dsa.service';
import { RoundEngineBridge } from './integration/round-engine.bridge';
import { JUDGE0_CLIENT, Judge0Client, judge0OptionsFromEnv } from './judge0/judge0.client';
import { ProctoringAdminController } from './proctoring/proctoring-admin.controller';
import { ProctoringController } from './proctoring/proctoring.controller';
import { DSA_PROCTOR_POLICY, policyFromEnv } from './proctoring/proctoring.policy';
import { ProctoringService } from './proctoring/proctoring.service';
import { DSA_PROCTOR_STORE, InMemoryProctorStore } from './proctoring/proctoring.store';
import { MockQuestionRepository } from './questions/mock-question.repository';
import { DSA_QUESTION_REPOSITORY } from './questions/question.repository';
import { DSA_LIFECYCLE } from './session/assessment-lifecycle';
import { DSA_INVITATION_RESOLVER } from './session/invitation.resolver';
import { DSA_SESSION_STORE } from './session/session.store';

// The DSA page runs the round engine's coding rounds: links, sessions and results go through RoundEngineBridge.
// Still to swap: DSA_QUESTION_REPOSITORY (HR's question bank) and DSA_PROCTOR_STORE (see
// docs/dsa-integration-notes.md and docs/dsa-proctoring-implementation.md).
@Module({
  imports: [RoundEngineModule],
  controllers: [DsaController, ProctoringController, ProctoringAdminController],
  providers: [
    DsaService,
    ProctoringService,
    RoundEngineBridge,
    { provide: DSA_QUESTION_REPOSITORY, useClass: MockQuestionRepository },
    { provide: DSA_INVITATION_RESOLVER, useExisting: RoundEngineBridge },
    { provide: DSA_SESSION_STORE, useExisting: RoundEngineBridge },
    { provide: DSA_LIFECYCLE, useExisting: RoundEngineBridge },
    { provide: DSA_PROCTOR_STORE, useClass: InMemoryProctorStore },
    { provide: DSA_PROCTOR_POLICY, useFactory: () => policyFromEnv() },
    { provide: JUDGE0_CLIENT, useFactory: () => new Judge0Client(judge0OptionsFromEnv()) },
  ],
})
export class DsaModule {}
