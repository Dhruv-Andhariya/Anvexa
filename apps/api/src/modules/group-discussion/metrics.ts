import type { GdMetrics, GdPhase } from '@hireflow/contracts';

/**
 * After the GD (phase 5), as pure functions: the transcript lines of every speaker on ONE timeline (ms since the room
 * locked), the speaking metrics per student, and the texts sent to the evaluator. Nothing here involves AI.
 */

export interface TranscriptLine {
  /** null = HR. */
  participantId: string | null;
  name: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Said during a private talk with HR. */
  private: boolean;
}

export interface PhaseWindow {
  phase: GdPhase;
  fromMs: number;
  toMs: number;
}

export interface TalkInterval {
  participantId: string;
  fromMs: number;
  toMs: number;
  include: boolean;
}

/** Turns of one speaker: pieces closer than this are one turn. */
const TURN_GAP_MS = 1500;
/** Starting while someone else has been talking for at least this long, and goes on after, is an interruption. */
const OVERLAP_MS = 500;
/** An answer to HR starts within this long after HR stopped. */
const ANSWER_WINDOW_MS = 30_000;

const FILLERS = /\b(u+m+|u+h+|e+r+m+|a+h+|h+m+|you know|i mean|basically|actually|literally|kind of|sort of)\b/gi;

export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
export const fillerCount = (text: string) => (text.match(FILLERS) ?? []).length;

/** When each phase ran, from the batch's phase log. The last phase runs until `endMs`. */
export function phaseWindows(log: { phase: GdPhase; at: string }[], lockedAt: Date, endMs: number): PhaseWindow[] {
  const sorted = [...log].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return sorted.map((p, i) => ({
    phase: p.phase,
    fromMs: Date.parse(p.at) - lockedAt.getTime(),
    toMs: i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.at) - lockedAt.getTime() : endMs,
  }));
}

/**
 * Marks what was said inside a private talk. A student's lines count as private during THEIR talk; HR's lines during
 * any talk (HR was in the private room). Lines of a talk HR chose to include stay in, marked as private.
 * Returns only the lines that may be used (excluded private ones are dropped).
 */
export function applyPrivateTalks(lines: TranscriptLine[], talks: TalkInterval[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    const mid = (line.startMs + line.endMs) / 2;
    const talk = talks.find((t) => mid >= t.fromMs && mid < t.toMs && (line.participantId === null || line.participantId === t.participantId));
    if (!talk) out.push(line);
    else if (talk.include) out.push({ ...line, private: true });
  }
  return out;
}

interface Turn {
  participantId: string;
  startMs: number;
  endMs: number;
}

function turnsOf(lines: TranscriptLine[]): Turn[] {
  const turns: Turn[] = [];
  const last = new Map<string, Turn>();
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    if (!l.participantId) continue;
    const prev = last.get(l.participantId);
    if (prev && l.startMs - prev.endMs <= TURN_GAP_MS) {
      prev.endMs = Math.max(prev.endMs, l.endMs);
    } else {
      const turn = { participantId: l.participantId, startMs: l.startMs, endMs: l.endMs };
      turns.push(turn);
      last.set(l.participantId, turn);
    }
  }
  return turns;
}

const inPhase = (windows: PhaseWindow[], phase: GdPhase, ms: number) => windows.some((w) => w.phase === phase && ms >= w.fromMs && ms < w.toMs);

/**
 * Speaking metrics of every student. Talk time, words and fillers count everything the student said in the main
 * room (the discussion, the summary, answers to HR); interruptions only during the discussion; `summarySeconds` only
 * inside the student's own summary minute.
 */
export function computeMetrics(
  lines: TranscriptLine[],
  windows: PhaseWindow[],
  participantIds: string[],
  summary: { order: string[]; slotMs: number },
): Map<string, GdMetrics> {
  const studentLines = lines.filter((l) => l.participantId !== null && !l.private);
  const hrLines = lines.filter((l) => l.participantId === null);
  const turns = turnsOf(studentLines);
  const discussionTurns = turns.filter((t) => inPhase(windows, 'DISCUSSION', t.startMs));
  const summaryWindow = windows.find((w) => w.phase === 'SUMMARY');
  const totalTalk = studentLines.reduce((s, l) => s + (l.endMs - l.startMs), 0);

  // whoever speaks first after HR stops (before HR speaks again, within 30 s) answered HR
  const answerers = new Set<string>();
  const byStart = [...studentLines].sort((a, b) => a.startMs - b.startMs);
  const hrSorted = [...hrLines].sort((a, b) => a.startMs - b.startMs);
  hrSorted.forEach((h, i) => {
    const nextHr = hrSorted[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const first = byStart.find((l) => l.startMs >= h.endMs - OVERLAP_MS && l.startMs < nextHr && l.startMs - h.endMs <= ANSWER_WINDOW_MS);
    if (first?.participantId) answerers.add(first.participantId);
  });

  const result = new Map<string, GdMetrics>();
  for (const id of participantIds) {
    const own = studentLines.filter((l) => l.participantId === id);
    const talkMs = own.reduce((s, l) => s + (l.endMs - l.startMs), 0);
    const text = own.map((l) => l.text).join(' ');
    const words = wordCount(text);
    const interruptions = discussionTurns.filter(
      (t) =>
        t.participantId === id &&
        discussionTurns.some((o) => o.participantId !== id && o.startMs <= t.startMs - OVERLAP_MS && o.endMs >= t.startMs + OVERLAP_MS),
    ).length;

    let summaryMs = 0;
    const slot = summary.order.indexOf(id);
    if (summaryWindow && slot >= 0) {
      const from = summaryWindow.fromMs + slot * summary.slotMs;
      const to = Math.min(from + summary.slotMs, summaryWindow.toMs);
      summaryMs = own.reduce((s, l) => s + Math.max(0, Math.min(l.endMs, to) - Math.max(l.startMs, from)), 0);
    }

    result.set(id, {
      talkSeconds: round(talkMs / 1000),
      talkShare: totalTalk ? round(talkMs / totalTalk, 3) : 0,
      words,
      wordsPerMinute: talkMs ? round(words / (talkMs / 60_000)) : 0,
      fillerWords: fillerCount(text),
      interruptions,
      turns: turns.filter((t) => t.participantId === id).length,
      summarySeconds: round(summaryMs / 1000),
      answeredHr: answerers.has(id),
    });
  }
  return result;
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The whole GD as the evaluator reads it, in time order, with the phase as a heading. HR's lines are labelled
 * "HR asked:" so the evaluator knows when a student answers HR (HR itself is never scored).
 */
export function fullTranscript(lines: TranscriptLine[], windows: PhaseWindow[]): string {
  const out: string[] = [];
  let phase: GdPhase | null = null;
  for (const l of [...lines].sort((a, b) => a.startMs - b.startMs)) {
    const w = windows.find((x) => l.startMs >= x.fromMs && l.startMs < x.toMs);
    if (w && w.phase !== phase) {
      phase = w.phase;
      out.push(`--- ${phase} ---`);
    }
    const who = l.participantId === null ? 'HR asked' : l.name;
    out.push(`[${clock(l.startMs)}] ${who}${l.private ? ' (private talk with HR)' : ''}: ${l.text.trim()}`);
  }
  return out.join('\n');
}

/** One student's own lines only. */
export function studentTranscript(lines: TranscriptLine[], participantId: string): string {
  return lines
    .filter((l) => l.participantId === participantId)
    .sort((a, b) => a.startMs - b.startMs)
    .map((l) => `[${clock(l.startMs)}]${l.private ? ' (private talk with HR)' : ''} ${l.text.trim()}`)
    .join('\n');
}
