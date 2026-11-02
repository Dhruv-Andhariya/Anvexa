import { HttpException } from '@nestjs/common';
import { jdValidationSchema, type JdContent, type JobForm } from '@hireflow/contracts';

/** Same error body shape as modules/jobs: { statusCode, code, message, ...extra }. */
export function publisherError(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}

export interface JdCheck {
  errors: string[];
  warnings: string[];
}

/** Cheap checks that must pass before anything goes public. Mirrors the M03 rule checks plus publish-only rules. */
export function basicPublishProblems(form: JobForm, jd: JdContent, now = new Date()): string[] {
  const errors: string[] = [];
  if (!jd.title.trim()) errors.push('The JD has no job title.');
  if (!jd.summary.trim()) errors.push('The JD has no summary.');
  if (!jd.responsibilities.some((r) => r.trim())) errors.push('The JD needs at least one responsibility.');
  if (!jd.requirements.some((r) => r.trim())) errors.push('The JD needs at least one requirement.');
  if (form.deadline && new Date(form.deadline) <= now) errors.push('The last date to apply is already in the past.');
  return errors;
}

export interface JdValidatorOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export const jdValidatorOptionsFromEnv = (): JdValidatorOptions => ({
  baseUrl: process.env.AI_WORKER_URL || 'http://localhost:8000',
  timeoutMs: 15_000,
});

/**
 * Asks the M03 JD validator (AI worker POST /v1/jd/validate) for errors before publishing.
 * If the worker is down we do not block HR: basic checks still run and the preview shows a warning.
 */
export class JdValidatorClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: JdValidatorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async validate(jd: JdContent): Promise<JdCheck> {
    try {
      const res = await this.fetchImpl(new URL('/v1/jd/validate', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(jd),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const parsed = jdValidationSchema.safeParse(await res.json().catch(() => undefined));
      if (!res.ok || !parsed.success) return unreachable();
      return {
        errors: parsed.data.issues.filter((i) => i.severity === 'error').map((i) => i.message),
        warnings: parsed.data.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
      };
    } catch {
      return unreachable();
    }
  }
}

const unreachable = (): JdCheck => ({
  errors: [],
  warnings: ['The AI JD validator could not be reached, so only the basic checks ran.'],
});
