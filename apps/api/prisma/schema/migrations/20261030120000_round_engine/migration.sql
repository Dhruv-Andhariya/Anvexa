-- M13 round engine: online test rounds after the AI voice screening (round_engine.prisma). Additive only:
-- four new tables, no change to existing ones. Webcam video is never stored, only proctoring events.

-- CreateEnum
CREATE TYPE "round_attempt_status" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "proctor_event_type" AS ENUM ('ASSESSMENT_STARTED', 'ASSESSMENT_SUBMITTED', 'ASSESSMENT_TIMED_OUT', 'CAMERA_STARTED', 'CAMERA_STOPPED', 'CAMERA_PERMISSION_REVOKED', 'TAB_SWITCH', 'FULLSCREEN_EXIT', 'CONNECTION_LOST');

-- CreateEnum
CREATE TYPE "proctor_severity" AS ENUM ('INFO', 'WARNING');

-- CreateEnum
CREATE TYPE "round_outcome_email_kind" AS ENUM ('REJECTED', 'CLEARED_NEXT_BY_HR', 'CLEARED_ALL');

-- CreateTable
CREATE TABLE "round_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "token_hash" TEXT,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by_id" UUID,
    "email_status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "invite_id" UUID NOT NULL,
    "status" "round_attempt_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "consent_version" TEXT NOT NULL,
    "consent_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "deadline_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "answers" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "system_passed" BOOLEAN,
    "progressed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_proctor_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "type" "proctor_event_type" NOT NULL,
    "severity" "proctor_severity" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "round_proctor_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "round_outcome_emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "kind" "round_outcome_email_kind" NOT NULL,
    "next_round_name" TEXT,
    "status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "round_outcome_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "round_invites_token_hash_key" ON "round_invites"("token_hash");

-- CreateIndex
CREATE INDEX "round_invites_email_status_next_attempt_at_idx" ON "round_invites"("email_status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "round_invites_tenant_id_job_id_idx" ON "round_invites"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_invites_application_id_round_id_key" ON "round_invites"("application_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_attempts_invite_id_key" ON "round_attempts"("invite_id");

-- CreateIndex
CREATE INDEX "round_attempts_status_deadline_at_idx" ON "round_attempts"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "round_attempts_tenant_id_job_id_idx" ON "round_attempts"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_attempts_application_id_round_id_key" ON "round_attempts"("application_id", "round_id");

-- CreateIndex
CREATE INDEX "round_proctor_events_attempt_id_occurred_at_idx" ON "round_proctor_events"("attempt_id", "occurred_at");

-- CreateIndex
CREATE INDEX "round_proctor_events_tenant_id_idx" ON "round_proctor_events"("tenant_id");

-- CreateIndex
CREATE INDEX "round_outcome_emails_status_next_attempt_at_idx" ON "round_outcome_emails"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "round_outcome_emails_tenant_id_idx" ON "round_outcome_emails"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_outcome_emails_application_id_round_id_key" ON "round_outcome_emails"("application_id", "round_id");

-- AddForeignKey
ALTER TABLE "round_invites" ADD CONSTRAINT "round_invites_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_invites" ADD CONSTRAINT "round_invites_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "round_invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_proctor_events" ADD CONSTRAINT "round_proctor_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "round_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_outcome_emails" ADD CONSTRAINT "round_outcome_emails_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "round_outcome_emails" ADD CONSTRAINT "round_outcome_emails_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Simple invariants the code relies on.
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_revision_check" CHECK ("revision" >= 0);
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_deadline_check" CHECK ("deadline_at" IS NULL OR "deadline_at" > "started_at");
