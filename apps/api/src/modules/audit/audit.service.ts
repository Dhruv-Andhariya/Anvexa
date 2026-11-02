import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';

export interface AuditEntry {
  tenantId: string | null;
  actorUserId: string | null;
  action: string; // e.g. "job.approved"
  subjectType?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
}

/** M32: append-only record of who did what. Never store passwords, tokens or JD text here. */
export abstract class AuditService {
  abstract record(entry: AuditEntry): Promise<void>;
}

@Injectable()
export class PrismaAuditService extends AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async record(entry: AuditEntry) {
    try {
      await this.prisma.auditLog.create({
        data: { ...entry, metadata: entry.metadata as Prisma.InputJsonObject | undefined },
      });
    } catch (err) {
      // the action already happened; a failed audit write must be visible in the logs but not undo it
      this.logger.error(`could not write audit entry ${entry.action}: ${(err as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [{ provide: AuditService, useClass: PrismaAuditService }], exports: [AuditService] })
export class AuditModule {}
