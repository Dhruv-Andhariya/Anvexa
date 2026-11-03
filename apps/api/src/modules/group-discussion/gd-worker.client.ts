import { gdEvaluationResultSchema, type GdEvaluationResult, type GdMetrics } from '@hireflow/contracts';

/**
 * HTTP client of the GD worker (workers/gd-agent, FastAPI): Whisper transcription of one recording (it reads the
 * chunk files straight from GD_STORAGE_DIR on the same machine), the rubric evaluation of one student (LLM, strict
 * JSON, validated with Pydantic there and with zod here), and the whole session mixed into one audio file. GD_WORKER_URL, default http://localhost:8010.
 */
export interface WhisperSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
}

export interface EvaluateInput {
  studentId: string;
  studentName: string;
  topic: string;
  studentTranscript: string;
  fullTranscript: string;
  metrics: GdMetrics;
  /** HR asked this student something (else hr_response must be null). */
  askedByHr: boolean;
}

/** One recording on the session timeline (ms from the moment the room locked). */
export interface MixTrack {
  chunkPaths: string[];
  mimeType: string;
  offsetMs: number;
  /** [fromMs, toMs) where this track is silent (the student was in a private talk with HR). */
  mute: [number, number][];
}

export class GdWorkerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GdWorkerError';
  }
}

export abstract class GdWorkerClient {
  abstract transcribe(chunkPaths: string[], mimeType: string): Promise<{ language: string | null; segments: WhisperSegment[] }>;
  abstract evaluate(input: EvaluateInput): Promise<{ result: GdEvaluationResult; model: string | null }>;
  /** Writes the mixed session to outPath (must be "<group folder>/session.webm" under GD_STORAGE_DIR). */
  abstract mix(tracks: MixTrack[], outPath: string): Promise<{ durationMs: number; bytes: number }>;
}

export class HttpGdWorkerClient extends GdWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly secret: string | null,
  ) {
    super();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpGdWorkerClient {
    const timeout = Number(env.GD_WORKER_TIMEOUT_MS);
    return new HttpGdWorkerClient(
      ((env.GD_WORKER_URL ?? '').trim() || 'http://localhost:8010').replace(/\/+$/, ''),
      Number.isInteger(timeout) && timeout > 0 ? timeout : 15 * 60_000,
      (env.GD_WORKER_SECRET ?? '').trim() || null,
    );
  }

  async transcribe(chunkPaths: string[], mimeType: string) {
    const body = (await this.post('/gd/transcribe', { chunk_paths: chunkPaths, mime_type: mimeType })) as {
      language?: unknown;
      segments?: unknown;
    };
    const segments = Array.isArray(body.segments)
      ? body.segments
          .map((s) => s as { start?: unknown; end?: unknown; text?: unknown })
          .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string' && s.text.trim())
          .map((s) => ({ start: s.start as number, end: s.end as number, text: (s.text as string).trim() }))
      : [];
    return { language: typeof body.language === 'string' ? body.language : null, segments };
  }

  async evaluate(i: EvaluateInput) {
    const body = (await this.post('/gd/evaluate', {
      student_id: i.studentId,
      student_name: i.studentName,
      topic: i.topic,
      student_transcript: i.studentTranscript,
      full_transcript: i.fullTranscript,
      metrics: i.metrics,
      asked_by_hr: i.askedByHr,
    })) as { result?: unknown; model?: unknown };
    const parsed = gdEvaluationResultSchema.safeParse(body.result);
    if (!parsed.success) throw new GdWorkerError('The evaluator returned an invalid result.', true);
    return { result: parsed.data, model: typeof body.model === 'string' ? body.model : null };
  }

  async mix(tracks: MixTrack[], outPath: string) {
    const body = (await this.post('/gd/mix', {
      tracks: tracks.map((t) => ({ chunk_paths: t.chunkPaths, mime_type: t.mimeType, offset_ms: t.offsetMs, mute: t.mute })),
      out_path: outPath,
    })) as { duration_ms?: unknown; bytes?: unknown };
    if (typeof body.duration_ms !== 'number' || typeof body.bytes !== 'number') throw new GdWorkerError('The GD worker returned an invalid mix result.', true);
    return { durationMs: Math.round(body.duration_ms), bytes: Math.round(body.bytes) };
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.secret ? { 'x-worker-secret': this.secret } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GdWorkerError('The GD worker (workers/gd-agent) is not reachable.', true);
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const detail = (json as { detail?: unknown } | undefined)?.detail;
      throw new GdWorkerError(typeof detail === 'string' ? detail.slice(0, 300) : `GD worker answered HTTP ${res.status}`, res.status >= 500 || res.status === 429);
    }
    return json;
  }
}
