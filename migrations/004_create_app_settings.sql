-- ============================================================
-- Migration 004: App-wide settings table
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL UNIQUE,   -- e.g. 'appearance'
  value         JSONB NOT NULL DEFAULT '{}',
  updated_by    INTEGER,                -- admin user id
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Disable RLS so the backend can read/write freely
ALTER TABLE app_settings DISABLE ROW LEVEL SECURITY;

-- Seed the default appearance settings row (idempotent)
INSERT INTO app_settings (key, value)
VALUES (
  'appearance',
  '{
    "fontFamily":   "Inter",
    "fontSize":     "16",
    "headingSize":  "24",
    "bodyColor":    "#1f2937",
    "headingColor": "#0f766e",
    "linkColor":    "#0d9488",
    "bgColor":      "#f0fdfa",
    "cardBg":       "#ffffff",
    "accentColor":  "#14b8a6",
    "borderRadius": "12",
    "applyTo": {"dashboard":true,"quizPage":true,"quizTaking":true,"quizHistory":true,"leaderboard":true,"rewards":true,"badges":true,"hangman":true,"spellingBee":true}
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;
