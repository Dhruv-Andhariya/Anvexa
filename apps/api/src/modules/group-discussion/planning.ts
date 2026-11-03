import { randomBytes } from 'node:crypto';
import type { GdTopic, SavedRound } from '@hireflow/contracts';

/**
 * Pure rules of the GD round (no I/O): which rounds are GD rounds, what their topics are, which topic each group
 * gets. Group sizes and time slots are in @hireflow/contracts (planGroupSizes / planGroupSlots) so the HR page shows
 * exactly what the server will do.
 */

export const isGroupDiscussionRound = (round: Pick<SavedRound, 'type'>): boolean => round.type === 'GROUP_DISCUSSION';

/** The round's questions are its discussion topics, in HR's order. */
export function topicsOf(round: SavedRound): GdTopic[] {
  return [...round.questions].sort((a, b) => a.position - b.position).map((q) => ({ id: q.id, text: q.text }));
}

/**
 * One topic per group, going round the list; `offset` = groups already scheduled in this round, so a later event
 * does not start again with the first topic (students of an earlier group may have told others about it).
 */
export function assignTopics(topics: GdTopic[], groups: number, offset: number): (GdTopic | null)[] {
  if (!topics.length) return Array.from({ length: groups }, () => null);
  return Array.from({ length: groups }, (_, i) => topics[(offset + i) % topics.length]!);
}

/** A LiveKit room name nobody can guess (it is never shown to students; their join token names the room). */
export const newRoomName = () => `gd-${randomBytes(12).toString('base64url')}`;
