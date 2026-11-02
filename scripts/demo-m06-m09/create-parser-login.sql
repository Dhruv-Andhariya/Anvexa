-- For the resume-parser owner (M10). Run once per environment as a database admin.
-- Creates a LOGIN user that can only read the view parser_resume_inbox (via role hireflow_resume_reader).
-- Change the password, keep it in the parser's .env, never commit it.
--
--   docker exec -i hireflow-postgres-1 psql -U hire -d hireflow < scripts/demo-m06-m09/create-parser-login.sql
--
-- Parser connection string:  postgresql://hireflow_parser:<password>@localhost:5432/hireflow
-- Read new resumes (with an overlap: created_at is set at insert, the row appears at commit, up to ~30 s later):
--   SELECT * FROM parser_resume_inbox WHERE created_at > <last seen> - interval '2 minutes' ORDER BY created_at LIMIT 50;
--   The file: storage_key in the S3 bucket (parser needs read-only s3:GetObject), or content when storage_key is NULL.
--   and skip resume_ids you already processed.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireflow_parser') THEN
        CREATE ROLE hireflow_parser LOGIN PASSWORD 'change-me-local-only' IN ROLE hireflow_resume_reader;
    END IF;
END
$$;
