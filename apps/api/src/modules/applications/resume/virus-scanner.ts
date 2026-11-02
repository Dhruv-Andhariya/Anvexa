import { createConnection } from 'node:net';

export type ScanVerdict = 'clean' | 'infected';

/** Scans a resume BEFORE it is saved. Throws ScannerUnavailableError when it cannot decide (we then fail closed). */
export interface VirusScanner {
  /** Stored in resumes.scanned_by. */
  readonly name: string;
  scan(file: Buffer): Promise<ScanVerdict>;
}

export class ScannerUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ScannerUnavailableError';
  }
}

export const VIRUS_SCANNER = Symbol('VIRUS_SCANNER');

export interface ClamAvOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

/**
 * Talks to a clamd daemon over TCP using the INSTREAM command:
 *   "zINSTREAM\0", then chunks each prefixed with a 4-byte big-endian length, then a zero-length chunk.
 *   Reply: "stream: OK" or "stream: <signature> FOUND".
 * Verified against clamav/clamav:stable (2026-10-13). Re-check if you change the ClamAV version, and that
 * StreamMaxLength in clamd.conf is >= 5 MB (the default is larger).
 */
export class ClamAvScanner implements VirusScanner {
  readonly name = 'clamav';

  constructor(private readonly options: ClamAvOptions) {}

  scan(file: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new ScannerUnavailableError(reason));
      };

      socket.setTimeout(this.options.timeoutMs, () => fail('virus scanner timed out'));
      socket.on('error', () => fail('virus scanner is not reachable'));
      socket.on('close', () => fail('virus scanner closed the connection without a verdict'));
      // With the "z" prefix clamd ends its reply with a NUL byte. Read up to it, then close ourselves.
      socket.on('data', (d) => {
        chunks.push(d);
        if (settled || !d.includes(0)) return;
        const reply = Buffer.concat(chunks).toString('utf8').split('\0')[0]!.trim();
        settled = true;
        socket.destroy();
        if (/^stream: OK$/.test(reply)) resolve('clean');
        else if (/ FOUND$/.test(reply)) resolve('infected');
        else reject(new ScannerUnavailableError('virus scanner returned an unexpected reply'));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < file.length; i += CHUNK) {
          const part = file.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        // Zero-length chunk = end of stream. Do NOT half-close (socket.end): clamd then drops the
        // connection without a verdict (checked against clamav/clamav:stable on 2026-10-13).
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** The industry-standard harmless antivirus test string. */
export const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * LOCAL DEMO ONLY: flags the EICAR test file and passes everything else. Refused in production.
 * Lets the demo run without the ~1 GB ClamAV container.
 */
export class DevEicarOnlyScanner implements VirusScanner {
  readonly name = 'dev-eicar-only';

  async scan(file: Buffer): Promise<ScanVerdict> {
    return file.includes(EICAR_SIGNATURE, 0, 'latin1') ? 'infected' : 'clean';
  }
}

export function virusScannerFromEnv(env: NodeJS.ProcessEnv = process.env): VirusScanner {
  const kind = env.VIRUS_SCANNER || 'clamav';
  if (kind === 'dev-eicar-only') {
    if (env.NODE_ENV === 'production') throw new Error('VIRUS_SCANNER=dev-eicar-only is not allowed in production');
    return new DevEicarOnlyScanner();
  }
  if (kind !== 'clamav') throw new Error(`Unknown VIRUS_SCANNER "${kind}" (use clamav or dev-eicar-only)`);
  return new ClamAvScanner({
    host: env.CLAMAV_HOST || 'localhost',
    port: Number(env.CLAMAV_PORT) || 3310,
    timeoutMs: Number(env.CLAMAV_TIMEOUT_MS) || 30_000,
  });
}
