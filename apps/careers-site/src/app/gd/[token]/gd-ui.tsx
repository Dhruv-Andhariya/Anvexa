'use client';

import { GD_PHASE_LABEL, gdLiveStateSchema, gdRemainingMs, isHrIdentity, type GdLiveState, type GdPhase } from '@hireflow/contracts';
import { VideoTrack, useIsMuted, useIsSpeaking, type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { ParticipantKind, Track, type Participant } from 'livekit-client';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * The parts of the GD room every screen shows: topic banner, phase tracker, timer and the video tiles. The live state
 * comes from the LiveKit room metadata (pushed by the server on every change) and is drawn here as it is; the timer
 * counts down on the SERVER's clock (offsetMs = server - this device).
 */

export const parseLiveState = (metadata: string | undefined): GdLiveState | null => {
  if (!metadata) return null;
  try {
    const parsed = gdLiveStateSchema.safeParse(JSON.parse(metadata));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The phases students see in the tracker (the introduction and the goodbye are short and not shown). */
const TRACKED: GdPhase[] = ['THINKING', 'DISCUSSION', 'SUMMARY', 'HR_QUESTIONS'];

export function TopicBanner({ state }: { state: GdLiveState }) {
  if (!state.topic) {
    return (
      <div className="rounded-xl border border-border bg-surface px-4 py-3 text-center text-sm text-muted">
        {state.phase === 'NOT_STARTED' ? 'The discussion starts when the joining window closes.' : 'The topic will be announced in a moment.'}
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-accent">Topic</p>
      <p className="mt-0.5 text-base font-semibold sm:text-lg">{state.topic}</p>
    </div>
  );
}

export function PhaseTracker({ state }: { state: GdLiveState }) {
  const phases = TRACKED.filter((p) => state.plan.some((x) => x.phase === p));
  const current = phases.indexOf(state.phase);
  const after = state.phase === 'CLOSE' || state.phase === 'ENDED';
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Discussion phases">
      {phases.map((p, i) => {
        const done = after || (current >= 0 ? i < current : false);
        const active = i === current;
        return (
          <li
            key={p}
            aria-current={active ? 'step' : undefined}
            className={`rounded-full border px-2.5 py-1 ${active ? 'border-accent bg-accent text-accent-foreground font-medium' : done ? 'border-border text-muted line-through' : 'border-border text-muted'}`}
          >
            {GD_PHASE_LABEL[p]}
          </li>
        );
      })}
    </ol>
  );
}

const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function PhaseTimer({ state, offsetMs }: { state: GdLiveState; offsetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remaining = gdRemainingMs(state, now, offsetMs);
  const paused = !!state.pausedAt;
  const low = remaining !== null && remaining < 60_000 && !paused;
  return (
    <div className="flex items-center gap-3" aria-live="off">
      <span className="text-sm font-medium">{GD_PHASE_LABEL[state.phase]}</span>
      {remaining !== null && (
        <span className={`rounded-md px-2 py-0.5 font-mono text-lg tabular-nums ${low ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-foreground'}`}>{mmss(remaining)}</span>
      )}
      {paused && <span className="rounded-full border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">Paused, HR speaking</span>}
      {state.phase === 'SUMMARY' && state.currentSpeaker && (
        <span className="text-sm">
          Now summarising: <span className="font-semibold">{state.currentSpeaker.name}</span>
        </span>
      )}
    </div>
  );
}

export const isModerator = (p: Participant) => p.kind === ParticipantKind.AGENT || p.identity === 'moderator';

/** One video tile: name, active-speaker ring, "Camera off" warning, the moderator and HR labelled. */
export function Tile({ trackRef, label, flagged, action }: { trackRef: TrackReferenceOrPlaceholder; label?: string; flagged?: boolean; action?: ReactNode }) {
  const p = trackRef.participant;
  const speaking = useIsSpeaking(p);
  const cameraMuted = useIsMuted({ participant: p, source: Track.Source.Camera });
  const micMuted = useIsMuted({ participant: p, source: Track.Source.Microphone });
  const moderator = isModerator(p);
  const hr = isHrIdentity(p.identity);
  const hasVideo = !!trackRef.publication && !cameraMuted && trackRef.source === Track.Source.Camera;
  const name = label ?? (moderator ? 'AI Moderator' : hr ? 'HR' : p.name || 'Participant');
  return (
    <div
      className={`relative aspect-video overflow-hidden rounded-xl border bg-black/80 transition ${speaking ? 'border-success ring-4 ring-success/60' : 'border-border'}`}
      data-speaking={speaking || undefined}
    >
      {hasVideo ? (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <VideoTrack trackRef={trackRef as any} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className={`flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold ${moderator ? 'bg-accent text-accent-foreground' : 'bg-white/15 text-white'}`} aria-hidden="true">
            {moderator ? 'AI' : hr ? 'HR' : name.slice(0, 1).toUpperCase()}
          </span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-1.5 text-xs text-white">
        <span className="truncate font-medium">
          {name}
          {hr && <span className="ml-1.5 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-accent-foreground">HR</span>}
        </span>
        {micMuted && !moderator && <span className="shrink-0 rounded bg-black/60 px-1.5 py-0.5">Mic off</span>}
      </div>
      {!moderator && !hr && (cameraMuted || !trackRef.publication) && (
        <span className="absolute left-2 top-2 rounded bg-danger px-2 py-0.5 text-xs font-semibold text-white">Camera off</span>
      )}
      {(flagged || action) && (
        <div className="absolute right-2 top-2 flex items-center gap-1.5">
          {flagged && <span className="rounded bg-white/90 px-1.5 py-0.5 text-xs" aria-label="Hand raised">✋</span>}
          {action}
        </div>
      )}
    </div>
  );
}

/** A student who is in a private talk with HR (not in this room right now). */
export function WithHrTile({ name }: { name: string }) {
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-dashed border-accent/60 bg-accent-soft">
      <div className="text-center">
        <p className="text-sm font-medium">{name}</p>
        <p className="mt-1 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">With HR</p>
      </div>
    </div>
  );
}

const GRID_GAP = 8;
/** On a very small window the grid never shrinks below this; the page may scroll then. */
const MIN_GRID_HEIGHT = 220;

/** The column count (and tile width) that gives n 16:9 tiles the most room inside w x h. */
function fitTiles(n: number, w: number, h: number) {
  let best = { cols: 1, tileW: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(Math.max(1, n) / cols);
    const tileW = Math.min((w - GRID_GAP * (cols - 1)) / cols, ((h - GRID_GAP * (rows - 1)) / rows) * (16 / 9));
    if (tileW > best.tileW) best = { cols, tileW };
  }
  return { cols: best.cols, tileW: Math.floor(best.tileW) };
}

/**
 * Everyone on one screen, no scrolling: the grid takes the window height left below it (minus `reserve` px for what
 * comes under it, e.g. the controls) and picks the column count that gives the biggest tiles.
 */
export function VideoGrid({ count, reserve = 0, children }: { count: number; reserve?: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = Math.max(MIN_GRID_HEIGHT, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - reserve));
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    // the parent changes size when the content above the grid does (topic banner, timer, notices)
    const ro = new ResizeObserver(measure);
    ro.observe(el.parentElement ?? el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [reserve]);
  const fit = box ? fitTiles(count, box.w, box.h) : null;
  return (
    <div
      ref={ref}
      className="grid w-full content-center justify-center"
      style={{ gap: GRID_GAP, height: box?.h, gridTemplateColumns: fit ? `repeat(${fit.cols}, ${fit.tileW}px)` : 'repeat(2, minmax(0, 1fr))' }}
    >
      {children}
    </div>
  );
}
