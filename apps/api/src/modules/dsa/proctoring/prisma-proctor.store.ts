import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma.service';
import { splitAssessmentId } from '../session/round-invitation.resolver';
import type { ProctorStore } from './proctoring.store';
import type { ProctorSession } from './proctoring.types';

const LIST_LIMIT = 500;

/**
 * Integrity events of HR rounds, kept in table dsa_proctor_sessions (one row per invitation, found by its hash
 * reference). The row belongs to the application and goes with it when the application is erased. Only HR rounds are
 * stored: a record whose assessment id is not "<applicationId>.<roundId>" (demo tokens) is refused.
 */
@Injectable()
export class PrismaProctorStore implements ProctorStore {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async get(inviteRef: string): Promise<ProctorSession | undefined> {
    const row = await this.db.dsaProctorSession.findUnique({ where: { inviteRef }, select: { session: true } });
    return row ? (row.session as unknown as ProctorSession) : undefined;
  }

  async save(session: ProctorSession): Promise<void> {
    const json = session as unknown as Prisma.InputJsonObject;
    const updated = await this.db.dsaProctorSession.updateMany({ where: { inviteRef: session.inviteRef }, data: { session: json } });
    if (updated.count > 0) return;
    const ids = splitAssessmentId(session.assessmentId);
    if (!ids) throw new Error('proctoring records are only stored for HR rounds');
    const app = await this.db.application.findUnique({ where: { id: ids.applicationId }, select: { tenantId: true } });
    if (!app) throw new Error('application not found for the proctoring record');
    await this.db.dsaProctorSession.createMany({
      data: { inviteRef: session.inviteRef, tenantId: app.tenantId, applicationId: ids.applicationId, roundId: ids.roundId, session: json },
      skipDuplicates: true, // two first events at once: the second one is written by the update below
    });
    await this.db.dsaProctorSession.updateMany({ where: { inviteRef: session.inviteRef }, data: { session: json } });
  }

  /** One company's records of one application (HR review). Another company's ids find nothing. */
  async forApplication(tenantId: string, applicationId: string): Promise<{ roundId: string; session: ProctorSession }[]> {
    const rows = await this.db.dsaProctorSession.findMany({ where: { tenantId, applicationId }, orderBy: { createdAt: 'asc' }, select: { roundId: true, session: true } });
    return rows.map((r) => ({ roundId: r.roundId, session: r.session as unknown as ProctorSession }));
  }

  async list(): Promise<ProctorSession[]> {
    const rows = await this.db.dsaProctorSession.findMany({ orderBy: { updatedAt: 'desc' }, take: LIST_LIMIT, select: { session: true } });
    return rows.map((r) => r.session as unknown as ProctorSession);
  }
}
