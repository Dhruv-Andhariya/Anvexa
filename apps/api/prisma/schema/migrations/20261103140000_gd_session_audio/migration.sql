-- M18 GD: the whole session as one audio file for HR (group_discussion.prisma). Additive only: nullable columns, so
-- APIs on older code that share the database keep working. The file itself lives next to the recordings
-- (GD_STORAGE_DIR/<tenant>/<batch>/session.webm) and is removed with them by the retention job.

-- AlterTable
ALTER TABLE "gd_batches" ADD COLUMN "session_audio_at" TIMESTAMP(3),
ADD COLUMN "session_audio_ms" INTEGER,
ADD COLUMN "session_audio_bytes" INTEGER,
ADD COLUMN "session_audio_error" TEXT;
