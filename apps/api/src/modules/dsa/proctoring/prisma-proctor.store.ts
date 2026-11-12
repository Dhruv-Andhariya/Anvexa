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
    await this.create(this.db, session);
    await this.db.dsaProctorSession.updateMany({ where: { inviteRef: session.inviteRef }, data: { session: json } });
  }

  /**
   * The record's row lock (SELECT ... FOR UPDATE inside a transaction): reports of one attempt are decided one after
   * the other, so two simultaneous reports can never both use up "the last" warning or terminate twice.
   */
  async withLock<T>(inviteRef: string, init: () => ProctorSession, fn: (session: ProctorSession) => T): Promise<T> {
    return this.db.$transaction(async (tx) => {
      let rows = await tx.$queryRaw<{ session: unknown }[]>`SELECT session FROM dsa_proctor_sessions WHERE invite_ref = ${inviteRef} FOR UPDATE`;
      if (rows.length === 0) {
        await this.create(tx, init()); // two first reports at once: the second one finds the row made by the first
        rows = await tx.$queryRaw<{ session: unknown }[]>`SELECT session FROM dsa_proctor_sessions WHERE invite_ref = ${inviteRef} FOR UPDATE`;
      }
      const session = rows[0]!.session as ProctorSession;
      const result = fn(session);
      await tx.dsaProctorSession.update({ where: { inviteRef }, data: { session: session as unknown as Prisma.InputJsonObject } });
      return result;
    });
  }

  private async create(db: Pick<PrismaService, 'dsaProctorSession' | 'application'>, session: ProctorSession): Promise<void> {
    const ids = splitAssessmentId(session.assessmentId);
    if (!ids) throw new Error('proctoring records are only stored for HR rounds');
    const app = await db.application.findUnique({ where: { id: ids.applicationId }, select: { tenantId: true } });
    if (!app) throw new Error('application not found for the proctoring record');
    await db.dsaProctorSession.createMany({
      data: { inviteRef: session.inviteRef, tenantId: app.tenantId, applicationId: ids.applicationId, roundId: ids.roundId, session: session as unknown as Prisma.InputJsonObject },
      skipDuplicates: true,
    });
  }

  /** One company's records of one application (HR review). Another company's ids find nothing. */
  async forApplication(tenantId: string, applicationId: string): Promise<{ inviteRef: string; roundId: string; session: ProctorSession }[]> {
    const rows = await this.db.dsaProctorSession.findMany({
      where: { tenantId, applicationId },
      orderBy: { createdAt: 'asc' },
      select: { inviteRef: true, roundId: true, session: true },
    });
    return rows.map((r) => ({ inviteRef: r.inviteRef, roundId: r.roundId, session: r.session as unknown as ProctorSession }));
  }

  async list(): Promise<ProctorSession[]> {
    const rows = await this.db.dsaProctorSession.findMany({ orderBy: { updatedAt: 'desc' }, take: LIST_LIMIT, select: { session: true } });
    return rows.map((r) => r.session as unknown as ProctorSession);
  }
}
