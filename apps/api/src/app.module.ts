import { Module } from '@nestjs/common';
import { PrismaModule } from './common/prisma.service';
import { HealthController } from './health.controller';
import { AuditModule } from './modules/audit';
import { ApplicationsModule } from './modules/applications';
import { AssessmentsModule } from './modules/assessments';
import { AtsModule } from './modules/ats';
import { AuthModule } from './modules/auth';
import { DsaModule } from './modules/dsa';
import { GroupDiscussionModule } from './modules/group-discussion';
import { JobsModule } from './modules/jobs';
import { PublisherModule } from './modules/publisher';
import { RoundEngineModule } from './modules/round-engine';
import { RoundsConfigModule } from './modules/rounds-config';
import { ScreeningModule } from './modules/screening';
import { TenantsModule } from './modules/tenants';

// Each intern registers THEIR module here with one import line (one-line conflicts are easy to fix).
// Pattern:  imports: [JobsModule, ApplicationsModule, AtsModule]
// AuthModule registers the global AuthGuard: every route must declare its access (see modules/auth/access.ts).
@Module({ imports: [PrismaModule, AuditModule, AuthModule, TenantsModule, JobsModule, PublisherModule, ApplicationsModule, AtsModule, ScreeningModule, RoundsConfigModule, AssessmentsModule, RoundEngineModule, DsaModule, GroupDiscussionModule], controllers: [HealthController] })
export class AppModule {}
