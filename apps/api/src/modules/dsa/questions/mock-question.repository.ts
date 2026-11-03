import { Injectable } from '@nestjs/common';
import { MOCK_QUESTIONS } from './mock-questions.data';
import type { QuestionRepository } from './question.repository';
import type { DsaQuestion } from './question.types';

/** Temporary data source: the same three questions for every assessment. */
@Injectable()
export class MockQuestionRepository implements QuestionRepository {
  async findForAssessment(_assessmentId: string): Promise<DsaQuestion[]> {
    return MOCK_QUESTIONS;
  }
}
