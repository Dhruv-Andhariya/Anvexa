-- Stage 2 rule AVERAGE_OF_ROUNDS (pipeline.prisma): the technical rounds (DSA / SQL / GD) are judged together at the
-- end - a failed round no longer stops the student; the average of their percentages must reach the average of the
-- rounds' own pass marks. Additive: existing rows keep their rule. The column default changes in the next migration
-- (Postgres cannot use a new enum value in the transaction that added it).

-- AlterEnum
ALTER TYPE "pipeline_stage2_rule" ADD VALUE IF NOT EXISTS 'AVERAGE_OF_ROUNDS';
