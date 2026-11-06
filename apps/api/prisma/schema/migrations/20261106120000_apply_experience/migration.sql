-- Apply form "Experience" field + automatic rejection when it is below the job's minimum experience.
-- Both columns are nullable: older applications have no experience and are never auto-rejected by it,
-- and code that does not know the columns yet keeps working.

ALTER TABLE "applications" ADD COLUMN "experience_years" DECIMAL(4,1);
ALTER TABLE "applications" ADD CONSTRAINT "applications_experience_years_check"
  CHECK ("experience_years" IS NULL OR ("experience_years" >= 0 AND "experience_years" <= 50));

ALTER TABLE "ats_evaluations" ADD COLUMN "auto_rejection_reason" TEXT;
