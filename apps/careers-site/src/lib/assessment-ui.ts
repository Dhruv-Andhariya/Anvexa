import type { AssessmentAnswer, AssessmentQuestion } from '@hireflow/contracts';
import { AssessmentApiError } from './assessment-api';

/** Logic of the assessment page without React (tested in tests/assessment.test.ts). */

export type AnswerMap = Record<string, { selected: number[]; marked: boolean }>;

export const toAnswerMap = (answers: AssessmentAnswer[]): AnswerMap =>
  Object.fromEntries(answers.map((a) => [a.questionId, { selected: [...a.selected], marked: a.marked }]));

/** What is sent to the server: only questions the candidate touched. */
export const toAnswerList = (map: AnswerMap): AssessmentAnswer[] =>
  Object.entries(map)
    .filter(([, a]) => a.selected.length > 0 || a.marked)
    .map(([questionId, a]) => ({ questionId, selected: a.selected, marked: a.marked }));

/** Picks an option: single-answer questions replace the choice, "select all that apply" toggles it. */
export function choose(map: AnswerMap, q: AssessmentQuestion, option: number): AnswerMap {
  const current = map[q.id] ?? { selected: [], marked: false };
  const selected = q.multiple
    ? current.selected.includes(option)
      ? current.selected.filter((o) => o !== option)
      : [...current.selected, option].sort((a, b) => a - b)
    : [option];
  return { ...map, [q.id]: { ...current, selected } };
}

export const clearAnswer = (map: AnswerMap, id: string): AnswerMap => ({ ...map, [id]: { selected: [], marked: map[id]?.marked ?? false } });

export const toggleMarked = (map: AnswerMap, id: string): AnswerMap => {
  const current = map[id] ?? { selected: [], marked: false };
  return { ...map, [id]: { ...current, marked: !current.marked } };
};

export type PaletteState = 'answered' | 'answered-marked' | 'marked' | 'unanswered';

export function paletteState(map: AnswerMap, id: string): PaletteState {
  const a = map[id];
  const answered = !!a && a.selected.length > 0;
  if (a?.marked) return answered ? 'answered-marked' : 'marked';
  return answered ? 'answered' : 'unanswered';
}

export function summary(questions: AssessmentQuestion[], map: AnswerMap) {
  const states = questions.map((q) => paletteState(map, q.id));
  return {
    total: questions.length,
    answered: states.filter((s) => s === 'answered' || s === 'answered-marked').length,
    marked: states.filter((s) => s === 'marked' || s === 'answered-marked').length,
    unanswered: states.filter((s) => s === 'unanswered' || s === 'marked').length,
  };
}

/**
 * Remaining time by the SERVER's clock: `offsetMs` = server time - device time when the page loaded, so a device
 * with a wrong clock still shows the right countdown. Never below 0.
 */
export const remainingMs = (deadlineIso: string, offsetMs: number, deviceNow = Date.now()) =>
  Math.max(0, Date.parse(deadlineIso) - (deviceNow + offsetMs));

export function formatRemaining(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/**
 * Local copy of the answers (survives a refresh while offline). Keyed by a hash of the token - the token itself is
 * never stored. The newer revision (server or device) wins when the page opens again.
 */
export async function draftKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  return `hireflow-assessment:${hex}`;
}

export interface Draft {
  revision: number;
  answers: AnswerMap;
}

export function readDraft(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    return Number.isInteger(d.revision) && d.answers && typeof d.answers === 'object' ? { revision: d.revision!, answers: d.answers } : null;
  } catch {
    return null;
  }
}

export function writeDraft(key: string, draft: Draft | null) {
  try {
    if (draft) window.localStorage.setItem(key, JSON.stringify(draft));
    else window.localStorage.removeItem(key);
  } catch {
    // private mode / storage full: the server copy still works
  }
}

/** Keeps only answers to questions of this test (a stale draft can never add others). */
export const pickKnown = (map: AnswerMap, questions: AssessmentQuestion[]): AnswerMap =>
  Object.fromEntries(questions.filter((q) => map[q.id]).map((q) => [q.id, map[q.id]!]));

/** What to tell the candidate for an error. Never shows raw server details. */
export function describeError(err: unknown): { fatal: boolean; title: string; message: string } {
  if (err instanceof AssessmentApiError) {
    const titles: Record<string, string> = {
      ASSESSMENT_LINK_INVALID: 'This link does not work',
      ASSESSMENT_LINK_EXPIRED: 'This link has expired',
      ASSESSMENT_LINK_REVOKED: 'This link was withdrawn',
      ASSESSMENT_UNAVAILABLE: 'Assessment not available',
      ASSESSMENT_SUBMITTED: 'Assessment already submitted',
      FEATURE_DISABLED: 'Assessment not available',
    };
    const title = titles[err.code] ?? (err.status === 404 ? titles.ASSESSMENT_LINK_INVALID : null);
    if (title) {
      const message = err.code === 'FEATURE_DISABLED' ? 'Online assessments are switched off right now. Please contact the hiring team.' : err.message;
      return { fatal: true, title, message };
    }
    return { fatal: false, title: 'Something went wrong', message: err.message };
  }
  return { fatal: false, title: 'Something went wrong', message: 'Something went wrong. Please try again.' };
}
