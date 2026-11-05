-- HR can skip a round for a whole job (rounds-config skip / unskip): students who pass the round before it go
-- straight to the next round that is not skipped. Additive only: three nullable columns on job_rounds.

-- AlterTable
ALTER TABLE "job_rounds" ADD COLUMN "skipped_at" TIMESTAMP(3),
ADD COLUMN "skipped_by_id" UUID,
ADD COLUMN "skip_reason" TEXT;
