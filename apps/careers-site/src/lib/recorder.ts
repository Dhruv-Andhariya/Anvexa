/**
 * Microphone recording for the AI screening round. MediaRecorder with the first container this browser can record
 * (Chrome / Edge / Firefox / Android: WebM-Opus; Safari before 18.4 / iOS: MP4-AAC). Nothing is stored in the browser.
 */

/** Preference order. The server accepts all of these. */
export const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2'];

export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // some browsers throw for unknown parameters
    }
  }
  return null;
}

export type MicProblem = 'UNSUPPORTED' | 'DENIED' | 'NOT_FOUND' | 'BUSY' | 'INSECURE' | 'UNKNOWN';

export function micProblemOf(err: unknown): MicProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'DENIED';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'NOT_FOUND';
  if (name === 'NotReadableError' || name === 'AbortError') return 'BUSY';
  return 'UNKNOWN';
}

export const MIC_MESSAGES: Record<MicProblem, string> = {
  UNSUPPORTED: 'This browser cannot record audio. Please open the link in a recent Chrome, Edge, Firefox or Safari.',
  DENIED: 'Microphone access was blocked. Allow the microphone for this site (the icon next to the address bar), then try again.',
  NOT_FOUND: 'No microphone was found. Connect a microphone or headset, then try again.',
  BUSY: 'Your microphone is being used by another app (a call or recording). Close it, then try again.',
  INSECURE: 'The microphone only works on a secure (https) page. Please open the link exactly as it was emailed to you.',
  UNKNOWN: 'The microphone could not be started. Please check it and try again.',
};

/** Checks what the browser offers before asking for anything. */
export function micSupport(): MicProblem | null {
  if (typeof window === 'undefined') return 'UNKNOWN';
  if (!window.isSecureContext) return 'INSECURE';
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return 'UNSUPPORTED';
  if (!pickMimeType((t) => MediaRecorder.isTypeSupported(t))) return 'UNSUPPORTED';
  return null;
}

/** Below this peak loudness (0..1) for a whole answer, nothing was said (mic muted, wrong device, silence). */
export const SILENCE_PEAK = 0.04;

export interface ActiveRecording {
  /** peak: the loudest moment (0..1), or null when this browser cannot measure it. */
  stop: () => Promise<{ blob: Blob; mimeType: string; durationMs: number; peak: number | null }>;
  cancel: () => void;
  /** 0..1 loudness right now (for the "listening" meter). */
  level: () => number;
}

/** Starts recording on an already-granted microphone stream. */
export function startRecording(stream: MediaStream): ActiveRecording {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = performance.now();
  recorder.start(250);

  // loudness meter
  let analyser: AnalyserNode | null = null;
  let ctx: AudioContext | null = null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
    }
  } catch {
    analyser = null;
  }
  const buf = new Uint8Array(analyser?.fftSize ?? 0);
  const measure = () => {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  };
  // the loudest moment of the whole answer, sampled on our own (the UI meter may not be polling)
  let loudest = 0;
  const sampler = analyser ? window.setInterval(() => (loudest = Math.max(loudest, measure())), 100) : null;
  const close = () => {
    if (sampler) window.clearInterval(sampler);
    void ctx?.close().catch(() => undefined);
  };

  return {
    level() {
      const now = measure();
      loudest = Math.max(loudest, now);
      return now;
    },
    cancel() {
      close();
      if (recorder.state !== 'inactive') recorder.stop();
    },
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          close();
          const type = recorder.mimeType || mimeType || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mimeType: type, durationMs: performance.now() - started, peak: analyser ? loudest : null });
        };
        if (recorder.state === 'inactive') recorder.onstop(new Event('stop'));
        else recorder.stop();
      });
    },
  };
}
