// Public entry of the rounds-config module (M05). Other modules import ONLY from here.
// Round engine (teammate): RoundsConfigService.forRoundEngine() to read a job's rounds, lockForAttempts() when the
// first student starts. Results go to the assessments module (RoundResultsService.record).
export { RoundsConfigModule } from './rounds-config.module';
export { RoundModules } from './round-modules';
export { RoundsConfigService, passRuleOf, toSavedRound, type RoundsForEngine } from './rounds-config.service';
export type { StoredConfig, StoredRound, StoredQuestion } from './rounds-config.store';
