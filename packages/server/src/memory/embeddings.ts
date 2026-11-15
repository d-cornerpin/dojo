// Embedding generation via Ollama or OpenAI-compatible APIs.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { openAgentCall } from '../agent/abortable-call.js';
import { localWorkBegins } from '../services/ollama-lock.js';
import { openAiCompatibleUrl } from '../services/openai-compatible-url.js';
import { readEmbeddingConfig, embeddingModelKey, type EmbeddingConfig } from './embedding-model.js';

const logger = createLogger('embeddings');


function getEmbeddingConfig(): EmbeddingConfig {
  return readEmbeddingConfig();
}

// ── Backend absence, reported as a fact instead of guessed from prose ──
//
// The embedder is OPTIONAL and fires on every message, response and summary, so its absence must not be an ERROR
// storm. The reported CODE decides (`provider-error.ts`; prose is the LAST resort): a 404 leaves the fetch as a
// TYPE, and prose covers only a daemon that never answered at all.
export class EmbeddingBackendUnavailableError extends Error {
  /** Duck-typed marker: `instanceof` is not reliable across module instances. */
  readonly backendUnavailable = true;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'EmbeddingBackendUnavailableError';
  }
}

/** True when THE BACKEND IS NOT THERE: the daemon never answered (transport) or has no such model (HTTP 404).
 *  A 500, a malformed body or a DB write fault is a genuine failure and keeps the ERROR branch. */
export function isEmbeddingBackendUnavailable(err: unknown): boolean {
  if (err instanceof Error && (err as { backendUnavailable?: unknown }).backendUnavailable === true) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNREFUSED|fetch failed|aborted|timeout|ENOTFOUND|network/i.test(msg);
}

// ── The absence is announced ONCE, by whoever notices first ──
// Memory writes, the vault's per-entry embed and its per-search query embed share this latch, which re-arms the
// moment the backend ANSWERS (see generateEmbedding), not when some caller stores a row.
let backendAbsenceReported = false;

export function warnEmbeddingBackendAbsentOnce(context: Record<string, unknown>): void {
  if (backendAbsenceReported) return;
  backendAbsenceReported = true;
  logger.warn('Embedding backend unavailable — embeddings are paused until it answers again', context);
}

// The one place a non-OK embed response becomes an error. 404 is "no such model" on both backends; some
// OpenAI-compatible servers say it in prose under another status, so the body is read as a fallback.
function embedResponseError(prefix: string, status: number, body: string): Error {
  const msg = `${prefix}: HTTP ${status} ${body.slice(0, 200)}`;
  return status === 404 || /model[^.]{0,40}not found|model_not_found|no such model/i.test(body)
    ? new EmbeddingBackendUnavailableError(msg, status)
    : new Error(msg);
}


// Default per-request embed deadline: background embeds tolerate a cold GPU load, while latency-sensitive callers
// (the router) pass a short timeoutMs so a slow embedder degrades to the fallback instead of stalling first token.
const DEFAULT_EMBED_TIMEOUT_MS = 30000;

export async function generateEmbedding(
  text: string,
  // `agentId` is whose stop this answers to: an agent AWAITS this on seven paths (`recall-lane`, `vector-search`,
  // `vault_search`, four a2a). The corpus sweep passes none.
  opts?: { keepAlive?: string | number; timeoutMs?: number; agentId?: string },
): Promise<Float32Array> {
  const slot = opts?.agentId === undefined ? null : openAgentCall(opts.agentId, 'turn');
  try {
  const config = getEmbeddingConfig();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;

  // The char cap embeds most summaries whole; a dense input that overflows the model's token context is rescued by
  // the halving retry below.
  const EMBED_CHAR_CAP = 7000;
  let truncated = text.length > EMBED_CHAR_CAP ? text.slice(0, EMBED_CHAR_CAP) : text;

  if (config.provider === 'ollama') {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const endLocalWork = localWorkBegins(baseUrl);   // an Ollama restart waits for it
    try {
    // On a token-context overflow, halve the input and retry (up to 3x) so a dense input still embeds.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          prompt: truncated,
          // keep_alive: how long Ollama holds the model resident after this call (the router warmer passes a window).
          ...(opts?.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
        }),
        signal: slot ? AbortSignal.any([slot.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const data = await response.json() as { embedding: number[] };
        backendAbsenceReported = false; // it ANSWERED, re-arm the absence warning
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
    } finally { endLocalWork(); }
  }

  // OpenAI-compatible endpoint: same adaptive halving retry on a context overflow.
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(openAiCompatibleUrl(config.baseUrl, 'embeddings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: truncated,
      }),
      // The caller's declared `timeoutMs` is honoured on this transport too. An abort is classified by
      // `isEmbeddingBackendUnavailable` (pausing embedding behind the latch) and `memory/backfill.ts` re-embeds it.
      signal: slot ? AbortSignal.any([slot.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const data = await response.json() as { data: Array<{ embedding: number[] }> };
      backendAbsenceReported = false; // it ANSWERED, re-arm the absence warning
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
  } finally { slot?.release(); }   // by identity, across the halving retries
}


// Source kinds, liveness rules and the guarded write are a LEAF (`embedding-sources.ts` says why).
import { insertEmbeddingIfSourceAlive, UNDECLARED_EMBEDDING_KIND_WARNING, type EmbeddingSourceType } from './embedding-sources.js';
export { EMBEDDING_SOURCE_TABLES, embeddingSourceAliveSql, type EmbeddingSourceType } from './embedding-sources.js';

export async function storeEmbedding(
  sourceType: EmbeddingSourceType,
  sourceId: string,
  agentId: string | null,
  content: string,
  // Set only by the re-embed after a model switch: a row made by another model is replaced.
  opts?: { replaceStale?: boolean },
): Promise<void> {
  try {
    if (content.trim().length < 20) return;

    // The label is read BEFORE the model call, so a vector is stamped with the model that made it.
    const model = embeddingModelKey();

    const db = getDb();
    const existing = db.prepare(
      'SELECT id, embedding_model AS model FROM embeddings WHERE source_type = ? AND source_id = ?'
    ).all(sourceType, sourceId) as Array<{ id: string; model: string | null }>;
    // `embeddings` has no unique key per source: an embed in flight across a model switch can land an old-model row
    // beside a current one. The re-embed treats the source as done once ONE current row exists and removes stale rows.
    const hasCurrent = existing.some((r) => r.model === model);
    const dropStale = (): void => {
      db.prepare('DELETE FROM embeddings WHERE source_type = ? AND source_id = ? AND embedding_model IS NOT ?').run(sourceType, sourceId, model);
    };
    if (existing.length > 0 && !opts?.replaceStale) return;
    if (hasCurrent) { if (opts?.replaceStale) dropStale(); return; }

    const embedding = await generateEmbedding(content);

    // The replaced rows go in the same synchronous step as the new one lands (no await between),
    // and only when the new one is written: a failed embed leaves the old rows in place.
    if (existing.length > 0) dropStale();

    // GUARDED WRITE: the `await` above is the orphan class's whole mechanism; see `embedding-sources.ts`.
    const written = insertEmbeddingIfSourceAlive(db, {
      id: uuidv4(), sourceType, sourceId, agentId, preview: content.slice(0, 200),
      vector: Buffer.from(embedding.buffer), dimensions: embedding.length, model,
    }, (kind) => logger.warn(UNDECLARED_EMBEDDING_KIND_WARNING, { sourceType: kind, sourceId }, agentId ?? undefined));
    if (!written) {
      logger.debug('Embedding discarded: its source was deleted while it was being computed',
        { sourceType, sourceId }, agentId ?? undefined);
      return;
    }

    logger.debug('Embedding stored', { sourceType, sourceId, dimensions: embedding.length }, agentId ?? undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The default embed backend (Ollama) is engine-optional: absent is WARN, said once (see the latch above).
    if (isEmbeddingBackendUnavailable(err)) {
      warnEmbeddingBackendAbsentOnce({ error: msg, site: 'memory.storeEmbedding', sourceType, sourceId });
      return; // best-effort, don't throw
    }
    logger.error('Failed to store embedding', {
      error: msg,
      sourceType,
      sourceId,
    });
  }
}


export function queueEmbedding(
  sourceType: EmbeddingSourceType,
  sourceId: string,
  agentId: string | null,
  content: string,
): void {
  storeEmbedding(sourceType, sourceId, agentId, content).catch(err => {
    logger.debug('Queued embedding failed', {
      error: err instanceof Error ? err.message : String(err),
      sourceType,
      sourceId,
    });
  });
}

// Re-embed a source whose content changed: the insert path dedups by (source_type, source_id), so updates must
// drop the stale row first.
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
