-- M07: encrypted OAuth tokens per company per channel (LinkedIn "Connect" button).

-- CreateTable
CREATE TABLE "channel_credentials" (
    "tenant_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMP(3),
    "refresh_token_expires_at" TIMESTAMP(3),
    "scopes" TEXT NOT NULL DEFAULT '',
    "connected_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_credentials_pkey" PRIMARY KEY ("tenant_id","channel")
);
