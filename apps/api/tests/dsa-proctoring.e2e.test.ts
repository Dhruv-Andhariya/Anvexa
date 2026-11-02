import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DsaController } from '../src/modules/dsa/dsa.controller';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { JUDGE0_CLIENT, type CodeRunner } from '../src/modules/dsa/judge0/judge0.client';
import { ProctoringAdminController } from '../src/modules/dsa/proctoring/proctoring-admin.controller';
import { ProctoringController } from '../src/modules/dsa/proctoring/proctoring.controller';
import { DSA_PROCTOR_POLICY, policyFromEnv } from '../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService, inviteRefFor } from '../src/modules/dsa/proctoring/proctoring.service';
import { DSA_PROCTOR_STORE, InMemoryProctorStore } from '../src/modules/dsa/proctoring/proctoring.store';
import { CONSENT_VERSION } from '../src/modules/dsa/proctoring/proctoring.types';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { DSA_QUESTION_REPOSITORY } from '../src/modules/dsa/questions/question.repository';
import { DSA_INVITATION_RESOLVER, DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { DSA_SESSION_STORE, InMemorySessionStore } from '../src/modules/dsa/session/session.store';

const idleRunner: CodeRunner = { runBatch: async () => [] };

@Module({
  controllers: [DsaController, ProctoringController, ProctoringAdminController],
  providers: [
    DsaService,
    ProctoringService,
    { provide: DSA_QUESTION_REPOSITORY, useClass: MockQuestionRepository },
    { provide: DSA_INVITATION_RESOLVER, useClass: DemoInvitationResolver },
    { provide: DSA_SESSION_STORE, useClass: InMemorySessionStore },
    { provide: DSA_PROCTOR_STORE, useClass: InMemoryProctorStore },
    { provide: DSA_PROCTOR_POLICY, useValue: { ...policyFromEnv({}), enabled: true } },
    { provide: JUDGE0_CLIENT, useValue: idleRunner },
  ],
})
class TestModule {}

const KEY = 'test-admin-key-123';
let app: NestExpressApplication;
let root = '';

const call = async (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
const consent = { consent: true, consentVersion: CONSENT_VERSION, fullscreen: true };

describe('proctoring over HTTP', () => {
  beforeAll(async () => {
    process.env.DSA_ADMIN_API_KEY = KEY;
    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    root = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  });
  afterAll(async () => {
    delete process.env.DSA_ADMIN_API_KEY;
    await app?.close();
  });

  it('gates the start on consent, then records events and reports standing without thresholds', async () => {
    const t = 'demo-dsa-token';
    expect((await call('POST', `/dsa/${t}/start`)).json.code).toBe('PROCTORING_NOT_STARTED');
    expect((await call('POST', `/dsa/${t}/proctor/start`, { ...consent, consent: false })).json.code).toBe('CONSENT_REQUIRED');
    const started = await call('POST', `/dsa/${t}/proctor/start`, consent);
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ enabled: true, requireFullscreen: true, consentVersion: CONSENT_VERSION });
    expect((await call('POST', `/dsa/${t}/start`)).json.status).toBe('in_progress');

    const rec = await call('POST', `/dsa/${t}/proctor/events`, { events: [{ type: 'FULLSCREEN_EXIT' }, { type: 'COPY' }] });
    expect(rec.status).toBe(200);
    // two suspicious events used both allowed warnings: still running, but this is now the final warning
    expect(rec.json).toMatchObject({ accepted: 2, ignored: 0, violationCount: 2, level: 'final_warning', strikesUsed: 2, strikesAllowed: 2, ended: false });
    expect(rec.text).not.toMatch(/warnScore|reviewScore|disqualify|inviteRef|threshold/i);
    await call('POST', `/dsa/${t}/proctor/events`, { events: [{ type: 'FULLSCREEN_RETURN' }] });
    const state = await call('GET', `/dsa/${t}`);
    expect(state.json.proctoring).toMatchObject({ started: true, violationCount: 2 });
  });

  it('refuses fabricated identities and malformed bodies', async () => {
    const t = 'demo-dsa-token';
    const forged = await call('POST', `/dsa/${t}/proctor/events`, { candidateId: 'victim', events: [{ type: 'COPY' }] });
    expect(forged).toMatchObject({ status: 400 });
    expect(forged.json.code).toBe('UNEXPECTED_FIELD');
    expect((await call('POST', `/dsa/not-a-token/proctor/events`, { events: [{ type: 'COPY' }] })).status).toBe(404);
    expect((await call('POST', `/dsa/${t}/proctor/events`, { events: [{ type: 'NOPE' }] })).json.code).toBe('INVALID_EVENT_TYPE');
  });

  it('gives candidates no way to read the event log', async () => {
    const t = 'demo-dsa-token';
    for (const path of [`/dsa/${t}/proctor/events`, `/dsa/${t}/proctor/summary`, `/dsa/${t}/proctor`]) {
      expect((await call('GET', path)).status).toBe(404);
    }
    const ref = inviteRefFor(t);
    // the token is not an admin credential, and neither is a made-up key
    expect((await call('GET', `/dsa-admin/proctoring/${ref}/summary`)).status).toBe(401);
    expect((await call('GET', `/dsa-admin/proctoring/${ref}/summary`, undefined, { 'x-dsa-admin-key': t })).status).toBe(401);
    expect((await call('GET', `/dsa-admin/proctoring/${ref}/events`, undefined, { 'x-dsa-admin-key': 'wrong' })).status).toBe(401);
  });

  it('serves HR the summary, the event log and the flagged list with the admin key', async () => {
    const h = { 'x-dsa-admin-key': KEY };
    const ref = inviteRefFor('demo-dsa-token');
    const sum = await call('GET', `/dsa-admin/proctoring/${ref}/summary`, undefined, h);
    expect(sum.status).toBe(200);
    expect(sum.json).toMatchObject({ inviteRef: ref, totalViolations: 2, fullscreenExitCount: 1, copyPasteAttempts: 1, status: 'clean', flagged: false });
    expect(typeof sum.json.totalTimeOutsideMs).toBe('number');
    expect(sum.json.policy).toHaveProperty('reviewScore');
    expect(sum.text).not.toContain('demo-dsa-token');

    const events = await call('GET', `/dsa-admin/proctoring/${ref}/events?limit=1&offset=0`, undefined, h);
    expect(events.json.total).toBe(2);
    expect(events.json.events).toHaveLength(1);
    expect(events.json.events[0]).toHaveProperty('durationMs');

    expect((await call('GET', `/dsa-admin/proctoring/${'0'.repeat(24)}/summary`, undefined, h)).status).toBe(404);
    expect((await call('GET', `/dsa-admin/proctoring/flagged`, undefined, h)).json).toEqual({ flagged: [] });
  });

  it('ends proctoring only after finish, and the admin routes vanish when no key is configured', async () => {
    const t = 'demo-dsa-token';
    expect((await call('POST', `/dsa/${t}/proctor/end`)).json.code).toBe('ASSESSMENT_IN_PROGRESS');
    expect((await call('POST', `/dsa/${t}/finish`)).json.status).toBe('finished');
    expect((await call('POST', `/dsa/${t}/proctor/end`)).json).toEqual({ ended: true });
    expect((await call('POST', `/dsa/${t}/proctor/events`, { events: [{ type: 'COPY' }] })).json.code).toBe('ALREADY_FINISHED');
    const saved = process.env.DSA_ADMIN_API_KEY;
    delete process.env.DSA_ADMIN_API_KEY;
    expect((await call('GET', `/dsa-admin/proctoring/flagged`, undefined, { 'x-dsa-admin-key': KEY })).status).toBe(404);
    process.env.DSA_ADMIN_API_KEY = saved;
  });
});
