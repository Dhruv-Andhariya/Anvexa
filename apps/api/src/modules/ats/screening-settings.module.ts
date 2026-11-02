import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants';
import { ScreeningSettingsController } from './screening-settings.controller';
import { AUTO_REJECTION, AUTO_SHORTLIST, autoRejectionFromEnv, autoShortlistFromEnv } from './auto-rejection';
import { ScreeningSettingsService } from './screening-settings.service';

/**
 * The per-job minimum ATS score on its own, so the jobs module (job creation) and the publisher (publish check) can
 * use it without depending on the ATS worker and its imports.
 */
@Module({
  imports: [TenantsModule],
  controllers: [ScreeningSettingsController],
  providers: [
    ScreeningSettingsService,
    { provide: AUTO_REJECTION, useFactory: () => autoRejectionFromEnv() },
    { provide: AUTO_SHORTLIST, useFactory: () => autoShortlistFromEnv() },
  ],
  exports: [ScreeningSettingsService, AUTO_REJECTION, AUTO_SHORTLIST],
})
export class ScreeningSettingsModule {}
