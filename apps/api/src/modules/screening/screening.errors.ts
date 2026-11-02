import { HttpException } from '@nestjs/common';

/** Same error body shape as the other modules: { statusCode, code, message, ...extra }. Never a token or transcript. */
export function screeningError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}
