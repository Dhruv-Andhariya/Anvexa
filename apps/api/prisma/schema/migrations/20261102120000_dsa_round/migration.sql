-- DSA (coding) rounds run by the round engine (round_engine.prisma). Additive only: one nullable column and one new
-- table. Nothing existing is changed or rewritten.

-- AlterTable
ALTER TABLE "round_attempts" ADD COLUMN "coding_state" JSONB;

-- CreateTable
CREATE TABLE "dsa_proctor_sessions" (
    "invite_ref" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "session" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dsa_proctor_sessions_pkey" PRIMARY KEY ("invite_ref")
);

-- CreateIndex
CREATE INDEX "dsa_proctor_sessions_tenant_id_application_id_idx" ON "dsa_proctor_sessions"("tenant_id", "application_id");

-- AddForeignKey
ALTER TABLE "dsa_proctor_sessions" ADD CONSTRAINT "dsa_proctor_sessions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
