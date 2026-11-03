'use client';

import type { GdPublicSession } from '@hireflow/contracts';
import { useEffect, useRef, useState } from 'react';
import { CAMERA_MESSAGES, cameraProblemOf, cameraSupport } from '@/lib/camera';
import { MIC_MESSAGES, micProblemOf, micSupport } from '@/lib/recorder';

/**
 * The lobby: facts about the GD, a device check (camera preview + microphone level meter), the recording consent,
 * and a countdown to the start. Join stays disabled until the camera shows a picture, the microphone has picked up
 * the student's voice, and the consent box is ticked.
 */

const ist = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

export function Lobby({
  session,
  offsetMs,
  joining,
  error,
  onJoin,
}: {
  session: GdPublicSession;
  offsetMs: number;
  joining: boolean;
  error: string;
  onJoin: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [cameraOk, setCameraOk] = useState(false);
  const [level, setLevel] = useState(0);
  const [micHeard, setMicHeard] = useState(false);
  const [problem, setProblem] = useState('');
  const [consent, setConsent] = useState(session.joined);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  async function check() {
    setProblem('');
    const cam = cameraSupport();
    const mic = micSupport();
    if (cam) return setProblem(CAMERA_MESSAGES[cam]);
    if (mic) return setProblem(MIC_MESSAGES[mic]);
    try {
      stop();
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
      }
      const track = s.getVideoTracks()[0];
      setCameraOk(!!track && track.readyState === 'live');
      track?.addEventListener('ended', () => setCameraOk(false));
      // microphone level meter
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (!stream.current) return void ctx.close();
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        if (peak > 0.08) setMicHeard(true);
        requestAnimationFrame(loop);
      };
      loop();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      setProblem(name === 'NotAllowedError' ? CAMERA_MESSAGES[cameraProblemOf(err)] : MIC_MESSAGES[micProblemOf(err)]);
    }
  }

  function stop() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  useEffect(() => {
    void check();
    return stop;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const serverNow = now + offsetMs;
  const startsIn = Date.parse(session.startsAt) - serverNow;
  const closesIn = Date.parse(session.joinClosesAt) - serverNow;
  const canJoinNow = session.status === 'OPEN' || (session.status === 'IN_PROGRESS' && session.joined);
  const ready = cameraOk && micHeard && consent;
  const s = session.settings;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <div>
          <p className="text-sm text-muted">
            {session.companyName} · {session.jobTitle}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">{session.roundName}</h1>
          <p className="mt-1 text-sm">Hello {session.candidateFirstName}, welcome to your group discussion.</p>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Fact label="Starts" value={ist(session.startsAt)} />
          <Fact label="Room closes" value={ist(session.joinClosesAt)} />
          <Fact label="Group size" value={`${session.groupSize} students`} />
          <Fact label="Thinking time" value={`${Math.round(s.thinkingSeconds / 60)} min`} />
          <Fact label="Discussion" value={`${s.discussionMinutes} min`} />
          <Fact label="Summary" value={`${s.summarySeconds} s each`} />
        </dl>
        <div className="text-sm text-muted">
          <p className="font-medium text-foreground">How it works</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>An AI moderator greets everyone, explains the rules and announces the topic (it also stays at the top of your screen).</li>
            <li>You get thinking time, then an open discussion. Speak one at a time and build on others&apos; points.</li>
            <li>In the summary round the moderator calls each of you by name for a short summary.</li>
            {s.hrQuestionsEnabled && <li>Then the HR team may ask you questions ({s.hrQuestionsMinutes} min).</li>}
            <li>Keep your camera and microphone on the whole time. If you get disconnected, open this link again to rejoin.</li>
          </ul>
        </div>
        <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
          <input type="checkbox" className="mt-0.5" checked={consent} disabled={session.joined} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            I agree that my <strong>audio is recorded</strong> during the group discussion, transcribed and evaluated (with AI help) by{' '}
            {session.companyName} for this hiring process only, and that the hiring team watches the discussion live. The recording is
            deleted after the retention period. I can ask the hiring team to delete my data at any time.
          </span>
        </label>
      </section>

      <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
        <h2 className="font-semibold">Check your camera and microphone</h2>
        <video ref={video} muted playsInline className="aspect-video w-full rounded-lg bg-black object-cover" aria-label="Your camera preview" />
        <div>
          <p className="text-sm">Microphone: say a few words</p>
          <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-border" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} aria-label="Microphone level">
            <div className="h-full bg-success transition-[width]" style={{ width: `${Math.min(100, level * 250)}%` }} />
          </div>
        </div>
        <ul className="text-sm">
          <li className={cameraOk ? 'text-success' : 'text-muted'}>{cameraOk ? '✓ Camera works' : '○ Camera not ready'}</li>
          <li className={micHeard ? 'text-success' : 'text-muted'}>{micHeard ? '✓ Microphone works' : '○ Speak to test the microphone'}</li>
          <li className={consent ? 'text-success' : 'text-muted'}>{consent ? '✓ Consent given' : '○ Tick the consent box'}</li>
        </ul>
        {problem && (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
            {problem}{' '}
            <button type="button" className="font-medium underline" onClick={() => void check()}>
              Try again
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
        {session.status === 'UPCOMING' ? (
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-center text-sm">
            The room opens in <span className="font-mono font-semibold tabular-nums">{countdown(startsIn)}</span>. Keep this page open.
          </p>
        ) : (
          session.status === 'OPEN' && closesIn > 0 && <p className="text-center text-sm text-muted">The room closes in {countdown(closesIn)}.</p>
        )}
        <button
          type="button"
          disabled={!ready || !canJoinNow || joining}
          onClick={() => {
            stop(); // free the camera and microphone for the room
            onJoin();
          }}
          className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {joining ? 'Joining…' : session.joined ? 'Rejoin the discussion' : 'Join the discussion'}
        </button>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
