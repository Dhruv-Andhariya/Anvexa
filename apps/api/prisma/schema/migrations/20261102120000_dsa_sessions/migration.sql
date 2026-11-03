-- Coding rounds on the DSA page: the attempt state the DSA page keeps (additive: 1 new table).
CREATE TABLE "dsa_sessions" (
    "invite_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dsa_sessions_pkey" PRIMARY KEY ("invite_id")
);

CREATE INDEX "dsa_sessions_tenant_id_idx" ON "dsa_sessions"("tenant_id");

ALTER TABLE "dsa_sessions" ADD CONSTRAINT "dsa_sessions_invite_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "round_invites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
