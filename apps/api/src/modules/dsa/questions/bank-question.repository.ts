import { Injectable } from '@nestjs/common';
import { fromHrProblem } from './hr-problem';
import { MOCK_QUESTIONS } from './mock-questions.data';
import type { QuestionRepository } from './question.repository';
import type { DsaQuestion } from './question.types';
import type { DsaInvitation } from '../session/invitation.resolver';

/**
 * Questions of an HR round, as HR set them up in the rounds editor (stored with the round in the database). Each round
 * question is either HR's own problem (statement + test cases, run as a stdin / stdout program) or points to a bank
 * problem (`dsa:<id>` topic). The candidate gets it under the ROUND question's id, worth the marks HR set, so the result
 * can be handed to the assessments module question by question. Without an HR round (demo tokens) every bank problem
 * is returned unchanged.
 */
@Injectable()
export class BankQuestionRepository implements QuestionRepository {
  private readonly bank = new Map(MOCK_QUESTIONS.map((q) => [q.id, q]));

  async findForAssessment(_assessmentId: string, invitation?: DsaInvitation): Promise<DsaQuestion[]> {
    if (!invitation?.round) return MOCK_QUESTIONS;
    const out: DsaQuestion[] = [];
    for (const rq of invitation.round.questions) {
      if (rq.custom) {
        out.push(fromHrProblem({ ...rq, custom: rq.custom }));
        continue;
      }
      const problem = this.bank.get(rq.bankId);
      // the HR editor refuses unknown problems; if one slips through the candidate must not get a smaller test silently
      if (!problem) throw new Error(`DSA problem ${rq.bankId} is not in the problem bank`);
      out.push({ ...problem, id: rq.id, marks: rq.marks });
    }
    return out;
  }
}
