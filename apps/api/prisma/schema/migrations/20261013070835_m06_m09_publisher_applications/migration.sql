-- CreateEnum
CREATE TYPE "application_state" AS ENUM ('APPLIED');

-- CreateEnum
CREATE TYPE "score_type" AS ENUM ('CGPA', 'PERCENTAGE');

-- CreateEnum
CREATE TYPE "resume_scan_status" AS ENUM ('CLEAN');

-- CreateEnum
CREATE TYPE "publisher_job_listing_status" AS ENUM ('LIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "job_post_status" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'NOT_CONFIGURED');

-- CreateTable
CREATE TABLE "candidates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phone_verified_at" TIMESTAMP(3),
    "city" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "jd_snapshot_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'direct',
    "state" "application_state" NOT NULL DEFAULT 'APPLIED',
    "college" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "graduation_year" INTEGER NOT NULL,
    "score_type" "score_type" NOT NULL,
    "score_value" DECIMAL(5,2) NOT NULL,
    "linkedin_url" TEXT,
    "github_url" TEXT,
    "portfolio_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "scan_status" "resume_scan_status" NOT NULL,
    "scanned_by" TEXT NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_files" (
    "resume_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "resume_files_pkey" PRIMARY KEY ("resume_id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "candidate_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMP(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications_phone_otp_challenges" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_phone_otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_company_profiles" (
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "about" TEXT,
    "careers_page_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_company_profiles_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "publisher_job_listings" (
    "job_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "publisher_job_listing_status" NOT NULL DEFAULT 'LIVE',
    "current_snapshot_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_job_listings_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "publisher_approved_jd_snapshots" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "form" JSONB NOT NULL,
    "jd" JSONB NOT NULL,
    "selection_process" TEXT[],
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publisher_approved_jd_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_posts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "job_post_status" NOT NULL DEFAULT 'PENDING',
    "external_id" TEXT,
    "url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publisher_channel_settings" (
    "tenant_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publisher_channel_settings_pkey" PRIMARY KEY ("tenant_id","channel")
);

-- CreateIndex
CREATE INDEX "candidates_tenant_id_email_idx" ON "candidates"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenant_id_phone_key" ON "candidates"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "applications_tenant_id_job_id_created_at_idx" ON "applications"("tenant_id", "job_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenant_id_job_id_candidate_id_key" ON "applications"("tenant_id", "job_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "resumes_application_id_key" ON "resumes"("application_id");

-- CreateIndex
CREATE INDEX "resumes_tenant_id_created_at_idx" ON "resumes"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "consents_tenant_id_candidate_id_idx" ON "consents"("tenant_id", "candidate_id");

-- CreateIndex
CREATE INDEX "applications_phone_otp_challenges_tenant_id_phone_created_a_idx" ON "applications_phone_otp_challenges"("tenant_id", "phone", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_company_profiles_slug_key" ON "publisher_company_profiles"("slug");

-- CreateIndex
CREATE INDEX "publisher_job_listings_tenant_id_status_idx" ON "publisher_job_listings"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_job_listings_tenant_id_slug_key" ON "publisher_job_listings"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "publisher_approved_jd_snapshots_tenant_id_job_id_idx" ON "publisher_approved_jd_snapshots"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "publisher_approved_jd_snapshots_job_id_version_key" ON "publisher_approved_jd_snapshots"("job_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "job_posts_tenant_id_job_id_channel_key" ON "job_posts"("tenant_id", "job_id", "channel");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_files" ADD CONSTRAINT "resume_files_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resumes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================================
-- M09 -> M10 hand-off: read-only resume inbox for the resume parser.
-- The parser connects with a login that is a member of `hireflow_resume_reader`.
-- That role can SELECT this view and nothing else: no access to the underlying tables,
-- so it cannot insert, update or delete anything owned by the applications module.
-- Only virus-scanned (CLEAN) resumes ever reach these tables.
-- =====================================================================================
CREATE VIEW "parser_resume_inbox" AS
SELECT
    r."id"             AS "resume_id",
    r."tenant_id"      AS "tenant_id",
    a."id"             AS "application_id",
    a."job_id"         AS "job_id",
    a."jd_snapshot_id" AS "jd_snapshot_id",
    r."file_name"      AS "file_name",
    r."mime_type"      AS "mime_type",
    r."size_bytes"     AS "size_bytes",
    r."sha256"         AS "sha256",
    f."content"        AS "content",
    r."created_at"     AS "created_at"
FROM "resumes" r
JOIN "applications" a ON a."id" = r."application_id" AND a."tenant_id" = r."tenant_id"
JOIN "resume_files" f ON f."resume_id" = r."id" AND f."tenant_id" = r."tenant_id"
WHERE r."scan_status" = 'CLEAN';

COMMENT ON VIEW "parser_resume_inbox" IS
  'Read-only resume feed for the M10 parser. Order by created_at and remember the last one you processed.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireflow_resume_reader') THEN
        CREATE ROLE "hireflow_resume_reader" NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO "hireflow_resume_reader";
GRANT SELECT ON "parser_resume_inbox" TO "hireflow_resume_reader";
