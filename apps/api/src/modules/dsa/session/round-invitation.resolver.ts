import { HttpException, Inject, Injectable } from '@nestjs/common';
import { dsaBankIdOf } from '@hireflow/contracts';
import { RoundEngineService, type CodingRoundContext } from '../../round-engine';
import type { DsaInvitation, InvitationResolver } from './invitation.resolver';

/** The proctoring record is kept per application and round: its assessment id carries both ("<applicationId>.<roundId>"). */
export const assessmentIdFor = (ctx: { applicationId: string; round: { id: string } }) => `${ctx.applicationId}.${ctx.round.id}`;

export const splitAssessmentId = (id: string): { applicationId: string; roundId: string } | null => {
  const [applicationId, roundId, extra] = id.split('.');
  return applicationId && roundId && extra === undefined ? { applicationId, roundId } : null;
};

/** What the candidate page calls the candidate: the first name only, like the multiple-choice test page. */
export const firstNameOf = (fullName: string) => fullName.trim().split(/\s+/)[0]?.slice(0, 40) || 'Candidate';

/** The invitation as the dsa module needs it, built from the round engine's view of the candidate's coding round. */
export function toInvitation(token: string, ctx: CodingRoundContext, showResult: boolean): DsaInvitation {
  return {
    token,
    assessmentId: assessmentIdFor(ctx),
    candidateName: firstNameOf(ctx.candidateName),
    durationMinutes: ctx.minutes,
    round: {
      questions: [...ctx.round.questions]
        .sort((a, b) => a.position - b.position)
        .map((q) => ({
          id: q.id,
          bankId: dsaBankIdOf(q.topics) ?? '',
          marks: q.marks,
          ...(q.coding ? { custom: { statement: q.text, difficulty: q.difficulty, spec: q.coding } } : {}),
        })),
    },
    showResult,
  };
}

/**
 * The real invitation lookup: the link token of an HR round, validated by the round engine (known, not withdrawn, not
 * expired before the start, and the round is still a DSA round). Unknown tokens give null (404); a withdrawn or expired
 * link keeps the engine's own error (410) so the candidate is told why.
 */
@Injectable()
export class RoundInvitationResolver implements InvitationResolver {
  constructor(@Inject(RoundEngineService) private readonly engine: RoundEngineService) {}

  async resolve(token: string): Promise<DsaInvitation | null> {
    try {
      return toInvitation(token, await this.engine.openCodingRound(token), process.env.DSA_SHOW_SCORE === 'on');
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 404) return null;
      throw err;
    }
  }
}
