import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/** Every API error has the same body: { statusCode, code, message } (+ issues[] for invalid input). */
export function apiError(status: number, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** Validate a request body with a shared contract schema, or throw 400 `code` with field-level issues. */
export function parseBody<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown, code: string, message: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const err = apiError(HttpStatus.BAD_REQUEST, code, message);
  const body = err.getResponse() as Record<string, unknown>;
  body.issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw err;
}
