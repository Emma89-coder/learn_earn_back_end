-- ============================================================
-- Migration 005: Add voucher numbers and reward name to redemptions
-- Run in Supabase SQL Editor
-- ============================================================

-- Add voucher_number, reward_name, and collected columns
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS voucher_number VARCHAR(20);
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS reward_name TEXT;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS collected BOOLEAN DEFAULT false;
ALTER TABLE redemptions ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;

-- Index for quick voucher lookups
CREATE INDEX IF NOT EXISTS idx_redemptions_voucher ON redemptions (voucher_number);
CREATE INDEX IF NOT EXISTS idx_redemptions_user_id ON redemptions (user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_collected ON redemptions (collected);

-- Disable RLS so backend can read/write freely
ALTER TABLE redemptions DISABLE ROW LEVEL SECURITY;
