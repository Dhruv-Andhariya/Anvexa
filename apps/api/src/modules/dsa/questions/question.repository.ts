import type { DsaQuestion } from './question.types';

export const DSA_QUESTION_REPOSITORY = Symbol('DSA_QUESTION_REPOSITORY');

/**
 * Data source for DSA questions. The temporary in-memory implementation
 * (`MockQuestionRepository`) is replaced by an HR-configured one by binding
 * another class to `DSA_QUESTION_REPOSITORY` in `dsa.module.ts`.
 */
export interface QuestionRepository {
  /** Questions for an assessment, in the order the candidate sees them. */
  findForAssessment(assessmentId: string): Promise<DsaQuestion[]>;
}
