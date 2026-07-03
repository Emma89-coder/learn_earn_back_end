-- Create badges table
CREATE TABLE IF NOT EXISTS badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,
  icon_url VARCHAR(500),
  criteria TEXT,
  is_active BOOLEAN DEFAULT true,
  automation_enabled BOOLEAN DEFAULT false,
  automation_trigger VARCHAR(100),
  automation_condition VARCHAR(50),
  automation_threshold INTEGER DEFAULT 0,
  automation_points_reward INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create learner_badges junction table
CREATE TABLE IF NOT EXISTS learner_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(learner_id, badge_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_badges_is_active ON badges(is_active);
CREATE INDEX IF NOT EXISTS idx_badges_automation_enabled ON badges(automation_enabled);
CREATE INDEX IF NOT EXISTS idx_learner_badges_learner_id ON learner_badges(learner_id);
CREATE INDEX IF NOT EXISTS idx_learner_badges_badge_id ON learner_badges(badge_id);

-- Enable RLS (Row Level Security) if needed
ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_badges ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for badges
-- Allow authenticated admins to see all badges
CREATE POLICY "Admin can view all badges" ON badges
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can create badges" ON badges
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can update badges" ON badges
  FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Admin can delete badges" ON badges
  FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- Create RLS policies for learner_badges
-- Allow learners to see their own badges
CREATE POLICY "Learners can view their badges" ON learner_badges
  FOR SELECT
  USING (learner_id = auth.uid());

-- Allow admins to manage all learner badges
CREATE POLICY "Admin can manage all badges" ON learner_badges
  FOR ALL
  USING (auth.uid() IS NOT NULL);
