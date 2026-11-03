-- SQL rounds (sql_bank.prisma, rounds.prisma): the company's SQL question bank, and the copy of a SQL question kept on
-- a round question. Additive only: one new table and one nullable column. Nothing existing is changed or rewritten.

-- CreateTable
CREATE TABLE "sql_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "difficulty" "round_question_difficulty" NOT NULL,
    "marks" INTEGER NOT NULL,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "problem" JSONB NOT NULL,
    "seed_key" TEXT,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sql_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sql_questions_tenant_id_active_idx" ON "sql_questions"("tenant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "sql_questions_tenant_id_seed_key_key" ON "sql_questions"("tenant_id", "seed_key");

-- AlterTable
ALTER TABLE "round_questions" ADD COLUMN "sql_spec" JSONB;
