import { HttpException } from '@nestjs/common';

/** Same error body shape as modules/jobs: { statusCode, code, message, ...extra }. */
export function applicationsError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}
