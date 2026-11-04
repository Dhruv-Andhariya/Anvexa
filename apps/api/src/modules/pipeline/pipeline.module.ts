import { Module } from '@nestjs/common';
import { AssessmentsModule } from '../assessments';
import { RoundsConfigModule } from '../rounds-config';
import { TenantsModule } from '../tenants';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';
import { PipelineStore, PrismaPipelineStore } from './pipeline.store';

/** Hiring pipeline rules between the rounds (Stage 2 overall criterion, rejection emails, GD rubric, PI section). */
@Module({
  imports: [TenantsModule, RoundsConfigModule, AssessmentsModule],
  controllers: [PipelineController],
  providers: [PipelineService, { provide: PipelineStore, useClass: PrismaPipelineStore }],
  exports: [PipelineService],
})
export class PipelineModule {}
