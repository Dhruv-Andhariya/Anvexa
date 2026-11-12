import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { proctorIncidentReviewRequestSchema, proctorIncidentTypeOf, type DsaProctoringReview } from '@hireflow/contracts';
import { AuditService } from '../../audit';
import type { Actor } from '../../tenants';
import { dsaError } from '../dsa.dto';
import { ProctoringService } from './proctoring.service';
import type { ProctorSession } from './proctoring.types';

/** At most this many events per round are sent to the HR page (the full log stays in the database). */
const EVENT_LIMIT = 300;

/** One company's proctoring records of one application (PrismaProctorStore in production). */
export interface ProctorRecordsByApplication {
  forApplication(tenantId: string, applicationId: string): Promise<{ inviteRef: string; roundId: string; session: ProctorSession }[]>;
}
export const DSA_PROCTOR_RECORDS = Symbol('DSA_PROCTOR_RECORDS');

const MODULE = { code: 'DSA', sql: 'SQL', mixed: 'MIXED' } as const;

/**
 * HR's review of the DSA / SQL proctoring records. The company always comes from the HR session (the caller), so
 * another company's application or round finds nothing (404). Reviewing an incident stores who, when and why, and is
 * audited; it never changes a score, the warning count or a termination (the integrity decision does that, separately).
 */
@Injectable()
export class ProctoringHrService {
  constructor(
    @Inject(DSA_PROCTOR_RECORDS) private readonly records: ProctorRecordsByApplication,
    @Inject(ProctoringService) private readonly proctoring: ProctoringService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async review(tenantId: string, applicationId: string): Promise<DsaProctoringReview> {
    const rows = await this.records.forApplication(tenantId, applicationId);
    return {
      applicationId,
      rounds: rows.map(({ roundId, session }) => {
        const { summary: s, events } = this.proctoring.reviewOf(session, EVENT_LIMIT);
        return {
          roundId,
          module: session.kind ? MODULE[session.kind] : null,
          warningCount: s.strikesUsed,
          maxWarnings: s.strikesAllowed,
          terminatedAt: s.terminatedAt,
          terminationReason: s.terminationReason,
          cameraMonitored: session.camera === true,
          detectionVersion: session.detectionVersion ?? null,
          status: s.status,
          flagged: s.flagged,
          reasons: s.reasons,
          totalViolations: s.totalViolations,
          strikesAllowed: s.strikesAllowed,
          strikesUsed: s.strikesUsed,
          fullscreenExitCount: s.fullscreenExitCount,
          tabSwitchCount: s.tabSwitchCount,
          copyPasteAttempts: s.copyPasteAttempts,
          devToolsAttempts: s.devToolsAttempts,
          cameraOffCount: s.cameraOffCount,
          noFaceCount: s.noFaceCount,
          multipleFacesCount: s.multipleFacesCount,
          totalTimeOutsideMs: s.totalTimeOutsideMs,
          incidents: events.map((e) => ({
            id: e.id,
            type: e.type,
            category: proctorIncidentTypeOf(e.type),
            at: e.at,
            durationMs: e.durationMs,
            confidence: e.confidence,
            detail: e.detail,
            outcome: (e.outcome as NonNullable<DsaProctoringReview['rounds'][number]['incidents']>[number]['outcome']) ?? (e.strike !== null ? 'WARNING' : null),
            warningNumber: e.strike,
            note: e.note,
            evidence: 'METADATA_ONLY' as const,
            review: e.review,
          })),
          events: events.map((e) => ({ type: e.type, severity: e.severity, at: e.at, durationMs: e.durationMs, detail: e.detail })),
        };
      }),
    };
  }

  /** HR marks one incident Confirmed / Dismissed / Requires further review, with a reason. */
  async reviewIncident(tenantId: string, applicationId: string, roundId: string, incidentId: number, body: unknown, actor: Actor | null): Promise<DsaProctoringReview> {
    const parsed = proctorIncidentReviewRequestSchema.safeParse(body);
    if (!parsed.success) throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REVIEW', parsed.error.issues[0]?.message ?? 'Invalid review.');
    const row = (await this.records.forApplication(tenantId, applicationId)).find((r) => r.roundId === roundId);
    const before = row?.session.events.find((e) => e.id === incidentId);
    if (!row || !before) throw dsaError(HttpStatus.NOT_FOUND, 'INCIDENT_NOT_FOUND', 'This incident does not exist.');
    const review = { status: parsed.data.status, reason: parsed.data.reason, by: actor?.name ?? null, at: new Date().toISOString() };
    if (!(await this.proctoring.reviewIncident(row.inviteRef, incidentId, review))) {
      throw dsaError(HttpStatus.NOT_FOUND, 'INCIDENT_NOT_FOUND', 'This incident does not exist.');
    }
    await this.audit.record({
      tenantId,
      actorUserId: actor?.id ?? null,
      action: 'proctoring.incident_reviewed',
      subjectType: 'application',
      subjectId: applicationId,
      metadata: { roundId, incidentId, type: before.type, outcome: before.outcome ?? null, status: review.status, previousStatus: before.review?.status ?? null, reason: review.reason },
    });
    return this.review(tenantId, applicationId);
  }
}
