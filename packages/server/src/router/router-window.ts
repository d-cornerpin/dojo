// One window for every automatic pick: an auto-routed agent's memory is sized by ONE router window, not by
// the model picked for this request, so a cheap small-model turn never shrinks what the agent remembers.
// floor: the smallest effective window (`getContextWindow`) among enabled models on light, standard and
//   heavy (not `system`); a model whose provider is down still counts so the figure does not jump.
// router window: min(setting ?? floor, floor); the floor is the slider's top (no tier model runs above its own).
// A turn's window: the router window for an auto agent (never above its pick's own), else `getContextWindow(model)`.
// Not moved: the transport's `max_tokens` and the provider boundary keep the dialed model's real window
//   (agent/model.ts). On a mixed-size router an auto agent uses the smallest window; raise or drop that model.

import { getDb } from '../db/connection.js';
import { getContextWindow } from '../agent/model.js';
import { MAIN_MODEL_MIN_WINDOW, passesMainModelFloor } from '../agent/main-model-floor.js';
import { agentFloor } from './standing-filters.js';
import { registerRouterFloorName } from '../healer/owner-notices.js';

export const ROUTER_WINDOW_SETTING = 'router.context_window';

const AGENT_TIERS = ['light', 'standard', 'heavy'] as const;

/** The smallest window among the models on the light, standard and heavy tiers, or null when none is. */
export function routerWindowFloor(): { tokens: number; modelName: string; modelId: string } | null {
  let rows: Array<{ model_id: string; name: string | null }>;
  try {
    rows = getDb().prepare(
      `SELECT DISTINCT rtm.model_id, m.name FROM router_tier_models rtm LEFT JOIN models m ON m.id = rtm.model_id
       WHERE rtm.tier_id IN (${AGENT_TIERS.map(() => '?').join(', ')}) AND COALESCE(m.is_enabled, 1) = 1`,
    ).all(...AGENT_TIERS) as Array<{ model_id: string; name: string | null }>;
  } catch {
    return null;
  }
  let floor: { tokens: number; modelName: string; modelId: string } | null = null;
  for (const r of rows) {
    if (r.model_id === 'auto' || r.model_id === '__auto__') continue;
    const tokens = getContextWindow(r.model_id);
    if (tokens >= MAIN_MODEL_MIN_WINDOW && (floor === null || tokens < floor.tokens)) floor = { tokens, modelName: r.name ?? r.model_id, modelId: r.model_id };
  }
  return floor;
}

// The no-fit text names the router's smallest model (`healer/owner-notices.ts`, a light module).
registerRouterFloorName(() => routerWindowFloor()?.modelName ?? null);
agentFloor.mayRun = passesMainModelFloor;

function routerWindowSetting(): number | null {
  try {
    const raw = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(ROUTER_WINDOW_SETTING) as { value: string } | undefined)?.value;
    return raw !== undefined && /^\d+$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function routerWindowTokens(): number | null {
  const floor = routerWindowFloor();
  if (floor === null) return null;
  return Math.min(routerWindowSetting() ?? floor.tokens, floor.tokens);
}

/** For an auto-routed agent: the router's smallest model and the window its picks run at (the owner's
 *  words when that window cannot hold it name these). Null for a fixed-model agent, or with no floor. */
export function autoRouterContext(agentId: string): { modelName: string; floorTokens: number; windowTokens: number } | null {
  if (!isAutoRouted(agentId)) return null;
  const floor = routerWindowFloor();
  const windowTokens = routerWindowTokens();
  return floor === null || windowTokens === null ? null : { modelName: floor.modelName, floorTokens: floor.tokens, windowTokens };
}

export function isAutoRouted(agentId: string): boolean {
  try {
    const modelId = (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id;
    return modelId === 'auto' || modelId === '__auto__';
  } catch {
    return false;
  }
}

export function agentTurnWindow(agentId: string, modelId: string): number {
  const own = getContextWindow(modelId);
  if (!isAutoRouted(agentId)) return own;
  const router = routerWindowTokens();
  return router === null ? own : Math.min(router, own);
}

export interface RouterWindowReport {
  tokens: number;
  floorTokens: number;
  floorModelName: string;
  /** The slider's low end, MEASURED: the smallest window the named agent can run in (instructions, tools
   *  and the output reserve, over the fill line). Above `floorTokens`, that agent cannot run on automatic. */
  minTokens: number;
  minAgentName: string | null;
  /** Agents whose measurement failed: left out of the low end and named, never a failed Router tab. */
  unmeasuredAgentNames: string[];
}

export async function routerWindowReport(): Promise<RouterWindowReport | null> {
  const floor = routerWindowFloor();
  const tokens = routerWindowTokens();
  if (floor === null || tokens === null) return null;
  const [{ measureAgentToolPayloadTokens }, { buildAssemblyContext, assembleSystemFromRegistry }, { estimateTokens, toolAndOutputReserve, CONTEXT_THRESHOLD }, { getModelOutputCap }] = await Promise.all([
    import('../tools/tool-docs.js'), import('../prompt/registry/assembler.js'), import('../memory/budget.js'), import('../agent/model.js'),
  ]);
  const autos = getDb().prepare(
    "SELECT id, name FROM agents WHERE model_id IN ('auto', '__auto__') AND status != 'terminated' ORDER BY name",
  ).all() as Array<{ id: string; name: string }>;
  const outputCap = getModelOutputCap(floor.modelId);
  let minTokens = 0;
  let minAgentName: string | null = null;
  const unmeasuredAgentNames: string[] = [];
  for (const a of autos) {
    try {
      const system = estimateTokens(assembleSystemFromRegistry(buildAssemblyContext(a.id, '__auto__')).text);
      const reserve = toolAndOutputReserve({ toolPayloadTokens: await measureAgentToolPayloadTokens(a.id), maxOutputTokens: outputCap });
      // The inverse of `contextWindowPolicy`: the smallest window whose fill line, less the reserve, holds the prompt.
      const need = Math.ceil((system + reserve) / CONTEXT_THRESHOLD);
      if (need > minTokens) { minTokens = need; minAgentName = a.name; }
    } catch {
      unmeasuredAgentNames.push(a.name);
    }
  }
  return { tokens, floorTokens: floor.tokens, floorModelName: floor.modelName, minTokens, minAgentName, unmeasuredAgentNames };
}
