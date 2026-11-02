import { HttpException, HttpStatus } from '@nestjs/common';
import { LANGUAGES, type Language } from './questions/question.types';

export const MAX_CODE_CHARS = 64_000;

export interface CodeRequestDto {
  questionId: string;
  language: Language;
  code: string;
}

export function dsaError(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ statusCode: status, code, message }, status);
}

/** Validates the body of POST run / submit. Throws a 400 with a readable message. */
export function parseCodeRequest(body: unknown): CodeRequestDto {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.questionId !== 'string' || b.questionId === '') {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'questionId is required.');
  }
  if (typeof b.language !== 'string' || !(LANGUAGES as readonly string[]).includes(b.language)) {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', `language must be one of: ${LANGUAGES.join(', ')}.`);
  }
  if (typeof b.code !== 'string' || b.code.trim() === '') {
    throw dsaError(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', 'Write some code before running or submitting.');
  }
  if (b.code.length > MAX_CODE_CHARS) {
    throw dsaError(HttpStatus.BAD_REQUEST, 'CODE_TOO_LARGE', `Code must be at most ${MAX_CODE_CHARS} characters.`);
  }
  return { questionId: b.questionId, language: b.language as Language, code: b.code };
}
