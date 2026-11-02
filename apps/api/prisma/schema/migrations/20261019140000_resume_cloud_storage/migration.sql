-- Resume files move to cloud storage (S3): the database keeps only the record and the object key.
-- Rows without a storage_key still have their bytes in resume_files (local dev, or not yet moved by
-- `pnpm --filter api resumes:to-s3`).

-- AlterTable
ALTER TABLE "resumes" ADD COLUMN "storage_key" TEXT;

-- Parser feed: same columns as before plus storage_key (added at the end, so CREATE OR REPLACE keeps the grant).
-- content is NULL for files in S3: read them from the bucket with storage_key instead.
CREATE OR REPLACE VIEW "parser_resume_inbox" AS
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
    r."created_at"    AS "created_at",
    r."storage_key"   AS "storage_key"
FROM "resumes" r
JOIN "applications" a ON a."id" = r."application_id" AND a."tenant_id" = r."tenant_id"
LEFT JOIN "resume_files" f ON f."resume_id" = r."id" AND f."tenant_id" = r."tenant_id"
WHERE r."scan_status" = 'CLEAN';

COMMENT ON VIEW "parser_resume_inbox" IS
  'Read-only resume feed for the M10 parser. Poll with an overlap: WHERE created_at > (last seen created_at - interval ''2 minutes'') ORDER BY created_at, and skip resume_ids you already processed. Rows can appear with an older created_at than ones you already saw (created_at = insert time, visible at commit). The file: storage_key in the S3 bucket (S3_BUCKET), or content when storage_key is NULL.';
