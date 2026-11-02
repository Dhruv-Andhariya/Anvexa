import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadRootEnv, trustProxySetting } from './common/env';

loadRootEnv(); // repo-root .env (DATABASE_URL, AI_WORKER_URL, ...), regardless of the working directory

/**
 * Browsers send the session cookie, so only trusted origins may call the API with credentials.
 * CORS_ORIGINS (comma-separated) in production; otherwise only localhost dev servers (3000/3100/3200/3300).
 */
function corsOrigins(): (string | RegExp)[] {
  const configured = (process.env.CORS_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return configured.length ? configured : [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/];
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: corsOrigins(), credentials: true });
  await app.listen(process.env.API_PORT ?? 4000);
}
bootstrap();
