import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications';
import { GroupDiscussionModule } from '../group-discussion';
import { RoundEngineModule } from '../round-engine';
import { RoundsConfigModule } from '../rounds-config';
import { SqlModule } from '../sql';
import { TenantsModule } from '../tenants';
import { CodingAuthorClient, codingAuthorOptionsFromEnv } from './authoring/coding-author.client';
import { CodingAuthorController } from './authoring/coding-author.controller';
import { CODING_AUTHOR_CLIENT, CodingAuthorService } from './authoring/coding-author.service';
import { DsaHrController } from './dsa-hr.controller';
import { DsaController } from './dsa.controller';
import { DsaService } from './dsa.service';
import { CODE_RUNNER } from './execution/code-runner';
import { PistonRunner, pistonOptionsFromEnv } from './execution/piston.runner';
import { ProctoringAdminController } from './proctoring/proctoring-admin.controller';
import { DSA_PROCTOR_RECORDS, ProctoringHrService } from './proctoring/proctoring-hr.service';
import { ProctoringController } from './proctoring/proctoring.controller';
import { DSA_PROCTOR_POLICY, policyFromEnv } from './proctoring/proctoring.policy';
import { ProctoringService } from './proctoring/proctoring.service';
import { PrismaProctorStore } from './proctoring/prisma-proctor.store';
import { DSA_PROCTOR_STORE, InMemoryProctorStore } from './proctoring/proctoring.store';
import { BankQuestionRepository } from './questions/bank-question.repository';
import { DSA_QUESTION_REPOSITORY } from './questions/question.repository';
import { EngineSessionStore } from './session/engine-session.store';
import { DSA_INVITATION_RESOLVER, DemoInvitationResolver } from './session/invitation.resolver';
import { RoundInvitationResolver } from './session/round-invitation.resolver';
import { DSA_SESSION_STORE, InMemorySessionStore } from './session/session.store';

/**
 * DSA_DEMO_MODE=on switches the module to the demo tokens (DSA_DEMO_TOKENS / the two built-in ones) with everything
 * kept in memory: for trying the page without an HR round. Off (default): the real thing, where the link token comes
 * from the round engine's invitation email and the attempt, result and proctoring record live in the database.
 */
const demoMode = () => ['on', 'true', '1'].includes((process.env.DSA_DEMO_MODE ?? '').trim().toLowerCase());

@Module({
  // SqlModule: the SQL sandbox that runs the queries of SQL problems (SQL rounds use this same coding page)
  imports: [ApplicationsModule, GroupDiscussionModule, RoundEngineModule, RoundsConfigModule, TenantsModule, SqlModule],
  controllers: [DsaController, ProctoringController, ProctoringAdminController, DsaHrController, CodingAuthorController],
  providers: [
    DsaService,
    ProctoringService,
    RoundInvitationResolver,
    DemoInvitationResolver,
    EngineSessionStore,
    InMemorySessionStore,
    PrismaProctorStore,
    InMemoryProctorStore,
    ProctoringHrService,
    { provide: DSA_PROCTOR_RECORDS, useExisting: PrismaProctorStore },
    { provide: DSA_QUESTION_REPOSITORY, useClass: BankQuestionRepository },
    {
      provide: DSA_INVITATION_RESOLVER,
      useFactory: (round: RoundInvitationResolver, demo: DemoInvitationResolver) => (demoMode() ? demo : round),
      inject: [RoundInvitationResolver, DemoInvitationResolver],
    },
    {
      provide: DSA_SESSION_STORE,
      useFactory: (engine: EngineSessionStore, memory: InMemorySessionStore) => (demoMode() ? memory : engine),
      inject: [EngineSessionStore, InMemorySessionStore],
    },
    {
      provide: DSA_PROCTOR_STORE,
      useFactory: (db: PrismaProctorStore, memory: InMemoryProctorStore) => (demoMode() ? memory : db),
      inject: [PrismaProctorStore, InMemoryProctorStore],
    },
    { provide: DSA_PROCTOR_POLICY, useFactory: () => policyFromEnv() },
    // The engine that runs candidate code: Piston on the hosting machine (docs/dsa-piston-hosting.md).
    { provide: CODE_RUNNER, useFactory: () => new PistonRunner(pistonOptionsFromEnv()) },
    // HR's rounds editor: coding problems from the AI worker or HR's file (solutions run on the code runner)
    CodingAuthorService,
    { provide: CODING_AUTHOR_CLIENT, useFactory: () => new CodingAuthorClient(codingAuthorOptionsFromEnv()) },
  ],
})
export class DsaModule {}
