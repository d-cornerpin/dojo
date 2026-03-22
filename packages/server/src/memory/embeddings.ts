// ════════════════════════════════════════
// Embedding Generation (Phase 5C)
// Generates vector embeddings via Ollama or OpenAI-compatible APIs
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('embeddings');

// ── Configuration ──

interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model: string;
  dimensions: number;
  baseUrl: string;
  batchSize: number;
}

function getEmbeddingConfig(): EmbeddingConfig {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'embedding_config'").get() as { value: string } | undefined;

  if (row) {
    try {
      const parsed = JSON.parse(row.value);
      return {
        provider: parsed.provider ?? 'ollama',
        model: parsed.model ?? 'nomic-embed-text',
        dimensions: parsed.dimensions ?? 768,
        baseUrl: parsed.baseUrl ?? 'http://localhost:11434',
        batchSize: parsed.batchSize ?? 50,
      };
    } catch { /* fall through */ }
  }

  return {
    provider: 'ollama',
    model: 'nomic-embed-text',
    dimensions: 768,
    baseUrl: 'http://localhost:11434',
    batchSize: 50,
  };
}

export function setEmbeddingConfig(config: Partial<EmbeddingConfig>): void {
  const current = getEmbeddingConfig();
  const updated = { ...current, ...config };
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('embedding_config', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(JSON.stringify(updated), JSON.stringify(updated));
}

// ── Embedding Generation ──

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const config = getEmbeddingConfig();

  // Truncate text to prevent very large inputs
  const truncated = text.length > 8000 ? text.slice(0, 8000) : text;

  if (config.provider === 'ollama') {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        prompt: truncated,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Ollama embedding failed: HTTP ${response.status} ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as { embedding: number[] };
    return new Float32Array(data.embedding);
  }

  // OpenAI-compatible endpoint
  const response = await fetch(`${config.baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      input: truncated,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Embedding API failed: HTTP ${response.status} ${errorText.slice(0, 200)}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return new Float32Array(data.data[0].embedding);
}

// ── Store Embedding ──

export async function storeEmbedding(
  sourceType: 'message' | 'summary' | 'briefing',
  sourceId: string,
  agentId: string | null,
  content: string,
): Promise<void> {
  try {
    // Skip very short content
    if (content.trim().length < 20) return;

    // Check if already embedded
    const db = getDb();
    const existing = db.prepare(
      'SELECT id FROM embeddings WHERE source_type = ? AND source_id = ?'
    ).get(sourceType, sourceId);
    if (existing) return;

    const embedding = await generateEmbedding(content);

    db.prepare(`
      INSERT INTO embeddings (id, source_type, source_id, agent_id, content_preview, embedding, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      sourceType,
      sourceId,
      agentId,
      content.slice(0, 200),
      Buffer.from(embedding.buffer),
      embedding.length,
    );

    logger.debug('Embedding stored', { sourceType, sourceId, dimensions: embedding.length }, agentId ?? undefined);
  } catch (err) {
    logger.error('Failed to store embedding', {
      error: err instanceof Error ? err.message : String(err),
      sourceType,
      sourceId,
    });
    // Embedding is best-effort — don't throw
  }
}

// ── Queue Embedding (async, non-blocking) ──

export function queueEmbedding(
  sourceType: 'message' | 'summary' | 'briefing',
  sourceId: string,
  agentId: string | null,
  content: string,
): void {
  // Fire and forget — don't block the caller
  storeEmbedding(sourceType, sourceId, agentId, content).catch(err => {
    logger.debug('Queued embedding failed', {
      error: err instanceof Error ? err.message : String(err),
      sourceType,
      sourceId,
    });
  });
}

// ── Embedding Status ──

export function getEmbeddingStatus(): {
  total: number;
  embedded: number;
  pending: number;
  config: EmbeddingConfig;
} {
  const db = getDb();

  const msgCount = (db.prepare('SELECT COUNT(*) as count FROM messages WHERE length(content) >= 20').get() as { count: number }).count;
  const sumCount = (db.prepare('SELECT COUNT(*) as count FROM summaries').get() as { count: number }).count;
  const total = msgCount + sumCount;

  const embedded = (db.prepare('SELECT COUNT(*) as count FROM embeddings').get() as { count: number }).count;

  return {
    total,
    embedded,
    pending: Math.max(0, total - embedded),
    config: getEmbeddingConfig(),
  };
}
