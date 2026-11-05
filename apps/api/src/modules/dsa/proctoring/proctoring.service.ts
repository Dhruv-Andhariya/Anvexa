import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { dsaError } from '../dsa.dto';
import { DSA_CLOCK } from '../dsa.tokens';
import type { ProctorEventInput, ProctorStartDto } from './proctoring.dto';
import { DISABLED_POLICY, DSA_PROCTOR_POLICY, clientConfig, countsAsViolation, severityOf, summarize, type ProctorPolicy } from './proctoring.policy';
import { DSA_PROCTOR_STORE, InMemoryProctorStore, type ProctorStore } from './proctoring.store';
import {
  CAMERA_CONSENT_VERSION,
  CONSENT_VERSION,
  RETURN_CLOSES,
  isCameraType,
  type CandidateProctorState,
  type ClientProctoringConfig,
  type ProctorEvent,
  type ProctorSession,
  type ProctoringSummary,
  type ReturnType,
  type ViolationType,
} from './proctoring.types';

/** Stable, non-reversible reference for an invitation. HR integrations compute the same value from the token. */
export function inviteRefFor(token: string): string {
  return createHash('sha256').update(`dsa-invite:${token}`).digest('hex').slice(0, 24);
}

/** The slice of an assessment session the proctoring service needs. */
export interface AttemptWindow {
  assessmentId: string;
  startedAt: number | null;
  /** Epoch ms when events stop being accepted (deadline or finish). */
  endsAt: number | null;
}

export interface RecordResult extends CandidateProctorState {
  accepted: number;
  ignored: number;
}

@Injectable()
export class ProctoringService {
  constructor(
    @Optional() @Inject(DSA_PROCTOR_STORE) private readonly store: ProctorStore = new InMemoryProctorStore(),
    @Optional() @Inject(DSA_PROCTOR_POLICY) readonly policy: ProctorPolicy = DISABLED_POLICY,
    @Optional() @Inject(DSA_CLOCK) private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.policy.enabled;
  }

  /** `camera`: the attempt is watched by the AI camera (cameraFor(policy, kind of round)). */
  config(camera = false): ClientProctoringConfig {
    return clientConfig(this.policy, camera);
  }

  async isStarted(inviteRef: string): Promise<boolean> {
    const s = await this.store.get(inviteRef);
    return !!s?.consentAt;
  }

  /**
   * Records the candidate's consent. Idempotent: the first consent time is kept. `camera`: the attempt is watched by
   * the AI camera; the candidate then consents to the camera notice and must have the webcam on.
   */
  async start(inviteRef: string, assessmentId: string, dto: ProctorStartDto, camera = false): Promise<ClientProctoringConfig> {
    if (!this.policy.enabled) throw dsaError(HttpStatus.NOT_FOUND, 'PROCTORING_DISABLED', 'Proctoring is not enabled for this assessment.');
    if (dto.consentVersion !== (camera ? CAMERA_CONSENT_VERSION : CONSENT_VERSION)) {
      throw dsaError(HttpStatus.CONFLICT, 'CONSENT_OUTDATED', 'The monitoring notice has changed. Reload the page and read it again.');
    }
    if (this.policy.requireFullscreen && !dto.fullscreen) {
      throw dsaError(HttpStatus.BAD_REQUEST, 'FULLSCREEN_REQUIRED', 'Full-screen mode must be on before the assessment can start.');
    }
    if (camera && dto.camera !== true) {
      throw dsaError(HttpStatus.BAD_REQUEST, 'CAMERA_REQUIRED', 'Your webcam must be on before the assessment can start. Allow the camera and try again.');
    }
    const session = await this.getOrCreate(inviteRef, assessmentId);
    if (!session.consentAt) {
      session.consentVersion = dto.consentVersion;
      session.consentAt = this.now();
      session.fullscreenAtStart = dto.fullscreen;
      session.cameraAtStart = dto.camera === true;
      session.camera = camera;
      await this.store.save(session);
    }
    return this.config(session.camera === true);
  }

  /** Called when the assessment actually starts, so event times can be bounded by it. */
  async markAssessmentStarted(inviteRef: string, assessmentId: string, at: number): Promise<void> {
    if (!this.policy.enabled) return;
    const session = await this.getOrCreate(inviteRef, assessmentId);
    if (session.startedAt === null) {
      session.startedAt = at;
      await this.store.save(session);
    }
  }

  async record(inviteRef: string, attempt: AttemptWindow, inputs: ProctorEventInput[]): Promise<RecordResult> {
    if (!this.policy.enabled) throw dsaError(HttpStatus.NOT_FOUND, 'PROCTORING_DISABLED', 'Proctoring is not enabled for this assessment.');
    const session = await this.getOrCreate(inviteRef, attempt.assessmentId);
    if (!session.consentAt) {
      throw dsaError(HttpStatus.CONFLICT, 'PROCTORING_NOT_STARTED', 'Proctoring has not been started for this assessment.');
    }
    const now = this.now();
    const lo = attempt.startedAt ?? session.consentAt;
    const hi = Math.min(now, attempt.endsAt ?? now);
    let accepted = 0;
    let ignored = 0;

    for (const input of inputs) {
      // Never trust the client's clock: a time outside the attempt window falls back to the server's.
      const at = typeof input.at === 'number' ? Math.min(Math.max(input.at, lo), hi) : hi;
      const outcome = this.apply(session, input, at);
      if (outcome) accepted += 1;
      else ignored += 1;
    }
    await this.store.save(session);
    return { accepted, ignored, ...this.candidateState(session) };
  }

  /** Closes open episodes at `endAt` and seals the record. Safe to call twice. */
  async end(inviteRef: string, endAt: number): Promise<ProctoringSummary | null> {
    if (!this.policy.enabled) return null;
    const session = await this.store.get(inviteRef);
    if (!session) return null;
    if (session.endedAt === null) {
      for (const e of session.events) {
        if (this.isEpisode(e) && e.endedAt === null) {
          e.endedAt = Math.max(endAt, e.at);
          e.durationMs = e.endedAt - e.at;
        }
      }
      session.endedAt = endAt;
      await this.store.save(session);
    }
    return summarize(session, this.policy, this.now());
  }

  async summary(inviteRef: string): Promise<ProctoringSummary | null> {
    const session = await this.store.get(inviteRef);
    return session ? summarize(session, this.policy, this.now()) : null;
  }

  /** HR review of stored sessions (already filtered to one company and application by the caller). */
  reviewOf(session: ProctorSession, eventLimit: number): { summary: ProctoringSummary; events: ProctorEventView[] } {
    return { summary: summarize(session, this.policy, this.now()), events: this.views(session).slice(0, eventLimit) };
  }

  async events(inviteRef: string, limit: number, offset: number): Promise<{ total: number; events: ProctorEventView[] } | null> {
    const session = await this.store.get(inviteRef);
    if (!session) return null;
    const views = this.views(session);
    return { total: views.length, events: views.slice(offset, offset + limit) };
  }

  /** Events in time order, each with the warning it used up (1, 2, ...) or null when it did not count. */
  private views(session: ProctorSession): ProctorEventView[] {
    let strike = 0;
    return [...session.events]
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .map((e) => toView(e, countsAsViolation(e, this.policy) ? ++strike : null));
  }

  /** Attempts whose status needs a person to look at them. */
  async flagged(): Promise<ProctoringSummary[]> {
    const all = await this.store.list();
    return all
      .map((s) => summarize(s, this.policy, this.now()))
      .filter((s) => s.flagged)
      .sort((a, b) => b.score - a.score);
  }

  async candidateStateFor(inviteRef: string): Promise<CandidateProctorState> {
    const session = await this.store.get(inviteRef);
    return session ? this.candidateState(session) : { violationCount: 0, level: 'ok', strikesAllowed: this.policy.maxStrikes, strikesUsed: 0 };
  }

  async currentStatus(inviteRef: string): Promise<ProctoringSummary | null> {
    return this.summary(inviteRef);
  }

  // ------------------------------------------------------------------ internals

  private candidateState(session: ProctorSession): CandidateProctorState {
    const s = summarize(session, this.policy, this.now());
    const byScore = s.score >= this.policy.reviewScore ? 'final_warning' : s.score >= this.policy.warnScore ? 'warning' : 'ok';
    // With an allowed-warnings limit: any strike is a warning, and using the last allowed one is the final warning.
    const max = this.policy.maxStrikes;
    const byStrikes = max > 0 ? (s.totalViolations >= max ? 'final_warning' : s.totalViolations > 0 ? 'warning' : 'ok') : 'ok';
    const rank = { ok: 0, warning: 1, final_warning: 2 } as const;
    const level = rank[byStrikes] > rank[byScore] ? byStrikes : byScore;
    return { violationCount: s.totalViolations, level, strikesAllowed: max, strikesUsed: s.totalViolations };
  }

  private isEpisode(e: ProctorEvent): boolean {
    return e.type === 'FULLSCREEN_EXIT' || e.type === 'TAB_SWITCH' || e.type === 'WINDOW_BLUR';
  }

  private async getOrCreate(inviteRef: string, assessmentId: string): Promise<ProctorSession> {
    const existing = await this.store.get(inviteRef);
    if (existing) return existing;
    const created: ProctorSession = {
      inviteRef,
      assessmentId,
      consentVersion: null,
      consentAt: null,
      fullscreenAtStart: false,
      startedAt: null,
      endedAt: null,
      nextId: 1,
      events: [],
      dropped: 0,
    };
    await this.store.save(created);
    return created;
  }

  /** Applies one reported event. Returns true when it changed the record. */
  private apply(session: ProctorSession, input: ProctorEventInput, at: number): boolean {
    const p = this.policy;

    // A return signal only closes the matching open episode; it is never a record of its own.
    if (input.type in RETURN_CLOSES) {
      const closes = RETURN_CLOSES[input.type as ReturnType];
      const open = [...session.events].reverse().find((e) => e.type === closes && e.endedAt === null);
      if (!open) return false;
      open.endedAt = Math.max(at, open.at);
      open.durationMs = open.endedAt - open.at;
      return true;
    }

    const type = input.type as ViolationType | 'SESSION_RESUMED';
    const recent = [...session.events].reverse().find((e) => e.type === type);
    const camera = isCameraType(type);

    if (camera) {
      // a page cannot invent camera alerts for an attempt that is not camera-monitored
      if (session.camera !== true) return false;
      // the same behaviour reported again inside the cool-down is one alert, not a second warning
      if (recent && Math.abs(at - recent.at) < p.cameraCooldownMs) return false;
    }

    // The same action reported twice (a key event and a clipboard event, say) is one action.
    if (recent && Math.abs(at - recent.at) < p.dedupeMs && type !== 'SESSION_RESUMED') return false;
    // An episode that is already open cannot start again.
    if (recent && this.isEpisode(recent) && recent.endedAt === null) return false;

    if (type === 'WINDOW_BLUR') {
      // Switching tabs blurs the window too: that is one action, kept as the tab switch.
      // (A tab switch that is still open means the window is unfocused anyway, so a blur adds nothing.)
      const tab = session.events.find((e) => e.type === 'TAB_SWITCH' && (e.endedAt === null || Math.abs(at - e.at) <= p.mergeWindowMs));
      if (tab) return false;
    }
    if (type === 'FULLSCREEN_EXIT') {
      // Chrome itself leaves full screen when the tab is switched away. That is the same action as the tab switch.
      const tab = session.events.find((e) => e.type === 'TAB_SWITCH' && (e.endedAt === null || Math.abs(at - e.at) <= p.mergeWindowMs));
      if (tab) return false;
    }
    if (type === 'TAB_SWITCH') {
      // The window blur and the browser's own full-screen exit that come with a tab switch belong to it.
      for (const part of ['WINDOW_BLUR', 'FULLSCREEN_EXIT'] as const) {
        const merged = session.events.find((e) => e.type === part && Math.abs(e.at - at) <= p.mergeWindowMs);
        if (merged) {
          session.events.splice(session.events.indexOf(merged), 1);
          at = Math.min(at, merged.at); // the candidate really left at the earliest signal
        }
      }
    }

    if (session.events.length >= p.maxEventsPerAttempt) {
      session.dropped += 1;
      return false;
    }

    const prior = session.events.filter((e) => e.type === 'FULLSCREEN_EXIT').length;
    session.events.push({
      id: session.nextId++,
      type,
      severity: severityOf(type, prior, p),
      at,
      endedAt: null,
      durationMs: camera ? (input.durationMs ?? null) : null,
      detail: input.detail && input.detail.length > 0 ? input.detail : null,
      confidence: camera ? (input.confidence ?? null) : null,
    });
    return true;
  }
}

export interface ProctorEventView {
  id: number;
  type: string;
  severity: string;
  at: string;
  endedAt: string | null;
  durationMs: number | null;
  detail: string | null;
  /** An AI camera alert (a suspicious pattern for HR to review, never proof). */
  camera: boolean;
  /** Camera alerts: the model's confidence (0..1). */
  confidence: number | null;
  /** The allowed warning this event used up (1, 2, ...), or null when it did not count (info, review-only camera). */
  strike: number | null;
}

function toView(e: ProctorEvent, strike: number | null): ProctorEventView {
  return {
    id: e.id,
    type: e.type,
    severity: e.severity,
    at: new Date(e.at).toISOString(),
    endedAt: e.endedAt === null ? null : new Date(e.endedAt).toISOString(),
    durationMs: e.durationMs,
    detail: e.detail,
    camera: isCameraType(e.type),
    confidence: e.confidence ?? null,
    strike,
  };
}
