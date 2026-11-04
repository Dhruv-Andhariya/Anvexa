-- AI interview protection: multiple-face episodes (counted in the candidate's browser; no image is stored or sent).
-- Additive: a new incident type, a new policy enum and one defaulted column on the per-round settings.
-- ALTER TYPE ... ADD VALUE is not used by anything else in this migration.

-- AlterEnum
ALTER TYPE "ai_interview_violation_type" ADD VALUE 'MULTIPLE_FACES';

-- CreateEnum
CREATE TYPE "ai_interview_face_policy" AS ENUM ('OFF', 'RECORD', 'WARN');

-- AlterTable
ALTER TABLE "ai_interview_protection_settings" ADD COLUMN "multiple_faces_policy" "ai_interview_face_policy" NOT NULL DEFAULT 'WARN';
