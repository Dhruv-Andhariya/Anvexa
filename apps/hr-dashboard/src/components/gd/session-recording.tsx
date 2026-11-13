'use client';

import type { GdSessionAudio } from '@hireflow/contracts';
import { gdSessionAudioUrl } from '@/lib/gd-api';

const built = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const length = (ms: number) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
};
const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

/** The whole GD session as one audio file (everyone's voice on one timeline): player, length and a download link. */
export function SessionRecording({ batchId, audio, title }: { batchId: string; audio: GdSessionAudio; title?: string }) {
  const src = gdSessionAudioUrl(batchId);
  return (
    <div className="flex flex-col gap-1.5">
      {title && <p className="text-sm font-medium">{title}</p>}
      <audio controls preload="metadata" src={src} className="w-full">
        <a href={src}>Download the recording</a>
      </audio>
      <p className="text-xs text-muted">
        {length(audio.durationMs)} · {size(audio.bytes)} · built {built.format(new Date(audio.createdAt))} ·{' '}
        <a href={src} download className="text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
          Download
        </a>
      </p>
    </div>
  );
}
