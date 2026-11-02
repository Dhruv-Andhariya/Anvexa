import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { mailerFromEnv } from '../applications/email/mailer';
import { AuthService } from './auth.service';
import { GoogleAuthService } from './google-auth.service';
import { GOOGLE_OAUTH_CONFIG, googleOAuthConfigFromEnv } from './google-oauth';
import { LoginCodeService } from './login-code.service';
import { SignupCodeService } from './signup-code.service';
import { AUTH_MAILER, PasswordResetService } from './password-reset.service';
import { SessionsService } from './sessions.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  controllers: [AuthController, TeamController],
  providers: [
    AuthService,
    SessionsService,
    TeamService,
    PasswordResetService,
    LoginCodeService,
    SignupCodeService,
    GoogleAuthService,
    { provide: GOOGLE_OAUTH_CONFIG, useFactory: () => googleOAuthConfigFromEnv() },
    // reset links, login and sign-up codes go out through the same SMTP / Gmail settings as the application emails
    { provide: AUTH_MAILER, useFactory: () => mailerFromEnv() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionsService, TeamService],
})
export class AuthModule {}
