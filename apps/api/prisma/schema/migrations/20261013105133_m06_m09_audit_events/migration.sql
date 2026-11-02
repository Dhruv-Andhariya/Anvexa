-- CreateTable
CREATE TABLE "applications_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publisher_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "applications_audit_events_tenant_id_at_idx" ON "applications_audit_events"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "publisher_audit_events_tenant_id_at_idx" ON "publisher_audit_events"("tenant_id", "at");
