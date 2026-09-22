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

// ── Backend absence, reported as a fact instead of guessed from prose ──
//
// The embedder is OPTIONAL and fires on every message, response and summary, so
// whatever this module does when it is missing, it does hundreds of times an
// hour. ROUND 9 of the release ritual (2026-09-21, v3.1.26) measured the cost of
// getting that wrong: Ollama was UP serving zero models, every embed came back
// `HTTP 404 {"error":"model ... not found"}`, and absence was classified by a
// prose regex that knew refused connections and nothing about 404 — so an
// optional subsystem emitted 102 ERROR lines in 19 minutes and the SAFETY gate
// stopped the release.
//
// Widening the regex would be the same mistake spelled longer. `provider-error.ts`
// states the house rule — the reported CODE decides, prose is the LAST resort —
// so the 404 leaves the fetch as a TYPE, and prose is left to the one layer with
// no status to read: a daemon that never answered at all.
export class EmbeddingBackendUnavailableError extends Error {
  /** Duck-typed marker: `instanceof` is not reliable across module instances. */
  readonly backendUnavailable = true;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EmbeddingBackendUnavailableError';
  }
}

/** True when the failure means THE BACKEND IS NOT THERE — the daemon never
 *  answered (transport; no status to read) or answered that it has no such model
 *  (HTTP 404). A 500, a malformed body or a DB write fault is a genuine failure
 *  and keeps the ERROR branch. */
export function isEmbeddingBackendUnavailable(err: unknown): boolean {
  if (err instanceof Error && (err as { backendUnavailable?: unknown }).backendUnavailable === true) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|aborted|timeout|ENOTFOUND|network/i.test(msg);
}

// ── The absence is announced ONCE, by whoever notices first ──
// One fact, several witnesses: memory writes, the vault's per-entry embed and its
// per-search query embed each used to warn on their own schedule. They share this
// latch. It re-arms the moment the backend ANSWERS (see generateEmbedding), not
// when some caller manages to store a row — so "until it answers again" is the
// mechanism rather than an approximation of it.
let backendAbsenceReported = false;

export function warnEmbeddingBackendAbsentOnce(context: Record<string, unknown>): void {
  if (backendAbsenceReported) return;
  backendAbsenceReported = true;
  logger.warn('Embedding backend unavailable — embeddings are paused until it answers again', context);
}

// The one place a non-OK embed response becomes an error. 404 is "no such model"
// on both backends; some OpenAI-compatible servers say it in prose under another
// status, so the body is read as a fallback.
function embedResponseError(prefix: string, status: number, body: string): Error {
  const msg = `${prefix}: HTTP ${status} ${body.slice(0, 200)}`;
  return status === 404 || /model[^.]{0,40}not found|model_not_found|no such model/i.test(body)
    ? new EmbeddingBackendUnavailableError(msg, status)
    : new Error(msg);
}

// ── Embedding Generation ──

// Default per-request embed deadline. Background memory embeds (summaries,
// message backfill) can tolerate a cold GPU load, so they keep the generous
// 30s. Latency-sensitive callers on a turn's critical path (the router, FA-R4)
// pass a short timeoutMs so a slow or cold embedder degrades to the fallback
// instead of stalling first token.
const DEFAULT_EMBED_TIMEOUT_MS = 30000;

export async function generateEmbedding(
  text: string,
  opts?: { keepAlive?: string | number; timeoutMs?: number },
): Promise<Float32Array> {
  const config = getEmbeddingConfig();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;

  // D17: cap raised 2000 -> 7000. The C12 fix over-corrected: a flat 2000-char cap
  // embedded only the first 20-45% of a typical summary (avg ~4.7k chars, depth-2 ~12k),
  // so the back half of most summaries was invisible to vector recall (77% of summaries
  // exceeded 2000 chars). The token-overflow safety C12 was protecting against is ALREADY
  // handled by the adaptive halving-retry below (a dense input that overflows the embed
  // model's token context is halved and retried up to 3x), so the char cap can be raised
  // back to capture most summaries whole while the retry still rescues the rare dense one.
  const EMBED_CHAR_CAP = 7000;
  let truncated = text.length > EMBED_CHAR_CAP ? text.slice(0, EMBED_CHAR_CAP) : text;

  if (config.provider === 'ollama') {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    // C12: adaptive retry, on a token-context overflow, halve the input and retry (up to
    // 3x) so a dense input still embeds instead of dropping to un-searchable.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          prompt: truncated,
          // keep_alive: how long Ollama holds the model resident after this call.
          // The router warmer passes a window so the embedder stays loaded while
          // auto-router is in use (no cold ~300ms reloads per route).
          ...(opts?.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const data = await response.json() as { embedding: number[] };
        backendAbsenceReported = false; // it ANSWERED — re-arm the absence warning
        return new Float32Array(data.embedding);
      }
      const errorText = await response.text().catch(() => '');
      if (response.status === 500 && /exceeds the context length/i.test(errorText) && truncated.length > 200) {
        truncated = truncated.slice(0, Math.floor(truncated.length / 2));
        continue;
      }
      throw embedResponseError('Ollama embedding failed', response.status, errorText);
    }
    throw new Error('Ollama embedding failed: input still exceeded the context length after 3 halving retries');
  }

  // OpenAI-compatible endpoint, C12: same adaptive halving retry on a context overflow.
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (response.ok) {
      const data = await response.json() as { data: Array<{ embedding: number[] }> };
      backendAbsenceReported = false; // it ANSWERED — re-arm the absence warning
      return new Float32Array(data.data[0].embedding);
    }
    const errorText = await response.text().catch(() => '');
    if ((response.status === 500 || response.status === 400) && /exceeds the (context|maximum context) length|maximum context length|too long/i.test(errorText) && truncated.length > 200) {
      truncated = truncated.slice(0, Math.floor(truncated.length / 2));
      continue;
    }
    throw embedResponseError('Embedding API failed', response.status, errorText);
  }
  throw new Error('Embedding API failed: input still exceeded the context length after 3 halving retries');
}

// ── Store Embedding ──

export type EmbeddingSourceType = 'message' | 'summary' | 'briefing' | 'technique';

export async function storeEmbedding(
  sourceType: EmbeddingSourceType,
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
    const msg = err instanceof Error ? err.message : String(err);
    // The default embed backend (Ollama) is engine-optional. Absent is not a
    // fault: it is WARN, said once (see the latch above). ERROR stays for the
    // genuine failure an operator has to act on.
    if (isEmbeddingBackendUnavailable(err)) {
      warnEmbeddingBackendAbsentOnce({ error: msg, site: 'memory.storeEmbedding', sourceType, sourceId });
      return; // best-effort, don't throw
    }
    logger.error('Failed to store embedding', {
      error: msg,
      sourceType,
      sourceId,
    });
    // Embedding is best-effort, don't throw
  }
}

// ── Queue Embedding (async, non-blocking) ──

export function queueEmbedding(
  sourceType: EmbeddingSourceType,
  sourceId: string,
  agentId: string | null,
  content: string,
): void {
  // Fire and forget, don't block the caller
  storeEmbedding(sourceType, sourceId, agentId, content).catch(err => {
    logger.debug('Queued embedding failed', {
      error: err instanceof Error ? err.message : String(err),
      sourceType,
      sourceId,
    });
  });
}

// Re-embed a source whose content changed. The insert path dedups by
// (source_type, source_id), so updates must drop the stale row first or the
// new content would be silently ignored.
export function refreshEmbedding(
  sourceType: EmbeddingSourceType,
  sourceId: string,
  agentId: string | null,
  content: string,
): void {
  try {
    getDb().prepare('DELETE FROM embeddings WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  } catch { /* best effort */ }
  queueEmbedding(sourceType, sourceId, agentId, content);
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
