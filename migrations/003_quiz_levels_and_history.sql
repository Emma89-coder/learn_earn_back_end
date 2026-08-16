-- ============================================================
-- Migration 003: Quiz level progression (1-10), quiz attempt history,
--               and champion badge
-- Run this in your Supabase SQL Editor
-- ============================================================

-- 1. Add quiz_level (1-10) column to quizzes table
ALTER TABLE quizzes ADD COLUMN IF NOT EXISTS quiz_level INTEGER DEFAULT 1
  CHECK (quiz_level BETWEEN 1 AND 10);

-- 2. Add quiz_level tracking to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS quiz_level INTEGER DEFAULT 1
  CHECK (quiz_level BETWEEN 1 AND 10);

-- 3. quiz_attempts: full history of every quiz a learner takes
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id        INTEGER NOT NULL,
  quiz_title     TEXT,
  quiz_topic     TEXT,
  quiz_level     INTEGER DEFAULT 1,
  score          INTEGER DEFAULT 0,          -- percentage 0-100
  correct_count  INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  points_earned  INTEGER DEFAULT 0,
  passed         BOOLEAN DEFAULT false,
  answers        JSONB,
  attempted_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_id    ON quiz_attempts (user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz_id    ON quiz_attempts (quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_attempted  ON quiz_attempts (attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_level      ON quiz_attempts (quiz_level);

-- 4. Insert the Champion Badge (idempotent)
INSERT INTO badges (name, description, criteria, is_active, automation_enabled, automation_trigger, automation_condition, automation_threshold)
VALUES (
  'Quiz Champion',
  'Awarded for completing all 10 quiz levels. You are a true champion!',
  'Complete all 10 quiz levels by scoring 60% or above',
  true,
  true,
  'quiz_level_complete',
  'gte',
  10
)
ON CONFLICT (name) DO NOTHING;
