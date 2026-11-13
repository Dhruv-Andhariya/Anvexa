'use client';

import '@livekit/components-styles';
import { isHrIdentity, isStudentIdentity, type GdAttendance, type GdConnection, type GdHrLive, type GdLiveState } from '@hireflow/contracts';
import { LiveKitRoom, RoomAudioRenderer, StartAudio, useDataChannel, useLocalParticipant, useRoomContext, useRoomInfo, useTracks } from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PhaseTimer, PhaseTracker, Tile, TopicBanner, VideoGrid, WithHrTile, isModerator, parseLiveState } from '@/components/gd/gd-ui';
import { Button, Card, ErrorNotice, Spinner, inputClass } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { admitStudent, endPrivateTalk, getGdLive, rescheduleStudent, speakToGroup, startHrRecording, startPrivateTalk, uploadHrChunk } from '@/lib/gd-api';
import { ChunkRecorder } from '@/lib/gd-recorder';

const messageOf = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
const pill = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const ATTENDANCE: Record<GdAttendance, { text: string; style: string }> = {
  WAITING: { text: 'Waiting', style: 'border-border text-muted' },
  SCHEDULED: { text: 'Scheduled', style: 'border-border text-muted' },
  INVITED: { text: 'Not joined', style: 'border-border text-muted' },
  JOINED: { text: 'Joined', style: 'border-success/40 bg-success-soft text-success' },
  ABSENT: { text: 'Absent', style: 'border-danger/40 bg-danger-soft text-danger' },
  ADMITTED_LATE: { text: 'Admitted late', style: 'border-success/40 bg-success-soft text-success' },
};

const ACTIVITY: Record<string, string> = {
  JOINED: 'joined the room',
  SPEAK_START: 'started speaking to the group',
  SPEAK_END: 'stopped speaking',
  TIMER_PAUSED: 'timer paused',
  TIMER_RESUMED: 'timer resumed',
  PRIVATE_START: 'started a private talk with',
  PRIVATE_END: 'sent back',
  PRIVATE_INCLUDED: 'included the private talk with',
  PRIVATE_EXCLUDED: 'excluded the private talk with',
  ADMITTED_LATE: 'admitted',
  RESCHEDULED: 'moved to another group:',
  OVERRIDE: 'changed the decision for',
  CONFIRMED: 'confirmed the selection',
};

/**
 * HR's live page of one group: the same video grid as the students (HR visible to everyone, camera and mic off until HR
 * turns them on), the live state, and the controls - camera / mic, "Speak to group" (the discussion timer pauses),
 * "Talk privately" on a student's tile, "Send back",
 * admit / move absent students - with attendance, talk time, flags and HR's activity log on the side.
 */
export function LiveDashboard({ batchId }: { batchId: string }) {
  const [data, setData] = useState<GdHrLive | null>(null);
  const [connection, setConnection] = useState<GdConnection | null>(null);
  const [error, setError] = useState('');
  const [offsetMs, setOffsetMs] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await getGdLive(batchId);
      setData(d);
      setOffsetMs(Date.parse(d.state.serverNow) - Date.now());
      // one connection for the whole visit: a new token on every refresh must not reconnect the room
      if (d.connection) setConnection((c) => c ?? d.connection);
      setError('');
    } catch (err) {
      setError(messageOf(err));
    }
  }, [batchId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) {
    return error ? (
      <ErrorNotice title="Could not open this group" message={error} action={<Button onClick={() => load()}>Try again</Button>} />
    ) : (
      <Card className="flex min-h-48 items-center justify-center gap-3 text-muted">
        <Spinner className="text-muted" /> Opening the group…
      </Card>
    );
  }

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link href={`/group-discussion?round=${encodeURIComponent(data.roundId)}`} className="text-sm text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
          ← Group Discussion
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">
          {data.eventName} · Group {data.number}
        </h1>
        <p className="text-sm text-muted">
          {data.jobTitle} · {data.roundName} · starts {dateTime.format(new Date(data.startsAt))}, room closes {time.format(new Date(data.joinClosesAt))}
        </p>
      </div>
      <Link href={`/group-discussion/results/${encodeURIComponent(batchId)}`} className="text-sm font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
        Results →
      </Link>
    </div>
  );

  if (!connection) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Card>
          <p className="font-medium">{data.state.batchStatus === 'COMPLETED' ? 'This group discussion has ended.' : 'The room opens at the start time.'}</p>
          <p className="mt-1 text-sm text-muted">
            {data.state.batchStatus === 'COMPLETED' ? 'Open the results to see the evaluation.' : 'Keep this page open; it connects by itself when the room opens.'}
          </p>
        </Card>
        <SidePanel data={data} batchId={batchId} talkTime={{}} hands={new Set()} cameraOff={new Set()} onChanged={setData} onError={setError} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {header}
      {error && <ErrorNotice title="That did not work" message={error} />}
      <LiveKitRoom serverUrl={connection.url} token={connection.token} connect audio={false} video={false} data-lk-theme="default" className="contents">
        <MainRoom batchId={batchId} data={data} offsetMs={offsetMs} onChanged={setData} onError={setError} />
      </LiveKitRoom>
    </div>
  );
}

function MainRoom({ batchId, data, offsetMs, onChanged, onError }: { batchId: string; data: GdHrLive; offsetMs: number; onChanged: (d: GdHrLive) => void; onError: (m: string) => void }) {
  const room = useRoomContext();
  const { metadata } = useRoomInfo();
  const state: GdLiveState = useMemo(() => parseLiveState(metadata) ?? data.state, [metadata, data.state]);
  const { localParticipant, microphoneTrack, isCameraEnabled, isMicrophoneEnabled } = useLocalParticipant();
  const [busy, setBusy] = useState(false);
  const [privateTalk, setPrivateTalk] = useState<{ talkId: string; connection: GdConnection; name: string } | null>(null);

  // ---- speaking to the group: visible + audible, recorded for the evaluator ("HR asked:")
  const recorder = useRef<ChunkRecorder | null>(null);
  const speaking = state.hrSpeaking;
  const setSpeaking = useCallback(
    async (on: boolean) => {
      setBusy(true);
      try {
        if (on) {
          onChanged(await speakToGroup(batchId, true));
          await localParticipant.setMicrophoneEnabled(true);
        } else {
          await localParticipant.setMicrophoneEnabled(false);
          onChanged(await speakToGroup(batchId, false));
        }
      } catch (err) {
        onError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [batchId, localParticipant, onChanged, onError],
  );
  const micTrack = speaking ? microphoneTrack?.track?.mediaStreamTrack : undefined;
  useEffect(() => {
    if (!micTrack) return;
    const rec = new ChunkRecorder({ start: (mime) => startHrRecording(batchId, mime), upload: uploadHrChunk });
    recorder.current = rec;
    void rec.start(micTrack).catch(() => undefined);
    return () => rec.stop();
  }, [micTrack, batchId]);

  // HR questions phase: HR is unmuted by default; muted again when the phase ends
  const autoSpoke = useRef(false);
  useEffect(() => {
    if (state.phase === 'HR_QUESTIONS' && !speaking && !autoSpoke.current && !privateTalk) {
      autoSpoke.current = true;
      void setSpeaking(true);
    }
    if ((state.phase === 'CLOSE' || state.phase === 'ENDED') && speaking) void setSpeaking(false);
  }, [state.phase, speaking, privateTalk, setSpeaking]);

  // ---- talk time per student (LiveKit's active speakers, counted every second while the page is open)
  const [talkTime, setTalkTime] = useState<Record<string, number>>({});
  const speakingNow = useRef<Set<string>>(new Set());
  useEffect(() => {
    const onSpeakers = (speakers: { identity: string }[]) => {
      speakingNow.current = new Set(speakers.map((s) => s.identity).filter(isStudentIdentity));
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    const t = setInterval(() => {
      if (!speakingNow.current.size) return;
      setTalkTime((tt) => {
        const next = { ...tt };
        for (const id of speakingNow.current) next[id] = (next[id] ?? 0) + 1;
        return next;
      });
    }, 1000);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      clearInterval(t);
    };
  }, [room]);

  // ---- raised hands (data messages from the students' pages)
  const [hands, setHands] = useState<Set<string>>(new Set());
  useDataChannel('hand', (msg) => {
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

  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const ordered = [...tracks].sort((a, b) => weight(a.participant) - weight(b.participant));
  const cameraOff = new Set(tracks.filter((t) => isStudentIdentity(t.participant.identity) && (!t.publication || t.publication.isMuted)).map((t) => t.participant.identity));
  const withHr = state.withHr.map((id) => data.participants.find((p) => p.identity === id)?.name ?? 'A student');

  async function talkPrivately(participantId: string, name: string) {
    setBusy(true);
    try {
      if (speaking) await setSpeaking(false);
      const started = await startPrivateTalk(batchId, participantId);
      setPrivateTalk({ ...started, name });
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendBack() {
    if (!privateTalk) return;
    setBusy(true);
    try {
      onChanged(await endPrivateTalk(privateTalk.talkId));
      setPrivateTalk(null);
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const live = state.batchStatus === 'LOBBY_OPEN' || state.batchStatus === 'IN_PROGRESS';
  const toggle = (what: 'camera' | 'mic') =>
    void (what === 'camera' ? localParticipant.setCameraEnabled(!isCameraEnabled) : localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)).catch(() =>
      onError(`Your ${what === 'camera' ? 'camera' : 'microphone'} could not be turned on. Allow it in the browser and try again.`),
    );
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(320px,1fr)]">
      <div className="flex flex-col gap-4">
        <RoomAudioRenderer />
        <StartAudio label="Click to hear the room" className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground" />
        <TopicBanner state={state} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PhaseTracker state={state} />
          <PhaseTimer state={state} offsetMs={offsetMs} />
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
          <Button variant={speaking ? 'primary' : 'secondary'} disabled={busy || !live || !!privateTalk} onClick={() => void setSpeaking(!speaking)} aria-pressed={speaking}>
            {speaking ? '● Speaking to group - mute' : 'Speak to group'}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => toggle('camera')} aria-pressed={isCameraEnabled}>
            {isCameraEnabled ? 'Camera off' : 'Camera on'}
          </Button>
          <Button variant="ghost" disabled={busy || speaking} onClick={() => toggle('mic')} aria-pressed={isMicrophoneEnabled}>
            {isMicrophoneEnabled ? 'Mute' : 'Unmute'}
          </Button>
          <span className="text-xs text-muted">
            {speaking
              ? 'Students see and hear you. The discussion timer is paused while you speak.'
              : 'Students see your tile. Unmute talks without pausing the timer; "Speak to group" pauses it.'}
          </span>
        </div>

        {privateTalk && (
          <Card className="flex flex-col gap-3 border-accent/50">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">Private talk with {privateTalk.name}</p>
              <Button variant="primary" disabled={busy} onClick={() => void sendBack()}>
                Send back
              </Button>
            </div>
            <LiveKitRoom serverUrl={privateTalk.connection.url} token={privateTalk.connection.token} connect audio video={false} data-lk-theme="default">
              <PrivateGrid />
            </LiveKitRoom>
            <p className="text-xs text-muted">Excluded from the evaluation unless you tick &quot;Include in evaluation&quot; on the results page.</p>
          </Card>
        )}

        {/* room left under the grid: the page's bottom padding */}
        <VideoGrid count={ordered.length + withHr.length} reserve={40}>
          {ordered.map((t) => {
            const p = data.participants.find((x) => x.identity === t.participant.identity);
            return (
              <Tile
                key={`${t.participant.identity}-${t.source}`}
                trackRef={t}
                label={t.participant.identity === localParticipant.identity ? 'You (HR)' : undefined}
                flagged={hands.has(t.participant.identity)}
                action={
                  p && (
                    <button
                      type="button"
                      className="rounded bg-white/90 px-1.5 py-0.5 text-xs font-medium text-black hover:bg-white disabled:opacity-50"
                      disabled={busy || !!privateTalk || !live}
                      onClick={() => void talkPrivately(p.id, p.name)}
                    >
                      Talk privately
                    </button>
                  )
                }
              />
            );
          })}
          {withHr.map((name, i) => (
            <WithHrTile key={`with-hr-${i}`} name={name} />
          ))}
        </VideoGrid>
      </div>

      <SidePanel data={data} batchId={batchId} talkTime={talkTime} hands={hands} cameraOff={cameraOff} onChanged={onChanged} onError={onError} />
    </div>
  );
}

function PrivateGrid() {
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  return (
    <>
      <RoomAudioRenderer />
      <div className="grid grid-cols-2 gap-2">
        {tracks.map((t) => (
          <Tile key={t.participant.identity} trackRef={t} />
        ))}
      </div>
    </>
  );
}

function SidePanel({
  data,
  batchId,
  talkTime,
  hands,
  cameraOff,
  onChanged,
  onError,
}: {
  data: GdHrLive;
  batchId: string;
  talkTime: Record<string, number>;
  hands: Set<string>;
  cameraOff: Set<string>;
  onChanged: (d: GdHrLive) => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const maxTalk = Math.max(60, ...Object.values(talkTime));
  const totalTalk = Object.values(talkTime).reduce((a, b) => a + b, 0);

  async function run(action: () => Promise<GdHrLive | unknown>) {
    setBusy(true);
    try {
      const r = await action();
      if (r && typeof r === 'object' && 'participants' in r) onChanged(r as GdHrLive);
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4 sm:p-4">
        <h2 className="font-semibold">Attendance</h2>
        <ul className="flex flex-col divide-y divide-border">
          {data.participants.map((p) => {
            const a = ATTENDANCE[p.attendance];
            const live = cameraOff.has(p.identity);
            return (
              <li key={p.id} className="flex flex-col gap-1.5 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium" title={p.email}>
                    {p.name}
                  </span>
                  <span className={`${pill} ${a.style}`}>{a.text}</span>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {live && <span className={`${pill} border-danger/40 bg-danger-soft text-danger`}>Camera off now</span>}
                  {p.cameraOffCount > 0 && <span className={`${pill} border-border text-muted`}>camera off ×{p.cameraOffCount}</span>}
                  {hands.has(p.identity) && <span className={`${pill} border-accent/40 bg-accent-soft text-accent`}>✋ hand raised</span>}
                </div>
                {p.attendance === 'ABSENT' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" className="px-2 py-1 text-xs" disabled={busy} onClick={() => void run(() => admitStudent(batchId, p.id))}>
                      Admit
                    </Button>
                    {data.rescheduleTargets.length > 0 && (
                      <>
                        <select
                          className={`${inputClass} w-auto py-1 text-xs`}
                          value={moveTo[p.id] ?? ''}
                          onChange={(e) => setMoveTo((m) => ({ ...m, [p.id]: e.target.value }))}
                          aria-label={`Move ${p.name} to another group`}
                        >
                          <option value="">Move to…</option>
                          {data.rescheduleTargets.map((t) => (
                            <option key={t.batchId} value={t.batchId}>
                              {t.eventName} · group {t.number} · {dateTime.format(new Date(t.startsAt))}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          disabled={busy || !moveTo[p.id]}
                          onClick={() => void run(async () => {
                            await rescheduleStudent(p.id, moveTo[p.id]!);
                            return getGdLive(batchId);
                          })}
                        >
                          Move
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card className="flex flex-col gap-2 p-4 sm:p-4">
        <h2 className="font-semibold">Talk time</h2>
        {totalTalk === 0 ? (
          <p className="text-sm text-muted">Counted while this page is open.</p>
        ) : (
          data.participants
            .filter((p) => talkTime[p.identity])
            .sort((a, b) => (talkTime[b.identity] ?? 0) - (talkTime[a.identity] ?? 0))
            .map((p) => {
              const s = talkTime[p.identity] ?? 0;
              return (
                <div key={p.id} className="text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{p.name}</span>
                    <span className="tabular-nums text-muted">
                      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} · {Math.round((s / totalTalk) * 100)}%
                    </span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-border">
                    <div className="h-full bg-accent" style={{ width: `${(s / maxTalk) * 100}%` }} />
                  </div>
                </div>
              );
            })
        )}
      </Card>

      <Card className="flex flex-col gap-1 p-4 sm:p-4">
        <h2 className="font-semibold">Live transcript</h2>
        <p className="text-sm text-muted">Not available live. Every student&apos;s audio is transcribed right after the discussion and shown with the results.</p>
      </Card>

      <Card className="flex flex-col gap-2 p-4 sm:p-4">
        <h2 className="font-semibold">HR activity</h2>
        {data.activity.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
            {data.activity.map((a, i) => (
              <li key={i}>
                <span className="tabular-nums text-muted">{time.format(new Date(a.at))}</span> {a.hrName ?? 'HR'} {ACTIVITY[a.kind] ?? a.kind} {a.participantName ?? ''}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </aside>
  );
}

const weight = (p: { identity: string }) => (isModerator(p as never) ? 0 : isHrIdentity(p.identity) ? 2 : 1);
