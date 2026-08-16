-- ============================================================
-- Migration 002: Create RAG (Retrieval-Augmented Generation) tables
-- Run this in your Supabase SQL editor
-- ============================================================

-- RAG Documents table
CREATE TABLE IF NOT EXISTS rag_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT,
  size        BIGINT,
  chunks      INTEGER DEFAULT 0,
  word_count  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  user_id     INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- RAG Queries log table
CREATE TABLE IF NOT EXISTS rag_queries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     INTEGER,
  question    TEXT NOT NULL,
  answer      TEXT,
  sources     TEXT[],
  document_id UUID REFERENCES rag_documents(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common lookups
CREATE INDEX IF NOT EXISTS idx_rag_documents_user_id    ON rag_documents (user_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_status     ON rag_documents (status);
CREATE INDEX IF NOT EXISTS idx_rag_documents_created_at ON rag_documents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_queries_user_id      ON rag_queries (user_id);
CREATE INDEX IF NOT EXISTS idx_rag_queries_created_at   ON rag_queries (created_at DESC);
