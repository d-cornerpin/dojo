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
//     existing agents are not broken. They are told once instead (`noteSmallMainModelOnce`, in `main-model-notice.ts`),
//     through the same `chat:error` card every other engine notice rides.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
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
export function windowOf(modelId: string): { name: string; window: number } | null {
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

/** True when the model may serve as an agent's main model (unknown windows and `auto` pass). */
export function passesMainModelFloor(modelId: string): boolean {
  const w = windowOf(modelId);
  return !w || w.window >= MAIN_MODEL_MIN_WINDOW;
}

/**
 * The config keys through which a person (or the setup wizard) picks a service agent's MAIN
 * model; the agent's own start-up code copies them onto its row. `PUT /settings/:key` refuses a
 * small model for these before writing, with the same sentence every other door gives.
 */
export const MAIN_MODEL_SETTING_KEYS: readonly string[] = [
  'healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model', 'imaginer_brain_model',
];
