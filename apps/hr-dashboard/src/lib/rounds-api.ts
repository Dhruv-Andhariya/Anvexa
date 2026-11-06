import {
  assessmentJobSchema,
  generateQuestionsResultSchema,
  jobAssessmentsSchema,
  jobRoundsSchema,
  studentAssessmentSchema,
  type AssessmentJob,
  type CodingProblemsGenerateRequest,
  type CodingProblemsResult,
  type GenerateQuestionsRequest,
  type GenerateQuestionsResult,
  type JobAssessments,
  type JobRounds,
  type OverrideRoundResultRequest,
  type PassRuleChangeResult,
  type PassRuleInput,
  type SaveRoundsRequest,
  type SkipRoundResult,
  type StudentAssessment,
} from '@hireflow/contracts';
import { API_URL, ApiError } from './api';
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

const skipResult = (v: unknown): SkipRoundResult => {
  const o = (v ?? {}) as { rounds?: unknown; movedOn?: unknown; inProgress?: unknown };
  return { rounds: jobRoundsSchema.parse(o.rounds), movedOn: Number(o.movedOn) || 0, inProgress: Number(o.inProgress) || 0 };
};

/**
 * Skips one round for the whole job (works after students started too): students who pass the round before it get the
 * next round that runs; students waiting for it move on at once.
 */
export const skipRound = (jobId: string, roundId: string, reason: string, opts: Options = {}): Promise<SkipRoundResult> =>
  call('POST', `${rounds(jobId)}/rounds/${encodeURIComponent(roundId)}/skip`, { reason }, skipResult, opts);

/** "Undo skip": the round runs again for students who have not gone past it yet. */
export const unskipRound = (jobId: string, roundId: string, opts: Options = {}): Promise<SkipRoundResult> =>
  call('POST', `${rounds(jobId)}/rounds/${encodeURIComponent(roundId)}/unskip`, {}, skipResult, opts);

export const listAssessmentJobs =(opts: Options = {}): Promise<AssessmentJob[]> =>
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

/** HR changes one round's passing criterion, also after students started: that round's results are graded again. */
export const changePassRule = (jobId: string, roundId: string, passRule: PassRuleInput, opts: Options = {}): Promise<PassRuleChangeResult> =>
  call('PUT', `/assessments/jobs/${encodeURIComponent(jobId)}/rounds/${encodeURIComponent(roundId)}/pass-rule`, { passRule }, (v) => v as PassRuleChangeResult, opts);

/** DSA coding round: new problems written by the AI (their test outputs checked by running a reference solution). */
export const generateCodingProblems = (jobId: string, req: CodingProblemsGenerateRequest, opts: Options = {}): Promise<CodingProblemsResult> =>
  call('POST', `/dsa-hr/jobs/${encodeURIComponent(jobId)}/coding-problems/generate`, req, (v) => v as CodingProblemsResult, opts);

/** DSA coding round: the problems of HR's PDF, Word (.docx) or CSV file. Nothing is saved until the round is saved. */
export async function importCodingProblems(jobId: string, file: File): Promise<CodingProblemsResult> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/dsa-hr/jobs/${encodeURIComponent(jobId)}/coding-problems/import`, {
      method: 'POST',
      headers: { 'x-requested-with': 'hireflow' },
      body: form,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the Anvexa API. Check that it is running and try again.');
  }
  const json = (await res.json().catch(() => undefined)) as { code?: string; message?: string } | undefined;
  if (!res.ok) {
    const fallback = res.status === 413 ? 'The file is larger than 5 MB.' : 'The file could not be imported. Please try again.';
    throw new ApiError(res.status, json?.code ?? `HTTP_${res.status}`, json?.message ?? fallback);
  }
  return json as unknown as CodingProblemsResult;
}
