-- ============================================================
-- Migration 008: Add categories to district questions
-- Run in Supabase SQL Editor
-- ============================================================

ALTER TABLE district_questions
ADD COLUMN IF NOT EXISTS category VARCHAR(64);

UPDATE district_questions
SET category = CASE
  WHEN question ILIKE '%capital%' OR question ILIKE '%commercial capital%' OR question ILIKE '%town%' OR question ILIKE '%boma%'
    THEN 'capitals-major-towns'
  WHEN question ILIKE '%border%' OR question ILIKE '%borders%' OR question ILIKE '%crossing%' OR question ILIKE '%entry point%'
    THEN 'borders-neighbors'
  WHEN question ILIKE '%mount%' OR question ILIKE '%plateau%' OR question ILIKE '%lake%' OR question ILIKE '%island%' OR question ILIKE '%plain%'
    THEN 'physical-features'
  WHEN question ILIKE '%national park%' OR question ILIKE '%wildlife reserve%' OR question ILIKE '%reserve%'
    THEN 'parks-wildlife'
  WHEN question ILIKE '%farming%' OR question ILIKE '%tea%' OR question ILIKE '%tobacco%' OR question ILIKE '%rice%'
    THEN 'economic-activities'
  WHEN question ILIKE '%road%' OR question ILIKE '%turn-off%' OR question ILIKE '%crossing%'
    THEN 'transport-border-posts'
  WHEN question ILIKE '%museum%' OR question ILIKE '%old capital%' OR question ILIKE '%pottery%'
    THEN 'history-culture'
  WHEN question ILIKE '%northern region%' OR question ILIKE '%southern region%' OR question ILIKE '%central region%'
    THEN 'region-classification'
  ELSE 'physical-features'
END
WHERE category IS NULL;

ALTER TABLE district_questions
ALTER COLUMN category SET DEFAULT 'physical-features';

UPDATE district_questions
SET category = 'physical-features'
WHERE category IS NULL;

ALTER TABLE district_questions
ALTER COLUMN category SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_district_questions_category
  ON district_questions (category);

CREATE INDEX IF NOT EXISTS idx_district_questions_active_category
  ON district_questions (is_active, category);
