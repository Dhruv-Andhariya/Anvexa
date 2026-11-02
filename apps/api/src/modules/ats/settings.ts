// Second public entry of the ats module: ONLY the per-job screening settings. The jobs and publisher modules import
// from here (not from index.ts) so they never load AtsModule, which itself imports applications -> publisher.
export { ScreeningSettingsModule } from './screening-settings.module';
export { ScreeningSettingsService } from './screening-settings.service';
