#!/usr/bin/env node
// Demo of the M18 AI group discussion: creates ONE ready-to-join GD group and prints the personal student links
// (and HR's live page), without the earlier rounds and WITHOUT sending any email. Everything else is the real thing:
// lobby, LiveKit room, AI moderator, timer, HR controls, recording, transcription, evaluation, results.
//
//   node scripts/demo-gd/demo-gd.mjs                                   3 seats, starts in 3 minutes, company "pattern"
//   node scripts/demo-gd/demo-gd.mjs --students "Naina,Friend" --start-in 5 --company "pattern"
//   node scripts/demo-gd/demo-gd.mjs --clean                           removes every demo GD of the company
//
// Needs: the API running (it opens / locks the room and runs the phases), the GD worker + moderator
// (scripts/start-public.ps1 starts all of them), CAREERS_SITE_URL = a public https address (the tunnel), LIVEKIT_* and
// ENCRYPTION_KEY in the repo-root .env. The demo job is called "[DEMO] GD ..." and only lives in that company.
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.loadEnvFile(path.join(root, '.env'));
const require = createRequire(path.join(root, 'apps/api/package.json'));
const { PrismaClient } = require('@prisma/client');

const DEMO = '[DEMO] GD';
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, u: (s) => `\x1b[4m${s}\x1b[0m` };
const fail = (msg) => {
  console.error(c.r(`✗ ${msg}`));
  process.exit(1);
};

// Short phases so a demo takes ~15 minutes; every feature is the same as in a real GD.
const SETTINGS = {
  minGroupSize: 2,
  maxGroupSize: 10,
  graceMinutes: 3,
  introSeconds: 45,
  thinkingSeconds: 60,
  discussionMinutes: 5,
  summarySeconds: 45,
  hrQuestionsEnabled: true,
  hrQuestionsMinutes: 2,
  silencePromptSeconds: 20,
  breakMinutes: 0,
};
const TOPICS = [
  'Should artificial intelligence replace traditional exams in colleges?',
  'Work from home or work from office: which is better for freshers?',
  'Is social media doing more good than harm to students?',
];

const uuid = () => randomUUID();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Same format as apps/api/src/common/secret-box.ts (v1.<iv>.<tag>.<data>, AES-256-GCM, ENCRYPTION_KEY). */
function seal(plain) {
  const raw = (process.env.ENCRYPTION_KEY ?? '').trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) fail('ENCRYPTION_KEY in .env must be 32 bytes (base64 or hex).');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** Same as gdSlotMinutes() in packages/contracts. */
const slotMinutes = (s, n) =>
  Math.ceil((s.graceMinutes * 60 + s.introSeconds + s.thinkingSeconds + s.discussionMinutes * 60 + s.summarySeconds * n + (s.hrQuestionsEnabled ? s.hrQuestionsMinutes * 60 : 0) + 60) / 60);

const db = new PrismaClient();

async function tenantOf(name) {
  const tenants = await db.tenant.findMany({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true, name: true } });
  if (!tenants.length) fail(`No company called "${name}". Use --company "<name>".`);
  if (tenants.length > 1) fail(`Several companies are called "${name}". Use --company with its id: ${tenants.map((t) => t.id).join(', ')}`);
  return tenants[0];
}

async function clean(tenantId) {
  const jobs = await db.job.findMany({ where: { tenantId, title: { startsWith: DEMO } }, select: { id: true } });
  const storage = path.resolve((process.env.GD_STORAGE_DIR ?? '').trim() || path.join(homedir(), '.hireflow', 'gd-recordings'));
  for (const job of jobs) {
    const batches = await db.gdBatch.findMany({ where: { tenantId, event: { jobId: job.id } }, select: { id: true } });
    const apps = await db.application.findMany({ where: { tenantId, jobId: job.id }, select: { id: true, candidateId: true } });
    await db.$transaction([
      db.roundResult.deleteMany({ where: { tenantId, jobId: job.id } }),
      db.gdEvent.deleteMany({ where: { tenantId, jobId: job.id } }),
      db.gdParticipant.deleteMany({ where: { tenantId, jobId: job.id } }),
      db.application.deleteMany({ where: { tenantId, jobId: job.id } }),
      db.candidate.deleteMany({ where: { tenantId, id: { in: apps.map((a) => a.candidateId) } } }),
      db.job.update({ where: { id: job.id }, data: { currentJdVersionId: null } }),
      db.job.delete({ where: { id: job.id } }),
    ]);
    for (const b of batches) rmSync(path.join(storage, tenantId, b.id), { recursive: true, force: true });
  }
  return jobs.length;
}

async function main() {
  const tenant = await tenantOf(arg('company', 'pattern'));
  if (args.includes('--clean')) {
    const n = await clean(tenant.id);
    console.log(c.g(`✓ Removed ${n} demo GD job(s) of "${tenant.name}" (with their students, groups, recordings and results).`));
    return;
  }

  const careers = (process.env.CAREERS_SITE_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(careers)) fail('CAREERS_SITE_URL must be a public https address (run scripts/start-public.ps1 first) - camera and microphone need https.');
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) fail('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are missing in .env.');
  const hrBase = (process.env.HR_DASHBOARD_URL ?? 'http://localhost:3000').trim().replace(/\/+$/, '');
  const names = arg('students', 'Naina,Friend,Guest').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length < 1 || names.length > 10) fail('Give 1 to 10 student names, e.g. --students "Naina,Friend".');
  const startIn = Math.max(1, Math.min(120, Number(arg('start-in', '3')) || 3));

  // one demo at a time per company: links of an older demo stop working
  const removed = await clean(tenant.id);

  const source = await db.job.findFirst({ where: { tenantId: tenant.id, status: 'APPROVED', currentJdVersionId: { not: null } }, orderBy: { createdAt: 'desc' } });
  if (!source) fail(`"${tenant.name}" has no approved job to copy the demo job from.`);
  const jd = await db.jdVersion.findUniqueOrThrow({ where: { id: source.currentJdVersionId } });
  const hr = await db.membership.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'asc' }, select: { userId: true, user: { select: { name: true } } } });

  const now = Date.now();
  const startsAt = new Date(now + startIn * 60_000);
  const endsAt = new Date(startsAt.getTime() + slotMinutes(SETTINGS, names.length) * 60_000);
  const jobId = uuid();
  const jdVersionId = uuid();
  const roundId = uuid();
  const eventId = uuid();
  const batchId = uuid();
  const title = `${DEMO} - ${source.title}`;
  const seats = names.map((name, i) => ({ name, token: randomBytes(32).toString('base64url'), candidateId: uuid(), applicationId: uuid(), participantId: uuid(), n: i + 1 }));
  const tag = randomBytes(3).toString('hex');

  await db.$transaction(async (tx) => {
    await tx.job.create({ data: { id: jobId, tenantId: tenant.id, title, formData: { ...source.formData, title }, status: 'APPROVED', openings: 1, createdById: hr?.userId ?? null } });
    await tx.jdVersion.create({ data: { id: jdVersionId, tenantId: tenant.id, jobId, version: 1, source: jd.source, content: { ...jd.content, title } } });
    await tx.job.update({ where: { id: jobId }, data: { currentJdVersionId: jdVersionId } });
    await tx.jobRoundConfig.create({ data: { jobId, tenantId: tenant.id, status: 'COMPLETE', updatedById: hr?.userId ?? null } });
    await tx.jobRound.create({
      data: { id: roundId, tenantId: tenant.id, jobId, position: 1, type: 'GROUP_DISCUSSION', name: 'Group Discussion', description: 'Demo group discussion', passMode: 'INTERVIEWER_SCORE', passValue: 6, passMaxScore: 10 },
    });
    await tx.roundQuestion.createMany({ data: TOPICS.map((text, i) => ({ id: uuid(), tenantId: tenant.id, roundId, position: i + 1, kind: 'INTERVIEW', text })) });
    await tx.gdEvent.create({ data: { id: eventId, tenantId: tenant.id, jobId, roundId, name: 'Demo GD', startsAt, ...SETTINGS, undersized: names.length < SETTINGS.minGroupSize, createdById: hr?.userId ?? null } });
    await tx.gdBatch.create({ data: { id: batchId, tenantId: tenant.id, eventId, number: 1, startsAt, endsAt, roomName: `gd-${randomBytes(12).toString('base64url')}`, topicQuestionId: null, topicText: TOPICS[0] } });
    for (const s of seats) {
      await tx.candidate.create({ data: { id: s.candidateId, tenantId: tenant.id, name: s.name, email: `gd-demo-${tag}-${s.n}@example.com`, phone: `+9190000${tag.slice(0, 3)}${String(s.n).padStart(2, '0')}` } });
      await tx.application.create({
        data: {
          id: s.applicationId,
          tenantId: tenant.id,
          jobId,
          jdVersionId,
          candidateId: s.candidateId,
          email: `gd-demo-${tag}-${s.n}@example.com`,
          source: 'gd-demo',
          college: 'Demo College',
          degree: 'B.E.',
          branch: 'Computer',
          graduationYear: 2026,
          scoreType: 'CGPA',
          scoreValue: 8,
        },
      });
      await tx.gdParticipant.create({
        data: {
          id: s.participantId,
          tenantId: tenant.id,
          applicationId: s.applicationId,
          jobId,
          roundId,
          batchId,
          attendance: 'INVITED',
          tokenHash: sha256(s.token),
          tokenSealed: seal(s.token),
          tokenExpiresAt: new Date(endsAt.getTime() + 24 * 3_600_000),
        },
      });
    }
    // the email log says "already done": the demo sends NO invitation, reminder or HR email
    const done = { status: 'SENT', sentAt: new Date(now), attempts: 0 };
    await tx.gdEmail.createMany({
      data: [
        ...seats.flatMap((s) => [
          { id: uuid(), tenantId: tenant.id, batchId, participantId: s.participantId, kind: 'INVITE', toEmail: 'demo', dedupeKey: `INVITE:${s.participantId}:${batchId}`, ...done },
          { id: uuid(), tenantId: tenant.id, batchId, participantId: s.participantId, kind: 'REMINDER', toEmail: 'demo', dedupeKey: `REMINDER:${s.participantId}:${batchId}`, ...done },
        ]),
        ...(hr ? [{ id: uuid(), tenantId: tenant.id, batchId, participantId: null, kind: 'HR_LINK', toEmail: 'demo', dedupeKey: `HR_LINK:${batchId}:${hr.userId}`, ...done }] : []),
      ],
    });
  });

  const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  console.log(`\n${c.b(`Demo group discussion ready in "${tenant.name}"`)}${removed ? c.d(` (replaced ${removed} older demo)`) : ''}`);
  console.log(`   Topic: ${TOPICS[0]}`);
  console.log(`   Room opens ${c.b(time(startsAt))}, closes ${time(new Date(startsAt.getTime() + SETTINGS.graceMinutes * 60_000))} (join before that!), ends about ${time(endsAt)}`);
  console.log(`   Phases: intro ${SETTINGS.introSeconds}s · thinking ${SETTINGS.thinkingSeconds}s · discussion ${SETTINGS.discussionMinutes} min · summary ${SETTINGS.summarySeconds}s each · HR questions ${SETTINGS.hrQuestionsMinutes} min`);
  console.log(`\n${c.b('Student links')} ${c.d('(one per person, any browser or phone; open it early for the camera / mic check)')}`);
  for (const s of seats) console.log(`   ${s.name.padEnd(12)} ${c.u(`${careers}/gd/${s.token}`)}`);
  console.log(`\n${c.b('HR live page')} ${c.d(`(log in as HR of "${tenant.name}"${hr ? `, e.g. ${hr.user.name}` : ''})`)}`);
  console.log(`   ${c.u(`${hrBase}/group-discussion/live/${batchId}`)}`);
  console.log(`   Results after the end: ${c.u(`${hrBase}/group-discussion/results/${batchId}`)}`);
  console.log(`\n${c.d('Remove the demo later: node scripts/demo-gd/demo-gd.mjs --clean')}\n`);
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => db.$disconnect());
