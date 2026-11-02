import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants';
import { QuestionGeneratorClient, questionGeneratorOptionsFromEnv } from './question-generator.client';
import { RoundsConfigController } from './rounds-config.controller';
import { RoundsConfigService } from './rounds-config.service';
import { PrismaRoundsConfigStore, RoundsConfigStore } from './rounds-config.store';

/**
 * M05 round configurator. Imports nothing but tenants, so the publisher (publish check) and the assessments / round
 * engine modules can import it without cycles.
 */
@Module({
  imports: [TenantsModule],
  controllers: [RoundsConfigController],
  providers: [
    RoundsConfigService,
    { provide: RoundsConfigStore, useClass: PrismaRoundsConfigStore },
    { provide: QuestionGeneratorClient, useFactory: () => new QuestionGeneratorClient(questionGeneratorOptionsFromEnv()) },
  ],
  exports: [RoundsConfigService],
})
export class RoundsConfigModule {}
