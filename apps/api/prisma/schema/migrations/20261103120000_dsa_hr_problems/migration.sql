-- DSA rounds with HR's own problems (rounds.prisma): the problem (format, constraints, test cases) is kept with the
-- coding question. Additive only: one nullable column. Nothing existing is changed or rewritten.

-- AlterTable
ALTER TABLE "round_questions" ADD COLUMN "coding_spec" JSONB;
