-- M06-M09: read the approved JD, company and audit log from Intern 1's core tables
-- (jd_versions + job_approvals, tenants + company_profiles, audit_logs) instead of the interim copies.

-- The parser view reads applications.jd_snapshot_id, which is replaced below. Re-created at the end.
DROP VIEW IF EXISTS "parser_resume_inbox";

-- Rows written by the interim tables point at snapshots that no longer exist (local demo / test data
-- only; nothing was ever live). Clear them so the new NOT NULL columns can be added. Children first.
DELETE FROM "resume_files";
DELETE FROM "resumes";
DELETE FROM "consents";
DELETE FROM "applications";
DELETE FROM "candidates";
DELETE FROM "applications_phone_otp_challenges";
DELETE FROM "job_posts";
DELETE FROM "publisher_job_listings";
DELETE FROM "publisher_channel_settings";

-- AlterTable
ALTER TABLE "applications" DROP COLUMN "jd_snapshot_id",
ADD COLUMN     "confirmation_email_sent_at" TIMESTAMP(3),
ADD COLUMN     "jd_version_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "job_posts" DROP COLUMN "snapshot_id",
ADD COLUMN     "jd_version_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "publisher_job_listings" DROP COLUMN "current_snapshot_id",
ADD COLUMN     "approval_id" UUID NOT NULL,
ADD COLUMN     "jd_version_id" UUID NOT NULL,
ADD COLUMN     "published_by" UUID,
ADD COLUMN     "selection_process" TEXT[];

-- DropTable
DROP TABLE "applications_audit_events";

-- DropTable
DROP TABLE "publisher_approved_jd_snapshots";

-- DropTable
DROP TABLE "publisher_audit_events";

-- DropTable
DROP TABLE "publisher_company_profiles";


-- Read-only resume feed for the M10 parser (same columns as before, jd_snapshot_id -> jd_version_id).
CREATE VIEW "parser_resume_inbox" AS
SELECT
    r."id"            AS "resume_id",
    r."tenant_id"     AS "tenant_id",
    a."id"            AS "application_id",
    a."job_id"        AS "job_id",
    a."jd_version_id" AS "jd_version_id",
    r."file_name"     AS "file_name",
    r."mime_type"     AS "mime_type",
    r."size_bytes"    AS "size_bytes",
    r."sha256"        AS "sha256",
    f."content"       AS "content",
    r."created_at"    AS "created_at"
FROM "resumes" r
JOIN "applications" a ON a."id" = r."application_id" AND a."tenant_id" = r."tenant_id"
JOIN "resume_files" f ON f."resume_id" = r."id" AND f."tenant_id" = r."tenant_id"
WHERE r."scan_status" = 'CLEAN';

COMMENT ON VIEW "parser_resume_inbox" IS
  'Read-only resume feed for the M10 parser. Order by created_at and remember the last one you processed.';

-- The role was created by 20261013070835; grants on a dropped view are lost, so grant again.
GRANT SELECT ON "parser_resume_inbox" TO "hireflow_resume_reader";
