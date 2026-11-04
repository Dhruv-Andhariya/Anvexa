-- AI technical interview protection (apps/api/src/modules/ai-interview/protection*). Additive only: new enums, a new
-- status value, five new nullable / defaulted columns on ai_interview_sessions and two new tables, all deleted with
-- the interview / round (ON DELETE CASCADE, so a DPDP erase of the application removes them too).
-- Existing interviews keep protection = NULL: they were opened without the warning policy, so nothing is monitored.
-- ALTER TYPE ... ADD VALUE is not used by anything else in this migration (PostgreSQL forbids that in one transaction).

-- CreateEnum
CREATE TYPE "ai_interview_violation_type" AS ENUM ('TAB_SWITCH', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'CAMERA_LOST', 'MIC_LOST');

-- CreateEnum
CREATE TYPE "ai_interview_violation_outcome" AS ENUM ('WARNING', 'TERMINATED', 'RECORDED', 'GROUPED');

-- CreateEnum
CREATE TYPE "ai_interview_integrity_status" AS ENUM ('NONE', 'INTEGRITY_VIOLATION_REVIEW', 'REVIEWED');

-- CreateEnum
CREATE TYPE "ai_interview_device_policy" AS ENUM ('RECOVER', 'WARN');

-- AlterEnum
ALTER TYPE "ai_interview_status" ADD VALUE 'TERMINATED';

-- AlterTable
ALTER TABLE "ai_interview_sessions" ADD COLUMN     "integrity_status" "ai_interview_integrity_status" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "protection" JSONB,
ADD COLUMN     "terminated_at" TIMESTAMP(3),
ADD COLUMN     "termination_reason" TEXT,
ADD COLUMN     "warning_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ai_interview_violations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "type" "ai_interview_violation_type" NOT NULL,
    "outcome" "ai_interview_violation_outcome" NOT NULL,
    "warning_number" INTEGER,
    "incident_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "detail" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interview_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interview_protection_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "max_warnings" INTEGER NOT NULL DEFAULT 2,
    "tab_switch_monitoring" BOOLEAN NOT NULL DEFAULT true,
    "fullscreen_required" BOOLEAN NOT NULL DEFAULT true,
    "camera_policy" "ai_interview_device_policy" NOT NULL DEFAULT 'RECOVER',
    "microphone_policy" "ai_interview_device_policy" NOT NULL DEFAULT 'RECOVER',
    "updated_by_id" UUID,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_interview_protection_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_interview_violations_session_id_occurred_at_idx" ON "ai_interview_violations"("session_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ai_interview_violations_tenant_id_application_id_idx" ON "ai_interview_violations"("tenant_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_violations_session_id_incident_id_key" ON "ai_interview_violations"("session_id", "incident_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_interview_protection_settings_round_id_tenant_id_key" ON "ai_interview_protection_settings"("round_id", "tenant_id");

-- CreateIndex
CREATE INDEX "ai_interview_sessions_tenant_id_integrity_status_idx" ON "ai_interview_sessions"("tenant_id", "integrity_status");

-- AddForeignKey
ALTER TABLE "ai_interview_violations" ADD CONSTRAINT "ai_interview_violations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interview_protection_settings" ADD CONSTRAINT "ai_interview_protection_settings_round_id_tenant_id_fkey" FOREIGN KEY ("round_id", "tenant_id") REFERENCES "job_rounds"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written guards (not expressible in Prisma):
-- the warning counter never goes below zero
ALTER TABLE "ai_interview_sessions" ADD CONSTRAINT "ai_interview_sessions_warning_count_check" CHECK ("warning_count" >= 0);
-- a warning number is given to exactly one counted incident of an interview (a second concurrent writer fails)
CREATE UNIQUE INDEX "ai_interview_violations_session_counted_warning_key" ON "ai_interview_violations"("session_id", "warning_number") WHERE "outcome" IN ('WARNING', 'TERMINATED');
-- settings stay inside the limits the API enforces
ALTER TABLE "ai_interview_protection_settings" ADD CONSTRAINT "ai_interview_protection_settings_max_warnings_check" CHECK ("max_warnings" BETWEEN 1 AND 5);
