import { applicationRoundEngineSchema, type ApplicationRoundEngine } from '@hireflow/contracts';
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

/** Only after the invitation email FAILED: a new link is emailed. */
export const resendRoundInvite = (applicationId: string, roundId: string, opts: Options = {}): Promise<ApplicationRoundEngine> =>
  call('POST', `${app(applicationId)}/rounds/${encodeURIComponent(roundId)}/resend`, undefined, parse, opts);
