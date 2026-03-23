-- Migration: 010_fix_report_jobs_uniqueness.sql
-- Description: Aligns report_jobs schema with the app's athlete_id upsert behavior.

WITH ranked_report_jobs AS (
    SELECT
        id,
        athlete_id,
        ROW_NUMBER() OVER (
            PARTITION BY athlete_id
            ORDER BY
                CASE status
                    WHEN 'ready' THEN 0
                    WHEN 'processing' THEN 1
                    WHEN 'pending' THEN 2
                    WHEN 'failed' THEN 3
                    ELSE 4
                END,
                CASE WHEN report_url IS NOT NULL THEN 0 ELSE 1 END,
                updated_at DESC NULLS LAST,
                created_at DESC NULLS LAST,
                id DESC
        ) AS row_rank
    FROM report_jobs
),
duplicates_to_delete AS (
    SELECT id
    FROM ranked_report_jobs
    WHERE row_rank > 1
)
DELETE FROM report_jobs
WHERE id IN (SELECT id FROM duplicates_to_delete);

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_jobs_athlete_unique ON report_jobs(athlete_id);
