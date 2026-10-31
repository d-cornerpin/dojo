// ════════════════════════════════════════
// Which embedding model is in use, and whether it costs money.
//
// A leaf (database access only) so the vector readers, the writers and the switch handler all ask
// the same question. Every stored vector carries the key of the model that made it
// (`embeddings.embedding_model`, `vault_entries.embedding_model`), and a search only scores vectors
// whose key equals the current one: two models' vectors are never compared, even when their widths
// happen to match (the width check alone cannot tell them apart).
// ════════════════════════════════════════

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

/**
 * True when using this embedder costs nothing: Ollama always, and an OpenAI-compatible endpoint
 * only when it is on this machine or a private network address. Anything else (a hosted API, or an
 * address that cannot be told apart from one) counts as paid, the safe direction.
 */
export function embeddingIsLocal(cfg: Pick<EmbeddingConfig, 'provider' | 'baseUrl'> = readEmbeddingConfig()): boolean {
  if (cfg.provider === 'ollama') return true;
  try {
    const host = new URL(cfg.baseUrl).hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  } catch {
    return false;
  }
}
