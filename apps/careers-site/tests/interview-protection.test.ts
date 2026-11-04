import { describe, expect, it } from 'vitest';
import { InterviewApiError } from '../src/lib/interview-api';
import { describeError } from '../src/lib/interview-ui';
import {
  BLUR_GRACE_MS,
  FaceEpisodeTracker,
  INCIDENT_LABEL,
  ProtectionMonitor,
  WARNING_TEXT,
  fullscreenSupported,
  newIncidentId,
  warningText,
  warningTexts,
  type Incident,
  type ProtectionSignal,
} from '../src/lib/interview-protection';

/** A monitor already running (page visible, focused, in fullscreen) with predictable ids. */
function running(opts: { tabSwitch?: boolean; fullscreen?: boolean } = {}) {
  let n = 0;
  const m = new ProtectionMonitor({ tabSwitch: opts.tabSwitch ?? true, fullscreen: opts.fullscreen ?? true, newId: () => `inc_${++n}` });
  m.setActive(true, 0, { hidden: false, focused: true, fullscreen: true });
  const incidents: Incident[] = [];
  const feed = (s: ProtectionSignal, at: number) => {
    const i = m.signal(s, at);
    if (i) incidents.push(i);
    return i;
  };
  const tick = (at: number) => {
    const i = m.tick(at);
    if (i) incidents.push(i);
    return i;
  };
  return { m, feed, tick, incidents };
}

describe('tab switching', () => {
  it('a tab switch (blur + hidden, then visible + focus) is ONE incident; coming back is none', () => {
    const { feed, tick, incidents } = running();
    feed('blur', 1000);
    feed('hidden', 1010);
    tick(5000);
    feed('visible', 9000);
    feed('focus', 9005);
    tick(20000);
    expect(incidents).toEqual([{ id: 'inc_1', type: 'TAB_SWITCH', detail: 'visibilitychange' }]);
  });

  it('a later, separate switch is a new incident', () => {
    const { feed, incidents } = running();
    feed('hidden', 1000);
    feed('visible', 4000);
    feed('focus', 4001);
    feed('hidden', 30_000);
    expect(incidents.map((i) => [i.id, i.type])).toEqual([
      ['inc_1', 'TAB_SWITCH'],
      ['inc_2', 'TAB_SWITCH'],
    ]);
  });

  it('minimising (hidden without blur first) counts; repeated hidden events while away do not', () => {
    const { feed, incidents } = running();
    feed('hidden', 1000);
    feed('hidden', 1100);
    feed('blur', 1200);
    expect(incidents).toHaveLength(1);
  });

  it('focus lost to another window counts only after the grace (address bar clicks do not)', () => {
    const { feed, tick, incidents } = running();
    feed('blur', 1000);
    tick(1000 + BLUR_GRACE_MS - 100);
    feed('focus', 1000 + BLUR_GRACE_MS - 50); // back quickly: nothing
    expect(incidents).toHaveLength(0);
    feed('blur', 10_000);
    tick(10_000 + BLUR_GRACE_MS);
    tick(10_000 + BLUR_GRACE_MS + 5000); // still away: no second incident
    expect(incidents.map((i) => i.type)).toEqual(['WINDOW_BLUR']);
    // the other window covers the browser and it becomes hidden: the same incident
    feed('hidden', 15_000);
    expect(incidents).toHaveLength(1);
  });

  it('reloading or closing the page is not an incident (it pauses the interview instead)', () => {
    const { feed, incidents } = running();
    feed('unloading', 1000);
    feed('hidden', 1001);
    expect(incidents).toHaveLength(0);
    // restored from the back/forward cache: monitored again
    feed('restored', 5000);
    feed('visible', 5001);
    feed('hidden', 9000);
    expect(incidents).toHaveLength(1);
  });

  it('nothing is noticed while not active (setup, pause, end screens)', () => {
    const { m, feed, tick, incidents } = running();
    m.setActive(false, 100, { hidden: false, focused: true, fullscreen: true });
    feed('hidden', 1000);
    feed('blur', 1000);
    tick(10_000);
    feed('fullscreen-exit', 11_000);
    expect(incidents).toHaveLength(0);
  });

  it('tab monitoring switched off by HR: no tab incidents', () => {
    const { feed, tick, incidents } = running({ tabSwitch: false });
    feed('hidden', 1000);
    feed('blur', 2000);
    tick(9000);
    expect(incidents).toHaveLength(0);
  });
});

describe('fullscreen', () => {
  it('leaving fullscreen (Escape) is one incident; restoring and leaving again is another', () => {
    const { m, feed, incidents } = running();
    feed('fullscreen-exit', 1000);
    feed('fullscreen-exit', 1001); // duplicate event
    expect(m.isOutOfFullscreen).toBe(true);
    feed('fullscreen-enter', 5000);
    expect(m.isOutOfFullscreen).toBe(false);
    feed('fullscreen-exit', 60_000);
    expect(incidents.map((i) => i.type)).toEqual(['FULLSCREEN_EXIT', 'FULLSCREEN_EXIT']);
  });

  it('Alt+Tab out of fullscreen (exit + blur + hidden, in any order) is one incident', () => {
    const a = running();
    a.feed('fullscreen-exit', 1000);
    a.feed('blur', 1010);
    a.feed('hidden', 1020);
    expect(a.incidents.map((i) => i.type)).toEqual(['FULLSCREEN_EXIT']);

    const b = running();
    b.feed('blur', 1000);
    b.feed('hidden', 1010);
    b.feed('fullscreen-exit', 1050);
    expect(b.incidents.map((i) => i.type)).toEqual(['TAB_SWITCH']);
  });

  it('staying out of fullscreen does not hide later tab switches', () => {
    const { feed, incidents } = running();
    feed('fullscreen-exit', 1000);
    feed('hidden', 30_000);
    expect(incidents.map((i) => i.type)).toEqual(['FULLSCREEN_EXIT', 'TAB_SWITCH']);
  });

  it('not in fullscreen when monitoring starts (request refused) is not an incident; fullscreen not required = none', () => {
    const m = new ProtectionMonitor({ tabSwitch: true, fullscreen: true, newId: () => 'x' });
    m.setActive(true, 0, { hidden: false, focused: true, fullscreen: false });
    expect(m.signal('fullscreen-exit', 100)).toBeNull();
    const off = running({ fullscreen: false });
    off.feed('fullscreen-exit', 1000);
    expect(off.incidents).toHaveLength(0);
  });

  it('fullscreen support is detected from the document', () => {
    expect(fullscreenSupported({ fullscreenEnabled: true })).toBe(true);
    expect(fullscreenSupported({ fullscreenEnabled: false })).toBe(false); // iPhone Safari
    expect(fullscreenSupported(undefined)).toBe(false);
  });
});

describe('multiple faces (counts only)', () => {
  const tracker = () => {
    let n = 0;
    return new FaceEpisodeTracker(() => `face_${++n}`);
  };
  /** One count per second from `from` (seconds) for `seconds`. */
  const feed = (t: FaceEpisodeTracker, faces: number | null, from: number, seconds: number) => {
    const out: Incident[] = [];
    for (let s = 0; s < seconds; s++) {
      const i = t.sample(faces, (from + s) * 1000);
      if (i) out.push(i);
    }
    return out;
  };

  it('a person walking past (2 faces for 3 s) is nothing', () => {
    const t = tracker();
    expect([...feed(t, 1, 0, 10), ...feed(t, 2, 10, 3), ...feed(t, 1, 13, 10)]).toHaveLength(0);
  });

  it('2+ faces for 5 s is one incident, however long it lasts', () => {
    const t = tracker();
    const out = feed(t, 2, 0, 60);
    expect(out).toEqual([{ id: 'face_1', type: 'MULTIPLE_FACES', detail: '2 faces' }]);
  });

  it('one missed frame does not restart the 5 s; a real gap does', () => {
    const t = tracker();
    expect([...feed(t, 2, 0, 3), ...feed(t, 1, 3, 1), ...feed(t, 2, 4, 2)]).toHaveLength(1);
    const u = tracker();
    expect([...feed(u, 2, 0, 3), ...feed(u, 1, 3, 3), ...feed(u, 2, 6, 3)]).toHaveLength(0);
  });

  it('the episode ends after 3 s with one face; a later crowd is a new incident', () => {
    const t = tracker();
    const out = [...feed(t, 2, 0, 10), ...feed(t, 1, 10, 4), ...feed(t, 3, 14, 10)];
    expect(out.map((i) => [i.id, i.detail])).toEqual([
      ['face_1', '2 faces'],
      ['face_2', '3 faces'],
    ]);
  });

  it('unreadable frames are no evidence; reset forgets everything', () => {
    const t = tracker();
    expect(feed(t, null, 0, 30)).toHaveLength(0);
    feed(t, 2, 30, 4);
    t.reset();
    expect(feed(t, 2, 34, 4)).toHaveLength(0);
  });
});

describe('warning texts and errors', () => {
  it('warning 1, the final warning and the termination use the agreed wording', () => {
    expect(warningText(1, 2, false).title).toBe('Warning 1 of 2');
    expect(warningText(1, 2, false).message).toContain('Further violations may result in interview termination.');
    expect(warningText(2, 2, true).title).toBe('Final Warning — 2 of 2');
    expect(warningText(2, 2, true).message).toBe('This is your final warning. Any further qualifying violation will automatically terminate your interview.');
    expect(WARNING_TEXT.terminated.title).toBe('Interview Terminated');
    expect(INCIDENT_LABEL.FULLSCREEN_EXIT).toBe('You left fullscreen.');
  });

  it('the assessment page uses the same wording with "assessment"', () => {
    expect(warningText(1, 2, false, 'assessment').message).toContain('Further violations may result in assessment termination.');
    expect(warningText(2, 2, true, 'assessment').message).toBe('This is your final warning. Any further qualifying violation will automatically terminate your assessment.');
    expect(warningTexts('assessment').terminated.title).toBe('Assessment Terminated');
  });

  it('a terminated interview is final on the page', () => {
    const d = describeError(new InterviewApiError(409, 'INTERVIEW_TERMINATED', 'Your interview was ended.', false));
    expect(d).toMatchObject({ fatal: true, title: 'Interview Terminated' });
  });

  it('incident ids are random and in the shape the server accepts', () => {
    const a = newIncidentId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newIncidentId()).not.toBe(a);
  });
});
