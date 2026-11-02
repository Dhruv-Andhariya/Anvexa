import {
  assessmentJobSchema,
  generateQuestionsResultSchema,
  jobAssessmentsSchema,
  jobRoundsSchema,
  studentAssessmentSchema,
  type AssessmentJob,
  type GenerateQuestionsRequest,
  type GenerateQuestionsResult,
  type JobAssessments,
  type JobRounds,
  type OverrideRoundResultRequest,
  type SaveRoundsRequest,
  type StudentAssessment,
} from '@hireflow/contracts';
import { call, type Options } from './publisher-api';

/**
 * M05 assessment rounds + their results - HR side. Session cookie + CSRF header; the company always comes from the
 * session on the server. Everything here is HR-only: none of it is ever shown on the careers page or in posts.
 */
const rounds = (jobId: string) => `/rounds/jobs/${encodeURIComponent(jobId)}`;

export const getRounds = (jobId: string, opts: Options = {}): Promise<JobRounds> =>
  call('GET', rounds(jobId), undefined, (v) => jobRoundsSchema.parse(v), opts);

/** Saves every round of the job at once. complete = false keeps it a draft. */
export const saveRounds = (jobId: string, req: SaveRoundsRequest, opts: Options = {}): Promise<JobRounds> =>
  call('PUT', rounds(jobId), req, (v) => jobRoundsSchema.parse(v), opts);

/** AI question suggestions for one round. Nothing is saved: HR keeps the ones they pick, then saves the rounds. */
export const generateQuestions = (jobId: string, req: GenerateQuestionsRequest, opts: Options = {}): Promise<GenerateQuestionsResult> =>
  call('POST', `${rounds(jobId)}/generate`, req, (v) => generateQuestionsResultSchema.parse(v), opts);

export const listAssessmentJobs = (opts: Options = {}): Promise<AssessmentJob[]> =>
  call('GET', '/assessments/jobs', undefined, (v) => assessmentJobSchema.array().parse(v), opts);

export const getJobAssessments = (jobId: string, opts: Options = {}): Promise<JobAssessments> =>
  call('GET', `/assessments/jobs/${encodeURIComponent(jobId)}`, undefined, (v) => jobAssessmentsSchema.parse(v), opts);

export const getStudentAssessment = (applicationId: string, opts: Options = {}): Promise<StudentAssessment> =>
  call('GET', `/assessments/applications/${encodeURIComponent(applicationId)}`, undefined, (v) => studentAssessmentSchema.parse(v), opts);

/** passed null = back to the system result. */
export const overrideRoundResult = (applicationId: string, roundId: string, req: OverrideRoundResultRequest, opts: Options = {}): Promise<StudentAssessment> =>
  call(
    'PUT',
    `/assessments/applications/${encodeURIComponent(applicationId)}/rounds/${encodeURIComponent(roundId)}/override`,
    req,
    (v) => studentAssessmentSchema.parse(v),
    opts,
  );
