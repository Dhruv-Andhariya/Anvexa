/**
 * Live transcript while the candidate speaks: the browser's own speech recognition (Web Speech API, Chrome / Edge /
 * Safari). It is a PREVIEW for the candidate only and is never saved: the saved transcript is made on the server from
 * the recorded answer. Where the browser has no speech recognition, the page simply shows no live text.
 * Note for the consent text: Chrome and Edge send this audio to their own speech service to recognise it.
 */

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [i: number]: RecognitionResult };
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const liveTranscriptSupported = () => ctor() !== null;

export interface LiveTranscript {
  stop: () => void;
}

/**
 * Starts recognising. `onText` gets the finished words so far and the words still being recognised. Browsers stop
 * recognising after a silence: it restarts itself until stop() is called. Errors only end the preview.
 */
export function startLiveTranscript(onText: (final: string, interim: string) => void, lang = 'en-IN'): LiveTranscript | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  let active = true;
  let finals = '';
  let rec: Recognition | null = null;

  const begin = () => {
    if (!active) return;
    rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finals = `${finals} ${r[0].transcript}`.trim();
        else interim += r[0].transcript;
      }
      onText(finals, interim.trim());
    };
    rec.onerror = (e) => {
      // no permission / no service: the preview stops, the interview does not
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') active = false;
    };
    rec.onend = () => {
      if (active) window.setTimeout(begin, 150);
    };
    try {
      rec.start();
    } catch {
      active = false;
    }
  };
  begin();
  return {
    stop() {
      active = false;
      try {
        rec?.abort();
      } catch {
        // already stopped
      }
    },
  };
}
