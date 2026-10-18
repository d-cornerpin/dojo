// ════════════════════════════════════════════════════════════════════════════
// t202 D10 — A MODEL UNDER 32K TOKENS IS NOT AN AGENT'S MAIN MODEL.
//
// OWNER RULING (v3.4 decision 13), recorded as the one explicit exception to "no hard limits":
// refuse a model whose memory window is under 32K tokens as an agent's MAIN model, with a plain
// explanation. Small models stay available for the helper jobs that do not hold a conversation
// (titles, summaries, utility dials) — this module is called ONLY by the doors that set an
// agent's main model, and nothing here touches those jobs.
//
// ── WHAT COUNTS AS THE WINDOW ──
// The window the engine would actually budget this model's prompts against
// (`agent/model.ts` `effectiveContextWindow`): the advertised window, capped by the `num_ctx` the
// calls carry. A big model squeezed to 8K by its own override is an 8K model for the purpose of
// holding a conversation, and the person is told which number was used.
//
// ── WHAT IS DELIBERATELY NOT REFUSED ──
//   · a model that declared no usable window (NULL / 0) — unknown is not small;
//   · the auto-router sentinel — it picks per turn and is not a model with a window;
//   · an agent that is ALREADY on a small model, when the door is only re-saving that same model:
//     existing agents are not broken. They are told once instead (`noteSmallMainModelOnce`),
//     through the same `chat:error` card every other engine notice rides.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';

const logger = createLogger('main-model-floor');

/** The owner's floor, in tokens. "32K" models are advertised as 32,000 or 32,768; both pass. */
export const MAIN_MODEL_MIN_WINDOW = 32_000;

interface WindowRow {
  name: string;
  context_window: number | null;
  num_ctx_override: number | null;
  num_ctx_recommended: number | null;
}

/** The window this model's calls are budgeted against, or null when it declared none. */
function windowOf(modelId: string): { name: string; window: number } | null {
  if (modelId === 'auto' || modelId === '__auto__') return null;
  let row: WindowRow | undefined;
  try {
    row = getDb().prepare(
      'SELECT name, context_window, num_ctx_override, num_ctx_recommended FROM models WHERE id = ?',
    ).get(modelId) as WindowRow | undefined;
  } catch { return null; }
  if (!row) return null;
  const declared = row.context_window;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return null;
  const numCtx = resolveNumCtx({
    numCtxOverride: row.num_ctx_override, numCtxRecommended: row.num_ctx_recommended,
  }).effective;
  return { name: row.name, window: effectiveContextWindow(declared, numCtx) };
}

function kLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

/** The plain sentence a person reads. */
export function smallMainModelMessage(name: string, window: number): string {
  return `${name} has a memory window of about ${kLabel(window)} tokens, which is too small for an agent's main model. `
    + 'An agent needs at least 32K to hold a conversation together with its tools and instructions. '
    + 'Choose a model with a bigger window for this agent; small models can still do helper jobs such as titles and summaries.';
}

/**
 * The refusal for SETTING `modelId` as an agent's main model, or null when it is fine.
 * `currentModelId` is what the agent is on now: re-saving that same model is not a change and is
 * never refused, so an existing agent on a small model keeps working and stays editable.
 */
export function refuseSmallMainModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
): string | null {
  if (!modelId || modelId === currentModelId) return null;
  const w = windowOf(modelId);
  if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return null;
  return smallMainModelMessage(w.name, w.window);
}

/**
 * An agent that is already on a small main model is told ONCE (per model it has been on), by the
 * existing `chat:error` card at warning severity — nothing is changed or stopped. "Once" is a
 * stored fact (a `config` key naming the model already noticed), so a restart does not repeat it.
 * Returns true when this call is the one that spoke.
 */
export function noteSmallMainModelOnce(agentId: string, modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  try {
    const w = windowOf(modelId);
    if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return false;
    const db = getDb();
    const key = `small_main_model_noticed:${agentId}`;
    const seen = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    if (seen?.value === modelId) return false;
    db.prepare(`
      INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, modelId);
    logger.warn('This agent\'s main model is under the 32K floor; it keeps running', {
      modelId, window: w.window,
    }, agentId);
    broadcast({
      type: 'chat:error',
      agentId,
      error: `${smallMainModelMessage(w.name, w.window)} This agent keeps working as it is; the notice is shown once.`,
      code: 'MAIN_MODEL_SMALL',
      severity: 'warning',
      retryable: false,
    });
    return true;
  } catch { return false; }   // a notice is a courtesy; never break the read it rides on
}
