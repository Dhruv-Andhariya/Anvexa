-- AI technical interview round (apps/api/src/modules/ai-interview). Additive only: new enums + five new tables, linked to
-- applications and job_rounds with ON DELETE CASCADE (a DPDP erase of the application removes its interview too).
-- No existing table or column is changed.

-- CreateEnum
CREATE TYPE "ai_interview_status" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "ai_interview_question_kind" AS ENUM ('INTRO', 'MAIN', 'FOLLOW_UP', 'CLARIFY', 'CLOSING');

-- CreateEnum
CREATE TYPE "ai_interview_source" AS ENUM ('INTRO', 'RESUME', 'JOB', 'SCENARIO', 'HR', 'FOLLOW_UP', 'CLOSING');

-- CreateEnum
CREATE TYPE "ai_interview_transcript_quality" AS ENUM ('CLEAR', 'PARTLY_UNCLEAR', 'UNCLEAR');

-- CreateEnum
CREATE TYPE "ai_interview_report_status" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ai_interview_decision" AS ENUM ('ADVANCE', 'REJECT');

-- CreateTable
CREATE TABLE "ai_interview_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "token_hash" TEXT,
    "expires_at" TIMESTAMP(3),
    "link_base" TEXT,
    "email_status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_interview_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interview_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "status" "ai_interview_status" NOT NULL DEFAULT 'NOT_STARTED',
    "consent_id" UUID,
    "consent_given_at" TIMESTAMP(3),
    "config" JSONB NOT NULL,
    "plan" JSONB,
    "pending_seq" INTEGER NOT NULL DEFAULT 1,
    "pending_kind" "ai_interview_question_kind" NOT NULL DEFAULT 'INTRO',
    "pending_source" "ai_interview_source" NOT NULL DEFAULT 'INTRO',
    "pending_text" TEXT NOT NULL DEFAULT '',
    "pending_topic_id" TEXT,
    "pending_topic" TEXT,
    "pending_resume_ref" TEXT,
    "pending_asked_at" TIMESTAMP(3),
    "pending_repeats" INTEGER NOT NULL DEFAULT 0,
    "follow_ups_on_topic" INTEGER NOT NULL DEFAULT 0,
    "covered_topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "started_at" TIMESTAMP(3),
    "paused_seconds" INTEGER NOT NULL DEFAULT 0,
    "paused_at" TIMESTAMP(3),
    "pause_reason" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "decision" "ai_interview_decision",
    "decision_reason" TEXT,
    "decided_by_id" UUID,
    "decided_by_name" TEXT,
    "decided_at" TIMESTAMP(3),
    "recorded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_interview_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interview_turns" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "ai_interview_question_kind" NOT NULL,
    "source" "ai_interview_source" NOT NULL,
    "topic_id" TEXT,
    "topic" TEXT,
    "resume_ref" TEXT,
    "question" TEXT NOT NULL,
    "raw_transcript" TEXT NOT NULL,
    "normalized_transcript" TEXT NOT NULL,
    "transcript_quality" "ai_interview_transcript_quality" NOT NULL,
    "unclear_terms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reading" TEXT,
    "asked_at" TIMESTAMP(3) NOT NULL,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "answer_seconds" DOUBLE PRECISION,
    "client_turn_id" TEXT NOT NULL,
    "model" TEXT,
    "prompt_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interview_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interview_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interview_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interview_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "status" "ai_interview_report_status" NOT NULL DEFAULT 'PENDING',
    "report" JSONB,
    "overall_score" INTEGER,
    "recommendation" TEXT,
    "last_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "prompt_version" TEXT,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_interview_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_invites_token_hash_key" ON "ai_interview_invites"("token_hash");

-- CreateIndex
CREATE INDEX "ai_interview_invites_email_status_next_attempt_at_idx" ON "ai_interview_invites"("email_status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ai_interview_invites_tenant_id_job_id_idx" ON "ai_interview_invites"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_invites_application_id_round_id_key" ON "ai_interview_invites"("application_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_sessions_invite_id_key" ON "ai_interview_sessions"("invite_id");

-- CreateIndex
CREATE INDEX "ai_interview_sessions_tenant_id_job_id_status_idx" ON "ai_interview_sessions"("tenant_id", "job_id", "status");

-- CreateIndex
CREATE INDEX "ai_interview_sessions_status_last_activity_at_idx" ON "ai_interview_sessions"("status", "last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_sessions_application_id_round_id_key" ON "ai_interview_sessions"("application_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_turns_session_id_seq_key" ON "ai_interview_turns"("session_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_turns_session_id_client_turn_id_key" ON "ai_interview_turns"("session_id", "client_turn_id");

-- CreateIndex
CREATE INDEX "ai_interview_events_session_id_occurred_at_idx" ON "ai_interview_events"("session_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_reports_session_id_key" ON "ai_interview_reports"("session_id");

-- CreateIndex
CREATE INDEX "ai_interview_reports_status_updated_at_idx" ON "ai_interview_reports"("status", "updated_at");

-- AddForeignKey
ALTER TABLE "ai_interview_invites" ADD CONSTRAINT "ai_interview_invites_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_invites" ADD CONSTRAINT "ai_interview_invites_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "ai_interview_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "ai_interview_sessions_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "ai_interview_invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "ai_interview_sessions_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_turns" ADD CONSTRAINT "ai_interview_turns_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_events" ADD CONSTRAINT "ai_interview_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_reports" ADD CONSTRAINT "ai_interview_reports_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

