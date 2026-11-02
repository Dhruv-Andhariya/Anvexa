import { z } from 'zod';

/** Input limits shared by the profile form, the API and the AI worker (mirrored in ai_worker/schemas.py). */
export const COMPANY_PROFILE_LIMITS = {
  nameMax: 120,
  industryMax: 100,
  descriptionMin: 30,
  descriptionMax: 3000,
  productsMax: 2000,
  websiteMax: 200,
  headquartersMax: 120,
  cultureMax: 1500,
  benefitMax: 120,
  benefitsMax: 15,
} as const;

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'] as const;

const L = COMPANY_PROFILE_LIMITS;
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalHttpUrl = (label: string) =>
  z
    .string()
    .trim()
    .max(L.websiteMax)
    .url()
    .refine((v) => /^https?:\/\//i.test(v), `${label} must start with http:// or https://`)
    .optional();

/** Step 1: the company profile HR saves once. Every JD generation receives it as a second input. */
export const companyProfileSchema = z.object({
  name: z.string().trim().min(2).max(L.nameMax),
  industry: z.string().trim().min(2).max(L.industryMax),
  description: z.string().trim().min(L.descriptionMin).max(L.descriptionMax),
  productsServices: optionalText(L.productsMax),
  website: optionalHttpUrl('Website'),
  /** Careers page where candidates can see all openings. Shown to HR; not sent to the AI. */
  careersUrl: optionalHttpUrl('Careers page link'),
  headquarters: optionalText(L.headquartersMax),
  companySize: z.enum(COMPANY_SIZES).optional(),
  foundedYear: z.number().int().min(1800).max(2100).optional(),
  culture: optionalText(L.cultureMax),
  benefits: z.array(z.string().trim().min(1).max(L.benefitMax)).max(L.benefitsMax).default([]),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

/** What the API returns for the saved profile. */
export const companyProfileRecordSchema = companyProfileSchema.extend({
  id: z.string(),
  updatedAt: z.string(),
});
export type CompanyProfileRecord = z.infer<typeof companyProfileRecordSchema>;
