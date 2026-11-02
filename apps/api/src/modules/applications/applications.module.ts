import { Module } from '@nestjs/common';
import { PublisherModule } from '../publisher';
import { TenantsModule } from '../tenants';
import { CAPTCHA, turnstileFromEnv } from './abuse/captcha';
import { publicLimitsFromEnv, RateLimiter } from './abuse/rate-limiter';
import { ApplicationsService } from './applications.service';
import { HrApplicationsController } from './hr-applications.controller';
import { HrApplicationsService } from './hr-applications.service';
import { JobApplicationsEraser } from './job-applications.eraser';
import { EmailQueue } from './email/email-queue';
import { MAILER, mailerFromEnv, type Mailer } from './email/mailer';
import { MyDataService } from './my-data.service';
import { OTP_SENDER, otpSenderFromEnv } from './otp/otp-sender';
import { OTP_SECRET, OtpService, otpSecretFromEnv } from './otp/otp.service';
import { PublicCareersController } from './public-careers.controller';
import { RESUME_STORAGE, resumeStorageFromEnv } from './resume/resume-storage';
import { VIRUS_SCANNER, virusScannerFromEnv } from './resume/virus-scanner';

/** M08 unified apply link (public job data) + M09 applications intake + the HR view of applications. */
@Module({
  imports: [PublisherModule, TenantsModule],
  controllers: [PublicCareersController, HrApplicationsController],
  providers: [
    ApplicationsService,
    HrApplicationsService,
    MyDataService,
    JobApplicationsEraser,
    OtpService,
    { provide: RateLimiter, useFactory: () => new RateLimiter(publicLimitsFromEnv()) },
    { provide: CAPTCHA, useFactory: turnstileFromEnv },
    { provide: OTP_SENDER, useFactory: () => otpSenderFromEnv() },
    { provide: OTP_SECRET, useFactory: () => otpSecretFromEnv() },
    { provide: VIRUS_SCANNER, useFactory: () => virusScannerFromEnv() },
    { provide: RESUME_STORAGE, useFactory: () => resumeStorageFromEnv() },
    { provide: MAILER, useFactory: () => mailerFromEnv() },
    { provide: EmailQueue, useFactory: (mailer: Mailer) => new EmailQueue(mailer), inject: [MAILER] },
  ],
  // M10/M11 (ats module) reads resumes and sends candidate emails with the same storage and mailer.
  // The jobs module erases a job's applications when HR deletes the job.
  // M12 (screening module) rate-limits its public endpoints with the same per-IP limiter.
  exports: [RESUME_STORAGE, MAILER, JobApplicationsEraser, RateLimiter],
})
export class ApplicationsModule {}
