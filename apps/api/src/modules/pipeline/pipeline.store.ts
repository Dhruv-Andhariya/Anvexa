import { Inject, Injectable } from '@nestjs/common';
import type { PiCallStatus, PipelineSettings, RubricParameter } from '@hireflow/contracts';
import { PrismaService } from '../../common/prisma.service';

export interface PiCallRow {
  applicationId: string;
  status: PiCallStatus;
  notes: string;
  updatedByName: string | null;
  updatedAt: Date;
}

/** All database access of the pipeline module (tests use the in-memory store). */
export abstract class PipelineStore {
  abstract getSettings(tenantId: string, jobId: string): Promise<PipelineSettings | null>;
  abstract saveSettings(tenantId: string, jobId: string, s: PipelineSettings, actorId: string | null): Promise<void>;
  abstract getRubric(tenantId: string, roundId: string): Promise<RubricParameter[] | null>;
  abstract saveRubric(tenantId: string, jobId: string, roundId: string, parameters: RubricParameter[], actorId: string | null): Promise<void>;
  abstract deleteRubric(tenantId: string, roundId: string): Promise<void>;
  abstract listPiCalls(tenantId: string, jobId: string): Promise<PiCallRow[]>;
  abstract savePiCall(tenantId: string, jobId: string, applicationId: string, call: { status: PiCallStatus; notes: string }, actor: { id: string; name: string } | null): Promise<void>;
}

@Injectable()
export class PrismaPipelineStore extends PipelineStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {
    super();
  }

  async getSettings(tenantId: string, jobId: string) {
    const row = await this.db.jobPipelineSettings.findFirst({ where: { tenantId, jobId } });
    return row ? { stage2Rule: row.stage2Rule, stage2MinPercent: row.stage2MinPercent, rejectionEmails: row.rejectionEmails } : null;
  }

  async saveSettings(tenantId: string, jobId: string, s: PipelineSettings, actorId: string | null) {
    const data = { stage2Rule: s.stage2Rule, stage2MinPercent: s.stage2MinPercent, rejectionEmails: s.rejectionEmails, updatedById: actorId };
    await this.db.jobPipelineSettings.upsert({ where: { jobId }, create: { jobId, tenantId, ...data }, update: data });
  }

  async getRubric(tenantId: string, roundId: string) {
    const row = await this.db.roundRubric.findFirst({ where: { tenantId, roundId } });
    return row ? (row.parameters as unknown as RubricParameter[]) : null;
  }

  async saveRubric(tenantId: string, jobId: string, roundId: string, parameters: RubricParameter[], actorId: string | null) {
    const json = parameters as unknown as object[];
    await this.db.roundRubric.upsert({
      where: { roundId },
      create: { roundId, tenantId, jobId, parameters: json, updatedById: actorId },
      update: { parameters: json, updatedById: actorId },
    });
  }

  async deleteRubric(tenantId: string, roundId: string) {
    await this.db.roundRubric.deleteMany({ where: { tenantId, roundId } });
  }

  async listPiCalls(tenantId: string, jobId: string) {
    const rows = await this.db.piCall.findMany({ where: { tenantId, jobId } });
    return rows.map((r) => ({ applicationId: r.applicationId, status: r.status, notes: r.notes, updatedByName: r.updatedByName, updatedAt: r.updatedAt }));
  }

  async savePiCall(tenantId: string, jobId: string, applicationId: string, call: { status: PiCallStatus; notes: string }, actor: { id: string; name: string } | null) {
    const data = { status: call.status, notes: call.notes, updatedById: actor?.id ?? null, updatedByName: actor?.name ?? null };
    await this.db.piCall.upsert({ where: { applicationId }, create: { applicationId, tenantId, jobId, ...data }, update: data });
  }
}

/** For tests. */
export class MemoryPipelineStore extends PipelineStore {
  readonly settings = new Map<string, PipelineSettings>();
  readonly rubrics = new Map<string, RubricParameter[]>();
  readonly calls = new Map<string, PiCallRow & { jobId: string }>();

  async getSettings(_t: string, jobId: string) {
    return this.settings.get(jobId) ?? null;
  }
  async saveSettings(_t: string, jobId: string, s: PipelineSettings) {
    this.settings.set(jobId, { ...s });
  }
  async getRubric(_t: string, roundId: string) {
    return this.rubrics.get(roundId) ?? null;
  }
  async saveRubric(_t: string, _j: string, roundId: string, parameters: RubricParameter[]) {
    this.rubrics.set(roundId, parameters.map((p) => ({ ...p })));
  }
  async deleteRubric(_t: string, roundId: string) {
    this.rubrics.delete(roundId);
  }
  async listPiCalls(_t: string, jobId: string) {
    return [...this.calls.values()].filter((c) => c.jobId === jobId);
  }
  async savePiCall(_t: string, jobId: string, applicationId: string, call: { status: PiCallStatus; notes: string }, actor: { id: string; name: string } | null) {
    this.calls.set(applicationId, { applicationId, jobId, ...call, updatedByName: actor?.name ?? null, updatedAt: new Date() });
  }
}
