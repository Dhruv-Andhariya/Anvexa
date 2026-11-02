import { Injectable, Logger } from '@nestjs/common';
import { jobPublishedEvent, jobPublishFailedEvent } from '@hireflow/contracts';
import { uuidv7 } from '../../common/uuidv7';

/**
 * Emits M06 events in the doc 10.4 envelope. There is no event bus yet (M30), so for now the
 * event is validated against packages/contracts and logged (ids only, no content).
 * TODO(M30): write to the outbox table instead of logging when the event bus lands.
 */
@Injectable()
export class PublisherEvents {
  private readonly logger = new Logger('PublisherEvents');

  published(tenantId: string, data: { job_id: string; channel: string; external_id: string | null; url: string | null }) {
    this.emit(jobPublishedEvent.parse(this.envelope('job.published', tenantId, data.job_id, data)));
  }

  failed(tenantId: string, data: { job_id: string; channel: string; error: string }) {
    this.emit(jobPublishFailedEvent.parse(this.envelope('job.publish_failed', tenantId, data.job_id, data)));
  }

  private envelope<T>(type: string, tenantId: string, jobId: string, data: T) {
    return {
      id: `evt_${uuidv7()}`,
      type,
      version: 1,
      tenant_id: tenantId,
      occurred_at: new Date().toISOString(),
      correlation_id: jobId,
      producer: 'publisher',
      data,
    };
  }

  private emit(evt: { type: string; tenant_id: string; data: { job_id: string; channel: string } }) {
    this.logger.log(`${evt.type} tenant=${evt.tenant_id} job=${evt.data.job_id} channel=${evt.data.channel}`);
  }
}
