import type { Prisma } from '@prisma/client';
import { uuidv7 } from '../../common/uuidv7';

/**
 * Automatic decision emails. A resume that could not be screened (NEEDS_REVIEW, still pending) never gets either:
 * a technical problem is neither a rejection nor a shortlist.
 *  - Rejection (env AUTO_REJECTION_EMAILS, default on): a screened candidate who is not shortlisted - below the job's
 *    minimum ATS score, or set to "not shortlisted" by HR - gets the rejection email right away.
 *  - Shortlist (env AUTO_SHORTLIST_EMAILS, default on): a screened candidate who is shortlisted - at or above the
 *    minimum ATS score, or shortlisted by HR - gets the shortlist email with their AI screening link right away
 *    (held in the queue until that link is public, then sent by itself - never by an HR click).
 * Both go through the same queue (candidate_emails, one email per application) and DecisionEmailSender.
 */
export const AUTO_REJECTION = Symbol('AUTO_REJECTION');
export const AUTO_SHORTLIST = Symbol('AUTO_SHORTLIST');

const isOff = (raw: string | undefined) => ['off', 'false', '0'].includes((raw ?? '').trim().toLowerCase());

export const autoRejectionFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.AUTO_REJECTION_EMAILS);

/**
 * On by default: no HR click is ever needed. The email is always queued; DecisionEmailSender holds it until the
 * screening link is public (a student must never get a localhost link) and then sends it by itself.
 */
export const autoShortlistFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !isOff(env.AUTO_SHORTLIST_EMAILS);

/** Prisma client or transaction client: only the two tables used here. */
type Db = Pick<Prisma.TransactionClient, 'atsEvaluation' | 'candidateEmail'>;

/**
 * Queues the rejection email for every not-shortlisted, screened candidate of this company matching `scope` who has
 * no decision email yet. One email per candidate (unique application_id). Returns the application ids queued.
 */
export async function queueAutoRejections(db: Db, tenantId: string, scope: { jobId?: string; applicationIds?: string[] }): Promise<string[]> {
  const rows = await db.atsEvaluation.findMany({
    where: {
      tenantId,
      ...(scope.jobId ? { jobId: scope.jobId } : {}),
      ...(scope.applicationIds ? { applicationId: { in: scope.applicationIds } } : {}),
      status: 'SCORED',
      OR: [{ hrDecision: 'NOT_SHORTLISTED' }, { hrDecision: null, systemDecision: 'NOT_SHORTLISTED' }],
      application: { decisionEmail: { is: null } },
    },
    select: { applicationId: true },
  });
  if (!rows.length) return [];
  await db.candidateEmail.createMany({
    data: rows.map((r) => ({ id: uuidv7(), tenantId, applicationId: r.applicationId, kind: 'REJECTION' as const, requestedById: null })),
    skipDuplicates: true,
  });
  return rows.map((r) => r.applicationId);
}

/**
 * Queues the shortlist email for every shortlisted, screened candidate of this company matching `scope` who has no
 * decision email yet. Same rules as queueAutoRejections. Returns the application ids queued.
 */
export async function queueAutoShortlists(db: Db, tenantId: string, scope: { jobId?: string; applicationIds?: string[] }): Promise<string[]> {
  const rows = await db.atsEvaluation.findMany({
    where: {
      tenantId,
      ...(scope.jobId ? { jobId: scope.jobId } : {}),
      ...(scope.applicationIds ? { applicationId: { in: scope.applicationIds } } : {}),
      status: 'SCORED',
      OR: [{ hrDecision: 'SHORTLISTED' }, { hrDecision: null, systemDecision: 'SHORTLISTED' }],
      application: { decisionEmail: { is: null } },
    },
    select: { applicationId: true },
  });
  if (!rows.length) return [];
  await db.candidateEmail.createMany({
    data: rows.map((r) => ({ id: uuidv7(), tenantId, applicationId: r.applicationId, kind: 'SHORTLIST' as const, requestedById: null })),
    skipDuplicates: true,
  });
  return rows.map((r) => r.applicationId);
}
