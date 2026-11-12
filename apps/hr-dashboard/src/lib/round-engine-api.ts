import {
  applicationRoundEngineSchema,
  type ApplicationRoundEngine,
  type AssessmentIntegrityDecisionRequest,
  type DsaProctoringReview,
  type ProctorIncidentReviewRequest,
} from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/**
 * M13 online test rounds - HR side: invitation, attempt, proctoring events and outcome email of each round of one
 * student. Session cookie + CSRF header; the company always comes from the session on the server.
 */
const app = (applicationId: string) => `/round-engine/applications/${encodeURIComponent(applicationId)}`;
const parse = (v: unknown) => applicationRoundEngineSchema.parse(v);

export const getRoundEngine = (applicationId: string, opts: Options = {}): Promise<ApplicationRoundEngine> =>
  call('GET', app(applicationId), undefined, parse, opts);

/** The candidate's link stops working at once. */
export const revokeRoundInvite = (applicationId: string, roundId: string, opts: Options = {}): Promise<ApplicationRoundEngine> =>
  call('POST', `${app(applicationId)}/rounds/${encodeURIComponent(roundId)}/revoke`, undefined, parse, opts);

/** A test ended by the warning limit: HR's reviewed decision (then the usual next step follows, once). */
export const decideRoundIntegrity = (applicationId: string, roundId: string, req: AssessmentIntegrityDecisionRequest, opts: Options = {}): Promise<ApplicationRoundEngine> =>
  call('POST', `${app(applicationId)}/rounds/${encodeURIComponent(roundId)}/integrity-decision`, req, parse, opts);

/** Only after the invitation email FAILED: a new link is emailed. */
export const resendRoundInvite = (applicationId: string, roundId: string, opts: Options = {}): Promise<ApplicationRoundEngine> =>
  call('POST', `${app(applicationId)}/rounds/${encodeURIComponent(roundId)}/resend`, undefined, parse, opts);

const parseReview = (v: unknown): DsaProctoringReview => {
  const r = v as Partial<DsaProctoringReview> | null;
  if (!r || typeof r.applicationId !== 'string' || !Array.isArray(r.rounds)) throw new Error('Unexpected response');
  return r as DsaProctoringReview;
};

/** The student's DSA / SQL proctoring records: warnings, incidents, termination, reviews. */
export const getDsaProctoring = (applicationId: string, opts: Options = {}): Promise<DsaProctoringReview> =>
  call('GET', `/dsa-hr/applications/${encodeURIComponent(applicationId)}/proctoring`, undefined, parseReview, opts);

/** Confirm / dismiss / mark for further review one incident, with a reason (audited; never changes a score). */
export const reviewProctorIncident = (applicationId: string, roundId: string, incidentId: number, req: ProctorIncidentReviewRequest, opts: Options = {}): Promise<DsaProctoringReview> =>
  call(
    'PUT',
    `/dsa-hr/applications/${encodeURIComponent(applicationId)}/proctoring/${encodeURIComponent(roundId)}/incidents/${incidentId}/review`,
    req,
    parseReview,
    opts,
  );
