-- MARKS pass rules may carry HR's own round total (pass_max_score, e.g. "25 of 60 marks"; the student's marks are
-- scaled to it). The API stores it since the rounds wiring change, but the check constraint still required NULL for
-- MARKS, so saving such a round failed with "Internal server error". NULL keeps meaning "the questions' own total".
ALTER TABLE "job_rounds" DROP CONSTRAINT "job_rounds_pass_rule_check";
ALTER TABLE "job_rounds" ADD CONSTRAINT "job_rounds_pass_rule_check" CHECK (
  ("pass_mode" IS NULL AND "pass_value" IS NULL AND "pass_max_score" IS NULL)
  OR ("pass_mode" = 'CORRECT_COUNT' AND "pass_value" >= 1 AND "pass_max_score" IS NULL)
  OR ("pass_mode" = 'MARKS' AND "pass_value" >= 1
      AND ("pass_max_score" IS NULL OR ("pass_max_score" >= 1 AND "pass_value" <= "pass_max_score")))
  OR ("pass_mode" = 'PERCENTAGE' AND "pass_value" BETWEEN 1 AND 100 AND "pass_max_score" IS NULL)
  OR ("pass_mode" = 'INTERVIEWER_SCORE' AND "pass_max_score" BETWEEN 1 AND 100 AND "pass_value" BETWEEN 1 AND "pass_max_score")
);
