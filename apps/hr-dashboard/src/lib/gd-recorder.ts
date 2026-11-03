import { GD_AUDIO_LIMITS } from '@hireflow/contracts';

/**
 * Records HR's microphone while HR speaks to the group, so the evaluator knows what HR asked ("HR asked:" lines; HR
 * is never scored). Same recorder as the students' page (apps/careers-site/src/lib/gd-recorder.ts): a MediaRecorder
 * chunk every 5 s, uploaded in order, retried with back-off while the connection is down. Nothing is stored in the
 * browser.
 */

/** Preference order; the API accepts all of these. */
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // some browsers throw for unknown parameters
    }
  }
  return null;
}
export interface ChunkUploader {
  start(mimeType: string): Promise<{ recordingId: string }>;
  upload(recordingId: string, seq: number, chunk: Blob): Promise<void>;
}

const RETRY_MS = [1000, 3000, 8000, 15000];

export class ChunkRecorder {
  private recorder: MediaRecorder | null = null;
  private recordingId: string | null = null;
  private seq = 0;
  private queue: { seq: number; blob: Blob }[] = [];
  private sending = false;
  private stopped = false;

  constructor(
    private readonly uploader: ChunkUploader,
    private readonly onProblem: (message: string | null) => void = () => undefined,
  ) {}

  /** Starts recording `track` (a clone, so muting / switching the room's track never breaks the file). */
  async start(track: MediaStreamTrack): Promise<boolean> {
    const mimeType = typeof MediaRecorder === 'undefined' ? null : pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    if (!mimeType) {
      this.onProblem('This browser cannot record audio; your discussion cannot be evaluated. Please use Chrome, Edge, Firefox or Safari.');
      return false;
    }
    const { recordingId } = await this.uploader.start(mimeType);
    if (this.stopped) return false;
    this.recordingId = recordingId;
    const stream = new MediaStream([track.clone()]);
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
    recorder.ondataavailable = (e) => {
      if (!e.data.size || this.seq >= GD_AUDIO_LIMITS.chunksPerRecording) return;
      this.queue.push({ seq: ++this.seq, blob: e.data });
      void this.flush();
    };
    recorder.start(GD_AUDIO_LIMITS.chunkMs);
    this.recorder = recorder;
    return true;
  }

  /** Stops and sends what is left (the last chunk arrives with the stop). */
  stop(): void {
    this.stopped = true;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder?.stream.getTracks().forEach((t) => t.stop());
    this.recorder = null;
  }

  get pending(): number {
    return this.queue.length;
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.recordingId) return;
    this.sending = true;
    let attempt = 0;
    try {
      while (this.queue.length) {
        const next = this.queue[0]!;
        try {
          await this.uploader.upload(this.recordingId, next.seq, next.blob);
          this.queue.shift();
          attempt = 0;
          this.onProblem(null);
        } catch (err) {
          const retryable = (err as { retryable?: boolean } | null)?.retryable !== false;
          if (!retryable) {
            this.queue.shift(); // the server refused this piece for good (e.g. the GD is over): skip it
            continue;
          }
          this.onProblem('Connection problem: your audio is kept and uploaded when the connection is back.');
          await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]));
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
