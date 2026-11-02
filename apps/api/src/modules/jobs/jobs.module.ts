import { Module } from '@nestjs/common';
import { ApplicationsModule } from '../applications';
import { ScreeningSettingsModule } from '../ats/settings';
import { PublisherModule } from '../publisher';
import { TenantsModule } from '../tenants';
import { AiWorkerClient, aiWorkerOptionsFromEnv } from './ai-worker.client';
import { JobsController } from './jobs.controller';
import { JobsRepository, PrismaJobsRepository } from './jobs.repository';
import { JobsService } from './jobs.service';

@Module({
  imports: [TenantsModule, ScreeningSettingsModule, PublisherModule, ApplicationsModule],
  controllers: [JobsController],
  providers: [
    JobsService,
    { provide: JobsRepository, useClass: PrismaJobsRepository },
    { provide: AiWorkerClient, useFactory: () => new AiWorkerClient(aiWorkerOptionsFromEnv()) },
  ],
})
export class JobsModule {}
