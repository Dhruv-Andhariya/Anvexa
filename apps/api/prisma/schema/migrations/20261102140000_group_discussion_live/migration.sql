-- M18 AI group discussion, phases 2-7 (group_discussion.prisma). Additive only: new columns on gd_batches /
-- gd_participants (all nullable or with defaults) and new tables for recordings, client events, private talks, HR
-- activity, transcripts, evaluations and emails. Audio itself is stored as files (GD_STORAGE_DIR), never here.

-- CreateEnum
CREATE TYPE "gd_phase" AS ENUM ('NOT_STARTED', 'INTRO', 'THINKING', 'DISCUSSION', 'SUMMARY', 'HR_QUESTIONS', 'CLOSE', 'ENDED');

-- CreateEnum
CREATE TYPE "gd_processing_status" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "gd_speaker" AS ENUM ('STUDENT', 'HR');

-- CreateEnum
CREATE TYPE "gd_client_event_type" AS ENUM ('JOINED', 'LEFT', 'CAMERA_OFF', 'CAMERA_ON', 'MIC_OFF', 'MIC_ON', 'HAND_RAISED', 'HAND_LOWERED', 'TAB_HIDDEN');

-- CreateEnum
CREATE TYPE "gd_hr_activity_kind" AS ENUM ('JOINED', 'SPEAK_START', 'SPEAK_END', 'TIMER_PAUSED', 'TIMER_RESUMED', 'PRIVATE_START', 'PRIVATE_END', 'PRIVATE_INCLUDED', 'PRIVATE_EXCLUDED', 'ADMITTED_LATE', 'RESCHEDULED', 'OVERRIDE', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "gd_recommendation" AS ENUM ('SELECTED', 'NOT_SELECTED');

-- CreateEnum
CREATE TYPE "gd_evaluation_status" AS ENUM ('OK', 'NO_AUDIO', 'FAILED');

-- CreateEnum
CREATE TYPE "gd_email_kind" AS ENUM ('INVITE', 'REMINDER', 'HR_LINK', 'SELECTED', 'NOT_SELECTED');

-- AlterTable
ALTER TABLE "gd_batches" ADD COLUMN     "agent_dispatched_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_by_id" UUID,
ADD COLUMN     "ended_at" TIMESTAMP(3),
ADD COLUMN     "hr_speaking" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lobby_opened_at" TIMESTAMP(3),
ADD COLUMN     "locked_at" TIMESTAMP(3),
ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "paused_intervals" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "phase" "gd_phase" NOT NULL DEFAULT 'NOT_STARTED',
ADD COLUMN     "phase_ends_at" TIMESTAMP(3),
ADD COLUMN     "phase_log" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "phase_started_at" TIMESTAMP(3),
ADD COLUMN     "processed_at" TIMESTAMP(3),
ADD COLUMN     "processing_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "processing_error" TEXT,
ADD COLUMN     "processing_locked_at" TIMESTAMP(3),
ADD COLUMN     "processing_next_at" TIMESTAMP(3),
ADD COLUMN     "processing_status" "gd_processing_status",
ADD COLUMN     "summary_index" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "summary_order" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "gd_participants" ADD COLUMN     "admitted_by_id" UUID,
ADD COLUMN     "admitted_late_at" TIMESTAMP(3),
ADD COLUMN     "consent_at" TIMESTAMP(3),
ADD COLUMN     "consent_version" TEXT,
ADD COLUMN     "joined_at" TIMESTAMP(3),
ADD COLUMN     "last_seen_at" TIMESTAMP(3),
ADD COLUMN     "token_expires_at" TIMESTAMP(3),
ADD COLUMN     "token_hash" TEXT,
ADD COLUMN     "token_sealed" TEXT;

-- CreateTable
CREATE TABLE "gd_recordings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "participant_id" UUID,
    "hr_user_id" UUID,
    "speaker" "gd_speaker" NOT NULL,
    "mime_type" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "last_chunk_at" TIMESTAMP(3),
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "storage_prefix" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gd_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_participant_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "type" "gd_client_event_type" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_participant_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_private_talks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "hr_user_id" UUID,
    "room_name" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "include_in_evaluation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gd_private_talks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_hr_activity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "hr_user_id" UUID,
    "hr_name" TEXT,
    "kind" "gd_hr_activity_kind" NOT NULL,
    "participant_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "gd_hr_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_transcripts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "recording_id" UUID NOT NULL,
    "participant_id" UUID,
    "speaker" "gd_speaker" NOT NULL,
    "segments" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gd_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_evaluations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "status" "gd_evaluation_status" NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "scores" JSONB,
    "overall" DOUBLE PRECISION,
    "recommendation" "gd_recommendation",
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "feedback" TEXT NOT NULL DEFAULT '',
    "model" TEXT,
    "error" TEXT,
    "hr_decision" "gd_recommendation",
    "hr_decision_reason" TEXT,
    "hr_decided_by_id" UUID,
    "hr_decided_by_name" TEXT,
    "hr_decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "participant_id" UUID,
    "kind" "gd_email_kind" NOT NULL,
    "to_email" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gd_recordings_tenant_id_batch_id_idx" ON "gd_recordings"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "gd_participant_events_batch_id_occurred_at_idx" ON "gd_participant_events"("batch_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "gd_private_talks_room_name_key" ON "gd_private_talks"("room_name");

-- CreateIndex
CREATE INDEX "gd_private_talks_batch_id_idx" ON "gd_private_talks"("batch_id");

-- CreateIndex
CREATE INDEX "gd_hr_activity_batch_id_occurred_at_idx" ON "gd_hr_activity"("batch_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "gd_transcripts_recording_id_key" ON "gd_transcripts"("recording_id");

-- CreateIndex
CREATE INDEX "gd_transcripts_batch_id_idx" ON "gd_transcripts"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_evaluations_participant_id_key" ON "gd_evaluations"("participant_id");

-- CreateIndex
CREATE INDEX "gd_evaluations_batch_id_idx" ON "gd_evaluations"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_emails_dedupe_key_key" ON "gd_emails"("dedupe_key");

-- CreateIndex
CREATE INDEX "gd_emails_status_next_attempt_at_idx" ON "gd_emails"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "gd_emails_batch_id_idx" ON "gd_emails"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_participants_token_hash_key" ON "gd_participants"("token_hash");

-- AddForeignKey
ALTER TABLE "gd_recordings" ADD CONSTRAINT "gd_recordings_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_recordings" ADD CONSTRAINT "gd_recordings_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_participant_events" ADD CONSTRAINT "gd_participant_events_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_participant_events" ADD CONSTRAINT "gd_participant_events_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_private_talks" ADD CONSTRAINT "gd_private_talks_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_private_talks" ADD CONSTRAINT "gd_private_talks_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_hr_activity" ADD CONSTRAINT "gd_hr_activity_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_transcripts" ADD CONSTRAINT "gd_transcripts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_transcripts" ADD CONSTRAINT "gd_transcripts_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "gd_recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_transcripts" ADD CONSTRAINT "gd_transcripts_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_evaluations" ADD CONSTRAINT "gd_evaluations_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_evaluations" ADD CONSTRAINT "gd_evaluations_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_emails" ADD CONSTRAINT "gd_emails_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_emails" ADD CONSTRAINT "gd_emails_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "gd_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Simple invariants the code relies on.
ALTER TABLE "gd_batches" ADD CONSTRAINT "gd_batches_summary_index_check" CHECK ("summary_index" >= 0);
ALTER TABLE "gd_recordings" ADD CONSTRAINT "gd_recordings_speaker_check" CHECK (("speaker" = 'STUDENT') = ("participant_id" IS NOT NULL));
