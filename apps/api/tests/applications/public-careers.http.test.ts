import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { trustProxySetting } from '../../src/common/env';
import { CAPTCHA } from '../../src/modules/applications/abuse/captcha';
import { RateLimiter } from '../../src/modules/applications/abuse/rate-limiter';
import { ApplicationsService } from '../../src/modules/applications/applications.service';
import { MyDataService } from '../../src/modules/applications/my-data.service';
import { OtpService } from '../../src/modules/applications/otp/otp.service';
import { PublicCareersController } from '../../src/modules/applications/public-careers.controller';
import { PublicJobsReader } from '../../src/modules/publisher';
import { PDF } from './fixtures';

/** The real controller over HTTP (Express + multer), with the services replaced: no database needed. */
describe('POST /public/applications (HTTP)', () => {
  let app: INestApplication;
  let base = '';
  const limiter = new RateLimiter({ application: { max: 1, windowMs: 60_000 } });
  const check = vi.spyOn(limiter, 'check');
  const submit = vi.fn(async (input: { resume?: { originalname?: string; buffer: Buffer } }) => ({ fileName: input.resume?.originalname }));

  beforeAll(async () => {
    @Module({
      controllers: [PublicCareersController],
      providers: [
        { provide: PublicJobsReader, useValue: {} },
        { provide: OtpService, useValue: {} },
        { provide: ApplicationsService, useValue: { submit } },
        { provide: MyDataService, useValue: {} },
        { provide: RateLimiter, useValue: limiter },
        { provide: CAPTCHA, useValue: { enabled: false } },
      ],
    })
    class TestModule {}
    const nest = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    nest.set('trust proxy', trustProxySetting(undefined)); // loopback, as in main.ts
    app = nest;
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  const post = (file: Buffer, name: string, ip: string) => {
    const fd = new FormData();
    fd.set('companySlug', 'acme');
    fd.set('jobSlug', 'dev');
    fd.set('application', '{}');
    fd.set('resume', new Blob([new Uint8Array(file)]), name);
    return fetch(`${base}/public/applications`, { method: 'POST', body: fd, headers: { 'x-forwarded-for': ip } });
  };

  it('keeps a non-ASCII (UTF-8) file name intact', async () => {
    const res = await post(PDF, 'आशा पटेल CV.pdf', '1.1.1.1');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ fileName: 'आशा पटेल CV.pdf' });
    expect(check).toHaveBeenCalledTimes(1); // counted once per request (guard only, not again in the handler)
    expect(check).toHaveBeenLastCalledWith('application', '1.1.1.1'); // req.ip, the same value @Ip() gives
  });

  it('refuses an over-limit IP BEFORE reading the upload (429, not 413 for the 6 MB file)', async () => {
    const res = await post(Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]), 'big.pdf', '1.1.1.1');
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('other IPs are unaffected', async () => {
    expect((await post(PDF, 'cv.pdf', '2.2.2.2')).status).toBe(201);
  });
});

describe('TRUST_PROXY', () => {
  it('maps booleans and hop counts, and passes other values (Express "trust proxy" syntax) through', () => {
    expect(trustProxySetting(undefined)).toBe('loopback');
    expect(trustProxySetting(' ')).toBe('loopback');
    expect(trustProxySetting('true')).toBe(true); // the string "true" would be read as an IP address by Express
    expect(trustProxySetting('TRUE')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting('1')).toBe(1);
    expect(trustProxySetting('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
  });
});
