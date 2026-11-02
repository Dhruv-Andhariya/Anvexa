-- CreateEnum
CREATE TYPE "ats_status" AS ENUM ('PENDING', 'PROCESSING', 'SCORED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "screening_decision" AS ENUM ('SHORTLISTED', 'NOT_SHORTLISTED');

-- CreateEnum
CREATE TYPE "candidate_email_kind" AS ENUM ('SHORTLIST', 'REJECTION');

-- CreateEnum
CREATE TYPE "email_delivery_status" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "job_screening_settings" (
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "min_ats_score" INTEGER NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_screening_settings_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "ats_evaluations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "jd_version_id" UUID NOT NULL,
    "status" "ats_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "parsed_profile" JSONB,
    "score" INTEGER,
    "breakdown" JSONB,
    "matched_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missing_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_ats_score" INTEGER,
    "system_decision" "screening_decision",
    "hr_decision" "screening_decision",
    "hr_decided_by_id" UUID,
    "hr_decided_at" TIMESTAMP(3),
    "model" TEXT,
    "prompt_version" TEXT,
    "scored_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ats_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "kind" "candidate_email_kind" NOT NULL,
    "status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "requested_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_screening_settings_tenant_id_idx" ON "job_screening_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_screening_settings_job_id_tenant_id_key" ON "job_screening_settings"("job_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "ats_evaluations_application_id_key" ON "ats_evaluations"("application_id");

-- CreateIndex
CREATE INDEX "ats_evaluations_status_next_attempt_at_idx" ON "ats_evaluations"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ats_evaluations_tenant_id_job_id_status_idx" ON "ats_evaluations"("tenant_id", "job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_emails_application_id_key" ON "candidate_emails"("application_id");

-- CreateIndex
CREATE INDEX "candidate_emails_status_next_attempt_at_idx" ON "candidate_emails"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "candidate_emails_tenant_id_idx" ON "candidate_emails"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "screening_invites_application_id_key" ON "screening_invites"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "screening_invites_token_hash_key" ON "screening_invites"("token_hash");

-- CreateIndex
CREATE INDEX "screening_invites_tenant_id_idx" ON "screening_invites"("tenant_id");

-- AddForeignKey
ALTER TABLE "job_screening_settings" ADD CONSTRAINT "job_screening_settings_job_id_tenant_id_fkey" FOREIGN KEY ("job_id", "tenant_id") REFERENCES "jobs"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_emails" ADD CONSTRAINT "candidate_emails_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_invites" ADD CONSTRAINT "screening_invites_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Scores are always 0-100 (the API checks too; the database is the last line).
ALTER TABLE "job_screening_settings" ADD CONSTRAINT "job_screening_settings_min_ats_score_check" CHECK ("min_ats_score" BETWEEN 0 AND 100);
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_score_check" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100);
ALTER TABLE "ats_evaluations" ADD CONSTRAINT "ats_evaluations_min_ats_score_check" CHECK ("min_ats_score" IS NULL OR "min_ats_score" BETWEEN 0 AND 100);
