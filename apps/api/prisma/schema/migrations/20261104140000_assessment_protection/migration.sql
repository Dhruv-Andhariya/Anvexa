-- Online assessment protection (round engine): one warning counter per attempt, like the AI technical interview.
-- Additive only: a new attempt status value, new enums, defaulted / nullable columns on round_attempts and a new
-- incidents table (deleted with the attempt, so with the application). Attempts started before keep protection =
-- NULL and are not monitored. ALTER TYPE ... ADD VALUE is not used by anything else in this migration.

-- CreateEnum
CREATE TYPE "round_incident_type" AS ENUM ('TAB_SWITCH', 'WINDOW_BLUR', 'FULLSCREEN_EXIT', 'MULTIPLE_FACES');

-- CreateEnum
CREATE TYPE "round_incident_outcome" AS ENUM ('WARNING', 'TERMINATED', 'RECORDED', 'GROUPED');

-- CreateEnum
CREATE TYPE "round_integrity_status" AS ENUM ('NONE', 'INTEGRITY_VIOLATION_REVIEW', 'REVIEWED');

-- AlterEnum
ALTER TYPE "round_attempt_status" ADD VALUE 'TERMINATED';

-- AlterTable
ALTER TABLE "round_attempts" ADD COLUMN     "integrity_decided_at" TIMESTAMP(3),
ADD COLUMN     "integrity_decided_by" TEXT,
ADD COLUMN     "integrity_decision" TEXT,
ADD COLUMN     "integrity_reason" TEXT,
ADD COLUMN     "integrity_status" "round_integrity_status" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "protection" JSONB,
ADD COLUMN     "terminated_at" TIMESTAMP(3),
ADD COLUMN     "termination_reason" TEXT,
ADD COLUMN     "warning_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "round_protection_incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "type" "round_incident_type" NOT NULL,
    "outcome" "round_incident_outcome" NOT NULL,
    "warning_number" INTEGER,
    "incident_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "detail" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "round_protection_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "round_protection_incidents_attempt_id_occurred_at_idx" ON "round_protection_incidents"("attempt_id", "occurred_at");

-- CreateIndex
CREATE INDEX "round_protection_incidents_tenant_id_application_id_idx" ON "round_protection_incidents"("tenant_id", "application_id");

-- CreateIndex
CREATE UNIQUE INDEX "round_protection_incidents_attempt_id_incident_id_key" ON "round_protection_incidents"("attempt_id", "incident_id");

-- AddForeignKey
ALTER TABLE "round_protection_incidents" ADD CONSTRAINT "round_protection_incidents_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "round_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written guards (not expressible in Prisma):
ALTER TABLE "round_attempts" ADD CONSTRAINT "round_attempts_warning_count_check" CHECK ("warning_count" >= 0);
-- a warning number belongs to exactly one counted incident of an attempt
CREATE UNIQUE INDEX "round_protection_incidents_counted_warning_key" ON "round_protection_incidents"("attempt_id", "warning_number") WHERE "outcome" IN ('WARNING', 'TERMINATED');
