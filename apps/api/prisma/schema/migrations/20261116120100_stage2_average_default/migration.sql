-- New jobs' pipeline settings default to AVERAGE_OF_ROUNDS (DEFAULT_PIPELINE_SETTINGS in contracts; a job without a
-- settings row already uses it). Saved settings are unchanged.

-- AlterTable
ALTER TABLE "job_pipeline_settings" ALTER COLUMN "stage2_rule" SET DEFAULT 'AVERAGE_OF_ROUNDS';
