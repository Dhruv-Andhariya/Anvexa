import { Injectable } from '@nestjs/common';
import type { Difficulty, DsaProblemSpec, SqlProblemSpec } from '@hireflow/contracts';

export const DSA_INVITATION_RESOLVER = Symbol('DSA_INVITATION_RESOLVER');

/**
 * The questions of an HR round: the id each question has in the round, HR's marks, and the problem behind it - a bank
 * problem (`bankId`) or HR's own (`custom`: the question text is the statement, the spec holds the tests).
 */
export interface DsaRoundQuestion {
  id: string;
  bankId: string;
  marks: number;
  custom?: { statement: string; difficulty: Difficulty | null; spec: DsaProblemSpec };
  /** A SQL problem (the round's copy of a SQL bank question): the question text is the statement. */
  sql?: { statement: string; difficulty: Difficulty | null; spec: SqlProblemSpec };
}

export interface DsaInvitation {
  token: string;
  assessmentId: string;
  candidateName: string;
  durationMinutes: number;
  /** Set for an HR round (the round engine's invitation); absent for the demo tokens. */
  round?: { questions: DsaRoundQuestion[] };
  /** Show the candidate their score on the last page. Off for HR rounds: the outcome comes by email. */
  showResult?: boolean;
}

/**
 * Seam to the existing invitation / assessment-round workflow (owned by the round-engine team).
 * The real implementation validates the emailed token and returns the assessment it belongs to.
 * Return null for unknown, expired or already-used tokens.
 */
export interface InvitationResolver {
  resolve(token: string): Promise<DsaInvitation | null>;
}

/** Tokens set by DSA_DEMO_TOKENS must be long enough not to be guessed (the routes are public). */
const MIN_TOKEN_LENGTH = 16;

/**
 * Parses DSA_DEMO_TOKENS="tokenA:60,tokenB:30" (token:minutes, minutes optional, default 60, 1 to 600).
 * Returns null when the variable is unset. Entries with a short or odd token are ignored, never accepted.
 */
export function demoTokensFromEnv(raw: string | undefined = process.env.DSA_DEMO_TOKENS): Record<string, number> | null {
  if (!raw || raw.trim() === '') return null;
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [token, minutes] = part.trim().split(':');
    if (!token || token.length < MIN_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) continue;
    const m = Number(minutes);
    out[token] = Number.isFinite(m) && m >= 1 && m <= 600 ? Math.floor(m) : 60;
  }
  return out;
}

/**
 * Temporary resolver.
 *
 * The DSA routes are public (the token is the only credential) and run code on the hosting machine, so the well-known demo
 * tokens must never work on a deployed API. They are refused when NODE_ENV=production unless DSA_ALLOW_DEMO_TOKENS=on.
 *
 * For a temporary public demo (e.g. a Cloudflare quick tunnel) set DSA_DEMO_TOKENS to long random tokens, one per
 * tester. When it is set, ONLY those tokens work (the well-known ones are switched off, in any environment).
 * Replace this resolver with the real invitation lookup (see docs/dsa-integration-notes.md).
 */
@Injectable()
export class DemoInvitationResolver implements InvitationResolver {
  private readonly invitations: Record<string, Omit<DsaInvitation, 'token'>> = {
    'demo-dsa-token': {
      assessmentId: 'demo-assessment',
      candidateName: 'Demo Candidate',
      durationMinutes: Number(process.env.DSA_DEMO_DURATION_MINUTES) || 60,
    },
    // 1 minute assessment, handy for checking timer expiry by hand.
    'demo-dsa-short': { assessmentId: 'demo-assessment', candidateName: 'Demo Candidate', durationMinutes: 1 },
  };

  async resolve(token: string): Promise<DsaInvitation | null> {
    const configured = demoTokensFromEnv();
    if (configured) {
      const minutes = Object.prototype.hasOwnProperty.call(configured, token) ? configured[token] : undefined;
      return minutes === undefined
        ? null
        : { token, assessmentId: 'demo-assessment', candidateName: 'Candidate', durationMinutes: minutes };
    }
    if (process.env.NODE_ENV === 'production' && process.env.DSA_ALLOW_DEMO_TOKENS !== 'on') return null;
    const found = Object.prototype.hasOwnProperty.call(this.invitations, token) ? this.invitations[token] : undefined;
    return found ? { token, ...found } : null;
  }
}
