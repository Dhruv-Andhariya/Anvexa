import { z } from 'zod';
import { eventEnvelope } from './envelope';
import { jobFormSchema } from '../schemas/job';
import { atsScoreSchema } from '../schemas/resume';

// Add every event from doc section 10.5 here, one per line. The producer owns the schema.
export const jobCreatedEvent = eventEnvelope('job.created', z.object({ job_id: z.string(), form: jobFormSchema }));
export const applicationReceivedEvent = eventEnvelope(
  'application.received',
  z.object({ application_id: z.string(), job_id: z.string(), source: z.string() }),
);
export const atsScoredEvent = eventEnvelope('ats.scored', atsScoreSchema);
// M06 publisher (one event per channel)
export const jobPublishedEvent = eventEnvelope(
  'job.published',
  z.object({ job_id: z.string(), channel: z.string(), external_id: z.string().nullable(), url: z.string().nullable() }),
);
export const jobPublishFailedEvent = eventEnvelope(
  'job.publish_failed',
  z.object({ job_id: z.string(), channel: z.string(), error: z.string() }),
);

export { eventEnvelope };
