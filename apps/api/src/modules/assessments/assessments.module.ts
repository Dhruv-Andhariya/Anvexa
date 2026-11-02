import { Module } from '@nestjs/common';
import { RoundsConfigModule } from '../rounds-config';
import { TenantsModule } from '../tenants';
import { AssessmentsController } from './assessments.controller';
import { AssessmentsService } from './assessments.service';
import { AssessmentsStore, PrismaAssessmentsStore } from './assessments.store';

/** Results of the assessment rounds (written by the round engine, read and overridden by HR). */
@Module({
  imports: [TenantsModule, RoundsConfigModule],
  controllers: [AssessmentsController],
  providers: [AssessmentsService, { provide: AssessmentsStore, useClass: PrismaAssessmentsStore }],
  exports: [AssessmentsService],
})
export class AssessmentsModule {}
