import { z } from 'zod';

/** Every event in the system has this outer shape (doc section 10.4). Only `data` changes. */
export const eventEnvelope = <T extends z.ZodTypeAny>(type: string, data: T) =>
  z.object({
    id: z.string(),
    type: z.literal(type),
    version: z.number().int().positive(),
    tenant_id: z.string(),
    occurred_at: z.string().datetime(),
    correlation_id: z.string(),
    producer: z.string(),
    data,
  });
