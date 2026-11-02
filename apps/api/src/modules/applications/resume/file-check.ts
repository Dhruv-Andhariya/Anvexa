import { createHash } from 'node:crypto';
import { RESUME_LIMITS } from '@hireflow/contracts';

export type ResumeKind = 'pdf' | 'docx';

export interface CheckedResume {
  kind: ResumeKind;
  /** Decided from the file CONTENT, never from what the browser claims. */
  mimeType: (typeof RESUME_LIMITS.mimeTypes)[number];
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export type ResumeProblem = 'EMPTY' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'EXTENSION_MISMATCH';

const MIME: Record<ResumeKind, CheckedResume['mimeType']> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Detects PDF / DOCX from magic bytes. DOCX is a ZIP whose entries include word/document.xml. */
export function detectResumeKind(buf: Buffer): ResumeKind | undefined {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (!isZip) return undefined;
  const names = zipEntryNames(buf);
  if (names?.has('word/document.xml') && names.has('[Content_Types].xml')) return 'docx';
  return undefined;
}

const EOCD_SIG = 0x06054b50; // End Of Central Directory record
const CDH_SIG = 0x02014b50; // central directory file header

/**
 * Entry names from the ZIP central directory (the archive's real table of contents), or undefined when it is not
 * a well-formed ZIP. Reading the directory, not searching the bytes, means a name hidden in a comment or inside
 * file data does not count. Every offset is bounds-checked; ZIP64 (not used by Word for resumes) is refused.
 */
export function zipEntryNames(buf: Buffer): Set<string> | undefined {
  // The EOCD record (22 bytes + a comment of up to 65535 bytes) ends the file. Search backwards, and accept a
  // signature only if its comment length reaches exactly the end (a fake signature inside the comment does not).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const start = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) return undefined; // ZIP64
  if (start + size > eocd) return undefined;

  const names = new Set<string>();
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > start + size || buf.readUInt32LE(p) !== CDH_SIG) return undefined;
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32); // + extra + comment
    if (next > start + size) return undefined;
    names.add(buf.toString('latin1', p + 46, p + 46 + nameLen));
    p = next;
  }
  return names;
}

/** Keeps only a safe display name: no folders, no control characters, bounded length. */
export function safeFileName(name: string | undefined, kind: ResumeKind): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim().slice(-120);
  return cleaned || `resume.${kind}`;
}

export function checkResume(buf: Buffer, originalName: string | undefined): { ok: true; resume: CheckedResume } | { ok: false; problem: ResumeProblem } {
  if (!buf.length) return { ok: false, problem: 'EMPTY' };
  if (buf.length > RESUME_LIMITS.maxBytes) return { ok: false, problem: 'TOO_LARGE' };
  const kind = detectResumeKind(buf);
  if (!kind) return { ok: false, problem: 'UNSUPPORTED_TYPE' };
  const ext = (originalName ?? '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  if (ext && ext !== `.${kind}`) return { ok: false, problem: 'EXTENSION_MISMATCH' };
  return {
    ok: true,
    resume: {
      kind,
      mimeType: MIME[kind],
      fileName: safeFileName(originalName, kind),
      sizeBytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    },
  };
}
