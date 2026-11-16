-- Vector search reads an agent's newest embeddings first and stops at a bound. This index gives the
-- (agent, kind) read in write order, so the bound costs an index range, not a sort of every vector.
CREATE INDEX IF NOT EXISTS idx_embeddings_agent_source ON embeddings (agent_id, source_type);
