import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DsaController } from '../src/modules/dsa/dsa.controller';
import { DsaService } from '../src/modules/dsa/dsa.service';
import { JUDGE0_CLIENT } from '../src/modules/dsa/judge0/judge0.client';
import { MockQuestionRepository } from '../src/modules/dsa/questions/mock-question.repository';
import { MOCK_QUESTIONS } from '../src/modules/dsa/questions/mock-questions.data';
import { DSA_QUESTION_REPOSITORY } from '../src/modules/dsa/questions/question.repository';
import { DSA_INVITATION_RESOLVER, DemoInvitationResolver } from '../src/modules/dsa/session/invitation.resolver';
import { DSA_SESSION_STORE, InMemorySessionStore } from '../src/modules/dsa/session/session.store';
import { CORRECT, WRONG } from './dsa-fixtures';
import { LocalRunner } from './support/local-runner';

/**
 * Real HTTP, real Nest controllers/DI/validation. Code is executed with local toolchains (not Judge0),
 * so hidden cases genuinely pass and fail. Every response body is captured and scanned for hidden data.
 */
@Module({
  controllers: [DsaController],
  providers: [
    DsaService,
    { provide: DSA_QUESTION_REPOSITORY, useClass: MockQuestionRepository },
    { provide: DSA_INVITATION_RESOLVER, useClass: DemoInvitationResolver },
    { provide: DSA_SESSION_STORE, useClass: InMemorySessionStore },
    { provide: JUDGE0_CLIENT, useValue: new LocalRunner() },
  ],
})
class TestModule {}

const missing = LocalRunner.toolchainProblems();
let app: NestExpressApplication;
let base = '';
const captured: string[] = [];

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  captured.push(text);
  return { status: res.status, json: JSON.parse(text) as Record<string, any> };
}

describe.skipIf(missing.length > 0)('DSA HTTP API', () => {
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    app.setGlobalPrefix('api/v1');
    await app.listen(0);
    base = `${await app.getUrl()}/api/v1/dsa/demo-dsa-token`.replace('[::1]', 'localhost');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('serves the full flow and never puts hidden test data on the wire', async () => {
    expect((await call('GET', '')).json.status).toBe('not_started');
    const started = await call('POST', '/start');
    expect(started.status).toBe(200);
    expect(started.json.questions).toHaveLength(3);
    expect(started.json.questions[0]).not.toHaveProperty('testCases');

    for (const q of MOCK_QUESTIONS) {
      const good = await call('POST', '/submit', { questionId: q.id, language: 'python', code: CORRECT[q.id].python });
      expect(good.status).toBe(200);
      expect(good.json.verdict).toBe('passed');
      expect(good.json.score).toBe(q.marks);
      const bad = await call('POST', '/submit', { questionId: q.id, language: 'python', code: WRONG[q.id].python });
      expect(bad.json.verdict).toBe('failed');
      expect(bad.json.progress.bestScore).toBe(q.marks); // the earlier best is kept
      await call('POST', '/run', { questionId: q.id, language: 'python', code: CORRECT[q.id].python });
    }

    const done = await call('POST', '/finish');
    expect(done.json.result).toMatchObject({ totalScore: 60, maxScore: 60, percentage: 100, reason: 'submitted' });
    expect((await call('GET', '/result-does-not-exist')).status).toBe(404);

    const wire = captured.join('\n');
    const esc = (s: string) => JSON.stringify(s).slice(1, -1);
    for (const q of MOCK_QUESTIONS) {
      for (const t of q.testCases.filter((c) => c.hidden)) {
        expect(wire, `hidden display of ${t.id}`).not.toContain(esc(t.display));
        if (t.stdin.trim().length >= 4) expect(wire, `hidden stdin of ${t.id}`).not.toContain(esc(t.stdin.trim()));
      }
    }
    // Hidden cases must reach the client only as label + status + timing.
    const submissions = captured.filter((c) => c.includes('"cases"')).map((c) => JSON.parse(c));
    const hiddenCases = submissions.flatMap((s) => s.cases).filter((c: any) => c.hidden);
    expect(hiddenCases.length).toBeGreaterThan(0);
    for (const c of hiddenCases) expect(Object.keys(c).sort()).toEqual(['hidden', 'id', 'label', 'memoryKb', 'status', 'timeMs']);
    expect(wire).not.toMatch(/"(stdin|testCases|hiddenTests|harness|comparator)"/);
  }, 240_000);

  it('rejects malformed requests with readable errors', async () => {
    const r = await call('POST', '/run', { questionId: 'dsa-001', language: 'ruby', code: 'x' });
    expect(r.status).toBe(400); // validation runs before the (finished) state check
    const finished = await call('POST', '/run', { questionId: 'dsa-001', language: 'python', code: 'x = 1' });
    expect(finished.status).toBe(403);
    expect(finished.json.code).toBe('ALREADY_FINISHED');
    const fresh = await fetch(`${base.replace('demo-dsa-token', 'demo-dsa-short')}/start`, { method: 'POST' });
    expect(fresh.status).toBe(200);
    const bad = await fetch(`${base.replace('demo-dsa-token', 'demo-dsa-short')}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'dsa-001', language: 'ruby', code: 'x' }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('INVALID_REQUEST');
  });
});
