-- M12 AI screening round (apps/api/src/modules/screening). Additive only: new enums + three new tables, linked to
-- applications with ON DELETE CASCADE (a DPDP erase of the application removes its screening too). No existing table
-- or column is changed.

-- CreateEnum
CREATE TYPE "ai_screening_status" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ENDED_EARLY');

-- CreateEnum
CREATE TYPE "ai_screening_step" AS ENUM ('INTRO', 'EDUCATION', 'BACKGROUND', 'LOCATION', 'AVAILABILITY', 'CANDIDATE_QUESTIONS');

-- CreateEnum
CREATE TYPE "ai_screening_turn_kind" AS ENUM ('MAIN', 'FOLLOW_UP', 'CLOSING');

-- CreateEnum
CREATE TYPE "ai_screening_review_status" AS ENUM ('PENDING', 'REVIEWED', 'NEEDS_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "ai_screening_result_status" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "screening_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "ai_screening_status" NOT NULL DEFAULT 'NOT_STARTED',
    "consent_id" UUID,
    "consent_given_at" TIMESTAMP(3),
    "pending_seq" INTEGER NOT NULL DEFAULT 1,
    "pending_step" "ai_screening_step" NOT NULL DEFAULT 'INTRO',
    "pending_kind" "ai_screening_turn_kind" NOT NULL DEFAULT 'MAIN',
    "pending_text" TEXT NOT NULL DEFAULT '',
    "follow_ups_in_step" INTEGER NOT NULL DEFAULT 0,
    "candidate_questions" INTEGER NOT NULL DEFAULT 0,
    "steps_done" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "last_activity_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "review_status" "ai_screening_review_status" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screening_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_turns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "step" "ai_screening_step" NOT NULL,
    "kind" "ai_screening_turn_kind" NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "ai_reply" TEXT,
    "client_turn_id" TEXT NOT NULL,
    "answer_seconds" DOUBLE PRECISION,
    "model" TEXT,
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "status" "ai_screening_result_status" NOT NULL DEFAULT 'PENDING',
    "extraction" JSONB,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "screening_sessions_application_id_key" ON "screening_sessions"("application_id");

-- CreateIndex
CREATE INDEX "screening_sessions_tenant_id_job_id_status_idx" ON "screening_sessions"("tenant_id", "job_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "screening_turns_session_id_seq_key" ON "screening_turns"("session_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "screening_turns_session_id_client_turn_id_key" ON "screening_turns"("session_id", "client_turn_id");

-- CreateIndex
CREATE UNIQUE INDEX "screening_results_session_id_key" ON "screening_results"("session_id");

-- Sanity checks the code relies on.
ALTER TABLE "screening_sessions" ADD CONSTRAINT "screening_sessions_counters_check"
  CHECK ("pending_seq" >= 1 AND "steps_done" BETWEEN 0 AND 6 AND "follow_ups_in_step" >= 0 AND "candidate_questions" >= 0);
ALTER TABLE "screening_turns" ADD CONSTRAINT "screening_turns_seq_check" CHECK ("seq" >= 1);

-- AddForeignKey
ALTER TABLE "screening_sessions" ADD CONSTRAINT "screening_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_turns" ADD CONSTRAINT "screening_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "screening_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screening_results" ADD CONSTRAINT "screening_results_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "screening_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
