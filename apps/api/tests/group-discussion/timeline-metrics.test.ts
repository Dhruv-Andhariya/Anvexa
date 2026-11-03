import 'reflect-metadata';
import { GD_DEFAULT_SETTINGS, gdRemainingMs } from '@hireflow/contracts';
import { describe, expect, it } from 'vitest';
import { buildGdInviteEmail, buildGdReminderEmail, buildGdResultEmail } from '../../src/modules/group-discussion/emails';
import { finalDecisionOf } from '../../src/modules/group-discussion/gd-results.service';
import { gdBaseUrlFromEnv, gdLink, hashGdToken, isPublicGdLink, newGdToken } from '../../src/modules/group-discussion/link';
import {
  applyPrivateTalks,
  computeMetrics,
  fillerCount,
  fullTranscript,
  phaseWindows,
  studentTranscript,
  type TranscriptLine,
} from '../../src/modules/group-discussion/metrics';
import { pause, planOf, resume, start, step } from '../../src/modules/group-discussion/timeline';

const T0 = new Date('2026-11-02T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

describe('timeline', () => {
  const plan = planOf(GD_DEFAULT_SETTINGS, 3);

  it('plans intro, thinking, discussion, a minute of summary per student, HR questions and the close', () => {
    expect(plan).toEqual([
      { phase: 'INTRO', seconds: 60 },
      { phase: 'THINKING', seconds: 120 },
      { phase: 'DISCUSSION', seconds: 900 },
      { phase: 'SUMMARY', seconds: 180 },
      { phase: 'HR_QUESTIONS', seconds: 300 },
      { phase: 'CLOSE', seconds: 60 },
    ]);
    expect(planOf({ ...GD_DEFAULT_SETTINGS, hrQuestionsEnabled: false }, 0).map((p) => p.phase)).toEqual(['INTRO', 'THINKING', 'DISCUSSION', 'CLOSE']);
  });

  it('moves from phase to phase on the planned boundaries, even when a tick comes late', () => {
    let t = start(plan, T0);
    expect(t).toMatchObject({ phase: 'INTRO', phaseEndsAt: at(60) });
    expect(step(t, plan, 60, at(59))).toBeNull();
    t = step(t, plan, 60, at(61))!;
    expect(t).toMatchObject({ phase: 'THINKING', phaseStartedAt: at(60), phaseEndsAt: at(180) });
    // the worker was away for 20 minutes: thinking and discussion are over, summary has started at its planned time
    t = step(t, plan, 60, at(1100))!;
    expect(t).toMatchObject({ phase: 'SUMMARY', phaseStartedAt: at(1080), summaryIndex: 0 });
  });

  it('gives each student their minute in the summary round', () => {
    let t = step(start(plan, T0), plan, 60, at(1080))!;
    expect(t.phase).toBe('SUMMARY');
    expect(step(t, plan, 60, at(1100))).toBeNull();
    t = step(t, plan, 60, at(1141))!;
    expect(t.summaryIndex).toBe(1);
    t = step(t, plan, 60, at(1201))!;
    expect(t.summaryIndex).toBe(2);
    t = step(t, plan, 60, at(1261))!;
    expect(t.phase).toBe('HR_QUESTIONS');
    t = step(t, plan, 60, at(1620))!;
    expect(t.phase).toBe('ENDED');
    expect(step(t, plan, 60, at(9999))).toBeNull();
  });

  it('pauses only the discussion while HR speaks and gives the time back', () => {
    const thinking = step(start(plan, T0), plan, 60, at(60))!;
    expect(pause(thinking, at(70))).toBeNull();
    const discussion = step(thinking, plan, 60, at(180))!;
    const paused = pause(discussion, at(300))!;
    expect(step(paused, plan, 60, at(5000))).toBeNull(); // a paused timeline never moves
    expect(gdRemainingMs({ phaseEndsAt: paused.phaseEndsAt!.toISOString(), pausedAt: paused.pausedAt!.toISOString() }, at(400).getTime(), 0)).toBe(780_000);
    const resumed = resume(paused, at(345))!;
    expect(resumed.pausedMs).toBe(45_000);
    expect(resumed.timeline.phaseEndsAt).toEqual(at(1080 + 45));
  });
});

describe('metrics and transcripts', () => {
  const L = (participantId: string | null, name: string, s: number, e: number, text: string): TranscriptLine => ({
    participantId,
    name,
    startMs: s * 1000,
    endMs: e * 1000,
    text,
    private: false,
  });
  const windows = phaseWindows(
    [
      { phase: 'INTRO', at: at(0).toISOString() },
      { phase: 'THINKING', at: at(60).toISOString() },
      { phase: 'DISCUSSION', at: at(180).toISOString() },
      { phase: 'SUMMARY', at: at(1080).toISOString() },
      { phase: 'HR_QUESTIONS', at: at(1200).toISOString() },
    ],
    T0,
    1500_000,
  );
  const lines = [
    L('a', 'Asha', 190, 220, 'I think um AI can help students, you know, revise faster.'),
    L('b', 'Ravi', 215, 240, 'But basically exams test understanding.'), // starts while Asha talks: interruption
    L('a', 'Asha', 221, 225, 'Exactly.'), // 1 s after her line ended: the same turn
    L('b', 'Ravi', 300, 310, 'Let me add one more point.'),
    L('a', 'Asha', 1085, 1130, 'To summarise, we agreed AI helps revision.'),
    L('b', 'Ravi', 1140, 1170, 'In summary, exams still matter.'),
    L(null, 'HR', 1210, 1215, 'Ravi, why do exams matter?'),
    L('b', 'Ravi', 1217, 1240, 'Because they check understanding.'),
  ];

  it('counts talk time, words, fillers, turns, interruptions, the summary minute and answers to HR', () => {
    const m = computeMetrics(lines, windows, ['a', 'b'], { order: ['a', 'b'], slotMs: 60_000 });
    const a = m.get('a')!;
    const b = m.get('b')!;
    expect(a.talkSeconds).toBe(79);
    expect(a.turns).toBe(2);
    expect(a.fillerWords).toBe(2); // "um", "you know"
    expect(a.interruptions).toBe(0);
    expect(b.interruptions).toBe(1);
    expect(b.fillerWords).toBe(1); // "basically"
    expect(a.summarySeconds).toBe(45); // 1085-1130 inside her slot 1080-1140
    expect(b.summarySeconds).toBe(30);
    expect(b.answeredHr).toBe(true);
    expect(a.answeredHr).toBe(false);
    expect(a.talkShare + b.talkShare).toBeCloseTo(1, 2);
    expect(a.wordsPerMinute).toBeGreaterThan(0);
  });

  it('labels HR as "HR asked:" and shows the phase headings', () => {
    const text = fullTranscript(lines, windows);
    expect(text).toContain('--- DISCUSSION ---');
    expect(text).toContain('[20:10] HR asked: Ravi, why do exams matter?');
    expect(text).toContain('[03:10] Asha: I think um AI');
    expect(studentTranscript(lines, 'a')).not.toContain('Ravi');
  });

  it('leaves private talks out unless HR included them', () => {
    const talk = { participantId: 'b', fromMs: 295_000, toMs: 320_000, include: false };
    const withPrivateHr = [...lines, L(null, 'HR', 296, 299, 'How are you feeling?')];
    const out = applyPrivateTalks(withPrivateHr, [talk]);
    expect(out.some((l) => l.text === 'Let me add one more point.')).toBe(false);
    expect(out.some((l) => l.text === 'How are you feeling?')).toBe(false);
    // Asha's lines at the same time are not private (it was not her talk)
    const included = applyPrivateTalks(withPrivateHr, [{ ...talk, include: true }]);
    expect(included.find((l) => l.text === 'Let me add one more point.')?.private).toBe(true);
    expect(fullTranscript(included, windows)).toContain('Ravi (private talk with HR): Let me add one more point.');
  });

  it('counts the usual filler words', () => {
    expect(fillerCount('Umm, uh, I mean, it is kind of basically fine')).toBe(5);
  });
});

describe('links, emails and decisions', () => {
  it('makes an unguessable link whose hash is stored, following the careers site address', () => {
    const t = newGdToken();
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.tokenHash).toBe(hashGdToken(t.token));
    const base = gdBaseUrlFromEnv({ CAREERS_SITE_URL: 'https://jobs.example.com/' } as NodeJS.ProcessEnv)!;
    expect(gdLink(base, 'abc')).toBe('https://jobs.example.com/gd/abc');
    expect(isPublicGdLink(base)).toBe(true);
    expect(isPublicGdLink('http://localhost:3300/gd/{token}')).toBe(false);
    expect(gdBaseUrlFromEnv({ CAREERS_SITE_URL: 'http://localhost:3300', NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('emails the time, the joining window, the link and the recording notice, never the topic', () => {
    const base = { candidateName: 'Asha Patel', jobTitle: 'Analyst', companyName: 'Acme', companyWebsite: null, roundName: 'Group Discussion' };
    const invite = buildGdInviteEmail({ ...base, startsAt: T0, graceMinutes: 5, durationMinutes: 30, link: 'https://jobs.example.com/gd/abc' });
    expect(invite.subject).toBe('Invitation: Group Discussion for Analyst at Acme');
    expect(invite.text).toContain('closes 5 minutes later');
    expect(invite.text).toContain('https://jobs.example.com/gd/abc');
    expect(invite.text).toContain('audio is recorded');
    expect(invite.html).toContain('<a href="https://jobs.example.com/gd/abc">');
    const reminder = buildGdReminderEmail({ ...base, startsAt: T0, graceMinutes: 5, link: 'https://jobs.example.com/gd/abc' });
    expect(reminder.subject).toContain('Reminder');
    expect(buildGdResultEmail({ ...base, selected: true }).subject).toContain('Congratulations');
    expect(buildGdResultEmail({ ...base, selected: false }).text).toContain('not been selected');
  });

  it('never selects an absent student; HR beats the AI', () => {
    expect(finalDecisionOf('ABSENT', { hrDecision: 'SELECTED', recommendation: 'SELECTED' })).toBe('NOT_SELECTED');
    expect(finalDecisionOf('JOINED', { hrDecision: 'NOT_SELECTED', recommendation: 'SELECTED' })).toBe('NOT_SELECTED');
    expect(finalDecisionOf('ADMITTED_LATE', { hrDecision: null, recommendation: 'SELECTED' })).toBe('SELECTED');
    expect(finalDecisionOf('JOINED', null)).toBe('NOT_SELECTED');
  });
});
