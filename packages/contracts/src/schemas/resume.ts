import { z } from 'zod';

/** M10 output */
export const parsedProfileSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), year: z.number().optional() })),
  skills: z.array(z.string()),
  projects: z.array(z.object({ title: z.string(), description: z.string() })),
  experience: z.array(z.object({ company: z.string(), role: z.string(), months: z.number() })),
});
export type ParsedProfile = z.infer<typeof parsedProfileSchema>;

/** M11 output. Design principle #2: no score without reasons. */
export const atsScoreSchema = z.object({
  application_id: z.string(),
  score: z.number().int().min(0).max(100),
  parts: z.object({ skills: z.number(), experience: z.number(), education: z.number(), projects: z.number() }),
  reasons: z.array(z.string()).min(1),
  model: z.string(),
  prompt_version: z.string(),
});
export type AtsScore = z.infer<typeof atsScoreSchema>;
