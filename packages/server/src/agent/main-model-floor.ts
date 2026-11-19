// A model under a 32K memory window cannot be an agent's MAIN model: the doors that set it refuse
// it plainly. Helper jobs untouched; unknown windows and the auto-router pass (unknown is not small).

import { getDb } from '../db/connection.js';
import { effectiveContextWindow, resolveNumCtx } from './model.js';
import { refuseUnfitLocalModel } from './local-model-fit.js';
import { createLogger } from '../logger.js';
import { setAgentModel } from './model-switch.js';
import { tellOwner, ownerConditionCleared } from '../healer/owner-notices.js';
import { isStandardModelRow } from '../services/local-standard.js';
const logger = createLogger('main-model-floor');

/** The floor, in tokens. "32K" models are advertised as 32,000 or 32,768; both pass. */
export const MAIN_MODEL_MIN_WINDOW = 32_000;

interface WindowRow {
  name: string;
  context_window: number | null;
  num_ctx_override: number | null;
  num_ctx_recommended: number | null;
}

/** The window this model's calls are budgeted against (under `numCtxOverride` when given) and `now`, under the
 *  stored override; null when it declared none. */
export function windowOf(modelId: string, numCtxOverride?: number | null): { name: string; window: number; now: number } | null {
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
  const under = (o: number | null): number => effectiveContextWindow(declared, resolveNumCtx({ numCtxOverride: o, numCtxRecommended: row.num_ctx_recommended }).effective);
  return { name: row.name, window: under(numCtxOverride === undefined ? row.num_ctx_override : numCtxOverride), now: under(row.num_ctx_override) };
}

function kLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}K`;
}

export function smallMainModelMessage(name: string, window: number): string {
  return `${name} has a memory window of about ${kLabel(window)} tokens, which is too small for an agent's main model. `
    + 'An agent needs at least 32K to hold a conversation together with its tools and instructions. '
    + 'Choose a model with a bigger window for this agent; small models can still do helper jobs such as titles and summaries.';
}

/** The refusal for SETTING `modelId` as an agent's main model, or null when it is fine: re-saving
 *  the model the agent already runs is not a change and is never refused: agents keep working. */
export function refuseSmallMainModel(
  modelId: string | null | undefined,
  currentModelId?: string | null,
  numCtxOverride?: number | null,
): string | null {
  if (!modelId || modelId === currentModelId) return null;
  const w = windowOf(modelId, numCtxOverride);
  if (!w || w.window >= MAIN_MODEL_MIN_WINDOW) return null;
  return smallMainModelMessage(w.name, w.window);
}

/** True for a model that makes pictures, video, music or speech, embeds text, or is the Dojo's own decision model. */
export function isNonChatModel(capabilitiesJson: string | null | undefined): boolean {
  let caps: unknown;
  try { caps = JSON.parse(capabilitiesJson ?? '[]'); } catch { return false; }
  return Array.isArray(caps) && caps.some((c) => typeof c === 'string' && (c.endsWith('generation') || c === 'embedding' || c === 'decision'));
}

/** The refusal for setting a model that is not a chat model as an agent's model; null for a chat model, an unknown
 *  id, 'auto', or the model the agent already runs (re-saving is never refused). */
function refuseNonChatModel(modelId: string | null | undefined, currentModelId?: string | null): string | null {
  if (!modelId || modelId === currentModelId || modelId === 'auto') return null;
  let row: { name: string; capabilities: string | null } | undefined;
  try {
    row = getDb().prepare('SELECT name, capabilities FROM models WHERE id = ?').get(modelId) as typeof row;
  } catch { return null; }
  if (!row || !isNonChatModel(row.capabilities)) return null;
  return `${row.name} is not a chat model: it makes pictures, video, music or speech, embeds text, or is the Dojo's own decision model. An agent needs a chat model; choose another one.`;
}

/** Why a picker cannot offer this model as an agent's model, in the few words the picker shows; null when it can. */
export function notForAgentsReason(modelId: string): string | null {
  if (refuseNonChatModel(modelId) !== null) return 'not a chat model';
  if (!passesMainModelFloor(modelId)) return 'too small for an agent';
  return null;
}

/** THE door check for choosing a model for an agent: not a chat model first, then memory fit (so a refusal names the
 *  true reason), then the floor. Null means the model may be set. Every route and tool that picks an agent's model
 *  asks this; a spawn asks its two parts itself, since its model may be 'auto'. */
export async function refuseAgentModel(modelId: string | null | undefined, currentModelId?: string | null): Promise<string | null> {
  return refuseNonChatModel(modelId, currentModelId)
    ?? refuseUnfitLocalModel(modelId, currentModelId, 'agent', () => refuseSmallMainModel(modelId, currentModelId));
}

/** The one pick for "this agent needs another model": cheapest enabled chat model outside `exclude` that clears the
 *  floor. Never the router sentinel (no model) and never the Dojo's own small writer model. */
export function cheapestAgentModel(exclude: readonly string[] = []): string | null {
  const rows = getDb().prepare(
    `SELECT id, capabilities FROM models
      WHERE is_enabled = 1 AND id != 'auto' AND id NOT IN (${exclude.map(() => '?').join(',')})
      ORDER BY COALESCE(input_cost_per_m, 1e18) ASC, id ASC`,
  ).all(...exclude) as Array<{ id: string; capabilities: string | null }>;
  return rows.find((m) => !isNonChatModel(m.capabilities) && !isStandardModelRow(m.id) && refuseSmallMainModel(m.id) === null)?.id ?? null;
}

/** Moves every live agent on one of `modelIds` (and the service agents' model settings) to the cheapest big-enough
 *  model through the one setter; with none, the agents are left without a model and counted. */
export async function reassignAffectedAgents(
  modelIds: string[], fallbackId = cheapestAgentModel(modelIds),
): Promise<{ agentsMoved: number; agentsWithoutModel: number }> {
  const db = getDb();
  const marks = modelIds.map(() => '?').join(',');
  const live = (db.prepare(`SELECT id FROM agents WHERE model_id IN (${marks}) AND status != 'terminated'`)
    .all(...modelIds) as Array<{ id: string }>).map((a) => a.id);
  if (!fallbackId) {
    db.prepare(`UPDATE agents SET model_id = NULL, updated_at = datetime('now') WHERE model_id IN (${marks}) AND status != 'terminated'`).run(...modelIds);
    return { agentsMoved: 0, agentsWithoutModel: live.length };
  }
  db.prepare(
    `UPDATE config SET value = ?, updated_at = datetime('now')
      WHERE value IN (${marks}) AND key IN (${MAIN_MODEL_SETTING_KEYS.map(() => '?').join(',')})`,
  ).run(fallbackId, ...modelIds, ...MAIN_MODEL_SETTING_KEYS);
  for (const id of live) {
    try { await setAgentModel(id, fallbackId); } catch (err) {
      logger.warn('A moved agent\'s no-fit park could not be looked at again', {
        agentId: id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { agentsMoved: live.length, agentsWithoutModel: 0 };
}

/** Live agents on a model known to be under the floor; an unknown window is not small. */
export function agentsUnderFloor(): Array<{ name: string; modelId: string; modelName: string }> {
  const rows = getDb().prepare(
    "SELECT name, model_id AS modelId FROM agents WHERE status != 'terminated' AND model_id IS NOT NULL ORDER BY name",
  ).all() as Array<{ name: string; modelId: string }>;
  return rows.flatMap((r) => {
    const w = windowOf(r.modelId);
    return w && w.window < MAIN_MODEL_MIN_WINDOW ? [{ ...r, modelName: w.name }] : [];
  });
}

/** At start: each live agent on a too-small model moves to the cheapest big-enough model that is switched on, and the
 *  owner gets one card naming them; with no such model they stay and the card says who needs a pick. Nothing to do
 *  once nobody is under the floor, so every start may run it. */
export async function moveAgentsOffSmallModels(): Promise<void> {
  const small = agentsUnderFloor();
  const to = cheapestAgentModel();
  if (small.length === 0 || to) ownerConditionCleared('smallmodel:stuck');
  if (small.length === 0) return;
  if (!to) {
    const names = small.map((a) => `${a.name} (${a.modelName})`).join(', ');
    const one = small.length === 1;
    tellOwner('smallmodel:stuck', `${names} ${one ? 'is' : 'are'} on a model whose memory window is too small to hold a conversation, `
      + `and no bigger model is switched on to move ${one ? 'it' : 'them'} to. `
      + 'Switch on a model with a bigger memory window in Settings, or pick one on the agent\'s detail page.');
    return;
  }
  await reassignAffectedAgents([...new Set(small.map((a) => a.modelId))], to);
  const target = getDb().prepare('SELECT name, input_cost_per_m AS cost FROM models WHERE id = ?').get(to) as { name: string; cost: number | null };
  ownerConditionCleared('smallmodel:moved');   // a new move is a new telling
  const moved = small.map((a) => `${a.name} (from ${a.modelName})`).join(', ');
  const paid = (target.cost ?? 0) > 0 ? ', which is a paid model' : '';
  tellOwner('smallmodel:moved', `The Dojo moved ${moved} to ${target.name}${paid}, `
    + 'because a model with so small a memory window cannot hold a conversation. '
    + 'You can pick a different model for any agent on its detail page.');
}

/** The model a service agent is created or reactivated on: its setting, else the main agent's. One that cannot run an
 *  agent (under the floor, or not a chat model) is replaced by the cheapest model that can ('auto' when none can). */
export function serviceAgentModelId(settingKey: string, primaryId: string): string | null {
  const db = getDb();
  const picked = (db.prepare('SELECT value FROM config WHERE key = ?').get(settingKey) as { value: string } | undefined)?.value
    || (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined)?.model_id || null;
  if (!picked || (refuseSmallMainModel(picked) === null && refuseNonChatModel(picked) === null)) return picked;
  const replacement = cheapestAgentModel([picked]) ?? 'auto';
  logger.warn('A service agent\'s model cannot run an agent; replaced', { settingKey, from: picked, to: replacement });
  return replacement;
}

export function passesMainModelFloor(modelId: string): boolean { return refuseSmallMainModel(modelId) === null; }

/** Config keys picking a service agent's MAIN model; the settings route guards these before writing. */
export const MAIN_MODEL_SETTING_KEYS: readonly string[] = [
  'healer_model_id', 'dreaming_model_id', 'pm_agent_model', 'trainer_agent_model',
];

/** Config keys picking a LOCAL model the memory-fit gate judges: main models above plus the engine jobs. */
export const LOCAL_MODEL_SETTING_KEYS: readonly string[] = [...MAIN_MODEL_SETTING_KEYS, 'voice.opener_model', 'dojo_fallback_vision_model_id'];
