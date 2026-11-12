import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import {
  CAMERA_DETECTION_VERSION,
  CAMERA_EVENT_LABELS,
  PROCTOR_REASON_TEXT,
  countProtectionIncident,
  proctorWarningMessage,
  type CameraEventType,
  type ProctorCandidateWarning,
  type ProctorIncidentReview,
} from '@hireflow/contracts';
import { dsaError } from '../dsa.dto';
import { DSA_CLOCK } from '../dsa.tokens';
import type { ProctorEventInput, ProctorStartDto } from './proctoring.dto';
import { DISABLED_POLICY, DSA_PROCTOR_POLICY, clientConfig, countsAsViolation, qualification, severityOf, summarize, type ProctorPolicy } from './proctoring.policy';
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

/** Kind of coding round: programs (DSA), SQL, or both. */
export type CodingRoundKind = 'code' | 'sql' | 'mixed';

const ordinal = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const labelOf = (type: string) => (isCameraType(type) ? (CAMERA_EVENT_LABELS[type as CameraEventType] ?? type) : type.replaceAll('_', ' ').toLowerCase()).toLowerCase();

/**
 * The proctoring record of one coding attempt (DSA or SQL round) and its WARNING MANAGER:
 *   - every report is decided under the record's lock (one writer at a time), so duplicates and simultaneous reports
 *     can never use up a warning twice or terminate twice;
 *   - each new event is validated (proctoring.policy `qualification`) and counted with the rules shared by every
 *     protected round (`countProtectionIncident`): Warning 1, Warning 2, then the 3rd confirmed incident terminates;
 *   - the counter belongs to the attempt (one record per invitation): a DSA round and a SQL round each start at 0;
 *   - after termination (or the end of the attempt) nothing more is processed.
 * The caller (DsaService) ends the assessment itself when `terminated` comes back true.
 */
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

  /** Terminated by the warning limit (also when the assessment's own record has not caught up yet). */
  async isTerminated(inviteRef: string): Promise<{ at: number; reason: string | null } | null> {
    const s = await this.store.get(inviteRef);
    return s?.terminatedAt ? { at: s.terminatedAt, reason: s.terminationReason ?? null } : null;
  }

  /**
   * Records the candidate's consent. Idempotent: the first consent time is kept. `camera`: the attempt is watched by
   * the AI camera; the candidate then consents to the camera notice and must have the webcam on.
   */
  async start(inviteRef: string, assessmentId: string, dto: ProctorStartDto, camera = false, kind?: CodingRoundKind): Promise<ClientProctoringConfig> {
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
    const monitored = await this.store.withLock(inviteRef, () => this.blank(inviteRef, assessmentId), (session) => {
      if (!session.consentAt) {
        session.consentVersion = dto.consentVersion;
        session.consentAt = this.now();
        session.fullscreenAtStart = dto.fullscreen;
        session.cameraAtStart = dto.camera === true;
        session.camera = camera;
        session.kind = kind;
        session.warningCount = 0;
        session.detectionVersion = camera ? CAMERA_DETECTION_VERSION : null;
      }
      return session.camera === true;
    });
    return this.config(monitored);
  }

  /** Called when the assessment actually starts, so event times can be bounded by it. */
  async markAssessmentStarted(inviteRef: string, assessmentId: string, at: number): Promise<void> {
    if (!this.policy.enabled) return;
    await this.store.withLock(inviteRef, () => this.blank(inviteRef, assessmentId), (session) => {
      if (session.startedAt === null) session.startedAt = at;
    });
  }

  /** Records a batch of browser / camera reports and decides each one (see the class comment). */
  async record(inviteRef: string, attempt: AttemptWindow, inputs: ProctorEventInput[]): Promise<RecordResult> {
    if (!this.policy.enabled) throw dsaError(HttpStatus.NOT_FOUND, 'PROCTORING_DISABLED', 'Proctoring is not enabled for this assessment.');
    if (!(await this.isStarted(inviteRef))) {
      throw dsaError(HttpStatus.CONFLICT, 'PROCTORING_NOT_STARTED', 'Proctoring has not been started for this assessment.');
    }
    return this.store.withLock(inviteRef, () => this.blank(inviteRef, attempt.assessmentId), (session) => {
      const now = this.now();
      const lo = attempt.startedAt ?? session.consentAt ?? now;
      const hi = Math.min(now, attempt.endsAt ?? now);
      // a record made before the warning manager: its counter starts from what it already counted
      session.warningCount ??= session.events.filter((e) => countsAsViolation(e, this.policy)).length;
      let accepted = 0;
      let ignored = 0;
      for (const input of inputs) {
        // terminated or ended: nothing more is processed (also not a duplicate termination)
        if (session.terminatedAt || session.endedAt !== null) {
          ignored += 1;
          continue;
        }
        // the page sent this one before (a retry after a lost answer)
        if (input.eventId && session.events.some((e) => e.clientId === input.eventId)) {
          ignored += 1;
          continue;
        }
        // Never trust the client's clock: a time outside the attempt window falls back to the server's.
        const at = typeof input.at === 'number' ? Math.min(Math.max(input.at, lo), hi) : hi;
        const outcome = this.apply(session, input, at);
        if (!outcome) {
          ignored += 1;
          continue;
        }
        accepted += 1;
        if (outcome !== true) this.decide(session, outcome.event, outcome.inherited, now);
      }
      return { accepted, ignored, ...this.candidateState(session) };
    });
  }

  /** Closes open episodes at `endAt` and seals the record. Safe to call twice. */
  async end(inviteRef: string, endAt: number): Promise<ProctoringSummary | null> {
    if (!this.policy.enabled) return null;
    const existing = await this.store.get(inviteRef);
    if (!existing) return null;
    const session = await this.store.withLock(inviteRef, () => existing, (s) => {
      if (s.endedAt === null) {
        for (const e of s.events) {
          if (this.isEpisode(e) && e.endedAt === null) {
            e.endedAt = Math.max(endAt, e.at);
            e.durationMs = e.endedAt - e.at;
          }
        }
        s.endedAt = endAt;
      }
      return s;
    });
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

  /**
   * HR marks one incident Confirmed / Dismissed / Requires further review (the caller checked company and permission,
   * and writes the audit log). Only the review is stored: the warning count, the termination and every score stay as
   * they are. null = no such incident.
   */
  async reviewIncident(inviteRef: string, eventId: number, review: ProctorIncidentReview): Promise<ProctorEventView | null> {
    const existing = await this.store.get(inviteRef);
    if (!existing?.events.some((e) => e.id === eventId)) return null;
    return this.store.withLock(inviteRef, () => existing, (s) => {
      const e = s.events.find((x) => x.id === eventId);
      if (!e) return null;
      e.review = review;
      return this.views(s).find((v) => v.id === eventId) ?? null;
    });
  }

  /** Events in time order, each with the warning it used up (1, 2, ...) or null when it did not count. */
  private views(session: ProctorSession): ProctorEventView[] {
    let strike = 0;
    return [...session.events]
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .map((e) => {
        const counted = countsAsViolation(e, this.policy);
        if (counted) strike += 1;
        return toView(e, counted ? (e.warningNumber ?? strike) : null);
      });
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
    return session
      ? this.candidateState(session)
      : { violationCount: 0, level: 'ok', strikesAllowed: this.policy.maxStrikes, strikesUsed: 0, warning: null, terminated: false };
  }

  async currentStatus(inviteRef: string): Promise<ProctoringSummary | null> {
    return this.summary(inviteRef);
  }

  // ------------------------------------------------------------------ internals

  /**
   * The warning manager's decision for one new event (under the lock). An event merged with an already counted one
   * (a tab switch that absorbed its full-screen exit) keeps that decision instead of counting again.
   */
  private decide(session: ProctorSession, e: ProctorEvent, inherited: ProctorEvent | null, now: number) {
    if (inherited) {
      e.outcome = inherited.outcome;
      e.warningNumber = inherited.warningNumber ?? null;
      return;
    }
    const { qualifies, note } = qualification(e, this.policy);
    const limited = this.policy.maxStrikes > 0;
    const prior = session.events
      .filter((x) => x !== e && x.outcome !== undefined)
      .map((x) => ({ outcome: x.outcome!, warningNumber: x.warningNumber ?? null, occurredAt: new Date(x.at) }));
    const d = countProtectionIncident({
      qualifies,
      warningCount: session.warningCount ?? 0,
      maxWarnings: limited ? this.policy.maxStrikes : Number.MAX_SAFE_INTEGER,
      prior,
      now: new Date(e.at),
      groupWindowSeconds: this.policy.groupWindowSeconds,
    });
    e.outcome = d.outcome;
    e.warningNumber = d.warningNumber;
    e.note = note;
    session.warningCount = d.warningCount;
    if (d.terminate && !session.terminatedAt) {
      const max = this.policy.maxStrikes;
      session.terminatedAt = now;
      session.terminationReason = `Used all ${max} allowed warning${max === 1 ? '' : 's'}; the ${ordinal(max + 1)} confirmed incident (${labelOf(e.type)}) terminated the assessment automatically.`;
    }
  }

  private candidateState(session: ProctorSession): CandidateProctorState {
    const s = summarize(session, this.policy, this.now());
    const max = this.policy.maxStrikes;
    const used = s.strikesUsed;
    const byScore = s.score >= this.policy.reviewScore ? 'final_warning' : s.score >= this.policy.warnScore ? 'warning' : 'ok';
    // With an allowed-warnings limit: any warning is a warning, and using the last allowed one is the final warning.
    const byStrikes = max > 0 ? (used >= max ? 'final_warning' : used > 0 ? 'warning' : 'ok') : 'ok';
    const rank = { ok: 0, warning: 1, final_warning: 2 } as const;
    const level = max > 0 ? byStrikes : rank[byScore] > rank[byStrikes] ? byScore : byStrikes;
    return { violationCount: used, level, strikesAllowed: max, strikesUsed: used, warning: this.latestWarning(session), terminated: !!session.terminatedAt };
  }

  /** The latest warning issued, worded for the candidate (with what was detected). */
  private latestWarning(session: ProctorSession): ProctorCandidateWarning | null {
    const max = this.policy.maxStrikes;
    if (max <= 0) return null;
    const last = [...session.events].reverse().find((e) => e.outcome === 'WARNING' && e.warningNumber);
    if (!last) return null;
    const n = last.warningNumber!;
    return { warningNumber: n, maxWarnings: max, final: n >= max, message: proctorWarningMessage(n, max), reason: PROCTOR_REASON_TEXT[last.type] ?? '' };
  }

  private isEpisode(e: ProctorEvent): boolean {
    return e.type === 'FULLSCREEN_EXIT' || e.type === 'TAB_SWITCH' || e.type === 'WINDOW_BLUR';
  }

  private blank(inviteRef: string, assessmentId: string): ProctorSession {
    return {
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
  }

  /**
   * Applies one reported event. Returns null when it was ignored, true when it only closed an open episode, or the new
   * event (with the already counted event it absorbed, if any) for the warning manager to decide.
   */
  private apply(session: ProctorSession, input: ProctorEventInput, at: number): { event: ProctorEvent; inherited: ProctorEvent | null } | true | null {
    const p = this.policy;

    // A return signal only closes the matching open episode; it is never a record of its own.
    if (input.type in RETURN_CLOSES) {
      const closes = RETURN_CLOSES[input.type as ReturnType];
      const open = [...session.events].reverse().find((e) => e.type === closes && e.endedAt === null);
      if (!open) return null;
      open.endedAt = Math.max(at, open.at);
      open.durationMs = open.endedAt - open.at;
      return true;
    }

    const type = input.type as ViolationType | 'SESSION_RESUMED';
    const recent = [...session.events].reverse().find((e) => e.type === type);
    const camera = isCameraType(type);

    if (camera) {
      // a page cannot invent camera alerts for an attempt that is not camera-monitored
      if (session.camera !== true) return null;
      // the same behaviour reported again inside the cool-down is one alert, not a second warning
      if (recent && Math.abs(at - recent.at) < p.cameraCooldownMs) return null;
    }

    // The same action reported twice (a key event and a clipboard event, say) is one action.
    if (recent && Math.abs(at - recent.at) < p.dedupeMs && type !== 'SESSION_RESUMED') return null;
    // An episode that is already open cannot start again.
    if (recent && this.isEpisode(recent) && recent.endedAt === null) return null;

    if (type === 'WINDOW_BLUR') {
      // Switching tabs blurs the window too: that is one action, kept as the tab switch.
      // (A tab switch that is still open means the window is unfocused anyway, so a blur adds nothing.)
      const tab = session.events.find((e) => e.type === 'TAB_SWITCH' && (e.endedAt === null || Math.abs(at - e.at) <= p.mergeWindowMs));
      if (tab) return null;
    }
    if (type === 'FULLSCREEN_EXIT') {
      // Chrome itself leaves full screen when the tab is switched away. That is the same action as the tab switch.
      const tab = session.events.find((e) => e.type === 'TAB_SWITCH' && (e.endedAt === null || Math.abs(at - e.at) <= p.mergeWindowMs));
      if (tab) return null;
    }
    let inherited: ProctorEvent | null = null;
    if (type === 'TAB_SWITCH') {
      // The window blur and the browser's own full-screen exit that come with a tab switch belong to it.
      for (const part of ['WINDOW_BLUR', 'FULLSCREEN_EXIT'] as const) {
        const merged = session.events.find((e) => e.type === part && Math.abs(e.at - at) <= p.mergeWindowMs);
        if (merged) {
          session.events.splice(session.events.indexOf(merged), 1);
          at = Math.min(at, merged.at); // the candidate really left at the earliest signal
          // it already used up a warning: the tab switch is that same incident, never a second one
          if (!inherited && (merged.outcome === 'WARNING' || merged.outcome === 'TERMINATED')) inherited = merged;
        }
      }
    }

    if (session.events.length >= p.maxEventsPerAttempt) {
      session.dropped += 1;
      return null;
    }

    const prior = session.events.filter((e) => e.type === 'FULLSCREEN_EXIT').length;
    const event: ProctorEvent = {
      id: session.nextId++,
      type,
      severity: severityOf(type, prior, p),
      at,
      endedAt: null,
      durationMs: camera ? (input.durationMs ?? null) : null,
      detail: input.detail && input.detail.length > 0 ? input.detail : null,
      confidence: camera ? (input.confidence ?? null) : null,
      clientId: input.eventId ?? null,
    };
    session.events.push(event);
    return { event, inherited };
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
  /** An AI camera alert (a possible incident for HR to review, never proof). */
  camera: boolean;
  /** Camera alerts: the model's confidence (0..1). */
  confidence: number | null;
  /** The warning this event used up (1, 2, ... the last one terminated), or null when it did not count. */
  strike: number | null;
  /** The warning manager's decision (missing on records made before it). */
  outcome: string | null;
  /** Why a camera alert was kept for review only. */
  note: string | null;
  review: ProctorIncidentReview | null;
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
    outcome: e.outcome ?? null,
    note: e.note ?? null,
    review: e.review ?? null,
  };
}
