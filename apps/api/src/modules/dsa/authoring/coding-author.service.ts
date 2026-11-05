import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  CODING_CSV_COLUMNS,
  DSA_SPEC_LIMITS,
  codingProblemsGenerateRequestSchema,
  dsaProblemSpecSchema,
  parseCsv,
  type AuthoredCodingProblem,
  type CodingProblemsResult,
  type DsaProblemSpec,
} from '@hireflow/contracts';
import { apiError, parseBody } from '../../../common/api-error';
import { AuditService } from '../../audit';
import { RoundsConfigService } from '../../rounds-config';
import type { Actor } from '../../tenants';
import { CODE_RUNNER, CodeRunnerBusyError, CodeRunnerUnavailableError, type CodeRunner } from '../execution/code-runner';
import { CodingAuthorClient, CodingAuthorError, type RawCodingProblem } from './coding-author.client';

export const CODING_AUTHOR_CLIENT = Symbol('CODING_AUTHOR_CLIENT');

/** Files HR may upload: PDF, Word (.docx) and CSV, at most 5 MB. */
export const CODING_UPLOAD_LIMITS = { maxBytes: 5 * 1024 * 1024 } as const;
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Output compared like the coding page does: line by line, trailing spaces and trailing blank lines ignored. */
const normalOutput = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
/**
 * AI-written problems never name a programming language: students choose their own. Any sentence that names one
 * (or says "in any / your preferred language") is removed from what students read. HR's own files are not touched.
 */
const LANGUAGE_MENTION = new RegExp(
  [
    String.raw`\b(python\d?|java|javascript|typescript|kotlin|ruby|php|golang|scala|perl|haskell|dart)\b`,
    String.raw`c\+\+|\bcpp\b|\bc#|\bc sharp\b|\bnode\.?js\b`,
    String.raw`\b(any|your)\s+(preferred\s+|favou?rite\s+|chosen\s+|own\s+)?(programming\s+)?languages?\b`,
    String.raw`\bprogramming languages?\b|\blanguage of (your )?choice\b`,
  ].join('|'),
  'i',
);
export function languageNeutral(text: string): string {
  const keep = (sentence: string) => !LANGUAGE_MENTION.test(sentence);
  return text
    .split('\n')
    // a sentence ends at . ! ? followed by a space (so "Node.js" or "3.5" are not cut)
    .map((line) => line.split(/(?<=[.!?])\s+/).filter(keep).join(' ').trimEnd())
    .filter((line, i, all) => line.trim() !== '' || (i > 0 && all[i - 1]!.trim() !== ''))
    .join('\n')
    .trim();
}

const unescapeCell = (s: string) => s.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n');
const key = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');
const clampMarks = (n: number) => Math.min(Math.max(Math.round(n) || 10, 1), 1000);

/**
 * DSA coding round authoring: problems written by the AI, or read from HR's PDF / Word / CSV file, turned into
 * ready-to-edit coding questions (statement, formats, constraints, sample + hidden tests, marks). Every expected
 * output of an AI problem comes from RUNNING its reference solution on the code runner - never from the model's text.
 * Nothing is saved: HR reviews the problems in the rounds editor and saves the round.
 */
@Injectable()
export class CodingAuthorService {
  constructor(
    @Inject(RoundsConfigService) private readonly rounds: RoundsConfigService,
    @Inject(CODE_RUNNER) private readonly runner: CodeRunner,
    @Inject(CODING_AUTHOR_CLIENT) private readonly client: CodingAuthorClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async generate(tenantId: string, jobId: string, body: unknown, actor: Actor | null): Promise<CodingProblemsResult> {
    const req = parseBody(codingProblemsGenerateRequestSchema, body, 'INVALID_REQUEST', 'Check the number of problems, difficulty and topics.');
    const job = await this.rounds.jobFactsFor(tenantId, jobId);
    const raw = await this.ask({ mode: 'generate', job, count: req.count, difficulty: req.difficulty, topics: req.topics, avoid: req.avoid });
    const result = await this.finalize(raw.problems, 'ai');
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'rounds.coding_problems_generated', subjectType: 'job', subjectId: jobId, metadata: { asked: req.count, ready: result.problems.length, dropped: result.dropped.length, model: raw.model } });
    return result;
  }

  async importFile(tenantId: string, jobId: string, file: UploadedFile | undefined, actor: Actor | null): Promise<CodingProblemsResult> {
    if (!file || !file.size) throw apiError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Choose a PDF, Word (.docx) or CSV file.');
    if (file.size > CODING_UPLOAD_LIMITS.maxBytes) throw apiError(HttpStatus.PAYLOAD_TOO_LARGE, 'FILE_TOO_LARGE', 'The file is larger than 5 MB.');
    const name = file.originalname.toLowerCase();
    const kind = name.endsWith('.csv') || file.mimetype === 'text/csv' ? 'csv' : name.endsWith('.pdf') || file.mimetype === PDF ? 'pdf' : name.endsWith('.docx') || file.mimetype === DOCX ? 'docx' : null;
    if (!kind) {
      throw apiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'FILE_TYPE_NOT_SUPPORTED', name.endsWith('.doc') ? 'Old .doc files cannot be read: save it as .docx (Word) or PDF.' : 'Upload a PDF, Word (.docx) or CSV file.');
    }
    const job = await this.rounds.jobFactsFor(tenantId, jobId); // also: the job exists and its rounds are not locked
    let result: CodingProblemsResult;
    if (kind === 'csv') {
      result = this.fromCsv(file.buffer.toString('utf8'));
    } else {
      const raw = await this.ask({ mode: 'extract', job, count: 10, difficulty: 'MEDIUM', topics: [], avoid: [], document: { contentBase64: file.buffer.toString('base64'), mimeType: kind === 'pdf' ? PDF : DOCX } });
      result = await this.finalize(raw.problems, 'document');
      if (!result.problems.length && !result.dropped.length) {
        throw apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'NO_PROBLEMS_FOUND', 'No programming problem was found in this file.');
      }
    }
    await this.audit.record({ tenantId, actorUserId: actor?.id ?? null, action: 'rounds.coding_problems_imported', subjectType: 'job', subjectId: jobId, metadata: { kind, ready: result.problems.length, dropped: result.dropped.length } });
    return result;
  }

  // ---------------------------------------------------------------- CSV (HR's own data, taken as written)

  fromCsv(text: string): CodingProblemsResult {
    const rows = parseCsv(text);
    if (rows.length < 2) throw apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'CSV_EMPTY', 'The CSV file has no problem rows. Download the template to see the columns.');
    const header = rows[0]!.map(key);
    const missing = CODING_CSV_COLUMNS.required.filter((c) => !header.includes(c));
    if (missing.length) throw apiError(HttpStatus.UNPROCESSABLE_ENTITY, 'CSV_COLUMNS_MISSING', `The CSV file needs the columns: ${missing.join(', ')}. Download the template.`);
    const problems: AuthoredCodingProblem[] = [];
    const dropped: CodingProblemsResult['dropped'] = [];
    rows.slice(1).forEach((cells, i) => {
      const get = (col: string) => unescapeCell((cells[header.indexOf(col)] ?? '').trim());
      const title = get('title') || `Row ${i + 2}`;
      const tests: DsaProblemSpec['tests'] = [];
      for (const [inp, out] of [['sample_input', 'sample_output'], ['sample_input_2', 'sample_output_2']] as const) {
        if (get(out)) tests.push({ input: withNewline(get(inp)), output: get(out), hidden: false });
      }
      for (let n = 1; n <= CODING_CSV_COLUMNS.hiddenPairs; n++) {
        if (get(`hidden_output_${n}`)) tests.push({ input: withNewline(get(`hidden_input_${n}`)), output: get(`hidden_output_${n}`), hidden: true });
      }
      const difficulty = (['EASY', 'MEDIUM', 'HARD'] as const).find((d) => d === get('difficulty').toUpperCase()) ?? 'MEDIUM';
      const built = this.problem({ title, statement: get('statement'), inputFormat: get('input_format'), outputFormat: get('output_format'), constraints: get('constraints'), difficulty, marks: Number(get('marks')) || 10, tests }, 'csv', 'HR');
      if ('reason' in built) dropped.push({ title, reason: built.reason });
      else {
        if (!tests.some((t) => t.hidden)) built.notes.push('No hidden tests in the file: add some, otherwise Submit is graded on the samples only.');
        problems.push(built);
      }
    });
    return { problems, dropped };
  }

  // ---------------------------------------------------------------- AI problems: outputs computed by running the solution

  /** Runs each problem's reference solution on its test inputs; the runner's output becomes the expected output. */
  async finalize(raws: RawCodingProblem[], origin: 'ai' | 'document'): Promise<CodingProblemsResult> {
    const problems: AuthoredCodingProblem[] = [];
    const dropped: CodingProblemsResult['dropped'] = [];
    for (const p of raws) {
      const title = p.title.trim().slice(0, DSA_SPEC_LIMITS.titleMax) || 'Untitled problem';
      const notes: string[] = [];
      const samples = p.samples.filter((s) => s.input.length <= DSA_SPEC_LIMITS.testInputMax).slice(0, 3);
      const hiddenInputs = p.hiddenInputs.filter((h) => h.trim() && h.length <= DSA_SPEC_LIMITS.testInputMax).slice(0, 10);
      let tests: DsaProblemSpec['tests'] = [];
      let trusted = false;
      if (p.referenceSolution.trim()) {
        const inputs = [...samples.map((s) => s.input), ...hiddenInputs].map(withNewline);
        let runs;
        try {
          runs = await this.runner.runBatch(inputs.map((stdin) => ({ language: 'python', source: p.referenceSolution, stdin })));
        } catch (err) {
          if (err instanceof CodeRunnerUnavailableError || err instanceof CodeRunnerBusyError) {
            throw apiError(HttpStatus.SERVICE_UNAVAILABLE, 'CODE_RUNNER_UNAVAILABLE', 'The code runner (Piston) is not available, so the test outputs cannot be checked. Start it, then try again.');
          }
          throw err;
        }
        const outputOf = (i: number) => (runs[i]?.verdict === 'ok' && normalOutput(runs[i]!.stdout) !== '' ? normalOutput(runs[i]!.stdout) : null);
        // from a document: the solution is trusted only if it reproduces the document's own examples
        const samplesMatch = samples.every((s, i) => outputOf(i) !== null && outputOf(i) === normalOutput(s.output));
        trusted = origin === 'ai' ? samples.every((_, i) => outputOf(i) !== null) : samples.length > 0 && samplesMatch;
        if (trusted) {
          samples.forEach((s, i) => tests.push({ input: inputs[i]!, output: origin === 'ai' ? outputOf(i)! : normalOutput(s.output), hidden: false }));
          hiddenInputs.forEach((_, j) => {
            const out = outputOf(samples.length + j);
            if (out !== null && out.length <= DSA_SPEC_LIMITS.testOutputMax) tests.push({ input: inputs[samples.length + j]!, output: out, hidden: true });
          });
          const lost = hiddenInputs.length - tests.filter((t) => t.hidden).length;
          if (lost) notes.push(`${lost} hidden test(s) were left out because the reference solution failed on them.`);
        }
      }
      if (!trusted) {
        if (origin === 'ai') {
          dropped.push({ title, reason: 'Its reference solution did not run correctly, so its test outputs could not be checked.' });
          continue;
        }
        // HR's document: keep the examples exactly as written; HR adds hidden tests
        tests = samples.filter((s) => normalOutput(s.output)).map((s) => ({ input: withNewline(s.input), output: normalOutput(s.output), hidden: false }));
        notes.push(
          tests.length
            ? 'Only the examples from your file were kept: the AI could not confirm them, so add hidden tests yourself.'
            : 'Your file has no example with its output: add at least one sample test and some hidden tests.',
        );
      }
      if (!tests.some((t) => t.hidden) && trusted) notes.push('No hidden tests: add some, otherwise Submit is graded on the samples only.');
      // AI-written: never mention a programming language (HR's own document is kept as HR wrote it)
      const neutral = (s: string) => (origin === 'ai' ? languageNeutral(s) : s);
      const built = this.problem(
        { title: neutral(title) || title, statement: neutral(p.statement), inputFormat: neutral(p.inputFormat), outputFormat: neutral(p.outputFormat), constraints: neutral(p.constraints), difficulty: p.difficulty, marks: p.marks, tests },
        origin,
        'AI',
      );
      if ('reason' in built) dropped.push({ title, reason: built.reason });
      else problems.push({ ...built, notes: [...built.notes, ...notes] });
    }
    return { problems, dropped };
  }

  /** The editor's coding question, checked with the shared contract. A problem without any sample test is kept (HR completes it) unless nothing is usable. */
  private problem(
    p: { title: string; statement: string; inputFormat: string; outputFormat: string; constraints: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD'; marks: number; tests: DsaProblemSpec['tests'] },
    origin: AuthoredCodingProblem['origin'],
    source: 'HR' | 'AI',
  ): AuthoredCodingProblem | { reason: string } {
    if (!p.statement.trim()) return { reason: 'It has no problem statement.' };
    const spec = dsaProblemSpecSchema.safeParse({ title: p.title, inputFormat: p.inputFormat.slice(0, DSA_SPEC_LIMITS.formatMax), outputFormat: p.outputFormat.slice(0, DSA_SPEC_LIMITS.formatMax), constraints: p.constraints.slice(0, DSA_SPEC_LIMITS.formatMax), tests: p.tests.slice(0, DSA_SPEC_LIMITS.testsMax) });
    if (!spec.success) return { reason: spec.error.issues[0]?.message ?? 'It is not a valid problem.' };
    const notes = spec.data.tests.some((t) => !t.hidden) ? [] : ['Add at least one sample test (shown to students and used by Run).'];
    return { origin, question: { kind: 'CODING', text: p.statement.trim().slice(0, 8000), marks: clampMarks(p.marks), difficulty: p.difficulty, topics: [], source, coding: spec.data }, notes };
  }

  private async ask(input: Parameters<CodingAuthorClient['problems']>[0]) {
    try {
      return await this.client.problems(input);
    } catch (err) {
      if (err instanceof CodingAuthorError) throw apiError(err.status, err.code, err.message);
      throw err;
    }
  }
}

const withNewline = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
