-- Learn & Earn Database Restore Script
-- This script creates all necessary tables for the application

-- ============ USERS TABLE ============
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255),
  full_name VARCHAR(255),
  password_hash VARCHAR(255),
  role VARCHAR(50) NOT NULL DEFAULT 'learner',
  class_level VARCHAR(50),
  current_level VARCHAR(100),
  completed_levels TEXT,
  registration_number VARCHAR(255) UNIQUE,
  current_points INTEGER DEFAULT 0,
  lifetime_points INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============ REWARDS TABLE ============
CREATE TABLE IF NOT EXISTS rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  points_required INTEGER NOT NULL,
  stock_quantity INTEGER,
  image_url VARCHAR(500),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============ REDEMPTIONS TABLE ============
CREATE TABLE IF NOT EXISTS redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id UUID NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
  points_spent INTEGER NOT NULL,
  redeemed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'completed'
);

-- ============ BADGES TABLE ============
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

-- ============ LEARNER_BADGES TABLE ============
CREATE TABLE IF NOT EXISTS learner_badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  learner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(learner_id, badge_id)
);

-- ============ WORDS TABLE (for Hangman & Spelling Bee) ============
CREATE TABLE IF NOT EXISTS words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word VARCHAR(255) NOT NULL UNIQUE,
  word_type VARCHAR(50),
  difficulty VARCHAR(50),
  hint TEXT,
  points_reward INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============ SPELLING_WORDS TABLE (used by Spelling Bee) ============
CREATE TABLE IF NOT EXISTS spelling_words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word VARCHAR(255) NOT NULL UNIQUE,
  hint TEXT,
  example TEXT,
  difficulty VARCHAR(50) DEFAULT 'medium',
  level INTEGER DEFAULT 1,
  points INTEGER DEFAULT 10,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spelling_words_level ON spelling_words(level);
CREATE INDEX IF NOT EXISTS idx_spelling_words_difficulty ON spelling_words(difficulty);

-- ============ WORD_ATTEMPTS TABLE ============
CREATE TABLE IF NOT EXISTS word_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  word_id UUID NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  attempts INTEGER DEFAULT 0,
  guessed_correctly BOOLEAN DEFAULT false,
  points_earned INTEGER DEFAULT 0,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============ LEVEL_COMPLETION TABLE ============
CREATE TABLE IF NOT EXISTS level_completion (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level VARCHAR(100) NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  score_percentage INTEGER DEFAULT 0,
  UNIQUE(user_id, level)
);

-- ============ INDEXES FOR PERFORMANCE ============
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_rewards_is_active ON rewards(is_active);
CREATE INDEX IF NOT EXISTS idx_badges_is_active ON badges(is_active);
CREATE INDEX IF NOT EXISTS idx_badges_automation ON badges(automation_enabled);
CREATE INDEX IF NOT EXISTS idx_learner_badges_learner ON learner_badges(learner_id);
CREATE INDEX IF NOT EXISTS idx_learner_badges_badge ON learner_badges(badge_id);
CREATE INDEX IF NOT EXISTS idx_words_difficulty ON words(difficulty);
CREATE INDEX IF NOT EXISTS idx_words_is_active ON words(is_active);
CREATE INDEX IF NOT EXISTS idx_word_attempts_user ON word_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id);
CREATE INDEX IF NOT EXISTS idx_level_completion_user ON level_completion(user_id);

-- ============ SAMPLE DATA ============
-- Insert a sample admin user (username: admin, password will need to be hashed)
INSERT INTO users (username, email, full_name, role, created_at, updated_at)
VALUES ('admin', 'admin@learnearn.local', 'System Administrator', 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (username) DO NOTHING;

-- Insert sample learners
INSERT INTO users (username, email, full_name, role, class_level, registration_number, created_at, updated_at)
VALUES 
  ('learner1', 'learner1@example.com', 'John Doe', 'learner', 'Grade 5', 'REG001', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('learner2', 'learner2@example.com', 'Jane Smith', 'learner', 'Grade 6', 'REG002', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('learner3', 'learner3@example.com', 'Bob Wilson', 'learner', 'Grade 5', 'REG003', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('learner4', 'learner4@example.com', 'Alice Brown', 'learner', 'Grade 7', 'REG004', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('learner5', 'learner5@example.com', 'Charlie Davis', 'learner', 'Grade 6', 'REG005', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (username) DO NOTHING;

-- Insert sample rewards
INSERT INTO rewards (name, description, points_required, stock_quantity, is_active)
VALUES 
  ('Gold Certificate', 'Digital certificate for excellent performance', 500, 100, true),
  ('Book Voucher', 'Voucher for selecting any book', 300, 50, true),
  ('T-Shirt', 'Official Learn & Earn T-Shirt', 400, 25, true),
  ('Sticker Pack', 'Fun educational sticker pack', 100, 1000, true),
  ('Extra Practice Session', 'Extended time for practice', 200, 500, true)
ON CONFLICT DO NOTHING;

-- Insert sample words for games
INSERT INTO words (word, word_type, difficulty, hint, points_reward)
VALUES 
  ('ELEPHANT', 'Animal', 'Medium', 'Large animal with a trunk', 20),
  ('BUTTERFLY', 'Animal', 'Hard', 'Colorful insect with wings', 25),
  ('DICTIONARY', 'Object', 'Hard', 'Book of words and meanings', 30),
  ('KNOWLEDGE', 'Abstract', 'Hard', 'Information and understanding', 25),
  ('BEAUTIFUL', 'Adjective', 'Medium', 'Pleasing to look at', 20),
  ('ADVENTURE', 'Noun', 'Medium', 'An exciting or unusual experience', 20),
  ('TECHNOLOGY', 'Noun', 'Hard', 'Use of science for practical purposes', 30),
  ('EDUCATION', 'Noun', 'Medium', 'Process of learning and teaching', 20),
  ('IMAGINATION', 'Noun', 'Hard', 'Ability to form mental images', 25),
  ('CELEBRATION', 'Noun', 'Medium', 'Special event to commemorate', 20)
ON CONFLICT (word) DO NOTHING;

-- Insert sample badges
INSERT INTO badges (name, description, icon_url, criteria, is_active, automation_enabled)
VALUES 
  ('Quick Learner', 'Complete 5 quizzes', 'https://example.com/quick.png', 'Complete 5 quizzes in a day', true, false),
  ('Perfect Score', 'Get 100% on any quiz', 'https://example.com/perfect.png', 'Achieve perfect score on quiz', true, true),
  ('Spelling Master', 'Master spelling challenges', 'https://example.com/spell.png', 'Complete 10 spelling challenges', true, false),
  ('Game Champion', 'Win multiple games', 'https://example.com/champion.png', 'Win 5 hangman games', true, true),
  ('Knowledge Seeker', 'Earn 1000 points', 'https://example.com/seeker.png', 'Accumulate 1000 lifetime points', true, true)
ON CONFLICT (name) DO NOTHING;

-- ============ Enable Row Level Security (Optional) ============
-- ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE badges ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE learner_badges ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE rewards ENABLE ROW LEVEL SECURITY;

COMMIT;
