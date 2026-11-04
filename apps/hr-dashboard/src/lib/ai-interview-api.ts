import {
  aiInterviewHrViewSchema,
  aiInterviewProtectionConfigSchema,
  type AiInterviewDecisionRequest,
  type AiInterviewHrView,
  type AiInterviewProtectionConfig,
  type AiInterviewProtectionSettings,
} from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/**
 * AI technical interview rounds of one student - HR side. Session cookie + CSRF header; the company always comes from
 * the session on the server. The AI's report is advice: HR's decision is what moves the student on.
 */
const base = (applicationId: string) => `/ai-interview/applications/${encodeURIComponent(applicationId)}`;

export const getAiInterviews = (applicationId: string, opts: Options = {}): Promise<AiInterviewHrView> =>
  call('GET', base(applicationId), undefined, (v) => aiInterviewHrViewSchema.parse(v), opts);

export const decideAiInterview = (applicationId: string, roundId: string, req: AiInterviewDecisionRequest, opts: Options = {}): Promise<AiInterviewHrView> =>
  call('POST', `${base(applicationId)}/rounds/${encodeURIComponent(roundId)}/decision`, req, (v) => aiInterviewHrViewSchema.parse(v), opts);

const protectionPath = (jobId: string, roundId: string) => `/ai-interview/jobs/${encodeURIComponent(jobId)}/rounds/${encodeURIComponent(roundId)}/protection`;

/** The round's interview protection rules (warnings, monitoring, device policy). */
export const getInterviewProtection = (jobId: string, roundId: string, opts: Options = {}): Promise<AiInterviewProtectionConfig> =>
  call('GET', protectionPath(jobId, roundId), undefined, (v) => aiInterviewProtectionConfigSchema.parse(v), opts);

export const saveInterviewProtection = (jobId: string, roundId: string, settings: AiInterviewProtectionSettings, opts: Options = {}): Promise<AiInterviewProtectionConfig> =>
  call('PUT', protectionPath(jobId, roundId), settings, (v) => aiInterviewProtectionConfigSchema.parse(v), opts);

export const retryAiInterviewReport =(applicationId: string, roundId: string, opts: Options = {}): Promise<AiInterviewHrView> =>
  call('POST', `${base(applicationId)}/rounds/${encodeURIComponent(roundId)}/report`, {}, (v) => aiInterviewHrViewSchema.parse(v), opts);
