/// <reference types="multer" /> // Express.Multer.File (tsconfig "types" lists only node)
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { otpSendRequestSchema, otpVerifyRequestSchema, type ApplicationReceipt, type PublicJob } from '@hireflow/contracts';
import type { z } from 'zod';
import { featureFlag } from '../../common/feature-flags';
import { Public } from '../auth';
import { PublicJobsReader } from '../publisher';
import { CAPTCHA, TurnstileVerifier } from './abuse/captcha';
import { rateLimit, RateLimiter } from './abuse/rate-limiter';
import { applicationsError } from './applications.errors';
import { ApplicationsService, MULTIPART_LIMITS } from './applications.service';
import { MyDataService } from './my-data.service';
import { OtpService } from './otp/otp.service';

/**
 * PUBLIC endpoints (no login) used by apps/careers-site: M08 job page data + M09 apply flow.
 * The company comes from the public slug in the URL, so every lookup is scoped to that company.
 * Spam protection (doc M08): per-IP rate limits on every POST, and Cloudflare Turnstile on "send OTP"
 * when TURNSTILE_SECRET_KEY is set.
 */
@Public() // no login: students. Writes still need the `x-requested-with: hireflow` header (AuthGuard CSRF check).
@Controller('public')
@UseGuards(featureFlag('applications'))
export class PublicCareersController {
  constructor(
    @Inject(PublicJobsReader) private readonly jobs: PublicJobsReader,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(ApplicationsService) private readonly applications: ApplicationsService,
    @Inject(MyDataService) private readonly myData: MyDataService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CAPTCHA) private readonly captcha: TurnstileVerifier,
  ) {}

  /** GET /api/v1/public/:companySlug/jobs - live jobs of one company. */
  @Get(':companySlug/jobs')
  async list(@Param('companySlug') companySlug: string): Promise<PublicJob[]> {
    const jobs = await this.jobs.liveJobs(companySlug);
    if (!jobs) throw applicationsError(HttpStatus.NOT_FOUND, 'COMPANY_NOT_FOUND', 'Company not found.');
    return jobs;
  }

  /** GET /api/v1/public/:companySlug/jobs/:jobSlug - the approved JD for the job page. */
  @Get(':companySlug/jobs/:jobSlug')
  async job(@Param('companySlug') companySlug: string, @Param('jobSlug') jobSlug: string): Promise<PublicJob> {
    const found = await this.jobs.job(companySlug, jobSlug);
    if (!found) throw applicationsError(HttpStatus.NOT_FOUND, 'JOB_NOT_FOUND', 'This job does not exist.');
    return found.view;
  }

  /** POST /api/v1/public/otp/send - body { companySlug, phone, email? }: emails the code (see OtpService). */
  @Post('otp/send')
  @HttpCode(200)
  async sendOtp(@Body() body: unknown, @Ip() ip: string) {
    this.limiter.check('otp-send', ip);
    const req = parse(otpSendRequestSchema, body);
    await this.captcha.check(req.captchaToken, ip);
    return this.otp.send(await this.tenantOf(req.companySlug), req.phone, req.email);
  }

  /** POST /api/v1/public/otp/verify - body { companySlug, phone, code }; returns { otpToken }. */
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Ip() ip: string) {
    this.limiter.check('otp-verify', ip);
    const req = parse(otpVerifyRequestSchema, body);
    return this.otp.verify(await this.tenantOf(req.companySlug), req.phone, req.code, req.email);
  }

  /** POST /api/v1/public/applications - multipart: companySlug, jobSlug, application (JSON), resume (file). */
  @Post('applications')
  @HttpCode(201)
  // The per-IP limit is a guard, so it runs before the interceptor reads up to 5 MB of upload.
  @UseGuards(rateLimit('application'))
  // defParamCharset: browsers send non-ASCII file names as raw UTF-8 (multer's default latin1 garbles them).
  @UseInterceptors(FileInterceptor('resume', { limits: MULTIPART_LIMITS, defParamCharset: 'utf8' }))
  submit(@Body() body: Record<string, unknown>, @UploadedFile() resume: Express.Multer.File | undefined): Promise<ApplicationReceipt> {
    const companySlug = typeof body.companySlug === 'string' ? body.companySlug : '';
    const jobSlug = typeof body.jobSlug === 'string' ? body.jobSlug : '';
    return this.applications.submit({ companySlug, jobSlug, application: body.application, resume });
  }

  /** POST /api/v1/public/my-data - body { companySlug, phone, otpToken }: the student's own data (DPDP access). */
  @Post('my-data')
  @HttpCode(200)
  viewMyData(@Body() body: unknown, @Ip() ip: string) {
    this.limiter.check('my-data', ip);
    return this.myData.view(body);
  }

  /** POST /api/v1/public/my-data/delete - body { companySlug, phone, otpToken, confirm: true }: erase it (DPDP). */
  @Post('my-data/delete')
  @HttpCode(200)
  deleteMyData(@Body() body: unknown, @Ip() ip: string) {
    this.limiter.check('my-data', ip);
    return this.myData.erase(body);
  }

  /** GET /api/v1/public/config - public, non-secret settings the careers site needs (CAPTCHA on/off). */
  @Get('config')
  config() {
    return { captchaRequired: this.captcha.enabled };
  }

  private async tenantOf(companySlug: string): Promise<string> {
    const company = await this.jobs.company(companySlug);
    if (!company) throw applicationsError(HttpStatus.NOT_FOUND, 'COMPANY_NOT_FOUND', 'Company not found.');
    return company.tenantId;
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw applicationsError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', parsed.error.issues[0]?.message ?? 'Invalid request.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}
