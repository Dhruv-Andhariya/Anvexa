// Public entry of the assessments module. Other modules import ONLY from here.
// Round engine (teammate): AssessmentsService.record(tenantId, RoundResultInput) after each finished round.
export { AssessmentsModule } from './assessments.module';
export { AssessmentsService, type RecordedResult } from './assessments.service';
