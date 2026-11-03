import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/modules/applications';
import { publicLimitsFromEnv } from '../src/modules/applications/abuse/rate-limiter';
import { ACCESS_KEY } from '../src/modules/auth/access';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { SessionsService } from '../src/modules/auth/sessions.service';
import { DsaController } from '../src/modules/dsa/dsa.controller';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { CODE_RUNNER } from '../src/modules/dsa/execution/code-runner';
import { ProctoringAdminController } from '../src/modules/dsa/proctoring/proctoring-admin.controller';
import { ProctoringController } from '../src/modules/dsa/proctoring/proctoring.controller';
import { DSA_PROCTOR_POLICY, policyFromEnv } from '../src/modules/dsa/proctoring/proctoring.policy';
import { ProctoringService } from '../src/modules/dsa/proctoring/proctoring.service';
import { DSA_PROCTOR_STORE, InMemoryProctorStore } from '../src/modules/dsa/proctoring/proctoring.store';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { DSA_QUESTION_REPOSITORY } from '../src/modules/dsa/questions/question.repository';
import { DSA_INVITATION_RESOLVER, DemoInvitationResolver, demoTokensFromEnv } from '../src/modules/dsa/session/invitation.resolver';
import { DSA_SESSION_STORE, InMemorySessionStore } from '../src/modules/dsa/session/session.store';

/**
 * The real API runs a global AuthGuard that fails closed (a route with no declared access answers 403) and demands a
 * CSRF header on every write. These tests run the DSA controllers behind that very guard, so the integration is
 * checked, not assumed.
 */
const KEY = 'access-test-key';
const idleRunner = { runBatch: async () => [] };

@Module({
  controllers: [DsaController, ProctoringController, ProctoringAdminController],
  providers: [
    DsaService,
    ProctoringService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: SessionsService, useValue: { resolve: async () => null } }, // nobody is logged in
    { provide: DSA_QUESTION_REPOSITORY, useClass: MockQuestionRepository },
    { provide: DSA_INVITATION_RESOLVER, useClass: DemoInvitationResolver },
    { provide: DSA_SESSION_STORE, useClass: InMemorySessionStore },
    { provide: DSA_PROCTOR_STORE, useClass: InMemoryProctorStore },
    { provide: DSA_PROCTOR_POLICY, useValue: { ...policyFromEnv({}), enabled: false } },
    { provide: CODE_RUNNER, useValue: idleRunner },
    // the controllers carry the shared per-IP limit; the real module gets this provider from ApplicationsModule
    { provide: RateLimiter, useFactory: () => new RateLimiter(publicLimitsFromEnv()) },
  ],
})
class GuardedModule {}

let app: NestExpressApplication;
let root = '';
const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${root}${path}`, { method, headers });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
};

describe('DSA routes behind the real AuthGuard', () => {
  beforeAll(async () => {
    process.env.DSA_ADMIN_API_KEY = KEY;
    app = await NestFactory.create<NestExpressApplication>(GuardedModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    root = `${(await app.getUrl()).replace('[::1]', 'localhost')}/api/v1`;
  });
  afterAll(async () => {
    delete process.env.DSA_ADMIN_API_KEY;
    await app?.close();
  });

  it('every DSA controller declares its access (otherwise the guard answers 403 to everything)', () => {
    for (const c of [DsaController, ProctoringController, ProctoringAdminController]) {
      expect(Reflect.getMetadata(ACCESS_KEY, c), c.name).toEqual({ kind: 'public' });
    }
  });

  it('candidate reads need no login and no CSRF header', async () => {
    const r = await call('GET', '/dsa/demo-dsa-token');
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('not_started');
    expect((await call('GET', '/dsa/not-a-token')).json.code).toBe('INVALID_TOKEN'); // reached our handler, not the guard
  });

  it('candidate writes are refused without the CSRF header and accepted with it', async () => {
    const without = await call('POST', '/dsa/demo-dsa-token/start');
    expect(without.status).toBe(403);
    expect(without.json.code).toBe('CSRF_CHECK_FAILED');
    const withHeader = await call('POST', '/dsa/demo-dsa-token/start', { 'x-requested-with': 'hireflow' });
    expect(withHeader.status).toBe(200);
    expect(withHeader.json.status).toBe('in_progress');
  });

  it('the proctoring admin routes stay behind their own key, not behind a login', async () => {
    const noKey = await call('GET', '/dsa-admin/proctoring/flagged');
    expect(noKey.status).toBe(401);
    expect(noKey.json.code).toBe('UNAUTHORIZED'); // our guard, proving the AuthGuard let the request through to it
    expect((await call('GET', '/dsa-admin/proctoring/flagged', { 'x-dsa-admin-key': 'wrong' })).status).toBe(401);
    expect((await call('GET', '/dsa-admin/proctoring/flagged', { 'x-dsa-admin-key': KEY })).status).toBe(200);
    const saved = process.env.DSA_ADMIN_API_KEY;
    delete process.env.DSA_ADMIN_API_KEY;
    expect((await call('GET', '/dsa-admin/proctoring/flagged', { 'x-dsa-admin-key': KEY })).status).toBe(404); // closed by default
    process.env.DSA_ADMIN_API_KEY = saved;
  });
});

describe('demo tokens', () => {
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const keys = ['NODE_ENV', 'DSA_ALLOW_DEMO_TOKENS', 'DSA_DEMO_TOKENS'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    try {
      await fn();
    } finally {
      for (const k of keys) delete process.env[k];
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  };

  it('work in development and test', async () => {
    await withEnv({ NODE_ENV: 'development', DSA_ALLOW_DEMO_TOKENS: undefined }, async () => {
      expect(await new DemoInvitationResolver().resolve('demo-dsa-token')).toMatchObject({ assessmentId: 'demo-assessment' });
    });
  });

  it('are refused in production, so a deployed API is not a free code-execution endpoint', async () => {
    await withEnv({ NODE_ENV: 'production', DSA_ALLOW_DEMO_TOKENS: undefined }, async () => {
      expect(await new DemoInvitationResolver().resolve('demo-dsa-token')).toBeNull();
      expect(await new DemoInvitationResolver().resolve('demo-dsa-short')).toBeNull();
    });
  });

  it('DSA_DEMO_TOKENS replaces the well-known tokens with long random ones (for a temporary public demo)', async () => {
    const t1 = 'Xk9fQ2mPz7LrT4vB8nWd';
    const t2 = 'aB3dE5gH7jK9mN1pQ3sT';
    await withEnv({ NODE_ENV: 'development', DSA_ALLOW_DEMO_TOKENS: undefined, DSA_DEMO_TOKENS: `${t1}:45, ${t2}, short:30, bad token!!!!!!!!!!!!:30` }, async () => {
      const r = new DemoInvitationResolver();
      expect(await r.resolve(t1)).toMatchObject({ durationMinutes: 45 });
      expect(await r.resolve(t2)).toMatchObject({ durationMinutes: 60 }); // minutes optional
      expect(await r.resolve('demo-dsa-token')).toBeNull(); // the well-known tokens are off
      expect(await r.resolve('demo-dsa-short')).toBeNull();
      expect(await r.resolve('short')).toBeNull(); // too short to be safe
      expect(await r.resolve('__proto__')).toBeNull();
    });
    expect(demoTokensFromEnv('')).toBeNull();
    expect(demoTokensFromEnv(`${t1}:9999`)).toEqual({ [t1]: 60 }); // out-of-range minutes fall back to 60
  });

  it('can be allowed in production only by an explicit switch', async () => {
    await withEnv({ NODE_ENV: 'production', DSA_ALLOW_DEMO_TOKENS: 'on' }, async () => {
      expect(await new DemoInvitationResolver().resolve('demo-dsa-token')).not.toBeNull();
    });
  });
});
