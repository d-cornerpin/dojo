// The decision model's real window as a derived tag: Ollama's `/v1/systemone` ignores `num_ctx` in `options`, so a
// tag made `FROM` the standard decision model with `PARAMETER num_ctx N` (same weights, no download) starts the
// runner at N. N is the smaller of the writer's job window and what fits Ollama's 64 KiB request body, both at
// this box's density; the memory fit reserves exactly the window recorded here (dojo-working-memory.ts).

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { STANDARD_DECISION_MODEL } from './local-standard.js';
import { writerJobWindowTokens, DECISION_WINDOW_KEY } from './dojo-working-memory.js';
import { utilityNumCtx } from '../agent/utility-dial.js';
import { MEASURED_CHARS_PER_TOKEN } from './token-density.js';
import { MAX_DECISION_BODY_BYTES } from '../agent/decide.js';

const logger = createLogger('decision-window');

const OLLAMA_MODEL_CALL_MS = 10_000;

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
  setConfigValue(DECISION_WINDOW_KEY, String(window));
}

let inFlight: Promise<number | null> | null = null;
let toldFailure = false;

/**
 * Create or refresh the derived tag at the reserved window (idempotent; concurrent callers share one run). Returns
 * the window the tag has, or null when it could not be made (decide() then asks the base tag). Never throws.
 */
export function ensureDecisionWindowTag(baseUrl: string): Promise<number | null> {
  if (!inFlight) inFlight = makeTag(baseUrl).finally(() => { inFlight = null; });
  return inFlight;
}

/** The tag is gone from Ollama: clear the recorded window and make the tag again from the base tag, locally. */
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
