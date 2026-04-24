-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Clusters table: groups of similar support events
CREATE TABLE IF NOT EXISTS clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  centroid vector(1536),
  conversation_count INTEGER DEFAULT 0,
  severity TEXT CHECK (severity IN ('high', 'medium', 'low')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Support events table: normalized events from all channels
CREATE TABLE IF NOT EXISTS support_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source IN ('chatwoot', 'openphone')),
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'call', 'sms')),
  external_id TEXT NOT NULL,
  contact_name TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  embedding vector(1536),
  cluster_id UUID REFERENCES clusters(id),
  severity TEXT CHECK (severity IN ('high', 'medium', 'low')),
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vector similarity search index (requires training data; created after first inserts in prod)
CREATE INDEX IF NOT EXISTS support_events_embedding_idx
  ON support_events USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Performance indexes
CREATE INDEX IF NOT EXISTS support_events_cluster_id_idx ON support_events (cluster_id);
CREATE INDEX IF NOT EXISTS support_events_received_at_idx ON support_events (received_at);
CREATE INDEX IF NOT EXISTS support_events_source_idx ON support_events (source);
CREATE INDEX IF NOT EXISTS support_events_status_idx ON support_events (status);

-- Function to auto-update clusters.updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER clusters_updated_at
  BEFORE UPDATE ON clusters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
