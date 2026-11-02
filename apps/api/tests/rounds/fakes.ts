import { AssessmentsStore, type ResultRow, type ResultWrite, type StudentRow } from '../../src/modules/assessments/assessments.store';
import type { GenerateInput, QuestionGeneratorClient, RawGeneratedQuestion } from '../../src/modules/rounds-config/question-generator.client';
import { RoundsConfigStore, RoundsLockedError, type RoundsJob, type StoredConfig, type StoredRound } from '../../src/modules/rounds-config/rounds-config.store';

export const TENANT = '0192f3a1-0000-7000-8000-000000000001';
export const OTHER_TENANT = '0192f3a1-0000-7000-8000-000000000002';
export const JOB = '0192f3a1-7c2e-7a10-8b2c-123456789abc';
export const OTHER_JOB = '0192f3a1-7c2e-7a10-8b2c-0000000000ff';
export const APP = '0192f3a1-aaaa-7000-8000-000000000001';
export const ACTOR = { id: '0192f3a1-0000-7000-8000-0000000000aa', name: 'Priya HR' };

/** Rounds config in memory. Rows of every tenant live together, like in the database. */
export class MemoryRoundsConfigStore extends RoundsConfigStore {
  jobs = new Map<string, RoundsJob & { tenantId: string }>();
  configs = new Map<string, StoredConfig>();

  addJob(tenantId: string, id: string, title = 'AI Engineer') {
    this.jobs.set(id, {
      id,
      tenantId,
      title,
      form: { title, mustHaveSkills: ['Python', 'SQL'], niceToHaveSkills: [], experienceMin: 0, experienceMax: 2 },
      jd: { title, summary: 'Build AI features.', responsibilities: ['Ship models'], requirements: ['Python'], niceToHave: [] },
    });
  }

  async getJob(tenantId: string, jobId: string) {
    const j = this.jobs.get(jobId);
    return j && j.tenantId === tenantId ? { id: j.id, title: j.title, form: j.form, jd: j.jd } : null;
  }

  async getConfig(tenantId: string, jobId: string) {
    const c = this.configs.get(jobId);
    return c && c.tenantId === tenantId ? structuredClone(c) : null;
  }

  async listConfigs(tenantId: string, jobIds: string[]) {
    return [...this.configs.values()].filter((c) => c.tenantId === tenantId && jobIds.includes(c.jobId)).map((c) => structuredClone(c));
  }

  async replace(tenantId: string, jobId: string, status: StoredConfig['status'], rounds: StoredRound[]) {
    const current = this.configs.get(jobId);
    if (current?.lockedAt) throw new RoundsLockedError();
    this.configs.set(jobId, { jobId, tenantId, status, lockedAt: null, updatedAt: new Date('2026-10-30T10:00:00Z'), rounds: structuredClone(rounds) });
    return structuredClone(this.configs.get(jobId)!);
  }

  async lock(tenantId: string, jobId: string, at: Date) {
    const c = this.configs.get(jobId);
    if (!c || c.tenantId !== tenantId) return null;
    c.lockedAt ??= at;
    return c.lockedAt;
  }
}

export class FakeGenerator {
  calls: GenerateInput[] = [];
  constructor(public questions: RawGeneratedQuestion[] = [], public invalid = 0) {}
  async generate(input: GenerateInput) {
    this.calls.push(input);
    return { questions: this.questions, invalid: this.invalid, model: 'fake-model', promptVersion: 'round_questions.v1' };
  }
  asClient() {
    return this as unknown as QuestionGeneratorClient;
  }
}

export const student = (overrides: Partial<StudentRow> = {}): StudentRow => ({
  applicationId: APP,
  jobId: JOB,
  name: 'Asha Patel',
  email: 'asha@example.com',
  phone: '+919800000001',
  college: 'GTU',
  degree: 'B.Tech',
  branch: 'CSE',
  graduationYear: 2026,
  ats: { score: 82, minAtsScore: 70, decision: 'SHORTLISTED', breakdown: null, matchedSkills: ['Python'], missingSkills: [] },
  hasVoiceScreening: true,
  ...overrides,
});

export class MemoryAssessmentsStore extends AssessmentsStore {
  students: (StudentRow & { tenantId: string })[] = [];
  jobs: { id: string; tenantId: string; title: string }[] = [];
  results: (ResultRow & { tenantId: string })[] = [];

  async listJobs(tenantId: string) {
    return this.jobs.filter((j) => j.tenantId === tenantId).map(({ id, title }) => ({ id, title }));
  }
  async getJob(tenantId: string, jobId: string) {
    const j = this.jobs.find((x) => x.id === jobId && x.tenantId === tenantId);
    return j ? { id: j.id, title: j.title } : null;
  }
  async listStudents(tenantId: string, jobId: string) {
    return this.students.filter((s) => s.tenantId === tenantId && s.jobId === jobId);
  }
  async countByJob(tenantId: string, jobIds: string[]) {
    return new Map(
      jobIds.map((id) => [
        id,
        {
          students: this.students.filter((s) => s.tenantId === tenantId && s.jobId === id).length,
          results: this.results.filter((r) => r.tenantId === tenantId && r.jobId === id).length,
        },
      ]),
    );
  }
  async getStudent(tenantId: string, applicationId: string) {
    return this.students.find((s) => s.tenantId === tenantId && s.applicationId === applicationId) ?? null;
  }
  async listResults(tenantId: string, where: { jobId: string } | { applicationId: string }) {
    return this.results.filter(
      (r) => r.tenantId === tenantId && ('jobId' in where ? r.jobId === where.jobId : r.applicationId === where.applicationId),
    );
  }
  async upsertResult(tenantId: string, id: string, data: ResultWrite) {
    const existing = this.results.find((r) => r.applicationId === data.applicationId && r.roundId === data.roundId);
    if (existing) {
      Object.assign(existing, data);
      return existing;
    }
    const row = { ...data, id, tenantId, override: null };
    this.results.push(row);
    return row;
  }
  async setOverride(tenantId: string, applicationId: string, roundId: string, override: ResultRow['override'] & object | null) {
    const r = this.results.find((x) => x.tenantId === tenantId && x.applicationId === applicationId && x.roundId === roundId);
    if (!r) return null;
    r.override = override;
    return r;
  }
}
