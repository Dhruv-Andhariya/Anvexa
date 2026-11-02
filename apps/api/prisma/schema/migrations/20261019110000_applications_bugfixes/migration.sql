-- M09 fixes: dedupe by the email typed on each application (backed by a unique index), and the parser
-- polling guidance on parser_resume_inbox.

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "email" TEXT;

-- Backfill from the candidate (the best we have: candidates.email is the email of the LATEST application).
-- Where that would make two applications to the same job share an email, only the oldest one gets it; the
-- others stay NULL (NULLs never clash in a unique index).
WITH ranked AS (
    SELECT a."id",
           lower(c."email") AS "email",
           row_number() OVER (PARTITION BY a."tenant_id", a."job_id", lower(c."email") ORDER BY a."created_at", a."id") AS n
    FROM "applications" a
    JOIN "candidates" c ON c."id" = a."candidate_id" AND c."tenant_id" = a."tenant_id"
)
UPDATE "applications" a
SET "email" = ranked."email"
FROM ranked
WHERE ranked."id" = a."id" AND ranked.n = 1;

-- The API stores emails lower-case (applyFormSchema); the CHECK makes the unique index case-insensitive for
-- every writer, so "Asha@X.in" and "asha@x.in" can never both apply for one job.
ALTER TABLE "applications" ADD CONSTRAINT "applications_email_lower_case" CHECK ("email" = lower("email"));

-- CreateIndex
CREATE UNIQUE INDEX "applications_tenant_id_job_id_email_key" ON "applications"("tenant_id", "job_id", "email");

-- The view lists its columns explicitly, so the new column does not change it. Only the guidance changes:
-- created_at is set when the intake transaction STARTS, but a row becomes visible when it COMMITS (up to ~30 s
-- later under load), so "remember the last created_at" skips late commits.
COMMENT ON VIEW "parser_resume_inbox" IS
  'Read-only resume feed for the M10 parser. Poll with an overlap: WHERE created_at > (last seen created_at - interval ''2 minutes'') ORDER BY created_at, and skip resume_ids you already processed. Rows can appear with an older created_at than ones you already saw (created_at = insert time, visible at commit).';
