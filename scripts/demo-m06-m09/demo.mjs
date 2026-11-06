#!/usr/bin/env node
// Demo of M06 Job publisher + M07 Channel adapters + M08 Apply page + M09 Applications intake,
// starting where Intern 1's flow ends: an HR user, a company profile and an APPROVED JD in the database.
//
//   pnpm demo:m06-m09            (API on :4000, Postgres + Mailpit in docker; AI worker optional)
//   pnpm demo:m06-m09 --keep     (leave the demo application in the database for the resume parser)
//
// It uses Intern 1's real endpoints (signup/login, register company, create job, generate JD, approve). If the AI
// worker cannot generate a JD (not running, quota...), it inserts the ready-made JD from demo-job.json as version 1
// instead - exactly what step 3 would have written - and continues.
//
// Optional env: API_URL, MAILPIT_URL, DEMO_HR_EMAIL, DEMO_HR_PASSWORD, LINKEDIN_ORGANIZATION_ID (numeric LinkedIn
// page id - needs LINKEDIN_ACCESS_TOKEN and LINKEDIN_API_VERSION in the API's .env)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

// Switched off (2026-11-04, owner's rule): links and emails go ONLY to students who applied for the job themselves.
// This demo creates students who never applied and gives them personal links, so it does not run any more.
console.error('This demo is switched off: links are only ever given to students who applied for the job themselves.');
process.exit(1);
const API = (process.env.API_URL || 'http://localhost:4000/api/v1').replace(/\/+$/, '');
const MAILPIT = (process.env.MAILPIT_URL || 'http://localhost:8025').replace(/\/+$/, '');
const HR_EMAIL = process.env.DEMO_HR_EMAIL || 'demo.hr@hireflow.local';
const HR_PASSWORD = process.env.DEMO_HR_PASSWORD || 'demo-password-123';
const DB_CONTAINER = process.env.DB_CONTAINER || 'hireflow-postgres-1';
const DB_NAME = process.env.DB_NAME || 'hireflow';
const demo = JSON.parse(readFileSync(fileURLToPath(new URL('./demo-job.json', import.meta.url)), 'utf8'));

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
let stepNo = 0;
const step = (title) => console.log(`\n${c.b(`${++stepNo}. ${title}`)}`);
const ok = (msg) => console.log(`   ${c.g('✓')} ${msg}`);
const bad = (msg) => console.log(`   ${c.r('✗')} ${msg}`);
const note = (msg) => console.log(`   ${c.d(msg)}`);

let cookie = ''; // the HR browser's session cookie

/** Like the dashboard / careers site: CSRF header on every call, session cookie when acting as HR. */
async function api(path, { method = 'GET', body, form, hr = false } = {}) {
  const headers = { 'x-requested-with': 'hireflow' };
  if (hr && cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const set = res.headers.getSetCookie().find((x) => x.startsWith('hireflow_session='));
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Reads an emailed 6-digit code from the terminal (login 2FA / sign-up verification). */
async function askCode(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question(`   ${prompt} (also in the API console): `)).trim();
  rl.close();
  return code;
}

const must = (res, expected, what) => {
  if (res.status !== expected) throw new Error(`${what} failed (${res.status}): ${JSON.stringify(res.json)}`);
  return res.json;
};

/** A small but real PDF (Helvetica text) so the resume parser has something to read. */
function samplePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => `\\${m}`);
  const content = `BT /F1 12 Tf 72 760 Td 16 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A minimal .docx (ZIP, stored entries) that also contains the EICAR antivirus test file.
 * It passes the PDF/DOCX type check, so it really reaches the virus scanner - and ClamAV looks inside ZIPs.
 */
function docxWithEicar() {
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'],
    ['eicar.com', EICAR],
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text, 'latin1');
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function psql(sql) {
  return execFileSync('docker', ['exec', DB_CONTAINER, 'psql', '-U', 'hire', '-d', DB_NAME, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  console.log(c.b('Anvexa demo - M06 publisher, M07 channels, M08 apply page, M09 intake'));
  note(`API ${API}`);

  step('API is up');
  const health = await api('/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    bad('API not reachable. Start it:  pnpm infra:up  &&  pnpm --filter api dev');
    process.exit(1);
  }
  ok('API healthy');

  // ---------------- Intern 1's part (only what the publisher needs to exist) ----------------
  step(`HR logs in (${HR_EMAIL}) and has a company with a careers page link`);
  let session = (await api('/auth/login', { method: 'POST', body: { email: HR_EMAIL, password: HR_PASSWORD } })).json;
  if (session?.codeRequired) {
    // LOGIN_2FA=email: the code goes to the HR inbox; in local dev the API console also prints it ("dev only - login code")
    const code = await askCode(`Login code sent to ${session.emailHint}`);
    session = must(await api('/auth/login/verify', { method: 'POST', body: { challenge: session.challenge, code } }), 200, 'login code');
  }
  if (!session?.user) {
    session = must(await api('/auth/signup', { method: 'POST', body: { name: 'Demo HR', email: HR_EMAIL, password: HR_PASSWORD } }), 201, 'signup');
    if (session.codeRequired) {
      // SIGNUP_VERIFY_EMAIL=email: same, with "dev only - sign-up code" in the API console
      const code = await askCode(`Sign-up code sent to ${session.emailHint}`);
      session = must(await api('/auth/signup/verify', { method: 'POST', body: { challenge: session.challenge, code } }), 201, 'sign-up code');
    }
  }
  if (!session.company) {
    session = must(
      await api('/companies', {
        method: 'POST',
        hr: true,
        body: {
          name: 'Demo Tech Pvt Ltd',
          industry: 'Software',
          description: 'Demo Tech builds simple billing and inventory software for small businesses in Gujarat.',
          website: 'https://example.com',
          careersUrl: 'https://example.com/careers',
          headquarters: 'Ahmedabad',
          benefits: ['Health insurance'],
        },
      }),
      201,
      'register company',
    );
  }
  const companySlug = session.company.slug;
  ok(`${session.user.name} @ ${session.company.name} (${companySlug})`);
  const { id: _id, updatedAt: _u, ...profile } = must(await api('/company-profile', { hr: true }), 200, 'company profile');
  if (!profile.careersUrl) {
    must(await api('/company-profile', { method: 'PUT', hr: true, body: { ...profile, careersUrl: 'https://example.com/careers' } }), 200, 'add careers link');
    ok('careers page link added to the company profile');
  }

  if (process.env.LINKEDIN_ORGANIZATION_ID) {
    must(
      await api('/publisher/channels/linkedin/settings', {
        method: 'PUT',
        hr: true,
        body: { enabled: true, config: { organizationId: process.env.LINKEDIN_ORGANIZATION_ID } },
      }),
      204,
      'LinkedIn settings',
    );
    ok(`LinkedIn page set to organization ${process.env.LINKEDIN_ORGANIZATION_ID}`);
  }

  step('HR creates the job, the JD is generated and HR approves it (Intern 1 steps 2-4)');
  const job = must(await api('/jobs', { method: 'POST', hr: true, body: { ...demo.form, screening: { minAtsScore: 70 } } }), 201, 'create job'); // private min ATS score (needed to publish)
  ok(`job ${job.id} created`);
  let current = await api(`/jobs/${job.id}/jd/generate`, { method: 'POST', hr: true });
  if (current.status === 200) {
    ok(`AI wrote JD version ${current.json.versions[0].version}`);
  } else {
    note(`AI generation not available (${current.json?.code ?? current.status}) - inserting the ready-made demo JD as version 1`);
    const content = JSON.stringify(demo.jd).replaceAll('$jd$', '');
    psql(
      `WITH v AS (INSERT INTO jd_versions (id, tenant_id, job_id, version, source, content, model, created_at)
         SELECT gen_random_uuid(), tenant_id, id, 1, 'AI', $jd$${content}$jd$::jsonb, 'demo-fixture', now() FROM jobs WHERE id = '${job.id}' RETURNING id, job_id)
       UPDATE jobs SET status = 'JD_GENERATED', current_jd_version_id = v.id, updated_at = now() FROM v WHERE jobs.id = v.job_id;`,
    );
    current = await api(`/jobs/${job.id}`, { hr: true });
    ok('demo JD stored as version 1');
  }
  const approved = must(
    await api(`/jobs/${job.id}/approve`, {
      method: 'POST',
      hr: true,
      body: { jdVersionId: current.json.currentJdVersionId, companyDetailsVerified: true },
    }),
    200,
    'approve',
  );
  ok(`HR approved version ${approved.versions.find((v) => v.id === approved.approval.jdVersionId).version} - job status ${approved.status}`);

  // ---------------- M06 / M07: publisher ----------------
  step('Publisher reads the approved JD from the database (HR "Publish" page)');
  const list = must(await api('/publisher/jobs', { hr: true }), 200, 'list approved jobs');
  const row = list.find((j) => j.jobId === job.id);
  ok(`${list.length} approved job(s); this one: "${row.title}" version ${row.version}, ${row.listing ? 'published' : 'not published yet'}`);

  step('HR clicks "Preview & publish" -> the post for every channel');
  const req = { selectionProcess: demo.selectionProcess };
  const preview = must(await api(`/publisher/jobs/${job.id}/preview`, { method: 'POST', hr: true, body: req }), 200, 'preview');
  preview.warnings.forEach((w) => note(`note: ${w}`));
  preview.errors.forEach((e) => bad(e));
  for (const ch of preview.channels) {
    if (ch.availability === 'coming_soon') continue;
    console.log(`\n   ${c.b(`[${ch.label}]`)}${ch.blockers.length ? c.r(`  will be skipped: ${ch.blockers.join(' ')}`) : ''}`);
    if (ch.text) console.log(ch.text.split('\n').map((l) => `   │ ${l}`).join('\n'));
  }
  console.log(`\n   Coming soon: ${preview.channels.filter((x) => x.availability === 'coming_soon').map((x) => x.label).join(', ')}`);

  step('HR confirms -> published on all channels in parallel');
  const pub = must(await api(`/publisher/jobs/${job.id}/publish`, { method: 'POST', hr: true, body: req }), 200, 'publish');
  for (const p of pub.posts) {
    const line = `${p.channel.padEnd(12)} ${p.status}${p.url ? `  ${p.url}` : ''}${p.error ? c.d(`  (${p.error})`) : ''}`;
    p.status === 'PUBLISHED' ? ok(line) : console.log(`   - ${line}`);
  }
  const applyUrl = pub.applyUrl;
  const jobSlug = pub.slug;

  step('Publishing the same job again never posts twice');
  await api(`/publisher/jobs/${job.id}/publish`, { method: 'POST', hr: true, body: req });
  const posts = must(await api(`/publisher/jobs/${job.id}/posts`, { hr: true }), 200, 'posts');
  ok(`still version ${posts.version}, ${posts.posts.length} post rows (one per channel)`);

  // ---------------- M08 / M09: student ----------------
  step('Student opens the apply link');
  const pubJob = must(await api(`/public/${companySlug}/jobs/${jobSlug}`), 200, 'public job');
  ok(`${pubJob.jd.title} at ${pubJob.company.name} - ${pubJob.status}; company careers page: ${pubJob.company.careersPageUrl}`);
  console.log(`   Open in the browser (careers-site on :3300):  ${c.b(`${applyUrl}?src=linkedin`)}`);

  const phone = `9${String(Date.now()).slice(-9)}`;
  const email = `student.${Date.now()}@example.com`;

  step(`Phone OTP for +91${phone} (dev mode shows the code instead of sending an SMS)`);
  const sent = must(await api('/public/otp/send', { method: 'POST', body: { companySlug, phone } }), 200, 'otp send');
  const verified = must(await api('/public/otp/verify', { method: 'POST', body: { companySlug, phone, code: sent.devCode } }), 200, 'otp verify');
  ok('phone verified');

  const application = {
    name: 'Asha Patel',
    email,
    phone,
    city: 'Ahmedabad',
    college: 'LD College of Engineering',
    degree: 'B.E.',
    branch: 'Computer Engineering',
    graduationYear: 2026,
    scoreType: 'CGPA',
    scoreValue: 8.4,
    githubUrl: 'https://github.com/example',
    consents: { dataProcessing: true, aiEvaluation: true, recordings: false },
    otpToken: verified.otpToken,
    source: 'linkedin',
  };
  const formWith = (bytes, name) => {
    const fd = new FormData();
    fd.set('companySlug', companySlug);
    fd.set('jobSlug', jobSlug);
    fd.set('application', JSON.stringify(application));
    fd.set('resume', new Blob([bytes]), name);
    return fd;
  };
  const resume = samplePdf([
    'Asha Patel',
    'B.E. Computer Engineering, LD College of Engineering, 2026, CGPA 8.4',
    'Skills: Node.js, PostgreSQL, REST APIs, Git',
    'Project: Library management REST API in Node.js and PostgreSQL',
  ]);

  step('Safety checks before anything is saved');
  const fake = await api('/public/applications', { method: 'POST', form: formWith(Buffer.from('MZ this is not a pdf'), 'resume.pdf') });
  fake.status === 415 ? ok(`fake PDF rejected (${fake.status} ${fake.json.code})`) : bad(`fake PDF: ${fake.status}`);
  const virus = await api('/public/applications', { method: 'POST', form: formWith(docxWithEicar(), 'resume.docx') });
  virus.status === 422 ? ok(`Word file hiding the EICAR test virus rejected (${virus.status} ${virus.json.code})`) : bad(`virus file: ${virus.status}`);

  step('Student submits the application');
  const receipt = must(await api('/public/applications', { method: 'POST', form: formWith(resume, 'Asha_Patel_Resume.pdf') }), 201, 'submit');
  ok(`application ${receipt.applicationId} saved (job ${receipt.jobId})`);
  const dup = await api('/public/applications', { method: 'POST', form: formWith(resume, 'Asha_Patel_Resume.pdf') });
  dup.status === 409 ? ok(`second submit blocked as duplicate (${dup.json.code})`) : bad(`duplicate: ${dup.status}`);

  step('Student gets the "thanks for applying" email');
  if (!receipt.confirmationEmailSent) {
    bad('email switched off - is SMTP_URL set in .env and Mailpit running (pnpm infra:up)?');
  } else {
    // The API only QUEUES the email (sent in the background), so give it a few seconds to arrive.
    let msg;
    for (let i = 0; i < 15 && !msg; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1000));
      const found = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
        .then((r) => r.json())
        .catch(() => null);
      msg = found?.messages?.[0];
    }
    msg ? ok(`"${msg.Subject}" -> ${email}  (read it at ${MAILPIT})`) : note(`queued, not in Mailpit yet - check ${MAILPIT}`);
  }

  step('Resume parser reads it from the read-only view (role hireflow_resume_reader)');
  try {
    const out = psql(
      `BEGIN; SET LOCAL ROLE hireflow_resume_reader; SELECT file_name || ' | ' || mime_type || ' | ' || size_bytes || ' bytes' FROM parser_resume_inbox WHERE application_id = '${receipt.applicationId}'; COMMIT;`,
    );
    ok(`view row: ${out.split('\n').filter((l) => l && !/^(BEGIN|SET|COMMIT)$/.test(l)).join(' ')}`);
    try {
      psql('BEGIN; SET LOCAL ROLE hireflow_resume_reader; DELETE FROM resume_files; COMMIT;');
      bad('parser role could delete - this should never happen');
    } catch (e) {
      ok(`parser role cannot change tables (${String(e.stderr).match(/permission denied[^\n]*/)?.[0] ?? 'denied'})`);
    }
  } catch (e) {
    note(`skipped: could not run psql in docker container "${DB_CONTAINER}" (${e.message.split('\n')[0]})`);
  }

  step('HR closes the job -> students can no longer apply; then reopens it');
  must(await api(`/publisher/jobs/${job.id}/close`, { method: 'POST', hr: true }), 200, 'close');
  ok(`job page now says ${(await api(`/public/${companySlug}/jobs/${jobSlug}`)).json.status}`);
  const late = await api('/public/applications', { method: 'POST', form: formWith(resume, 'late.pdf') });
  late.status === 410 ? ok(`late application refused (${late.status} ${late.json.code})`) : bad(`late application: ${late.status}`);
  must(await api(`/publisher/jobs/${job.id}/reopen`, { method: 'POST', hr: true }), 200, 'reopen');
  ok('job reopened');

  step('Student uses "See or delete my data" (DPDP)');
  const proof = { companySlug, phone, otpToken: verified.otpToken };
  const mine = must(await api('/public/my-data', { method: 'POST', body: proof }), 200, 'my data');
  ok(`sees ${mine.applications.length} application(s): ${mine.applications.map((a) => a.jobTitle).join(', ')}`);
  if (process.argv.includes('--keep')) {
    note('--keep: the application stays in the database (for the resume parser / HR to look at)');
  } else {
    const erased = must(await api('/public/my-data/delete', { method: 'POST', body: { ...proof, confirm: true } }), 200, 'delete my data');
    ok(`deleted ${erased.deletedApplications} application(s) with resume, details and consents  (run with --keep to leave it)`);
  }

  console.log(`\n${c.g(c.b('Demo finished.'))} Student page: ${applyUrl}`);
  console.log(`HR page: http://localhost:3000/publish  (log in as ${HR_EMAIL} / ${HR_PASSWORD})\n`);
}

main().catch((err) => {
  console.error(`\n${c.r('Demo failed:')} ${err.message}`);
  process.exit(1);
});
