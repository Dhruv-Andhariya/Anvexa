'use client';

import '@livekit/components-styles';
import { isHrIdentity, type GdConnection, type GdLiveState, type GdPublicSession } from '@hireflow/contracts';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useDataChannel,
  useLocalParticipant,
  useRoomInfo,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GdApiError, getGdPrivateTalk, getGdSession, getGdState, joinGd, sendGdEvents, startGdRecording, uploadGdChunk } from '@/lib/gd-api';
import { ChunkRecorder } from '@/lib/gd-recorder';
import { Lobby } from './gd-lobby';
import { PhaseTimer, PhaseTracker, Tile, TopicBanner, VideoGrid, WithHrTile, isModerator, parseLiveState } from './gd-ui';

type Mode =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'lobby' }
  | { kind: 'room'; connection: GdConnection }
  | { kind: 'private'; connection: GdConnection }
  | { kind: 'done'; message: string };

const DONE_MESSAGE: Record<string, string> = {
  ENDED: 'This group discussion has ended. Thank you for taking part. The hiring team will email you the result.',
  CANCELLED: 'This group discussion was cancelled. The hiring team will contact you.',
  MISSED: 'The joining window for your group has closed. If you could not join in time, please contact the hiring team; they may admit you or move you to another group.',
};

/**
 * The student's GD page (/gd/[token]): lobby -> room -> (private talk with HR -> room) -> thank you. The page keeps the
 * personal link token in memory only; a reload shows the lobby again with "Rejoin" (no new consent needed).
 */
export function GdPage({ token }: { token: string }) {
  const [mode, setMode] = useState<Mode>({ kind: 'loading' });
  const [session, setSession] = useState<GdPublicSession | null>(null);
  const [state, setState] = useState<GdLiveState | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  const loadSession = useCallback(async () => {
    try {
      const s = await getGdSession(token);
      setSession(s);
      setOffsetMs(Date.parse(s.serverNow) - Date.now());
      if (DONE_MESSAGE[s.status]) setMode({ kind: 'done', message: DONE_MESSAGE[s.status]! });
      else setMode((m) => (m.kind === 'loading' || m.kind === 'error' ? { kind: 'lobby' } : m));
    } catch (err) {
      setMode({ kind: 'error', message: err instanceof GdApiError ? err.message : 'Could not load your group discussion. Please reload the page.' });
    }
  }, [token]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // in the lobby: keep the status fresh (the room opens at the start time; HR may admit a late student)
  useEffect(() => {
    if (mode.kind !== 'lobby' || !session) return;
    const startsIn = Date.parse(session.startsAt) - (Date.now() + offsetMs);
    const every = session.status === 'UPCOMING' && startsIn > 120_000 ? 30_000 : 5_000;
    const t = setInterval(() => void loadSession(), every);
    return () => clearInterval(t);
  }, [mode.kind, session, offsetMs, loadSession]);

  const join = useCallback(async () => {
    setJoining(true);
    setJoinError('');
    try {
      const r = await joinGd(token);
      setState(r.state);
      setOffsetMs(Date.parse(r.state.serverNow) - Date.now());
      setMode({ kind: 'room', connection: r.connection });
    } catch (err) {
      setJoinError(err instanceof GdApiError ? err.message : 'Could not join. Please try again.');
      if (err instanceof GdApiError && DONE_MESSAGE[err.code.replace('GD_', '')]) void loadSession();
    } finally {
      setJoining(false);
    }
  }, [token, loadSession]);

  /** The state as the server last told us (room metadata, or the polling fallback). */
  const onState = useCallback(
    async (next: GdLiveState) => {
      setState(next);
      if (next.phase === 'ENDED' || next.batchStatus === 'COMPLETED') {
        setMode({ kind: 'done', message: DONE_MESSAGE.ENDED! });
      }
    },
    [],
  );

  // a private talk opened / closed for this student: switch rooms
  const identity = mode.kind === 'room' || mode.kind === 'private' ? mode.connection.identity : null;
  const withHr = !!identity && !!state?.withHr.includes(identity);
  useEffect(() => {
    if (mode.kind === 'room' && withHr) {
      void getGdPrivateTalk(token).then((p) => {
        if (p.active && p.connection) setMode({ kind: 'private', connection: p.connection });
      });
    } else if (mode.kind === 'private' && state && !withHr) {
      void join(); // back to the group with a fresh token
    }
  }, [mode.kind, withHr, state, token, join]);

  // fallback polling: keeps the clock offset and the state right even if a metadata update was missed
  useEffect(() => {
    if (mode.kind !== 'room' && mode.kind !== 'private') return;
    const t = setInterval(async () => {
      try {
        const s = await getGdState(token);
        setOffsetMs(Date.parse(s.serverNow) - Date.now());
        void onState(s);
      } catch {
        // offline: LiveKit reconnects by itself; the next poll catches up
      }
    }, mode.kind === 'private' ? 3000 : 5000);
    return () => clearInterval(t);
  }, [mode.kind, token, onState]);

  if (mode.kind === 'loading') return <p className="text-muted">Loading your group discussion…</p>;
  if (mode.kind === 'error') return <Notice title="Something went wrong" text={mode.message} />;
  if (mode.kind === 'done') return <Notice title={session ? session.roundName : 'Group discussion'} text={mode.message} />;
  if (mode.kind === 'lobby' && session) return <Lobby session={session} offsetMs={offsetMs} joining={joining} error={joinError} onJoin={() => void join()} />;
  if ((mode.kind === 'room' || mode.kind === 'private') && state) {
    return (
      <LiveKitRoom
        key={`${mode.kind}-${mode.connection.token.slice(-12)}`}
        serverUrl={mode.connection.url}
        token={mode.connection.token}
        connect
        video
        audio
        options={{ adaptiveStream: true, dynacast: true, audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true } }}
        className="flex flex-col gap-4"
        data-lk-theme="default"
      >
        <RoomView token={token} state={state} offsetMs={offsetMs} privateTalk={mode.kind === 'private'} identity={mode.connection.identity} onState={(s) => void onState(s)} onLeave={() => setMode({ kind: 'lobby' })} />
      </LiveKitRoom>
    );
  }
  return null;
}

function RoomView({
  token,
  state: fallback,
  offsetMs,
  privateTalk,
  identity,
  onState,
  onLeave,
}: {
  token: string;
  state: GdLiveState;
  offsetMs: number;
  privateTalk: boolean;
  identity: string;
  onState: (s: GdLiveState) => void;
  onLeave: () => void;
}) {
  const { metadata } = useRoomInfo();
  const fromRoom = useMemo(() => parseLiveState(metadata), [metadata]);
  const state = privateTalk ? fallback : (fromRoom ?? fallback);
  useEffect(() => {
    if (fromRoom && !privateTalk) onState(fromRoom);
  }, [fromRoom, privateTalk]); // eslint-disable-line react-hooks/exhaustive-deps

  const { localParticipant, microphoneTrack, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();
  const [recProblem, setRecProblem] = useState<string | null>(null);

  // record the student's own microphone for the evaluation (a new recording per room connection)
  const micTrack = microphoneTrack?.track?.mediaStreamTrack;
  useEffect(() => {
    if (!micTrack) return;
    const rec = new ChunkRecorder(
      { start: (mime) => startGdRecording(token, mime), upload: (id, seq, blob) => uploadGdChunk(token, id, seq, blob) },
      setRecProblem,
    );
    rec.start(micTrack).catch(() => setRecProblem('Your audio could not be recorded. Please rejoin.'));
    return () => rec.stop();
  }, [micTrack, token]);

  // camera / microphone / tab events for HR (flags only; nobody is removed)
  const report = useCallback((type: Parameters<typeof sendGdEvents>[1][number]['type']) => {
    void sendGdEvents(token, [{ type, occurredAt: new Date().toISOString() }]).catch(() => undefined);
  }, [token]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      report('JOINED');
      return;
    }
    report(isCameraEnabled ? 'CAMERA_ON' : 'CAMERA_OFF');
  }, [isCameraEnabled, report]);
  const micFirst = useRef(true);
  useEffect(() => {
    if (micFirst.current) {
      micFirst.current = false;
      return;
    }
    report(isMicrophoneEnabled ? 'MIC_ON' : 'MIC_OFF');
  }, [isMicrophoneEnabled, report]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && report('TAB_HIDDEN');
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [report]);

  // raise hand: a data message to everyone in the room + an event for HR
  const [hands, setHands] = useState<Set<string>>(new Set());
  const { send } = useDataChannel('hand', (msg) => {
    const who = msg.from?.identity;
    if (!who) return;
    const raised = new TextDecoder().decode(msg.payload) === '1';
    setHands((h) => {
      const next = new Set(h);
      if (raised) next.add(who);
      else next.delete(who);
      return next;
    });
  });
  const myHand = hands.has(localParticipant.identity);
  const toggleHand = () => {
    const raised = !myHand;
    void send(new TextEncoder().encode(raised ? '1' : '0'), { reliable: true });
    setHands((h) => {
      const next = new Set(h);
      if (raised) next.add(localParticipant.identity);
      else next.delete(localParticipant.identity);
      return next;
    });
    report(raised ? 'HAND_RAISED' : 'HAND_LOWERED');
  };

  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  // the moderator first, then students, HR last
  const ordered = [...tracks].sort((a, b) => weight(a.participant) - weight(b.participant));
  const namesInPrivate = privateTalk ? [] : state.withHr.filter((id) => id !== identity).map((id) => state.summaryOrder.find((s) => s.identity === id)?.name ?? 'A student');

  return (
    <>
      <RoomAudioRenderer />
      <StartAudio label="Click to allow audio" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground" />
      {privateTalk ? (
        <div role="status" className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-center">
          <p className="font-semibold">Private talk with HR</p>
          <p className="text-sm text-muted">Your group carries on. You will go back to the discussion automatically when HR is done.</p>
        </div>
      ) : (
        <>
          <TopicBanner state={state} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PhaseTracker state={state} />
            <PhaseTimer state={state} offsetMs={offsetMs} />
          </div>
        </>
      )}

      {/* room left under the grid: the controls bar and the page's bottom padding */}
      <VideoGrid count={ordered.length + namesInPrivate.length} reserve={110}>
        {ordered.map((t) => (
          <Tile key={`${t.participant.identity}-${t.source}`} trackRef={t} label={t.participant.identity === identity ? 'You' : undefined} flagged={hands.has(t.participant.identity)} />
        ))}
        {namesInPrivate.map((name, i) => (
          <WithHrTile key={`with-hr-${i}`} name={name} />
        ))}
      </VideoGrid>

      {recProblem && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {recProblem}
        </p>
      )}
      {!isCameraEnabled && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          Your camera is off. Please turn it back on: the camera must stay on during the group discussion.
        </p>
      )}

      <div className="sticky bottom-3 z-10 mx-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-2 shadow-lg backdrop-blur">
        <TrackToggle source={Track.Source.Microphone} className="rounded-full border border-border px-3 py-2 text-sm">
          {isMicrophoneEnabled ? 'Mute' : 'Unmute'}
        </TrackToggle>
        <TrackToggle source={Track.Source.Camera} className="rounded-full border border-border px-3 py-2 text-sm">
          {isCameraEnabled ? 'Camera off' : 'Camera on'}
        </TrackToggle>
        {!privateTalk && (
          <button type="button" onClick={toggleHand} aria-pressed={myHand} className={`rounded-full border px-3 py-2 text-sm ${myHand ? 'border-accent bg-accent-soft' : 'border-border'}`}>
            {myHand ? 'Lower hand' : '✋ Raise hand'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Leave the group discussion? You can rejoin with the same link while it is running.')) {
              report('LEFT');
              onLeave();
            }
          }}
          className="rounded-full bg-danger px-3 py-2 text-sm font-medium text-white"
        >
          Leave
        </button>
      </div>
    </>
  );
}

const weight = (p: { identity: string; kind?: unknown }) => (isModerator(p as never) ? 0 : isHrIdentity(p.identity) ? 2 : 1);

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-surface p-6 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-muted">{text}</p>
    </div>
  );
}
