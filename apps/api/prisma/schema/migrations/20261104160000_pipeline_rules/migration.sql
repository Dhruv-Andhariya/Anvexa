-- Hiring pipeline rules (pipeline.prisma): per-job Stage 2 overall criterion and rejection-email switch, HR's GD
-- rubric per round, the personal-interview call log, and HR's rubric scores on GD evaluations.
-- Additive only: three new tables, two new enums, four nullable columns on gd_evaluations. Nothing existing is
-- changed or deleted (the orphan dsa_sessions table from a reverted branch is deliberately left alone).

-- CreateEnum
CREATE TYPE "pipeline_stage2_rule" AS ENUM ('ALL_ROUNDS_PASSED', 'TOTAL_PERCENT', 'BOTH');

-- CreateEnum
CREATE TYPE "pi_call_status" AS ENUM ('NOT_CALLED', 'CALLED', 'SCHEDULED', 'SELECTED', 'REJECTED');

-- AlterTable
ALTER TABLE "gd_evaluations" ADD COLUMN     "rubric_remarks" TEXT,
ADD COLUMN     "rubric_scored_at" TIMESTAMP(3),
ADD COLUMN     "rubric_scored_by_id" UUID,
ADD COLUMN     "rubric_scores" JSONB;

-- CreateTable
CREATE TABLE "job_pipeline_settings" (
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stage2_rule" "pipeline_stage2_rule" NOT NULL DEFAULT 'ALL_ROUNDS_PASSED',
    "stage2_min_percent" INTEGER,
    "rejection_emails" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_pipeline_settings_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "round_rubrics" (
    "round_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "parameters" JSONB NOT NULL,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_rubrics_pkey" PRIMARY KEY ("round_id")
);

-- CreateTable
CREATE TABLE "pi_calls" (
    "application_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "pi_call_status" NOT NULL DEFAULT 'NOT_CALLED',
    "notes" TEXT NOT NULL DEFAULT '',
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pi_calls_pkey" PRIMARY KEY ("application_id")
);

-- CreateIndex
CREATE INDEX "job_pipeline_settings_tenant_id_idx" ON "job_pipeline_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "round_rubrics_tenant_id_job_id_idx" ON "round_rubrics"("tenant_id", "job_id");

-- CreateIndex
CREATE INDEX "pi_calls_tenant_id_job_id_idx" ON "pi_calls"("tenant_id", "job_id");

-- AddForeignKey
ALTER TABLE "pi_calls" ADD CONSTRAINT "pi_calls_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
