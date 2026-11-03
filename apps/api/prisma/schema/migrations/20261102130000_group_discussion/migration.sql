-- M18 AI group discussion (group_discussion.prisma). Additive only: three new tables, no change to existing ones.
-- Students reach a GD round's pool when they pass the round before it; HR schedules events that split the pool into
-- groups (batches), each with its own time slot, LiveKit room and topic.

-- CreateEnum
CREATE TYPE "gd_event_status" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "gd_batch_status" AS ENUM ('SCHEDULED', 'LOBBY_OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "gd_attendance" AS ENUM ('WAITING', 'SCHEDULED', 'INVITED', 'JOINED', 'ABSENT', 'ADMITTED_LATE');

-- CreateTable
CREATE TABLE "gd_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "status" "gd_event_status" NOT NULL DEFAULT 'SCHEDULED',
    "min_group_size" INTEGER NOT NULL,
    "max_group_size" INTEGER NOT NULL,
    "grace_minutes" INTEGER NOT NULL,
    "intro_seconds" INTEGER NOT NULL,
    "thinking_seconds" INTEGER NOT NULL,
    "discussion_minutes" INTEGER NOT NULL,
    "summary_seconds" INTEGER NOT NULL,
    "hr_questions_enabled" BOOLEAN NOT NULL,
    "hr_questions_minutes" INTEGER NOT NULL,
    "silence_prompt_seconds" INTEGER NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "undersized" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "gd_batch_status" NOT NULL DEFAULT 'SCHEDULED',
    "room_name" TEXT NOT NULL,
    "topic_question_id" UUID,
    "topic_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gd_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "batch_id" UUID,
    "attendance" "gd_attendance" NOT NULL DEFAULT 'WAITING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gd_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gd_events_tenant_id_round_id_idx" ON "gd_events"("tenant_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_events_id_tenant_id_key" ON "gd_events"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_batches_room_name_key" ON "gd_batches"("room_name");

-- CreateIndex
CREATE INDEX "gd_batches_status_starts_at_idx" ON "gd_batches"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "gd_batches_event_id_number_key" ON "gd_batches"("event_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "gd_batches_id_tenant_id_key" ON "gd_batches"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "gd_participants_tenant_id_round_id_attendance_idx" ON "gd_participants"("tenant_id", "round_id", "attendance");

-- CreateIndex
CREATE INDEX "gd_participants_batch_id_idx" ON "gd_participants"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "gd_participants_application_id_round_id_key" ON "gd_participants"("application_id", "round_id");

-- AddForeignKey
ALTER TABLE "gd_events" ADD CONSTRAINT "gd_events_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_batches" ADD CONSTRAINT "gd_batches_event_id_tenant_id_fkey" FOREIGN KEY ("event_id", "tenant_id") REFERENCES "gd_events"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_participants" ADD CONSTRAINT "gd_participants_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_participants" ADD CONSTRAINT "gd_participants_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gd_participants" ADD CONSTRAINT "gd_participants_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "gd_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Simple invariants the code relies on.
ALTER TABLE "gd_events" ADD CONSTRAINT "gd_events_group_size_check" CHECK ("min_group_size" >= 2 AND "min_group_size" <= "max_group_size");
ALTER TABLE "gd_batches" ADD CONSTRAINT "gd_batches_slot_check" CHECK ("ends_at" > "starts_at");
