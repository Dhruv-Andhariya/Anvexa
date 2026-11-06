import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../src/common/uuidv7';
import { FORM, JD } from '../publisher/fixtures';

/**
 * Real-database fixtures for the ATS tests: a company, approved jobs and applications with a resume in
 * resume_files. Every run uses fresh random companies, so runs never see each other's rows.
 */
export async function seedCompany(db: PrismaClient, name = 'Acme') {
  const tenant = await db.tenant.create({ data: { id: uuidv7(), name, slug: `ats-${randomUUID().slice(0, 12)}` } });
  return tenant.id;
}

export async function seedJob(
  db: PrismaClient,
  tenantId: string,
  opts: { title?: string; minAtsScore?: number | null; mustHaveSkills?: string[]; experience?: [number, number] } = {},
) {
  const form = {
    ...FORM,
    title: opts.title ?? FORM.title,
    mustHaveSkills: opts.mustHaveSkills ?? FORM.mustHaveSkills,
    ...(opts.experience ? { experienceMin: opts.experience[0], experienceMax: opts.experience[1] } : {}),
  };
  const job = await db.job.create({
    data: { id: uuidv7(), tenantId, title: form.title, formData: form, status: 'APPROVED', openings: 1 },
  });
  const version = await db.jdVersion.create({
    data: { id: uuidv7(), tenantId, jobId: job.id, version: 1, source: 'AI', content: { ...JD, title: form.title } },
  });
  await db.job.update({ where: { id: job.id }, data: { currentJdVersionId: version.id } });
  if (opts.minAtsScore !== null) {
    await db.jobScreeningSettings.create({ data: { jobId: job.id, tenantId, minAtsScore: opts.minAtsScore ?? 70 } });
  }
  return { jobId: job.id, jdVersionId: version.id };
}

export async function seedApplication(
  db: PrismaClient,
  tenantId: string,
  job: { jobId: string; jdVersionId: string },
  opts: { name?: string; resume?: Buffer | null; mimeType?: string; experienceYears?: number | null } = {},
) {
  const n = randomUUID().slice(0, 8);
  const candidate = await db.candidate.create({
    data: { id: uuidv7(), tenantId, name: opts.name ?? `Student ${n}`, email: `s-${n}@example.com`, phone: `+9198${String(Math.random()).slice(2, 10)}` },
  });
  const app = await db.application.create({
    data: {
      id: uuidv7(),
      tenantId,
      jobId: job.jobId,
      jdVersionId: job.jdVersionId,
      candidateId: candidate.id,
      email: candidate.email,
      college: 'LD College of Engineering',
      degree: 'B.E.',
      branch: 'Computer',
      graduationYear: 2026,
      scoreType: 'CGPA',
      scoreValue: 8.4,
      experienceYears: opts.experienceYears ?? null,
    },
  });
  if (opts.resume !== null) {
    const resumeId = uuidv7();
    const bytes = opts.resume ?? Buffer.from('%PDF-1.4 resume');
    await db.resume.create({
      data: {
        id: resumeId,
        tenantId,
        applicationId: app.id,
        fileName: 'resume.pdf',
        mimeType: opts.mimeType ?? 'application/pdf',
        sizeBytes: bytes.length,
        sha256: 'x'.repeat(64),
        scanStatus: 'CLEAN',
        scannedBy: 'dev-eicar-only',
        scannedAt: new Date(),
      },
    });
    await db.resumeFile.create({ data: { resumeId, tenantId, content: bytes } });
  }
  return { applicationId: app.id, candidateId: candidate.id, email: candidate.email };
}

/** A worker answer with the given score (parts add up to it). */
export function screenResult(score: number) {
  const parts = [
    ['skills', 'Technical skills', 40],
    ['experience', 'Work experience & internships', 20],
    ['projects', 'Projects relevant to the role', 20],
    ['achievements', 'Achievements & certifications', 10],
    ['qualifications', 'Qualifications', 10],
  ] as const;
  return {
    score,
    breakdown: parts.map(([key, label, max]) => ({ key, label, max, points: (max * score) / 100, reason: `${label}: test reason.` })),
    matchedSkills: ['Node.js', 'SQL'],
    missingSkills: ['REST'],
    profile: {
      summary: 'Final-year student with backend projects.',
      skills: ['Node.js', 'SQL'],
      experience: [{ organization: 'Finly', role: 'Backend intern', kind: 'internship' as const, months: 6, relevant: true, summary: 'APIs' }],
      projects: [{ title: 'Expense API', technologies: ['Node.js'], relevant: true, summary: 'REST API' }],
      achievements: ['Hackathon winner'],
      certifications: [],
      education: [{ institution: 'LD College of Engineering', degree: 'B.E.', field: 'Computer', year: '2026' }],
    },
    model: 'fake-model',
    promptVersion: 'resume_screen.v1',
  };
}
