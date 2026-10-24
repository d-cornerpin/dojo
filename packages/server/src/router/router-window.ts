// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 (GitHub #25) — ONE WINDOW FOR EVERY AUTOMATIC PICK. THE OWNER'S DESIGN, 2026-10-23.
//
// THE DEFECT: an auto-routed agent's memory was sized by the model the router picked for THIS
// request (`getContextWindow(pick)` at every reader of a turn's window). A cheap light-tier turn on
// a small model folded the rows its window could not hold, folding moves the compaction boundary for
// good, and the next turn on a bigger model did not get them back: one light turn shrank what the
// agent remembers word for word to the light model's size.
//
// THE DESIGN (the owner's; he rejected "skip a pick too small and use a pricier one"): the router
// keeps choosing models by tier exactly as before, so cheap picks stay cheap. Only the window every
// pick runs at is fixed: ONE setting for the whole router (`router.context_window`, a slider on the
// Router tab), whose top is the smallest window among the router's light, standard and heavy models.
//
//   floor          the smallest effective window (`getContextWindow`, num_ctx applied) among the
//                  models assigned to light, standard and heavy. The `system` tier is not counted:
//                  it dials titles and classifiers, never an agent's conversation. Every assigned
//                  model counts, one whose provider is down included, so the figure does not jump
//                  when a provider trips.
//   router window  min(setting ?? floor, floor). The floor is the slider's own top — an arithmetic
//                  consequence (no tier model can run at more than its own window), not a cap.
//   a turn's window  the router window for an auto-routed agent; `getContextWindow(model)` unchanged
//                  for a fixed-model agent (byte-preservation). A pick the router reaches OUTSIDE its
//                  tiers (the budget's free redirect) may be smaller than the floor, and no model runs
//                  at more than its own window, so a turn's window is never above its pick's.
//
// NOT MOVED: the transport's `max_tokens` and the provider boundary keep the dialed model's REAL
// window (`agent/model.ts`), so a bigger pick still has its full room to answer.
// STATED TRADE-OFF (release notes): on a router whose models differ in size, an auto-routed agent
// uses the smallest model's window even on a bigger model; to give it more room, raise the smallest
// model or take it off the router.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getContextWindow } from '../agent/model.js';

/** The config key the Router tab's slider writes (through the existing settings route). */
export const ROUTER_WINDOW_SETTING = 'router.context_window';

const AGENT_TIERS = ['light', 'standard', 'heavy'] as const;

/** The smallest window among the models on the light, standard and heavy tiers, or null when none is. */
export function routerWindowFloor(): { tokens: number; modelName: string } | null {
  let rows: Array<{ model_id: string; name: string | null }>;
  try {
    rows = getDb().prepare(
      `SELECT DISTINCT rtm.model_id, m.name FROM router_tier_models rtm LEFT JOIN models m ON m.id = rtm.model_id
       WHERE rtm.tier_id IN (${AGENT_TIERS.map(() => '?').join(', ')})`,
    ).all(...AGENT_TIERS) as Array<{ model_id: string; name: string | null }>;
  } catch {
    return null;
  }
  let floor: { tokens: number; modelName: string } | null = null;
  for (const r of rows) {
    if (r.model_id === 'auto' || r.model_id === '__auto__') continue;
    const tokens = getContextWindow(r.model_id);
    if (floor === null || tokens < floor.tokens) floor = { tokens, modelName: r.name ?? r.model_id };
  }
  return floor;
}

/** The owner's setting, when it is a positive whole number of tokens. */
function routerWindowSetting(): number | null {
  try {
    const raw = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(ROUTER_WINDOW_SETTING) as { value: string } | undefined)?.value;
    return raw !== undefined && /^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** The window every automatic pick runs at: the setting, never above the floor. Null with no tier model. */
export function routerWindowTokens(): number | null {
  const floor = routerWindowFloor();
  if (floor === null) return null;
  return Math.min(routerWindowSetting() ?? floor.tokens, floor.tokens);
}

function isAutoRouted(agentId: string): boolean {
  try {
    const modelId = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
    return modelId === 'auto' || modelId === '__auto__';
  } catch {
    return false;
  }
}

/** The window an agent's turn on `modelId` is sized for (see the header). */
export function agentTurnWindow(agentId: string, modelId: string): number {
  const own = getContextWindow(modelId);
  if (!isAutoRouted(agentId)) return own;
  const router = routerWindowTokens();
  return router === null ? own : Math.min(router, own);
}

export interface RouterWindowReport {
  /** The window every automatic pick runs at now. */
  tokens: number;
  /** The slider's top: the smallest tier model's window, and that model. */
  floorTokens: number;
  floorModelName: string;
  /** The slider's low end, MEASURED: below it the named agent's instructions and tools alone overflow. */
  minTokens: number;
  minAgentName: string | null;
}

/** What the Router tab shows. Null when no model is on the three tiers (no slider is shown then). */
export async function routerWindowReport(): Promise<RouterWindowReport | null> {
  const floor = routerWindowFloor();
  const tokens = routerWindowTokens();
  if (floor === null || tokens === null) return null;
  const [{ measureAgentToolPayloadTokens }, { buildAssemblyContext, assembleSystemFromRegistry }, { estimateTokens }] = await Promise.all([
    import('../tools/tool-docs.js'), import('../prompt/registry/assembler.js'), import('../memory/budget.js'),
  ]);
  const autos = getDb().prepare(
    "SELECT id, name FROM agents WHERE model_id IN ('auto', '__auto__') AND status != 'terminated' ORDER BY name",
  ).all() as Array<{ id: string; name: string }>;
  let minTokens = 0;
  let minAgentName: string | null = null;
  for (const a of autos) {
    const system = estimateTokens(assembleSystemFromRegistry(buildAssemblyContext(a.id, '__auto__')).text);
    const need = system + await measureAgentToolPayloadTokens(a.id);
    if (need > minTokens) { minTokens = need; minAgentName = a.name; }
  }
  return { tokens, floorTokens: floor.tokens, floorModelName: floor.modelName, minTokens, minAgentName };
}
