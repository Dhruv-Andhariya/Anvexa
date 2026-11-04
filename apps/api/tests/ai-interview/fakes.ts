import { createHash } from 'node:crypto';
import type { AiInterviewDecision, AiInterviewProtectionSettings, AiInterviewReport, SavedRound } from '@hireflow/contracts';
import {
  AiInterviewStore,
  type EventRow,
  type InterviewContext,
  type InviteRow,
  type NewTurn,
  type NextUpdate,
  type ProtectionSettingsRow,
  type RecordViolationResult,
  type ReportRow,
  type SendFailure,
  type SessionRow,
  type TurnRow,
  type ViolationInput,
  type ViolationRow,
  type ViolationVerdict,
} from '../../src/modules/ai-interview/ai-interview.store';
import { InterviewWorkerError, type ReportInput, type TurnInput } from '../../src/modules/ai-interview/ai-interview-worker.client';
import type { InterviewConfig, StoredPlan } from '../../src/modules/ai-interview/flow';

export const TENANT = '01a20000-0000-7000-8000-000000000001';
export const OTHER_TENANT = '01a20000-0000-7000-8000-000000000002';
export const JOB = '01a20000-0000-7000-8000-0000000000a1';
export const APP = '01a20000-0000-7000-8000-0000000000b1';
export const OTHER_APP = '01a20000-0000-7000-8000-0000000000b2';
export const ROUND = '01a20000-0000-7000-8000-0000000000c1';
export const GD_ROUND = '01a20000-0000-7000-8000-0000000000c0';
export const NEXT_ROUND = '01a20000-0000-7000-8000-0000000000c2';
export const HR_Q = '01a20000-0000-7000-8000-0000000000d1';
export const TOKEN = 'tok_' + 'a'.repeat(40);
export const OTHER_TOKEN = 'tok_' + 'b'.repeat(40);
export const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export const CTX: InterviewContext = {
  tenantId: TENANT,
  applicationId: APP,
  jobId: JOB,
  candidateId: 'cand-1',
  candidateName: 'Asha Patel',
  email: 'asha@example.com',
  jobTitle: 'AI Engineer Intern',
  companyName: 'Acme Tech',
  companyWebsite: 'https://acme.example',
  job: {
    title: 'AI Engineer Intern',
    summary: 'Build LLM features.',
    responsibilities: ['Build RAG pipelines.'],
    requirements: ['Python', 'SQL'],
    niceToHave: [],
    skills: ['Python', 'FastAPI', 'PostgreSQL'],
    experienceLevel: '0-1 years',
  },
  resume: {
    summary: 'Final year student.',
    skills: ['Python', 'ChromaDB'],
    projects: [{ title: 'RAG chatbot for college notes', technologies: ['LangChain', 'ChromaDB'], summary: 'Answers questions from notes.' }],
    experience: [],
    education: [],
    certifications: [],
    achievements: [],
  },
};

/** A job whose rounds HR chose freely: Group Discussion, then the AI interview, then an HR interview. */
export function rounds(overrides: Partial<SavedRound> = {}): SavedRound[] {
  const base = { description: '', questions: [], totals: { questions: 0, marks: 0 } };
  return [
    { ...base, id: GD_ROUND, position: 1, type: 'GROUP_DISCUSSION', name: 'Group Discussion', timeLimitMinutes: null, passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 } },
    {
      ...base,
      id: ROUND,
      position: 2,
      type: 'AI_INTERVIEW',
      name: 'AI Technical Interview',
      timeLimitMinutes: 20,
      passRule: { mode: 'INTERVIEWER_SCORE', value: 6, maxScore: 10 },
      questions: [
        {
          id: HR_Q,
          position: 1,
          kind: 'INTERVIEW',
          text: 'Explain the difference between a process and a thread',
          options: [],
          correct: [],
          modelAnswer: 'Threads share memory within a process.',
          language: null,
          marks: 1,
          difficulty: null,
          topics: ['OS'],
          source: 'HR',
          coding: null,
        },
      ],
      totals: { questions: 1, marks: 1 },
      ...overrides,
    },
    { ...base, id: NEXT_ROUND, position: 3, type: 'HR_INTERVIEW', name: 'HR Interview', timeLimitMinutes: null, passRule: { mode: 'INTERVIEWER_SCORE', value: 5, maxScore: 10 } },
  ] as SavedRound[];
}

/** In-memory AiInterviewStore with the same rules as the Prisma one (unique seq / clientTurnId, conditional updates). */
export class MemoryStore extends AiInterviewStore {
  invites = new Map<string, InviteRow & { tokenHash: string | null; linkBase: string | null; nextAttemptAt: Date }>();
  contexts = new Map<string, InterviewContext>();
  sessions = new Map<string, SessionRow>();
  turnRows = new Map<string, (TurnRow & { model: string | null })[]>();
  eventRows = new Map<string, EventRow[]>();
  reports = new Map<string, ReportRow>();
  consents: { applicationId: string; purpose: string }[] = [];
  violationRows = new Map<string, (ViolationRow & { tenantId: string; applicationId: string; candidateId: string })[]>();
  settings = new Map<string, ProtectionSettingsRow & { tenantId: string }>();
  private n = 0;

  addInvite(token: string, i: Partial<InviteRow> = {}) {
    const id = `inv${++this.n}`;
    this.invites.set(id, {
      id,
      tenantId: TENANT,
      applicationId: APP,
      jobId: JOB,
      roundId: ROUND,
      expiresAt: new Date('2026-11-10T10:00:00Z'),
      emailStatus: 'SENT',
      attempts: 1,
      sentAt: new Date('2026-11-03T10:00:00Z'),
      lastError: null,
      tokenHash: hash(token),
      linkBase: 'https://careers.example/interview/{token}',
      nextAttemptAt: new Date(0),
      ...i,
    });
    return id;
  }

  async findInviteByHash(tokenHash: string) {
    return [...this.invites.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async context(tenantId: string, applicationId: string) {
    const c = this.contexts.get(applicationId);
    return c && c.tenantId === tenantId ? c : null;
  }
  async sessionByInvite(inviteId: string) {
    const s = [...this.sessions.values()].find((x) => x.inviteId === inviteId);
    return s ? { ...s } : null;
  }
  async session(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : null;
  }
  async ensureSession(invite: InviteRow, config: InterviewConfig, greeting: string, protection: AiInterviewProtectionSettings | null = null) {
    const existing = await this.sessionByInvite(invite.id);
    if (existing) return existing;
    const s: SessionRow = {
      id: `s${++this.n}`,
      tenantId: invite.tenantId,
      applicationId: invite.applicationId,
      jobId: invite.jobId,
      roundId: invite.roundId,
      inviteId: invite.id,
      status: 'NOT_STARTED',
      consentGivenAt: null,
      config: JSON.parse(JSON.stringify(config)),
      plan: null,
      pendingSeq: 1,
      pendingKind: 'INTRO',
      pendingSource: 'INTRO',
      pendingText: greeting,
      pendingTopicId: null,
      pendingTopic: null,
      pendingResumeRef: null,
      pendingAskedAt: null,
      pendingRepeats: 0,
      followUpsOnTopic: 0,
      coveredTopics: [],
      startedAt: null,
      pausedSeconds: 0,
      pausedAt: null,
      pauseReason: null,
      lastActivityAt: null,
      completedAt: null,
      endedReason: null,
      decision: null,
      decisionReason: null,
      decidedById: null,
      decidedByName: null,
      decidedAt: null,
      recordedAt: null,
      protection: protection ? JSON.parse(JSON.stringify(protection)) : null,
      warningCount: 0,
      integrityStatus: 'NONE',
      terminatedAt: null,
      terminationReason: null,
    };
    this.sessions.set(s.id, s);
    return { ...s };
  }
  async turns(sessionId: string) {
    return (this.turnRows.get(sessionId) ?? []).map((t) => ({ ...t }));
  }
  async start(session: SessionRow, ctx: InterviewContext, now: Date) {
    const s = this.sessions.get(session.id)!;
    if (s.status !== 'NOT_STARTED') return;
    Object.assign(s, { status: 'IN_PROGRESS', startedAt: now, lastActivityAt: now, consentGivenAt: now, pendingAskedAt: now });
    this.consents.push({ applicationId: ctx.applicationId, purpose: 'ai_technical_interview' });
  }
  async savePlan(sessionId: string, plan: StoredPlan) {
    const s = this.sessions.get(sessionId)!;
    if (s.plan == null) s.plan = JSON.parse(JSON.stringify(plan));
  }
  async saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: NextUpdate, now: Date) {
    const s = this.sessions.get(sessionId)!;
    const list = this.turnRows.get(sessionId) ?? [];
    if (s.pendingSeq !== expectedSeq || s.status !== 'IN_PROGRESS') return 'stale' as const;
    if (list.some((t) => t.seq === turn.seq || t.clientTurnId === turn.clientTurnId)) return 'stale' as const;
    list.push({ ...turn });
    this.turnRows.set(sessionId, list);
    Object.assign(s, {
      pendingSeq: expectedSeq + 1,
      pendingKind: next.pending.kind,
      pendingSource: next.pending.source,
      pendingText: next.pending.text,
      pendingTopicId: next.pending.topicId,
      pendingTopic: next.pending.topic,
      pendingResumeRef: next.pending.resumeRef,
      pendingAskedAt: now,
      pendingRepeats: 0,
      followUpsOnTopic: next.followUpsOnTopic,
      coveredTopics: next.coveredTopics,
      lastActivityAt: now,
      ...(next.done ? { status: 'COMPLETED', completedAt: now, endedReason: next.endedReason } : {}),
    });
    return 'saved' as const;
  }
  async finish(sessionId: string, status: 'COMPLETED' | 'INCOMPLETE', reason: string, closing: string, now: Date) {
    const s = this.sessions.get(sessionId)!;
    if (s.status !== 'IN_PROGRESS' && s.status !== 'PAUSED') return false;
    const pause = s.pausedAt ? Math.round((now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
    Object.assign(s, {
      status,
      completedAt: now,
      endedReason: reason,
      pausedSeconds: s.pausedSeconds + pause,
      pausedAt: null,
      pendingSeq: s.pendingSeq + 1,
      pendingKind: 'CLOSING',
      pendingSource: 'CLOSING',
      pendingText: closing,
      pendingTopicId: null,
    });
    return true;
  }
  async pause(sessionId: string, reason: string, now: Date) {
    const s = this.sessions.get(sessionId)!;
    if (s.status !== 'IN_PROGRESS') return false;
    Object.assign(s, { status: 'PAUSED', pausedAt: now, pauseReason: reason, lastActivityAt: now });
    return true;
  }
  async resume(sessionId: string, now: Date) {
    const s = this.sessions.get(sessionId)!;
    if (s.status !== 'PAUSED') return false;
    const pause = s.pausedAt ? Math.round((now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
    Object.assign(s, { status: 'IN_PROGRESS', pausedAt: null, pauseReason: null, pausedSeconds: s.pausedSeconds + pause, pendingAskedAt: now, pendingRepeats: 0, lastActivityAt: now });
    return true;
  }
  async countRepeat(sessionId: string, seq: number, max: number) {
    const s = this.sessions.get(sessionId)!;
    if (s.pendingSeq !== seq || s.pendingRepeats >= max) return false;
    s.pendingRepeats++;
    return true;
  }
  async touch(sessionId: string, now: Date) {
    const s = this.sessions.get(sessionId)!;
    if (s.status === 'IN_PROGRESS' || s.status === 'PAUSED') s.lastActivityAt = now;
  }
  async addEvents(_tenantId: string, sessionId: string, events: { type: string; occurredAt: Date; detail: string | null }[]) {
    this.eventRows.set(sessionId, [...(this.eventRows.get(sessionId) ?? []), ...events]);
  }

  // ---- protection: the body runs without an await between reading and writing, like the Prisma row lock
  async recordViolation(
    sessionId: string,
    owner: { tenantId: string; applicationId: string; candidateId: string },
    input: ViolationInput,
    decide: (session: SessionRow, prior: ViolationRow[]) => ViolationVerdict,
  ): Promise<RecordViolationResult> {
    const s = this.sessions.get(sessionId)!;
    const list = this.violationRows.get(sessionId) ?? [];
    const existing = list.find((v) => v.incidentId === input.incidentId);
    if (existing) return { kind: 'replay', row: { ...existing }, session: { ...s } };
    const verdict = decide({ ...s }, list.map((v) => ({ ...v })));
    if (!verdict) return { kind: 'ignored', session: { ...s } };
    const { terminationReason, terminatedText, ...decision } = verdict;
    const counted = decision.outcome === 'WARNING' || decision.outcome === 'TERMINATED';
    const stored = counted || list.length < input.maxRows;
    if (counted && list.some((v) => (v.outcome === 'WARNING' || v.outcome === 'TERMINATED') && v.warningNumber === decision.warningNumber)) {
      throw new Error('unique violation: warning number already used'); // the partial unique index
    }
    if (stored) {
      list.push({ ...owner, type: input.type, outcome: decision.outcome, warningNumber: decision.warningNumber, incidentId: input.incidentId, occurredAt: input.now, detail: input.detail, acknowledgedAt: null, resolvedAt: null });
      this.violationRows.set(sessionId, list);
    }
    if (counted) {
      s.warningCount = decision.warningCount;
      s.lastActivityAt = input.now;
      if (decision.terminate) {
        const pause = s.pausedAt ? Math.round((input.now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
        Object.assign(s, {
          status: 'TERMINATED',
          completedAt: input.now,
          endedReason: 'MAX_WARNINGS_EXCEEDED',
          terminatedAt: input.now,
          terminationReason,
          integrityStatus: 'INTEGRITY_VIOLATION_REVIEW',
          pausedSeconds: s.pausedSeconds + pause,
          pausedAt: null,
          pendingSeq: s.pendingSeq + 1,
          pendingKind: 'CLOSING',
          pendingSource: 'CLOSING',
          pendingText: terminatedText,
          pendingTopicId: null,
        });
      }
    }
    return { kind: 'saved', decision, stored, session: { ...s } };
  }
  async violations(sessionId: string) {
    return (this.violationRows.get(sessionId) ?? []).map((v) => ({ ...v }));
  }
  async acknowledgeWarning(sessionId: string, warningNumber: number, now: Date) {
    const v = (this.violationRows.get(sessionId) ?? []).find((x) => x.warningNumber === warningNumber && x.outcome === 'WARNING' && !x.acknowledgedAt);
    if (!v) return false;
    v.acknowledgedAt = now;
    return true;
  }
  async resolveDeviceIncidents(sessionId: string, now: Date) {
    for (const v of this.violationRows.get(sessionId) ?? []) if ((v.type === 'CAMERA_LOST' || v.type === 'MIC_LOST') && !v.resolvedAt) v.resolvedAt = now;
  }
  async protectionSettings(tenantId: string, roundId: string) {
    const r = this.settings.get(roundId);
    return r && r.tenantId === tenantId ? { settings: { ...r.settings }, updatedAt: r.updatedAt, updatedByName: r.updatedByName } : null;
  }
  async saveProtectionSettings(tenantId: string, roundId: string, settings: AiInterviewProtectionSettings, by: { id: string | null; name: string | null }) {
    const row = { tenantId, settings: { ...settings }, updatedAt: new Date('2026-11-03T09:00:00Z'), updatedByName: by.name };
    this.settings.set(roundId, row);
    return { settings: { ...row.settings }, updatedAt: row.updatedAt, updatedByName: row.updatedByName };
  }

  async queueInvite(row: { tenantId: string; applicationId: string; jobId: string; roundId: string }) {
    if ([...this.invites.values()].some((i) => i.applicationId === row.applicationId && i.roundId === row.roundId)) return false;
    const id = `inv${++this.n}`;
    this.invites.set(id, { id, ...row, expiresAt: null, emailStatus: 'QUEUED', attempts: 0, sentAt: null, lastError: null, tokenHash: null, linkBase: null, nextAttemptAt: new Date(0) });
    return true;
  }
  async claimDueInvites(now: Date, _staleBefore: Date, limit: number) {
    const due = [...this.invites.values()].filter((i) => i.emailStatus === 'QUEUED' && i.nextAttemptAt <= now).slice(0, limit);
    for (const i of due) Object.assign(i, { emailStatus: 'SENDING', attempts: i.attempts + 1 });
    return due.map((i) => ({ ...i }));
  }
  async setInviteToken(inviteId: string, tokenHash: string, expiresAt: Date, linkBase: string) {
    Object.assign(this.invites.get(inviteId)!, { tokenHash, expiresAt, linkBase });
  }
  async inviteSent(inviteId: string, sentAt: Date, expiresAt: Date) {
    Object.assign(this.invites.get(inviteId)!, { emailStatus: 'SENT', sentAt, expiresAt, lastError: null });
  }
  async inviteFailed(inviteId: string, failure: SendFailure) {
    const i = this.invites.get(inviteId)!;
    if ('giveUp' in failure) Object.assign(i, { emailStatus: 'FAILED', lastError: failure.error });
    else Object.assign(i, { emailStatus: 'QUEUED', nextAttemptAt: failure.retryAt, lastError: failure.error, attempts: failure.countAttempt ? i.attempts : i.attempts - 1 });
  }
  async idleSessions(before: Date, limit: number) {
    return [...this.sessions.values()].filter((s) => (s.status === 'IN_PROGRESS' || s.status === 'PAUSED') && (s.lastActivityAt ?? new Date(0)) < before).slice(0, limit).map((s) => ({ ...s }));
  }
  async sessionsNeedingReport(_now: Date, limit: number) {
    return [...this.sessions.values()]
      .filter((s) => (s.status === 'COMPLETED' || s.status === 'INCOMPLETE' || s.status === 'TERMINATED') && (this.turnRows.get(s.id) ?? []).some((t) => t.kind !== 'INTRO') && (!this.reports.has(s.id) || this.reports.get(s.id)!.status === 'FAILED'))
      .slice(0, limit)
      .map((s) => ({ ...s }));
  }
  async beginReport(session: SessionRow, now: Date) {
    const r = this.reports.get(session.id);
    if (r?.status === 'PENDING') return false;
    this.reports.set(session.id, { status: 'PENDING', report: r?.report ?? null, overallScore: null, lastError: null, attempts: (r?.attempts ?? 0) + 1, generatedAt: null, updatedAt: now });
    return true;
  }
  async finishReport(sessionId: string, data: { report: AiInterviewReport }, now: Date) {
    Object.assign(this.reports.get(sessionId)!, { status: 'DONE', report: data.report, overallScore: data.report.overallScore, generatedAt: now });
  }
  async failReport(sessionId: string, error: string) {
    Object.assign(this.reports.get(sessionId)!, { status: 'FAILED', lastError: error });
  }
  async decidedNotRecorded(limit: number) {
    return [...this.sessions.values()].filter((s) => s.decision && !s.recordedAt).slice(0, limit).map((s) => ({ ...s }));
  }
  async invitesForApplication(tenantId: string, applicationId: string) {
    return [...this.invites.values()].filter((i) => i.tenantId === tenantId && i.applicationId === applicationId);
  }
  async sessionsForApplication(tenantId: string, applicationId: string) {
    return [...this.sessions.values()].filter((s) => s.tenantId === tenantId && s.applicationId === applicationId).map((s) => ({ ...s }));
  }
  async report(sessionId: string) {
    return this.reports.get(sessionId) ?? null;
  }
  async events(sessionId: string) {
    return this.eventRows.get(sessionId) ?? [];
  }
  async decide(tenantId: string, sessionId: string, d: { decision: AiInterviewDecision; reason: string | null; byId: string | null; byName: string | null }, now: Date) {
    const s = this.sessions.get(sessionId);
    if (!s || s.tenantId !== tenantId || s.decision || !['COMPLETED', 'INCOMPLETE', 'TERMINATED'].includes(s.status)) return false;
    Object.assign(s, { decision: d.decision, decisionReason: d.reason, decidedById: d.byId, decidedByName: d.byName, decidedAt: now });
    if (s.integrityStatus === 'INTEGRITY_VIOLATION_REVIEW') s.integrityStatus = 'REVIEWED';
    return true;
  }
  async markRecorded(sessionId: string, now: Date) {
    const s = this.sessions.get(sessionId)!;
    s.recordedAt ??= now;
  }
}

type Heard = Awaited<ReturnType<FakeWorker['turn']>>;

/** Stands in for the AI worker. Queue turn results (or errors); records every call. */
export class FakeWorker {
  turns: (Heard | Error)[] = [];
  turnCalls: TurnInput[] = [];
  planCalls = 0;
  planError: Error | null = null;
  reportCalls: ReportInput[] = [];
  reportOut: AiInterviewReport = report(72);
  spoken: string[] = [];

  queue(...items: (Heard | Error)[]) {
    this.turns.push(...items);
    return this;
  }

  async plan() {
    this.planCalls++;
    if (this.planError) throw this.planError;
    return {
      topics: [
        { id: 't1', title: 'RAG chatbot', source: 'RESUME' as const, resumeRef: 'RAG chatbot for college notes', skill: 'RAG', goal: '', question: 'How does a question flow through your RAG chatbot?', priority: 1 },
        { id: 't2', title: 'OS', source: 'HR' as const, resumeRef: null, skill: null, goal: '', question: 'Can you explain the difference between a process and a thread?', priority: 1 },
        { id: 't3', title: 'Slow API', source: 'SCENARIO' as const, resumeRef: null, skill: null, goal: '', question: 'Suppose your API suddenly becomes slow - how would you find the cause?', priority: 2 },
      ],
      model: 'fake-model',
      promptVersion: 'interview_plan.v1',
    };
  }

  async turn(input: TurnInput) {
    this.turnCalls.push(input);
    const next = this.turns.shift();
    if (!next) throw new Error('FakeWorker.turn called more times than queued');
    if (next instanceof Error) throw next;
    return next;
  }

  async speak(text: string) {
    this.spoken.push(text);
    return Buffer.from('RIFF....WAVE');
  }

  async report(input: ReportInput) {
    this.reportCalls.push(input);
    return { report: this.reportOut, model: 'fake-model', promptVersion: 'interview_report.v1' };
  }
}

export const heard = (transcript: string, decision: Heard['decision'] = null, extra: Partial<Heard> = {}): Heard => ({
  audible: true,
  transcript,
  normalizedTranscript: transcript,
  quality: 'CLEAR',
  unclearTerms: [],
  decision,
  model: 'fake-model',
  promptVersion: 'interview_transcribe.v1+interview_turn.v1',
  ...extra,
});

export const silence = (): Heard => ({ ...heard(''), audible: false });

export const decision = (d: Partial<NonNullable<Heard['decision']>>): NonNullable<Heard['decision']> => ({
  reading: 'STRONG',
  action: 'NEXT_TOPIC',
  question: null,
  topicId: null,
  newTopicTitle: null,
  newTopicSource: null,
  newTopicResumeRef: null,
  coveredTopicIds: [],
  ...d,
});

export const busy = () => new InterviewWorkerError('The AI interviewer is busy right now.', 'LLM_RATE_LIMIT', true, 20);

export function report(overall: number | null): AiInterviewReport {
  return {
    overallScore: overall,
    dimensions: [{ key: 'TECHNICAL_KNOWLEDGE', score: overall === null ? null : overall / 10, summary: 'ok', evidence: [2] }],
    answers: [{ seq: 2, technicalAccuracy: 7, depth: 6, strengths: ['clear'], gaps: [], quote: null, summary: 'Explains retrieval.' }],
    strengths: ['Retrieval design'],
    improvementAreas: [],
    skillsDemonstrated: ['RAG'],
    skillsNotVerified: ['SQL'],
    recommendation: overall === null ? 'NEEDS_HUMAN_REVIEW' : overall >= 65 ? 'RECOMMENDED' : 'NEEDS_HUMAN_REVIEW',
    recommendationReason: 'Good project knowledge.',
    uncertain: false,
    uncertaintyNotes: [],
    summary: 'Solid on the project.',
  };
}

export const audio = () => ({ bytes: Buffer.alloc(4000, 1), mimeType: 'audio/webm;codecs=opus' });

export class FakeAudit {
  entries: { action: string; subjectId?: string | null; metadata?: unknown }[] = [];
  async record(e: { action: string; subjectId?: string | null; metadata?: unknown }) {
    this.entries.push(e);
  }
}

/** RoundsConfigService stand-in: the job's rounds (forRoundEngine) and the lock. */
export class FakeRounds {
  locked = 0;
  constructor(public list: SavedRound[] = rounds()) {}
  async forRoundEngine(tenantId: string, jobId: string) {
    return tenantId === TENANT && jobId === JOB ? { status: 'COMPLETE', locked: this.locked > 0, rounds: this.list } : null;
  }
  async lockForAttempts() {
    this.locked++;
  }
}

/** RoundEngineService stand-in: who waits for the module, and the results it records. */
export class FakeEngine {
  waiting: { tenantId: string; applicationId: string; jobId: string; roundId: string }[] = [];
  recorded: { tenantId: string; module: string; input: Record<string, unknown>; hrDecision?: { passed: boolean; reason: string } }[] = [];
  failNext = false;
  async waitingForModule() {
    return this.waiting;
  }
  async recordModuleResult(tenantId: string, module: string, input: Record<string, unknown>, hrDecision?: { passed: boolean; reason: string }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('database down');
    }
    this.recorded.push({ tenantId, module, input, hrDecision });
    return { outcome: hrDecision?.passed ? 'PASSED' : 'FAILED' };
  }
}

export class FakeMailer {
  enabled = true;
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, m: { subject: string; text: string }) {
    this.sent.push({ to, subject: m.subject, text: m.text });
  }
}
