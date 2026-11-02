-- Optional careers page link on the company profile. Additive: existing profiles get NULL.
-- AlterTable
ALTER TABLE "company_profiles" ADD COLUMN     "careers_url" TEXT;

