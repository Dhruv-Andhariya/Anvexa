import { CodeRunnerBusyError } from './code-runner';

/**
 * Caps how many code executions run at once on the hosting machine, and queues the rest in arrival order.
 * A run that waits longer than `queueTimeoutMs`, or arrives when `maxQueue` runs are already waiting, is refused
 * with CodeRunnerBusyError instead of piling up without limit.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: { grant: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number,
  ) {}

  get stats(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.waiters.length, max: this.max };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new CodeRunnerBusyError());
    return new Promise<void>((grant, reject) => {
      const waiter = {
        grant,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new CodeRunnerBusyError());
        }, this.queueTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant(); // the slot passes straight to the next in line, so `active` stays the same
    } else {
      this.active -= 1;
    }
  }
}
