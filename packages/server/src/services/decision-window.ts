// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268, orchestrator ruling 2) — THE DECISION MODEL'S REAL WINDOW: A DERIVED TAG.
//
// MEASURED (B5, `overhaul-plans/v35-writer-measure.md` → "The num_ctx question"): Ollama's `/v1/systemone`
// ignores `num_ctx` in `options`, at the top level and as `context_length`; the decision model's runner stays
// at its model file's own 8,192 and Ollama refuses any longer request. A derived tag carrying
// `PARAMETER num_ctx N` (`FROM` the standard decision model) does start its runner at N, and its weights are
// the same blobs, so nothing more is downloaded. So at install (`services/local-standard.ts`) the Dojo makes
// that tag with N = the window it reserves for the decision model, and `decide()` asks the tag.
//
// N is ONE number with one origin: the summary check reads a job's source rows and its summary — the writer's
// job text (`writerJobWindowTokens`) — but no request may exceed Ollama's 64 KiB body (B5: HTTP 413), so N is
// the smaller of the two, both counted at this box's density (`token-density.ts`). The memory fit sets aside
// exactly the window recorded here (`dojo-working-memory.ts decisionWindowTokens`).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { STANDARD_DECISION_MODEL } from './local-standard.js';
import { writerJobWindowTokens, DECISION_WINDOW_KEY } from './dojo-working-memory.js';
import { utilityNumCtx } from '../agent/utility-dial.js';
import { MEASURED_CHARS_PER_TOKEN } from './token-density.js';
import { MAX_DECISION_BODY_BYTES } from '../agent/decide.js';

const logger = createLogger('decision-window');

/** The bound the Dojo gives its other Ollama model reads (`services/ollama.ts getOllamaModelInfo`, `/api/show`). */
const OLLAMA_MODEL_CALL_MS = 10_000;

/** The window the decision model should run at on this box, in tokens. */
export async function desiredDecisionWindowTokens(): Promise<number> {
  // A character is at least one byte, so a body Ollama accepts holds at most MAX_DECISION_BODY_BYTES characters.
  const bodyWindow = utilityNumCtx({ inputChars: MAX_DECISION_BODY_BYTES, outputTokens: 0, configuredNumCtx: null, charsPerToken: MEASURED_CHARS_PER_TOKEN });
  return Math.min(await writerJobWindowTokens(null), bodyWindow);
}

async function ollamaPost(baseUrl: string, path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(OLLAMA_MODEL_CALL_MS),
    });
  } catch { return null; }
}

/** The derived tag's `num_ctx` as Ollama reports it, or null when the tag is not there. */
async function tagWindow(baseUrl: string): Promise<number | null> {
  const resp = await ollamaPost(baseUrl, '/api/show', { model: STANDARD_DECISION_MODEL.windowTag });
  if (!resp?.ok) return null;
  const params = ((await resp.json().catch(() => ({}))) as { parameters?: unknown }).parameters;
  const m = typeof params === 'string' ? /^num_ctx\s+(\d+)/m.exec(params) : null;
  return m ? Number(m[1]) : null;
}

function recordWindow(window: number | null): void {
  const db = getDb();
  if (window === null) { db.prepare('DELETE FROM config WHERE key = ?').run(DECISION_WINDOW_KEY); return; }
  db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(DECISION_WINDOW_KEY, String(window));
}

let inFlight: Promise<number | null> | null = null;
let toldFailure = false;

/**
 * Create or refresh the derived decision tag at the window this box reserves; idempotent (a tag already at
 * that window is left alone; concurrent callers share one run). Returns the window the tag has, or null when
 * it could not be made — then `decide()` asks the base tag at its built-in window, and the Ollama health
 * check's retry (`local-standard.ts retryStandardModelsIfMissing`) tries again. Never throws.
 */
export function ensureDecisionWindowTag(baseUrl: string): Promise<number | null> {
  if (!inFlight) inFlight = makeTag(baseUrl).finally(() => { inFlight = null; });
  return inFlight;
}

/** t268 (I-1): the tag is gone from Ollama (removed by hand, or never made): the recorded window goes at once,
 *  so `decide()` asks the base tag, and the tag is made again from the base tag — locally, never a download. */
export function repairDecisionWindowTag(baseUrl: string): Promise<number | null> {
  try { recordWindow(null); } catch { /* the make below records what is true */ }
  return ensureDecisionWindowTag(baseUrl);
}

async function makeTag(baseUrl: string): Promise<number | null> {
  try {
    const want = await desiredDecisionWindowTokens();
    const have = await tagWindow(baseUrl);
    if (have === want) { recordWindow(have); return have; }
    const resp = await ollamaPost(baseUrl, '/api/create', {
      model: STANDARD_DECISION_MODEL.windowTag, from: STANDARD_DECISION_MODEL.tag, parameters: { num_ctx: want }, stream: false,
    });
    if (!resp?.ok) {
      // Told once per process: the health check retries it on Ollama's own cadence, and one line says it.
      if (!toldFailure) logger.warn('The decision model\'s window tag could not be made; decide() keeps the built-in window', { status: resp?.status ?? null, want });
      toldFailure = true;
      recordWindow(have);   // what the tag (if any) really is
      return have;
    }
    recordWindow(want);
    toldFailure = false;
    logger.info('The decision model\'s window tag is set', { tag: STANDARD_DECISION_MODEL.windowTag, numCtx: want, was: have });
    return want;
  } catch (err) {
    logger.warn('The decision model\'s window tag check failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
