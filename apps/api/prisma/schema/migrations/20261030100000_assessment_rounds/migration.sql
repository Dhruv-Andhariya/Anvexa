-- M05 assessment rounds (apps/api/src/modules/rounds-config) + their results (apps/api/src/modules/assessments).
-- Additive only: new enums + four new tables. Linked to jobs (job_id, tenant_id) and to applications with
-- ON DELETE CASCADE (deleting a job or erasing an application removes its rounds / results). No existing table or
-- column is changed. Nothing here is ever served by a public API.
-- CreateEnum
CREATE TYPE "rounds_config_status" AS ENUM ('DRAFT', 'COMPLETE');

-- CreateEnum
CREATE TYPE "round_type" AS ENUM ('APTITUDE', 'TECHNICAL_MCQ', 'CODING', 'SQL', 'COMMUNICATION', 'GROUP_DISCUSSION', 'TECHNICAL_INTERVIEW', 'HR_INTERVIEW', 'CUSTOM');

-- CreateEnum
CREATE TYPE "round_pass_mode" AS ENUM ('CORRECT_COUNT', 'PERCENTAGE', 'MARKS', 'INTERVIEWER_SCORE');

-- CreateEnum
CREATE TYPE "round_question_kind" AS ENUM ('MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'DESCRIPTIVE', 'CODING', 'INTERVIEW');

-- CreateEnum
CREATE TYPE "round_question_difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "round_question_source" AS ENUM ('HR', 'AI');

-- CreateTable
CREATE TABLE "job_round_configs" (
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "rounds_config_status" NOT NULL DEFAULT 'DRAFT',
    "locked_at" TIMESTAMP(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_round_configs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "job_rounds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "round_type" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "time_limit_minutes" INTEGER,
    "pass_mode" "round_pass_mode",
    "pass_value" INTEGER,
    "pass_max_score" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "round_question_kind" NOT NULL,
    "text" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "correct" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "model_answer" TEXT,
    "language" TEXT,
    "marks" INTEGER NOT NULL DEFAULT 1,
    "difficulty" "round_question_difficulty",
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" "round_question_source" NOT NULL DEFAULT 'HR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "correct_count" INTEGER,
    "marks" DOUBLE PRECISION,
    "interviewer_score" DOUBLE PRECISION,
    "pass_mode" "round_pass_mode" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "max_score" DOUBLE PRECISION NOT NULL,
    "pass_mark" INTEGER NOT NULL,
    "system_passed" BOOLEAN NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "override_passed" BOOLEAN,
    "override_reason" TEXT,
    "overridden_by_id" UUID,
    "overridden_by_name" TEXT,
    "overridden_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_round_configs_tenant_id_idx" ON "job_round_configs"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_round_configs_job_id_tenant_id_key" ON "job_round_configs"("job_id", "tenant_id");

-- CreateIndex
CREATE INDEX "job_rounds_tenant_id_job_id_idx" ON "job_rounds"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_rounds_job_id_position_key" ON "job_rounds"("job_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "job_rounds_id_tenant_id_key" ON "job_rounds"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "round_questions_tenant_id_idx" ON "round_questions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_questions_round_id_position_key" ON "round_questions"("round_id", "position");

-- CreateIndex
CREATE INDEX "round_results_tenant_id_job_id_idx" ON "round_results"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_results_application_id_round_id_key" ON "round_results"("application_id", "round_id");

-- AddForeignKey
ALTER TABLE "job_round_configs" ADD CONSTRAINT "job_round_configs_job_id_tenant_id_fkey" FOREIGN KEY ("job_id", "tenant_id") REFERENCES "jobs"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_job_id_tenant_id_fkey" FOREIGN KEY ("job_id", "tenant_id") REFERENCES "job_round_configs"("job_id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_questions" ADD CONSTRAINT "round_questions_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Pass marks can never be impossible. "Not more than the questions / total marks" needs the questions too, so the
-- API checks that inside the same transaction; these keep every single row sane on its own.
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_position_check" CHECK ("position" >= 1);
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_time_limit_check" CHECK ("time_limit_minutes" IS NULL OR "time_limit_minutes" BETWEEN 1 AND 600);
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_pass_rule_check" CHECK (
  ("pass_mode" IS NULL AND "pass_value" IS NULL AND "pass_max_score" IS NULL)
  OR ("pass_mode" IN ('CORRECT_COUNT', 'MARKS') AND "pass_value" >= 1 AND "pass_max_score" IS NULL)
  OR ("pass_mode" = 'PERCENTAGE' AND "pass_value" BETWEEN 1 AND 100 AND "pass_max_score" IS NULL)
  OR ("pass_mode" = 'INTERVIEWER_SCORE' AND "pass_max_score" BETWEEN 1 AND 100 AND "pass_value" BETWEEN 1 AND "pass_max_score")
);
ALTER TABLE "round_questions" ADD CONSTRAINT "round_questions_marks_check" CHECK ("marks" BETWEEN 1 AND 100);
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_pass_mark_check" CHECK ("pass_mark" >= 1 AND "pass_mark" <= "max_score");
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_score_check" CHECK ("score" >= 0 AND "score" <= "max_score");
ALTER TABLE "round_results" ADD CONSTRAINT "round_results_override_check" CHECK ("override_passed" IS NULL OR "override_reason" IS NOT NULL);
