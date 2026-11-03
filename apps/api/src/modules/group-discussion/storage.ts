import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where GD audio lives: one folder per recording, one file per chunk (000001.chunk, 000002.chunk...). Joining the
 * chunks of a recording in order gives the browser's original file (WebM / MP4), which Whisper reads directly.
 * Local disk by default (free); access only through the API (HR permission) and the local AI worker.
 *   GD_STORAGE_DIR, default ~/.hireflow/gd-recordings
 * Layout: <tenantId>/<batchId>/<recordingId>/<seq>.chunk  - one company is one folder, one group is one folder.
 *         <tenantId>/<batchId>/session.webm                  - the whole session mixed (built after the group ends)
 */
export abstract class GdAudioStorage {
  abstract prefixFor(tenantId: string, batchId: string, recordingId: string): string;
  abstract putChunk(prefix: string, seq: number, bytes: Buffer): Promise<void>;
  /** Absolute paths of a recording's chunks, in order (for the local AI worker). */
  abstract chunkPaths(prefix: string): Promise<string[]>;
  abstract deletePrefix(prefix: string): Promise<void>;
  /** Absolute path of a group's whole-session audio file (it may not exist). */
  abstract sessionAudioPath(tenantId: string, batchId: string): string;
  /** Group folders of a company that exist on disk (for removing what the database no longer knows). */
  abstract listBatchFolders(tenantId: string): Promise<string[]>;
  abstract deleteBatchFolder(tenantId: string, batchId: string): Promise<void>;
  abstract listTenantFolders(): Promise<string[]>;
}

const SAFE = /^[0-9a-f-]{36}$/i;
const chunkName = (seq: number) => `${String(seq).padStart(6, '0')}.chunk`;

export class LocalGdAudioStorage extends GdAudioStorage {
  constructor(readonly root: string) {
    super();
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalGdAudioStorage {
    return new LocalGdAudioStorage(path.resolve((env.GD_STORAGE_DIR ?? '').trim() || path.join(homedir(), '.hireflow', 'gd-recordings')));
  }

  prefixFor(tenantId: string, batchId: string, recordingId: string) {
    for (const id of [tenantId, batchId, recordingId]) if (!SAFE.test(id)) throw new Error('invalid id for a storage path');
    return [tenantId, batchId, recordingId].join('/');
  }

  async putChunk(prefix: string, seq: number, bytes: Buffer) {
    const dir = this.dir(prefix);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, chunkName(seq)), bytes);
  }

  async chunkPaths(prefix: string) {
    const dir = this.dir(prefix);
    const names = await readdir(dir).catch(() => [] as string[]);
    return names.filter((n) => /^\d{6}\.chunk$/.test(n)).sort().map((n) => path.join(dir, n));
  }

  sessionAudioPath(tenantId: string, batchId: string) {
    if (!SAFE.test(tenantId) || !SAFE.test(batchId)) throw new Error('invalid id for a storage path');
    return path.join(this.root, tenantId, batchId, 'session.webm');
  }

  async deletePrefix(prefix: string) {
    await rm(this.dir(prefix), { recursive: true, force: true });
  }

  async listBatchFolders(tenantId: string) {
    if (!SAFE.test(tenantId)) return [];
    return (await readdir(path.join(this.root, tenantId)).catch(() => [] as string[])).filter((n) => SAFE.test(n));
  }

  async deleteBatchFolder(tenantId: string, batchId: string) {
    if (!SAFE.test(tenantId) || !SAFE.test(batchId)) return;
    await rm(path.join(this.root, tenantId, batchId), { recursive: true, force: true });
  }

  async listTenantFolders() {
    return (await readdir(this.root).catch(() => [] as string[])).filter((n) => SAFE.test(n));
  }

  private dir(prefix: string) {
    const parts = prefix.split('/');
    if (parts.length !== 3 || !parts.every((p) => SAFE.test(p))) throw new Error('invalid storage prefix');
    return path.join(this.root, ...parts);
  }
}
