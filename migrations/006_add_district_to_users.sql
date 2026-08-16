-- ============================================================
-- Migration 006: Add district column to users table
-- Run in Supabase SQL Editor
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS district VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_users_district ON users(district);
