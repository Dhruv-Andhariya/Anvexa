import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { GD_LIMITS } from '@hireflow/contracts';
import { backgroundJobsOn, isFeatureOn } from '../../common/feature-flags';
import { AuditService } from '../audit';
import { GdLiveService } from './gd-live.service';
import { GdMailService } from './gd-mail.service';
import { GdResultsService } from './gd-results.service';
import { GdService } from './gd.service';
import { GdStore } from './gd.store';

export const GD_WORKER_CONFIG = Symbol('GD_WORKER_CONFIG');

export interface GdWorkerConfig {
  /** The background loops run (GD_PROCESSING, default on; always off in tests and with FEATURE_GROUP_DISCUSSION=off). */
  enabled: boolean;
  /** Pools, emails, evaluation (GD_POLL_MS). */
  pollMs: number;
  /** The live timeline: rooms opening / locking, phases (GD_LIVE_POLL_MS, default 1 s). */
  livePollMs: number;
  /**
   * No HR step: as soon as `autoScheduleMin` students wait in a GD round's pool, they are put into groups automatically
   * (AUTO_GD_SCHEDULE, default on; AUTO_GD_MIN_STUDENTS, default 6). Fewer = they keep waiting.
   */
  autoSchedule?: boolean;
  autoScheduleMin?: number;
  /** Minutes from scheduling to the first group's start, so the invitation and the 15-min reminder go out (AUTO_GD_LEAD_MINUTES). */
  autoLeadMinutes?: number;
}

const on = (v: string | undefined, dflt: boolean) => {
  const s = (v ?? '').trim().toLowerCase();
  return s ? !['off', 'false', '0', 'no'].includes(s) : dflt;
};
const int = (v: string | undefined, dflt: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
};

export const gdWorkerConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): GdWorkerConfig => ({
  enabled: backgroundJobsOn(env) && on(env.GD_PROCESSING, true) && isFeatureOn('group_discussion', env) && env.NODE_ENV !== 'test' && !env.VITEST,
  pollMs: int(env.GD_POLL_MS, 10_000, 1000, 600_000),
  livePollMs: int(env.GD_LIVE_POLL_MS, 1000, 250, 10_000),
  autoSchedule: on(env.AUTO_GD_SCHEDULE, true),
  autoScheduleMin: int(env.AUTO_GD_MIN_STUDENTS, 6, GD_LIMITS.groupSizeMin, GD_LIMITS.groupSizeMax),
  autoLeadMinutes: int(env.AUTO_GD_LEAD_MINUTES, 30, GD_LIMITS.minLeadMinutes + 5, 7 * 24 * 60),
});

/** After an automatic scheduling attempt failed for a round (no topics, rounds not complete...), try again this much later. */
const AUTO_RETRY_MS = 30 * 60_000;

const NOT_READY_PAUSE_MS = 5 * 60_000;
const RETENTION_EVERY_MS = 60 * 60_000;

/** "Table / column does not exist": P2021 / P2022 from Prisma queries, P2010 + Postgres 42P01 / 42703 from raw SQL. */
const isMissingTable = (err: unknown) => {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  return e?.code === 'P2021' || e?.code === 'P2022' || (e?.code === 'P2010' && (e.meta?.code === '42P01' || e.meta?.code === '42703'));
};

/**
 * The GD module's background loops (each one tick at a time per process; several API processes are safe: unique keys,
 * conditional updates and FOR UPDATE SKIP LOCKED claims everywhere).
 *  - live loop (~1 s): open rooms at the start time, lock them after the joining window, run the phases
 *  - slow loop (~10 s): fill the pools, queue + send emails, evaluate finished groups, hourly retention clean-up
 */
@Injectable()
export class GdWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('GdWorker');
  private timer: NodeJS.Timeout | undefined;
  private liveTimer: NodeJS.Timeout | undefined;
  private running = false;
  private liveRunning = false;
  private pausedUntil = 0;
  private lastRetention = 0;
  /** Rounds whose automatic scheduling failed: not tried again before this time. */
  private readonly autoRetryAt = new Map<string, number>();

  constructor(
    @Inject(GdStore) private readonly store: GdStore,
    @Inject(GdLiveService) private readonly live: GdLiveService,
    @Inject(GdMailService) private readonly mail: GdMailService,
    @Inject(GdResultsService) private readonly results: GdResultsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GD_WORKER_CONFIG) private readonly config: GdWorkerConfig,
    /** Automatic scheduling (none = HR schedules every GD on the Group Discussion page). */
    @Optional() @Inject(GdService) private readonly planner: GdService | null = null,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.liveTimer = setInterval(() => void this.tickLive(), this.config.livePollMs);
    this.timer.unref();
    this.liveTimer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.liveTimer) clearInterval(this.liveTimer);
  }

  /** Pools, emails, evaluation, retention. Never throws. */
  async tick(): Promise<void> {
    if (this.running || Date.now() < this.pausedUntil) return;
    this.running = true;
    try {
      await this.fillPools();
      if (this.config.autoSchedule) await this.autoSchedule();
      await this.mail.queueDue();
      await this.mail.sendDue();
      await this.results.processNext();
      if (Date.now() - this.lastRetention > RETENTION_EVERY_MS) {
        this.lastRetention = Date.now();
        await this.results.retention();
      }
    } catch (err) {
      this.failed(err);
    } finally {
      this.running = false;
    }
  }

  /** The timeline. Never throws. */
  async tickLive(): Promise<void> {
    if (this.liveRunning || Date.now() < this.pausedUntil) return;
    this.liveRunning = true;
    try {
      await this.live.tickLive();
    } catch (err) {
      this.failed(err);
    } finally {
      this.liveRunning = false;
    }
  }

  /**
   * No HR click: every GD round with at least `autoScheduleMin` students waiting gets an event right away - the whole
   * pool split into groups (HR's last settings for the round, else the defaults), first group `autoLeadMinutes` from
   * now. The usual invitation (date, time, personal link) and reminder emails follow. Returns the rounds scheduled.
   */
  async autoSchedule(): Promise<number> {
    if (!this.planner) return 0;
    const min = this.config.autoScheduleMin ?? 6;
    let scheduled = 0;
    for (const r of await this.store.roundsWithWaiting(min)) {
      const key = `${r.tenantId}|${r.roundId}`;
      if ((this.autoRetryAt.get(key) ?? 0) > Date.now()) continue;
      try {
        const startsAt = await this.planner.scheduleAutomatically(r.tenantId, r.roundId, { minGroupSize: min, leadMinutes: this.config.autoLeadMinutes ?? 30 });
        this.autoRetryAt.delete(key);
        scheduled++;
        await this.audit.record({ tenantId: r.tenantId, actorUserId: null, action: 'gd.auto_scheduled', subjectType: 'job_round', subjectId: r.roundId, metadata: { students: r.waiting, startsAt } });
      } catch (err) {
        this.autoRetryAt.set(key, Date.now() + AUTO_RETRY_MS);
        this.logger.warn(`GD not scheduled automatically round=${r.roundId} (${err instanceof Error ? err.message : 'unknown'}) - HR can schedule it on the Group Discussion page`);
      }
    }
    return scheduled;
  }

  /** Students who passed every round before a GD round (or finished AI screening when it is the first) wait in its pool. */
  async fillPools(): Promise<number> {
    let added = 0;
    for (const c of await this.store.poolCandidates(100)) {
      if (!(await this.store.addToPool(c))) continue;
      added++;
      await this.audit.record({
        tenantId: c.tenantId,
        actorUserId: null,
        action: 'gd.pool_joined',
        subjectType: 'application',
        subjectId: c.applicationId,
        metadata: { roundId: c.roundId },
      });
    }
    return added;
  }

  private failed(err: unknown) {
    if (isMissingTable(err)) {
      this.pausedUntil = Date.now() + NOT_READY_PAUSE_MS;
      this.logger.warn('group discussion tables are missing (run pnpm --filter api db:deploy) - paused 5 minutes');
    } else {
      this.logger.error(`group discussion tick failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }
}
