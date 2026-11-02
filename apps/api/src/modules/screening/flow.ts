import { AI_SCREENING_STEPS, type AiScreeningStep, type AiScreeningTurnKind } from '@hireflow/contracts';

/**
 * The fixed question flow of the AI screening round (M12). Pure functions, no I/O: the API - not the model - decides
 * which question comes next, how many follow-ups a step gets and when the call ends. The model only says whether an
 * answer needs a follow-up (and, in the last step, answers the candidate's questions).
 */

export interface FlowLimits {
  /** Follow-up questions allowed per step (AVAILABILITY gets one extra for the college permission / NOC question). */
  followUpsPerStep: number;
  /** Questions the candidate may ask in the last step. */
  candidateQuestions: number;
  /** Hard cap on answered turns, whatever happens. */
  maxTurns: number;
  /** After this many minutes no more follow-ups are asked and the call wraps up. */
  maxMinutes: number;
}

export const DEFAULT_LIMITS: FlowLimits = { followUpsPerStep: 1, candidateQuestions: 3, maxTurns: 18, maxMinutes: 15 };

export const flowLimitsFromEnv = (env: NodeJS.ProcessEnv = process.env): FlowLimits => ({
  followUpsPerStep: intEnv(env.SCREENING_FOLLOW_UPS_PER_QUESTION, DEFAULT_LIMITS.followUpsPerStep, 0, 3),
  candidateQuestions: intEnv(env.SCREENING_MAX_CANDIDATE_QUESTIONS, DEFAULT_LIMITS.candidateQuestions, 1, 10),
  maxTurns: intEnv(env.SCREENING_MAX_TURNS, DEFAULT_LIMITS.maxTurns, 6, 40),
  maxMinutes: intEnv(env.SCREENING_MAX_MINUTES, DEFAULT_LIMITS.maxMinutes, 3, 60),
});

export const TOTAL_STEPS = AI_SCREENING_STEPS.length;
export const ESTIMATED_MINUTES = 7;

export interface QuestionContext {
  candidateFirstName: string;
  jobTitle: string;
  companyName: string;
  locations: string[];
  workMode: 'ONSITE' | 'HYBRID' | 'REMOTE' | null;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'INTERNSHIP' | 'CONTRACT' | null;
}

export interface Question {
  step: AiScreeningStep;
  kind: AiScreeningTurnKind;
  text: string;
}

/** The main question of each step, in plain spoken English. */
export function mainQuestion(step: AiScreeningStep, ctx: QuestionContext): string {
  switch (step) {
    case 'INTRO': {
      const hi = ctx.candidateFirstName ? `Hi ${ctx.candidateFirstName}` : 'Hi';
      return `${hi}, thank you for joining this short screening call for the ${ctx.jobTitle} role at ${ctx.companyName}. Could you briefly introduce yourself?`;
    }
    case 'EDUCATION':
      return 'Could you tell me about your educational background, what you are currently studying, and your expected graduation date?';
    case 'BACKGROUND':
      return 'Could you walk me through your background, relevant projects, internships, or experience?';
    case 'LOCATION':
      return locationQuestion(ctx);
    case 'AVAILABILITY':
      return 'Are you currently studying or working, and what would your availability be for this role?';
    case 'CANDIDATE_QUESTIONS':
      return `Do you have any questions about the role, the company, ${ctx.employmentType === 'INTERNSHIP' ? 'the internship, ' : ''}work arrangements, or next steps?`;
  }
}

function locationQuestion(ctx: QuestionContext): string {
  if (ctx.workMode === 'REMOTE') return 'Where are you currently based? This role is remote - would working remotely suit you?';
  const places = ctx.locations.filter(Boolean);
  if (!places.length) return 'Where are you currently based, and would you be comfortable working from the job location?';
  const where = places.length === 1 ? places[0] : `${places.slice(0, -1).join(', ')} or ${places.at(-1)}`;
  const mode = ctx.workMode === 'HYBRID' ? ' in a hybrid setup' : '';
  return `Where are you currently based, and would you be comfortable working from ${where}${mode}?`;
}

export function closingText(ctx: QuestionContext): string {
  const name = ctx.candidateFirstName ? `, ${ctx.candidateFirstName}` : '';
  return `Thank you${name}. That is the end of this screening. The HR team will review your answers and contact you about the next steps. Have a great day!`;
}

/** Where the conversation stands when an answer arrives. */
export interface FlowState {
  step: AiScreeningStep;
  followUpsInStep: number;
  candidateQuestions: number;
  stepsDone: number;
  /** Answered turns INCLUDING the one being answered now. */
  answeredTurns: number;
  startedAt: Date;
  now: Date;
}

/** What the AI worker understood from the answer (already checked by the worker). */
export interface TurnDecision {
  needsFollowUp: boolean;
  followUpQuestion: string | null;
  candidateAskedQuestion: boolean;
  reply: string | null;
  candidateIsDone: boolean;
}

export interface FlowStep {
  next: Question;
  done: boolean;
  followUpsInStep: number;
  candidateQuestions: number;
  stepsDone: number;
}

/** Whether a follow-up may still be asked in this step (also sent to the worker so it does not write one in vain). */
export function followUpAllowed(state: Pick<FlowState, 'step' | 'followUpsInStep' | 'answeredTurns' | 'startedAt' | 'now'>, limits: FlowLimits): boolean {
  if (state.step === 'CANDIDATE_QUESTIONS') return false;
  const max = limits.followUpsPerStep + (state.step === 'AVAILABILITY' ? 1 : 0);
  return state.followUpsInStep < max && state.answeredTurns < limits.maxTurns - 1 && !timeUp(state, limits);
}

export function nextQuestion(state: FlowState, decision: TurnDecision, ctx: QuestionContext, limits: FlowLimits): FlowStep {
  const outOfTurns = state.answeredTurns >= limits.maxTurns;
  const late = timeUp(state, limits);

  if (state.step !== 'CANDIDATE_QUESTIONS') {
    if (decision.needsFollowUp && decision.followUpQuestion && !outOfTurns && followUpAllowed(state, limits)) {
      return {
        next: { step: state.step, kind: 'FOLLOW_UP', text: decision.followUpQuestion },
        done: false,
        followUpsInStep: state.followUpsInStep + 1,
        candidateQuestions: state.candidateQuestions,
        stepsDone: state.stepsDone,
      };
    }
    const stepsDone = state.stepsDone + 1;
    // Out of time or turns: skip the remaining fact-finding but still give the candidate the chance to ask questions.
    const nextStep = outOfTurns ? null : late ? 'CANDIDATE_QUESTIONS' : AI_SCREENING_STEPS[AI_SCREENING_STEPS.indexOf(state.step) + 1]!;
    if (!nextStep) return finish(ctx, null, state.candidateQuestions);
    return {
      next: { step: nextStep, kind: 'MAIN', text: mainQuestion(nextStep, ctx) },
      done: false,
      followUpsInStep: 0,
      candidateQuestions: state.candidateQuestions,
      stepsDone: nextStep === 'CANDIDATE_QUESTIONS' ? TOTAL_STEPS - 1 : stepsDone,
    };
  }

  // CANDIDATE_QUESTIONS: answer, then "any other questions?" until they are done or the limit is reached.
  const asked = decision.candidateAskedQuestion ? state.candidateQuestions + 1 : state.candidateQuestions;
  const reply = decision.candidateAskedQuestion ? decision.reply : null;
  if (decision.candidateAskedQuestion && !decision.candidateIsDone && asked < limits.candidateQuestions && !outOfTurns && !late) {
    return {
      next: { step: 'CANDIDATE_QUESTIONS', kind: 'FOLLOW_UP', text: `${reply ?? ''} Do you have any other questions?`.trim() },
      done: false,
      followUpsInStep: state.followUpsInStep,
      candidateQuestions: asked,
      stepsDone: TOTAL_STEPS - 1,
    };
  }
  return finish(ctx, reply, asked);
}

function finish(ctx: QuestionContext, reply: string | null, candidateQuestions: number): FlowStep {
  const text = reply ? `${reply} ${closingText(ctx)}` : closingText(ctx);
  return {
    next: { step: 'CANDIDATE_QUESTIONS', kind: 'CLOSING', text },
    done: true,
    followUpsInStep: 0,
    candidateQuestions,
    stepsDone: TOTAL_STEPS,
  };
}

function timeUp(state: Pick<FlowState, 'startedAt' | 'now'>, limits: FlowLimits): boolean {
  return state.now.getTime() - state.startedAt.getTime() >= limits.maxMinutes * 60_000;
}

function intEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
