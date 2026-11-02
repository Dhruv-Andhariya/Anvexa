import { createHash } from 'node:crypto';

/**
 * Spoken questions, cached in memory by the SHA-256 of their text. The main questions are the same for every candidate
 * of a job, so after the first one they play instantly; parallel requests for the same text share one AI call.
 * Small LRU: entries are ~100-500 KB of WAV. Lost on restart, which is fine (it is only a cache).
 */
export class SpeechCache {
  private readonly entries = new Map<string, Buffer>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();

  constructor(private readonly maxEntries = 120) {}

  async get(text: string, produce: () => Promise<Buffer>): Promise<Buffer> {
    const key = createHash('sha256').update(text).digest('hex');
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key); // move to the newest position
      this.entries.set(key, hit);
      return hit;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const job = produce()
      .then((audio) => {
        this.entries.set(key, audio);
        while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
        return audio;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }
}
