import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { checkResume, detectResumeKind, safeFileName, zipEntryNames } from '../../src/modules/applications/resume/file-check';
import {
  ClamAvScanner,
  DevEicarOnlyScanner,
  EICAR_SIGNATURE,
  ScannerUnavailableError,
  virusScannerFromEnv,
} from '../../src/modules/applications/resume/virus-scanner';
import { DOCX, PDF, zip } from './fixtures';

describe('resume file checks', () => {
  it('detects PDF and DOCX from content', () => {
    expect(detectResumeKind(PDF)).toBe('pdf');
    expect(detectResumeKind(DOCX)).toBe('docx');
    expect(detectResumeKind(Buffer.from('MZ executable'))).toBeUndefined();
    // A plain ZIP is not a Word file.
    expect(detectResumeKind(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('notes.txt')]))).toBeUndefined();
  });

  it('reads DOCX entries from the ZIP central directory, not from a byte search', () => {
    expect(zipEntryNames(DOCX)).toEqual(new Set(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']));
    // The names only in the archive comment: a byte search would have accepted this.
    const inComment = zip(['notes.txt'], '[Content_Types].xml word/document.xml');
    expect(inComment.includes('word/document.xml')).toBe(true);
    expect(detectResumeKind(inComment)).toBeUndefined();
    // A fake end-of-directory record inside the comment is ignored (its comment length does not reach the end).
    expect(zipEntryNames(zip(['a.txt'], 'PK\x05\x06' + '\0'.repeat(18) + 'fake'))).toEqual(new Set(['a.txt']));
    // Both parts are required, and names must match exactly.
    expect(detectResumeKind(zip(['word/document.xml']))).toBeUndefined();
    expect(detectResumeKind(zip(['[Content_Types].xml', 'word/document.xml.bak']))).toBeUndefined();
    expect(detectResumeKind(zip(['[Content_Types].xml', 'xword/document.xml']))).toBeUndefined();
  });

  it('refuses broken or truncated ZIPs without throwing', () => {
    expect(zipEntryNames(DOCX.subarray(0, DOCX.length - 1))).toBeUndefined(); // EOCD cut
    expect(detectResumeKind(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeUndefined();
    const badOffset = Buffer.from(DOCX);
    badOffset.writeUInt32LE(0xfffffff0, badOffset.length - 6); // central directory "starts" past the end
    expect(zipEntryNames(badOffset)).toBeUndefined();
    const badCount = Buffer.from(DOCX);
    badCount.writeUInt16LE(50, badCount.length - 12); // more entries than the directory holds
    expect(zipEntryNames(badCount)).toBeUndefined();
    const longName = Buffer.from(DOCX);
    const cdStart = longName.readUInt32LE(longName.length - 6);
    longName.writeUInt16LE(0xffff, cdStart + 28); // a name running past the directory
    expect(zipEntryNames(longName)).toBeUndefined();
    expect(checkResume(longName, 'cv.docx')).toEqual({ ok: false, problem: 'UNSUPPORTED_TYPE' });
  });

  it('accepts a real PDF and reports size + sha256 + the content-based MIME type', () => {
    const r = checkResume(PDF, 'Asha Resume.pdf');
    expect(r).toMatchObject({ ok: true, resume: { kind: 'pdf', mimeType: 'application/pdf', fileName: 'Asha Resume.pdf', sizeBytes: PDF.length } });
    if (r.ok) expect(r.resume.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [Buffer.alloc(0), 'a.pdf', 'EMPTY'],
    [Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]), 'a.pdf', 'TOO_LARGE'],
    [Buffer.from('MZ....'), 'resume.pdf', 'UNSUPPORTED_TYPE'],
    [PDF, 'resume.docx', 'EXTENSION_MISMATCH'],
    [PDF, 'resume.exe', 'EXTENSION_MISMATCH'],
  ])('rejects bad files (%#)', (buf, name, problem) => expect(checkResume(buf, name)).toEqual({ ok: false, problem }));

  it('cleans file names', () => {
    expect(safeFileName('C:\\Users\\x\\..\\evil<script>.pdf', 'pdf')).toBe('evilscript.pdf');
    expect(safeFileName(undefined, 'docx')).toBe('resume.docx');
  });
});

/** Minimal fake clamd: reads INSTREAM chunks and answers like clamd does. */
let server: Server | undefined;
async function fakeClamd(reply: (payload: Buffer) => string | null) {
  server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length) return;
      let off = cmd.length;
      const parts: Buffer[] = [];
      while (buf.length >= off + 4) {
        const len = buf.readUInt32BE(off);
        if (len === 0) {
          const r = reply(Buffer.concat(parts));
          if (r === null) sock.destroy();
          else sock.end(`${r}\0`);
          return;
        }
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return new ClamAvScanner({ host: '127.0.0.1', port: (server!.address() as AddressInfo).port, timeoutMs: 2000 });
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = undefined;
});

describe('ClamAvScanner', () => {
  it('streams the whole file and reads a clean verdict', async () => {
    let received = Buffer.alloc(0);
    const scanner = await fakeClamd((p) => {
      received = p;
      return 'stream: OK';
    });
    const big = Buffer.concat([PDF, Buffer.alloc(200_000, 7)]);
    expect(await scanner.scan(big)).toBe('clean');
    expect(received.equals(big)).toBe(true);
  });

  it('reports infected files', async () => {
    const scanner = await fakeClamd((p) => (p.includes(EICAR_SIGNATURE) ? 'stream: Eicar-Test-Signature FOUND' : 'stream: OK'));
    expect(await scanner.scan(Buffer.from(EICAR_SIGNATURE))).toBe('infected');
  });

  it('fails closed when clamd is down or answers strangely', async () => {
    await expect(new ClamAvScanner({ host: '127.0.0.1', port: 1, timeoutMs: 500 }).scan(PDF)).rejects.toBeInstanceOf(ScannerUnavailableError);
    const odd = await fakeClamd(() => 'stream: INSTREAM size limit exceeded. ERROR');
    await expect(odd.scan(PDF)).rejects.toBeInstanceOf(ScannerUnavailableError);
    const hangup = await fakeClamd(() => null);
    await expect(hangup.scan(PDF)).rejects.toBeInstanceOf(ScannerUnavailableError);
  });
});

describe('scanner selection', () => {
  it('dev scanner flags only EICAR', async () => {
    const s = new DevEicarOnlyScanner();
    expect(await s.scan(PDF)).toBe('clean');
    expect(await s.scan(Buffer.from(`x${EICAR_SIGNATURE}`))).toBe('infected');
  });
  it('refuses the dev scanner in production', () =>
    expect(() => virusScannerFromEnv({ VIRUS_SCANNER: 'dev-eicar-only', NODE_ENV: 'production' })).toThrow());
  it('defaults to clamav', () => expect(virusScannerFromEnv({}).name).toBe('clamav'));
});

/** Against a REAL clamd: CLAMAV_TEST_HOST=localhost pnpm --filter api test (needs the "security" docker profile). */
describe.skipIf(!process.env.CLAMAV_TEST_HOST)('ClamAvScanner (real clamd)', () => {
  const real = () => new ClamAvScanner({ host: process.env.CLAMAV_TEST_HOST!, port: Number(process.env.CLAMAV_TEST_PORT) || 3310, timeoutMs: 30_000 });
  it('passes a clean PDF and flags the EICAR test file', async () => {
    expect(await real().scan(PDF)).toBe('clean');
    expect(await real().scan(Buffer.from(EICAR_SIGNATURE))).toBe('infected');
  });
  it('handles a full 5 MB upload', async () =>
    expect(await real().scan(Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 - PDF.length, 32)]))).toBe('clean'));
});
