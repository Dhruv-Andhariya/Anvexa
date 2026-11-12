import { HttpException, HttpStatus, type CanActivate, type Type } from '@nestjs/common';

/**
 * Doc 18.1 "behind a feature flag": a module's routes can be switched off with an env variable
 * (FEATURE_<NAME>=off) without a code change. Default is ON.
 *
 *   @UseGuards(featureFlag('publisher'))   // FEATURE_PUBLISHER=off -> every route answers 404 FEATURE_DISABLED
 */
export function isFeatureOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[`FEATURE_${name.toUpperCase()}`];
  return !v || !['off', 'false', '0'].includes(v.trim().toLowerCase());
}

export function featureFlag(name: string): Type<CanActivate> {
  class FeatureFlagGuard implements CanActivate {
    canActivate(): boolean {
      if (isFeatureOn(name)) return true;
      throw new HttpException(
        { statusCode: HttpStatus.NOT_FOUND, code: 'FEATURE_DISABLED', message: 'This feature is turned off.' },
        HttpStatus.NOT_FOUND,
      );
    }
  }
  return FeatureFlagGuard;
}

/**
 * BACKGROUND_JOBS=off: this API runs no background work at all - no workers (ATS, rounds, AI interview, GD), no queued
 * emails, no rewriting of the Apply link in job posts. For a teammate's laptop that shares the live database: only the
 * one hosting laptop (whose public tunnels are in the links) may send emails to candidates. Default on.
 */
export function backgroundJobsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', 'false', '0', 'no'].includes((env.BACKGROUND_JOBS ?? '').trim().toLowerCase());
}
