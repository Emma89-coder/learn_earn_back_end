-- ============================================================
-- Migration 007: District questions table (admin can add/edit/delete)
-- Run in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS district_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  correct_answer VARCHAR(100) NOT NULL,
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE district_questions DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_district_questions_active ON district_questions (is_active);

-- Seed some default questions
INSERT INTO district_questions (question, correct_answer) VALUES
('Which district is the capital city of Malawi located in?', 'Lilongwe'),
('Which district is home to Mount Mulanje, the highest peak in Malawi?', 'Mulanje'),
('Which district is the commercial capital of Malawi?', 'Blantyre'),
('Which district contains the southern tip of Lake Malawi?', 'Mangochi'),
('Which district is known for Liwonde National Park?', 'Machinga'),
('Which district borders Mozambique to the south and has the lowest elevation?', 'Nsanje'),
('Which district is home to Nkhata Bay, a popular lakeside town?', 'Nkhata Bay'),
('Which district is famous for tea estates?', 'Thyolo'),
('Which district is in the far north bordering Tanzania?', 'Chitipa'),
('Which district is home to Zomba Plateau?', 'Zomba'),
('Which district is known for Kasungu National Park?', 'Kasungu'),
('Which district contains Likoma Island in Lake Malawi?', 'Likoma'),
('Which district is the largest by area in the Northern Region?', 'Mzimba'),
('Which district is home to Dedza Pottery?', 'Dedza'),
('Which district borders Zambia and is known for tobacco farming?', 'Mchinji'),
('Which district is known for Lengwe National Park?', 'Chikwawa'),
('Which district is home to Ntchisi Forest Reserve?', 'Ntchisi'),
('Which district is located between Blantyre and Zomba?', 'Chiradzulu'),
('Which district is known for Nkhotakota Wildlife Reserve?', 'Nkhotakota'),
('Which district borders Lake Malawi and is known for rice farming?', 'Salima'),
('Which district is known for Majete Wildlife Reserve?', 'Chikwawa'),
('Which district was the old capital of Malawi before Lilongwe?', 'Zomba'),
('Which district is home to Nyika National Park?', 'Rumphi'),
('Which district is known for Viphya Forest Plantation?', 'Mzimba'),
('Which district is home to Karonga Museum with dinosaur fossils?', 'Karonga'),
('Which district is known for Balaka turn-off on the M1 road?', 'Balaka'),
('Which district is home to Phalombe Plain at the foot of Mount Mulanje?', 'Phalombe'),
('Which district has Mwanza border crossing to Mozambique?', 'Mwanza'),
('Which district is known for Ntcheu Boma and borders Mozambique?', 'Ntcheu'),
('Which district is the main entry point from Tanzania in the north?', 'Karonga')
ON CONFLICT DO NOTHING;
