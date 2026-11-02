import { aiScreeningDetailSchema, aiScreeningJobListSchema, type AiScreeningDetail, type AiScreeningJobList, type AiScreeningReviewStatus } from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/** M12 AI screening round - HR side. Session cookie + CSRF header; the company always comes from the session. */
const appPath = (applicationId: string) => `/screening/applications/${encodeURIComponent(applicationId)}`;

export const listJobScreenings = (jobId: string, opts: Options = {}): Promise<AiScreeningJobList> =>
  call('GET', `/screening/jobs/${encodeURIComponent(jobId)}`, undefined, (v) => aiScreeningJobListSchema.parse(v), opts);

export const getScreening = (applicationId: string, opts: Options = {}): Promise<AiScreeningDetail> =>
  call('GET', appPath(applicationId), undefined, (v) => aiScreeningDetailSchema.parse(v), opts);

export const setScreeningReview = (applicationId: string, reviewStatus: AiScreeningReviewStatus, opts: Options = {}): Promise<AiScreeningDetail> =>
  call('PUT', `${appPath(applicationId)}/review`, { reviewStatus }, (v) => aiScreeningDetailSchema.parse(v), opts);

export const retryScreeningSummary = (applicationId: string, opts: Options = {}): Promise<AiScreeningDetail> =>
  call('POST', `${appPath(applicationId)}/summary`, undefined, (v) => aiScreeningDetailSchema.parse(v), opts);
