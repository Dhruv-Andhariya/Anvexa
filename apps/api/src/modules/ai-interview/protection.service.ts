import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_INTERVIEW_PROTECTION_LIMITS,
  DEFAULT_AI_INTERVIEW_PROTECTION,
  aiInterviewProtectionSettingsSchema,
  aiInterviewViolationAckRequestSchema,
  aiInterviewViolationRequestSchema,
  type AiInterviewProtectionConfig,
  type AiInterviewViolationResult,
} from '@hireflow/contracts';
import { AuditService } from '../audit';
import { RoundsConfigService } from '../rounds-config';
import type { Actor } from '../tenants';
import { AI_INTERVIEW_CLOCK, AiInterviewService, interviewError } from './ai-interview.service';
import { AiInterviewStore, type ProtectionSettingsRow } from './ai-interview.store';
import { TERMINATED_TEXT, accepts, classifyViolation, parseProtection, terminationReason } from './protection';

/**
 * InterviewProtectionService - the single source of truth for interview protection. The candidate's page only REPORTS
 * what the browser saw (tab hidden, focus lost, fullscreen left, device stopped) with an incident id it made; this
 * service authenticates the link, checks the interview is running, and lets the store decide - under the interview's
 * row lock - whether it is a new qualifying incident. The page never sends or decides a warning count.
 *
 * Termination (more warnings than the round allows) ends the interview at once, keeps every saved answer, writes the
 * report from them, and puts the interview in INTEGRITY_VIOLATION_REVIEW: HR reviews and decides (never automatic).
 */
@Injectable()
export class InterviewProtectionService {
  private readonly logger = new Logger('InterviewProtection');

  constructor(
    @Inject(AiInterviewStore) private readonly store: AiInterviewStore,
    @Inject(AiInterviewService) private readonly interviews: AiInterviewService,
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AI_INTERVIEW_CLOCK) private readonly now: () => Date,
  ) {}

  /** POST /public/interview/violation - one monitored incident reported by the page. Safe to send twice. */
  async report(token: string | undefined, body: unknown): Promise<AiInterviewViolationResult> {
    const parsed = aiInterviewViolationRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_EVENT', 'Invalid protection event.');
    const { incidentId, type } = parsed.data;
    const o = await this.interviews.open(token, { allowEnded: true });
    const settings = parseProtection(o.session.protection);
    if (!settings) return { outcome: 'IGNORED', warningNumber: null, warningCount: o.session.warningCount, maxWarnings: 0, status: o.session.status };

    const now = this.now();
    const result = await this.store.recordViolation(
      o.session.id,
      { tenantId: o.ctx.tenantId, applicationId: o.ctx.applicationId, candidateId: o.ctx.candidateId },
      { incidentId, type, detail: parsed.data.detail?.slice(0, 200) ?? null, now, maxRows: AI_INTERVIEW_PROTECTION_LIMITS.maxEventsPerSession },
      (session, prior) => {
        // decided on the LOCKED row: the status and the counter cannot change underneath
        const s = parseProtection(session.protection);
        if (!s || !accepts(session.status, type, s)) return null;
        const d = classifyViolation({ type, settings: s, warningCount: session.warningCount, prior, now });
        return { ...d, terminationReason: d.terminate ? terminationReason(type, s.maxWarnings) : null, terminatedText: TERMINATED_TEXT };
      },
    );

    const session = result.session;
    const base = { warningCount: session.warningCount, maxWarnings: settings.maxWarnings, status: session.status };
    if (result.kind === 'replay') return { ...base, outcome: result.row.outcome, warningNumber: result.row.warningNumber };
    if (result.kind === 'ignored') return { ...base, outcome: 'IGNORED', warningNumber: null };

    const d = result.decision;
    const audit = { tenantId: o.ctx.tenantId, actorUserId: null, subjectType: 'application', subjectId: o.ctx.applicationId } as const;
    if (d.outcome === 'WARNING') {
      await this.audit.record({ ...audit, action: 'ai_interview.protection_warning', metadata: { roundId: o.invite.roundId, type, warningNumber: d.warningNumber, maxWarnings: settings.maxWarnings } });
    }
    if (d.terminate) {
      this.logger.log(`interview terminated by the warning limit application=${o.ctx.applicationId}`);
      await this.audit.record({ ...audit, action: 'ai_interview.terminated', metadata: { roundId: o.invite.roundId, type, warnings: settings.maxWarnings, integrityStatus: 'INTEGRITY_VIOLATION_REVIEW' } });
      // the answers saved so far are evaluated for HR's review (in the background; the worker loop retries)
      void this.interviews.generateReport(session.id).catch(() => undefined);
    }
    return { ...base, outcome: d.outcome, warningNumber: d.warningNumber };
  }

  /** POST /public/interview/violation/ack - the candidate read warning N (shown again after a reload until then). */
  async acknowledge(token: string | undefined, body: unknown): Promise<{ acknowledged: boolean }> {
    const parsed = aiInterviewViolationAckRequestSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Invalid warning number.');
    const o = await this.interviews.open(token, { allowEnded: true });
    return { acknowledged: await this.store.acknowledgeWarning(o.session.id, parsed.data.warningNumber, this.now()) };
  }

  // ---------------------------------------------------------------- HR: the round's protection rules

  /** GET /ai-interview/jobs/:jobId/rounds/:roundId/protection */
  async settings(tenantId: string, jobId: string, roundId: string): Promise<AiInterviewProtectionConfig> {
    await this.aiRound(tenantId, jobId, roundId);
    return toConfig(roundId, await this.store.protectionSettings(tenantId, roundId));
  }

  /** PUT /ai-interview/jobs/:jobId/rounds/:roundId/protection - applies to interviews opened from now on. */
  async saveSettings(tenantId: string, jobId: string, roundId: string, body: unknown, actor: Actor | null): Promise<AiInterviewProtectionConfig> {
    await this.aiRound(tenantId, jobId, roundId);
    const parsed = aiInterviewProtectionSettingsSchema.safeParse(body);
    if (!parsed.success) throw interviewError(HttpStatus.BAD_REQUEST, 'INVALID_SETTINGS', parsed.error.issues[0]?.message ?? 'Invalid settings.');
    const before = (await this.store.protectionSettings(tenantId, roundId))?.settings ?? DEFAULT_AI_INTERVIEW_PROTECTION;
    const row = await this.store.saveProtectionSettings(tenantId, roundId, parsed.data, { id: actor?.id ?? null, name: actor?.name ?? null });
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'ai_interview.protection_settings_updated', subjectType: 'job', subjectId: jobId, metadata: { roundId, before, after: parsed.data } });
    return toConfig(roundId, row);
  }

  /** The round must be an AI interview round of this company's job: anything else is a 404 (no hint it exists). */
  private async aiRound(tenantId: string, jobId: string, roundId: string) {
    const config = await this.rounds.forRoundEngine(tenantId, jobId);
    const round = config?.rounds.find((r) => r.id === roundId);
    if (!round || round.type !== 'AI_INTERVIEW') throw interviewError(HttpStatus.NOT_FOUND, 'ROUND_NOT_FOUND', 'This AI interview round was not found. Save the rounds first.');
    return round;
  }
}

function toConfig(roundId: string, row: ProtectionSettingsRow | null): AiInterviewProtectionConfig {
  return {
    roundId,
    settings: row?.settings ?? { ...DEFAULT_AI_INTERVIEW_PROTECTION },
    isDefault: !row,
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedByName ?? null,
  };
}
