import { createHash } from 'node:crypto';
import type { AiScreeningExtraction, AiScreeningResultStatus, AiScreeningReviewStatus } from '@hireflow/contracts';
import type { AuditEntry } from '../../src/modules/audit';
import {
  ScreeningStore,
  type HrRow,
  type InviteRow,
  type NewTurn,
  type PendingUpdate,
  type ResultRow,
  type ScreeningContext,
  type SessionRow,
  type TurnRow,
} from '../../src/modules/screening/screening.store';
import { ScreeningWorkerError, type TurnInput, type TurnResult } from '../../src/modules/screening/screening-worker.client';

export const TENANT = '01a10000-0000-7000-8000-000000000001';
export const OTHER_TENANT = '01a10000-0000-7000-8000-000000000002';
export const JOB = '01a10000-0000-7000-8000-0000000000a1';
export const APP = '01a10000-0000-7000-8000-0000000000b1';
export const OTHER_APP = '01a10000-0000-7000-8000-0000000000b2';
export const TOKEN = 'tok_' + 'a'.repeat(40);
export const OTHER_TOKEN = 'tok_' + 'b'.repeat(40);
export const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export const CTX: ScreeningContext = {
  tenantId: TENANT,
  applicationId: APP,
  jobId: JOB,
  candidateId: 'cand-1',
  candidateName: 'Asha Patel',
  jobTitle: 'Backend Intern',
  companyName: 'Acme Tech',
  form: {
    locations: ['Ahmedabad'],
    workMode: 'HYBRID',
    employmentType: 'INTERNSHIP',
    deadline: null,
    salaryMin: 15000,
    salaryMax: 20000,
    currency: 'INR',
    salaryType: 'CTC',
  },
  jd: {
    title: 'Backend Intern',
    summary: 'Build APIs.',
    aboutCompany: '',
    responsibilities: ['Build REST APIs.'],
    requirements: ['Python'],
    niceToHave: [],
    benefits: ['Certificate'],
  },
};

/** In-memory ScreeningStore with the same rules as the Prisma one (unique seq / clientTurnId, stale claims). */
export class MemoryStore extends ScreeningStore {
  invites = new Map<string, InviteRow>();
  contexts = new Map<string, ScreeningContext>();
  sessions = new Map<string, SessionRow>();
  turnRows = new Map<string, TurnRow[]>();
  results = new Map<string, ResultRow & { attempts: number }>();
  inviteUsed = new Map<string, Date>();
  consents: { applicationId: string; purpose: string }[] = [];
  private n = 0;

  async findInvite(tokenHash: string) {
    return this.invites.get(tokenHash) ?? null;
  }
  async context(applicationId: string) {
    return this.contexts.get(applicationId) ?? null;
  }
  async session(applicationId: string) {
    const s = this.sessions.get(applicationId);
    return s ? { ...s } : null;
  }
  async ensureSession(ctx: ScreeningContext, firstQuestion: string) {
    if (!this.sessions.has(ctx.applicationId)) {
      this.sessions.set(ctx.applicationId, {
        id: `s${++this.n}`,
        tenantId: ctx.tenantId,
        applicationId: ctx.applicationId,
        jobId: ctx.jobId,
        status: 'NOT_STARTED',
        consentGivenAt: null,
        pendingSeq: 1,
        pendingStep: 'INTRO',
        pendingKind: 'MAIN',
        pendingText: firstQuestion,
        followUpsInStep: 0,
        candidateQuestions: 0,
        stepsDone: 0,
        startedAt: null,
        lastActivityAt: null,
        completedAt: null,
        endedReason: null,
        reviewStatus: 'PENDING',
      });
    }
    return (await this.session(ctx.applicationId))!;
  }
  async turns(sessionId: string) {
    return [...(this.turnRows.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
  }
  async start(session: SessionRow, ctx: ScreeningContext, now: Date) {
    const s = this.sessions.get(session.applicationId)!;
    if (s.status === 'NOT_STARTED') {
      Object.assign(s, { status: 'IN_PROGRESS', startedAt: now, lastActivityAt: now, consentGivenAt: now });
      this.consents.push({ applicationId: ctx.applicationId, purpose: 'ai_voice_screening' });
    } else if (s.status === 'ENDED_EARLY') {
      Object.assign(s, { status: 'IN_PROGRESS', endedReason: null, lastActivityAt: now });
    }
    return { ...s };
  }
  async saveTurn(sessionId: string, expectedSeq: number, turn: NewTurn, next: PendingUpdate, now: Date) {
    const s = [...this.sessions.values()].find((x) => x.id === sessionId)!;
    const rows = this.turnRows.get(sessionId) ?? [];
    if (s.pendingSeq !== expectedSeq || s.status !== 'IN_PROGRESS') return 'stale' as const;
    if (rows.some((r) => r.seq === turn.seq || r.clientTurnId === turn.clientTurnId)) return 'stale' as const;
    Object.assign(s, {
      pendingSeq: next.seq,
      pendingStep: next.step,
      pendingKind: next.kind,
      pendingText: next.text,
      followUpsInStep: next.followUpsInStep,
      candidateQuestions: next.candidateQuestions,
      stepsDone: next.stepsDone,
      lastActivityAt: now,
      ...(next.done ? { status: 'COMPLETED', completedAt: now } : {}),
    });
    const { model: _m, promptVersion: _p, ...row } = turn;
    rows.push({ ...row, createdAt: now });
    this.turnRows.set(sessionId, rows);
    return 'saved' as const;
  }
  async endEarly(sessionId: string, now: Date) {
    const s = [...this.sessions.values()].find((x) => x.id === sessionId)!;
    if (s.status === 'IN_PROGRESS') Object.assign(s, { status: 'ENDED_EARLY', endedReason: 'CANDIDATE_ENDED', lastActivityAt: now });
  }
  async markInviteUsed(applicationId: string, now: Date) {
    if (!this.inviteUsed.has(applicationId)) this.inviteUsed.set(applicationId, now);
  }
  async beginResult(session: SessionRow, now: Date) {
    const r = this.results.get(session.id);
    if (r?.status === 'PENDING') return false;
    this.results.set(session.id, { status: 'PENDING', extraction: null, lastError: null, model: null, updatedAt: now, attempts: (r?.attempts ?? 0) + 1 });
    return true;
  }
  async finishResult(sessionId: string, data: { extraction: AiScreeningExtraction; model: string }) {
    Object.assign(this.results.get(sessionId)!, { status: 'DONE' as AiScreeningResultStatus, extraction: data.extraction, model: data.model });
  }
  async failResult(sessionId: string, error: string) {
    Object.assign(this.results.get(sessionId)!, { status: 'FAILED' as AiScreeningResultStatus, lastError: error });
  }
  async result(sessionId: string) {
    return this.results.get(sessionId) ?? null;
  }
  async listForJob(tenantId: string, jobId: string): Promise<HrRow[]> {
    return [...this.contexts.values()]
      .filter((c) => c.tenantId === tenantId && c.jobId === jobId)
      .map((c) => this.row(c))
      .filter((r): r is HrRow => r !== null);
  }
  async hrRow(tenantId: string, applicationId: string) {
    const c = this.contexts.get(applicationId);
    if (!c || c.tenantId !== tenantId) return null;
    const row = this.row(c);
    return row ? { ...row, jobTitle: c.jobTitle, consentGivenAt: row.session?.consentGivenAt ?? null } : null;
  }
  async setReview(tenantId: string, applicationId: string, status: AiScreeningReviewStatus) {
    const s = this.sessions.get(applicationId);
    if (!s || s.tenantId !== tenantId) return false;
    s.reviewStatus = status;
    return true;
  }
  private row(c: ScreeningContext): HrRow | null {
    const invite = [...this.invites.values()].find((i) => i.applicationId === c.applicationId);
    const session = this.sessions.get(c.applicationId) ?? null;
    if (!invite && !session) return null;
    return {
      applicationId: c.applicationId,
      jobId: c.jobId,
      candidateName: c.candidateName,
      linkExpiresAt: invite?.expiresAt ?? null,
      session: session ? { ...session } : null,
      resultStatus: session ? (this.results.get(session.id)?.status ?? null) : null,
    };
  }
}

/** Stands in for the AI worker: queue turn results (or errors); records every call. */
export class FakeWorker {
  turns: (Partial<TurnResult> | Error)[] = [];
  turnCalls: TurnInput[] = [];
  spoken: string[] = [];
  extractCalls = 0;
  extractError: Error | null = null;

  queue(...results: (Partial<TurnResult> | Error)[]) {
    this.turns.push(...results);
    return this;
  }
  async turn(input: TurnInput): Promise<TurnResult> {
    this.turnCalls.push(input);
    const next = this.turns.shift();
    if (!next) throw new Error('FakeWorker.turn called more often than results were queued');
    if (next instanceof Error) throw next;
    return {
      audible: true,
      transcript: 'An answer.',
      needsFollowUp: false,
      followUpQuestion: null,
      candidateAskedQuestion: false,
      reply: null,
      candidateIsDone: false,
      model: 'fake-model',
      promptVersion: 'screening_turn.v1',
      ...next,
    };
  }
  async speak(text: string) {
    this.spoken.push(text);
    return Buffer.from(`RIFF${text.length}`);
  }
  async extract() {
    this.extractCalls++;
    if (this.extractError) throw this.extractError;
    return { extraction: EXTRACTION, model: 'fake-model', promptVersion: 'screening_extract.v1' };
  }
}

export const busy = () => new ScreeningWorkerError('The AI interviewer is busy right now.', 'LLM_RATE_LIMITED', true, 20);

export const EXTRACTION: AiScreeningExtraction = {
  introduction: { statedName: 'Asha', summary: 'Student.', evidence: [1] },
  education: { degree: 'B.E.', fieldOfStudy: 'Computer', institution: null, currentYearOrSemester: null, expectedGraduation: null, evidence: [2] },
  background: { projects: [], internshipsOrWork: [], interests: [], summary: null, evidence: [] },
  location: { currentLocation: 'Surat', willingToWorkAtJobLocation: 'YES', relocationNotes: null, evidence: [4] },
  availability: { currentStatus: null, availability: null, joiningTimeline: null, constraints: null, collegePermission: 'UNKNOWN', evidence: [] },
  candidateQuestions: [],
  unclear: [],
  summary: 'Asha is a student.',
};

export class FakeAudit {
  entries: AuditEntry[] = [];
  async record(e: AuditEntry) {
    this.entries.push(e);
  }
}

export const audio = (bytes = 5000) => ({ bytes: Buffer.alloc(bytes, 1), mimeType: 'audio/webm;codecs=opus' });
