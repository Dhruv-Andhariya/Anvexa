import {
  gdHrLiveSchema,
  gdPrivateTalkStartedSchema,
  gdRecordingStartedSchema,
  gdResultsSchema,
  gdRoundListSchema,
  gdRoundOverviewSchema,
  type CreateGdEventRequest,
  type GdHrLive,
  type GdPrivateTalkStarted,
  type GdRecommendation,
  type GdRecordingStarted,
  type GdResults,
  type GdRoundOverview,
  type GdRoundSummary,
} from '@hireflow/contracts';
import { API_URL } from './api';
import { call, type Options } from './publisher-api';

/**
 * M18 AI group discussion - HR side: the company's GD rounds, the students waiting for a group, and the events that
 * split them into groups. Session cookie + CSRF header; the company always comes from the session on the server.
 */
const overview = (v: unknown) => gdRoundOverviewSchema.parse(v);
const round = (roundId: string) => `/group-discussion/rounds/${encodeURIComponent(roundId)}`;

export const listGdRounds = (opts: Options = {}): Promise<GdRoundSummary[]> =>
  call('GET', '/group-discussion/rounds', undefined, (v) => gdRoundListSchema.parse(v), opts);

export const getGdRound = (roundId: string, opts: Options = {}): Promise<GdRoundOverview> => call('GET', round(roundId), undefined, overview, opts);

/** Every waiting student of the round is put into a group. */
export const createGdEvent = (roundId: string, req: CreateGdEventRequest, opts: Options = {}): Promise<GdRoundOverview> =>
  call('POST', `${round(roundId)}/events`, req, overview, opts);

/** Only before any group starts; the students go back to the waiting list. */
export const cancelGdEvent = (eventId: string, opts: Options = {}): Promise<GdRoundOverview> =>
  call('POST', `/group-discussion/events/${encodeURIComponent(eventId)}/cancel`, undefined, overview, opts);

export const setGdBatchTopic = (batchId: string, topicId: string, opts: Options = {}): Promise<GdRoundOverview> =>
  call('PUT', `/group-discussion/batches/${encodeURIComponent(batchId)}/topic`, { topicId }, overview, opts);

// ---------------------------------------------------------------- live dashboard

const batch = (batchId: string) => `/group-discussion/batches/${encodeURIComponent(batchId)}`;
const live = (v: unknown) => gdHrLiveSchema.parse(v);
const results = (v: unknown) => gdResultsSchema.parse(v);

export const getGdLive = (batchId: string, opts: Options = {}): Promise<GdHrLive> => call('GET', `${batch(batchId)}/live`, undefined, live, opts);

/** HR becomes visible + audible to the group (the discussion timer pauses), or mutes again. */
export const speakToGroup = (batchId: string, on: boolean, opts: Options = {}): Promise<GdHrLive> => call('POST', `${batch(batchId)}/speak`, { on }, live, opts);

export const startPrivateTalk = (batchId: string, participantId: string, opts: Options = {}): Promise<GdPrivateTalkStarted> =>
  call('POST', `${batch(batchId)}/private-talks`, { participantId }, (v) => gdPrivateTalkStartedSchema.parse(v), opts);

export const endPrivateTalk = (talkId: string, opts: Options = {}): Promise<GdHrLive> =>
  call('POST', `/group-discussion/private-talks/${encodeURIComponent(talkId)}/end`, undefined, live, opts);

export const admitStudent = (batchId: string, participantId: string, opts: Options = {}): Promise<GdHrLive> =>
  call('POST', `${batch(batchId)}/participants/${encodeURIComponent(participantId)}/admit`, undefined, live, opts);

export const rescheduleStudent = (participantId: string, batchId: string, opts: Options = {}): Promise<{ batchId: string }> =>
  call('POST', `/group-discussion/participants/${encodeURIComponent(participantId)}/reschedule`, { batchId }, (v) => v as { batchId: string }, opts);

export const startHrRecording = (batchId: string, mimeType: string, opts: Options = {}): Promise<GdRecordingStarted> =>
  call('POST', `${batch(batchId)}/recordings`, { mimeType }, (v) => gdRecordingStartedSchema.parse(v), opts);

/** Multipart upload of one audio chunk (session cookie + CSRF header, like every HR call). */
export async function uploadHrChunk(recordingId: string, seq: number, chunk: Blob): Promise<void> {
  const form = new FormData();
  form.append('seq', String(seq));
  form.append('chunk', chunk, `${seq}.chunk`);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/group-discussion/recordings/${encodeURIComponent(recordingId)}/chunks`, {
      method: 'POST',
      body: form,
      credentials: 'include',
      headers: { 'x-requested-with': 'hireflow' },
    });
  } catch {
    throw Object.assign(new Error('offline'), { retryable: true });
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: res.status >= 500 || res.status === 429 });
}

// ---------------------------------------------------------------- results

export const getGdResults = (batchId: string, opts: Options = {}): Promise<GdResults> => call('GET', `${batch(batchId)}/results`, undefined, results, opts);

/** null = back to the AI's recommendation. Logged with HR's name and the time. */
export const setGdDecision = (batchId: string, participantId: string, decision: GdRecommendation | null, reason: string, opts: Options = {}): Promise<GdResults> =>
  call('PUT', `${batch(batchId)}/students/${encodeURIComponent(participantId)}/decision`, { decision, reason }, results, opts);

export const includePrivateTalk = (talkId: string, include: boolean, opts: Options = {}): Promise<GdResults> =>
  call('PUT', `/group-discussion/private-talks/${encodeURIComponent(talkId)}/include`, { include }, results, opts);

export const reprocessGd = (batchId: string, opts: Options = {}): Promise<GdResults> => call('POST', `${batch(batchId)}/reprocess`, undefined, results, opts);

/** The whole session as one audio file (an <audio> src; the session cookie goes with it). */
export const gdSessionAudioUrl = (batchId: string) => `${API_URL}${batch(batchId)}/session-audio`;

export const rebuildGdSessionAudio = (batchId: string, opts: Options = {}): Promise<GdResults> =>
  call('POST', `${batch(batchId)}/session-audio`, undefined, results, opts);

export const confirmGdSelection = (batchId: string, opts: Options = {}): Promise<GdResults> => call('POST', `${batch(batchId)}/confirm`, undefined, results, opts);
