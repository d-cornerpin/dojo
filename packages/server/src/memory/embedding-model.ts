// Which embedding model is in use. A leaf (database access only) so the readers and writers ask one question. Every stored vector carries its model's key and a search
// scores only vectors with the current key: widths can match across models, so width cannot tell them apart.
import { getDb } from '../db/connection.js';

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model: string;
  dimensions: number;
  baseUrl: string;
  batchSize: number;
}

export function readEmbeddingConfig(): EmbeddingConfig {
  let row: { value: string } | undefined;
  try {
    row = getDb().prepare("SELECT value FROM config WHERE key = 'embedding_config'").get() as { value: string } | undefined;
  } catch { /* settings unreadable: the defaults below */ }
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
  return { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://localhost:11434', batchSize: 50 };
}

/** The label stamped on each vector and compared at search time. */
export function embeddingModelKey(cfg: Pick<EmbeddingConfig, 'provider' | 'model'> = readEmbeddingConfig()): string {
  return `${cfg.provider}:${cfg.model}`;
}
