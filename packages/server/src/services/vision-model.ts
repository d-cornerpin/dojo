// ════════════════════════════════════════
// services/vision-model.ts — centralized vision-model resolution.
//
// Background: before this helper existed, two different tools each had
// their own findVisionModel() with its own auto-pick heuristic
// (browser.ts and system-control.ts). Both silently picked a model
// without telling the user. That hid an important config decision
// (which model handles vision work? at what cost? at what quality?)
// behind a "cheapest vision-ish model" heuristic that could surprise
// the user.
//
// This module replaces both. Resolution order, applied everywhere on
// the platform that needs vision:
//   1. The calling agent's own model, if it's vision-capable and
//      enabled — fastest path, one model end-to-end, no extra hop.
//   2. The configured fallback vision model (config key
//      `dojo_fallback_vision_model_id`), if set and still pointing at
//      an enabled vision-capable model.
//   3. null — the caller decides what to do (usually: tell the user
//      that vision is unavailable, and degrade gracefully).
//
// There is intentionally NO step "auto-pick the cheapest vision
// model." That was the old hidden behavior. Forcing the user to set a
// fallback explicitly means they always know which model is doing the
// seeing.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getModelCapabilities } from './capabilities.js';

const logger = createLogger('vision-model');

export const FALLBACK_VISION_MODEL_CONFIG_KEY = 'dojo_fallback_vision_model_id';

export interface VisionModelChoice {
  modelId: string;
  providerId: string;
  apiModelId: string;
  source: 'agent_own' | 'fallback';
}

interface ModelRow {
  id: string;
  provider_id: string;
  api_model_id: string;
  is_enabled: number;
  capabilities: string | null;
}

function loadEnabledModel(modelId: string): ModelRow | null {
  try {
    const row = getDb()
      .prepare(`SELECT id, provider_id, api_model_id, is_enabled, capabilities FROM models WHERE id = ?`)
      .get(modelId) as ModelRow | undefined;
    if (!row) return null;
    if (!row.is_enabled) return null;
    return row;
  } catch {
    return null;
  }
}

function rowHasVision(row: ModelRow | null): boolean {
  if (!row) return false;
  const caps = getModelCapabilities(row.id);
  return caps.includes('vision');
}

/**
 * Read the configured fallback vision model ID (or null if unset).
 * Does NOT validate that the model still exists or is enabled — use
 * getEffectiveVisionModel() for the full resolution including validation.
 */
export function getConfiguredFallbackVisionModelId(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM config WHERE key = ?`)
      .get(FALLBACK_VISION_MODEL_CONFIG_KEY) as { value: string } | undefined;
    const v = row?.value?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Set (or clear) the configured fallback vision model. Pass null to clear.
 */
export function setConfiguredFallbackVisionModelId(modelId: string | null): void {
  const db = getDb();
  if (modelId === null || modelId.trim().length === 0) {
    db.prepare(`DELETE FROM config WHERE key = ?`).run(FALLBACK_VISION_MODEL_CONFIG_KEY);
    return;
  }
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(FALLBACK_VISION_MODEL_CONFIG_KEY, modelId, modelId);
}

/**
 * Resolve the vision model to use for a given calling agent. Returns
 * null if no usable vision path exists (agent's own model can't see AND
 * no fallback is configured / the configured fallback is invalid).
 */
export function getEffectiveVisionModel(agentId: string | null): VisionModelChoice | null {
  // Step 1 — agent's own model, if vision-capable.
  if (agentId) {
    try {
      const db = getDb();
      const agentRow = db
        .prepare(`SELECT model_id FROM agents WHERE id = ?`)
        .get(agentId) as { model_id: string | null } | undefined;
      const ownId = agentRow?.model_id ?? null;
      if (ownId) {
        const ownModel = loadEnabledModel(ownId);
        if (ownModel && rowHasVision(ownModel)) {
          return {
            modelId: ownModel.id,
            providerId: ownModel.provider_id,
            apiModelId: ownModel.api_model_id,
            source: 'agent_own',
          };
        }
      }
    } catch (err) {
      logger.warn('getEffectiveVisionModel: failed to look up agent own model', {
        agentId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 2 — configured fallback.
  const fallbackId = getConfiguredFallbackVisionModelId();
  if (fallbackId) {
    const fallbackModel = loadEnabledModel(fallbackId);
    if (fallbackModel && rowHasVision(fallbackModel)) {
      return {
        modelId: fallbackModel.id,
        providerId: fallbackModel.provider_id,
        apiModelId: fallbackModel.api_model_id,
        source: 'fallback',
      };
    }
    // Fallback configured but invalid (disabled, deleted, lost vision
    // capability). Log and proceed to step 3.
    logger.warn('Configured fallback vision model is no longer usable', {
      configuredId: fallbackId,
      enabled: !!fallbackModel,
      hasVision: rowHasVision(fallbackModel),
    });
  }

  // Step 3 — no usable path.
  return null;
}

/**
 * List every enabled vision-capable model on the platform. Used by the
 * Settings UI to populate the fallback-vision-model dropdown, and by
 * the startup migration to decide whether there's an obvious single
 * choice to auto-set.
 */
export interface VisionCandidate {
  id: string;
  providerId: string;
  apiModelId: string;
  name: string;
  providerName: string;
  inputCostPerM: number | null;
}

export function listEnabledVisionModels(): VisionCandidate[] {
  try {
    const rows = getDb().prepare(`
      SELECT m.id, m.provider_id, m.api_model_id, m.name, m.input_cost_per_m, p.name AS provider_name
      FROM models m
      JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1
      ORDER BY COALESCE(m.input_cost_per_m, 999) ASC, m.name ASC
    `).all() as Array<{
      id: string; provider_id: string; api_model_id: string; name: string;
      input_cost_per_m: number | null; provider_name: string;
    }>;
    const out: VisionCandidate[] = [];
    for (const r of rows) {
      const caps = getModelCapabilities(r.id);
      if (!caps.includes('vision')) continue;
      out.push({
        id: r.id,
        providerId: r.provider_id,
        apiModelId: r.api_model_id,
        name: r.name,
        providerName: r.provider_name,
        inputCostPerM: r.input_cost_per_m,
      });
    }
    return out;
  } catch (err) {
    logger.warn('listEnabledVisionModels failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Startup migration / boot helper. If no fallback vision model is
 * currently configured AND exactly one enabled vision-capable model
 * exists, silently set it as the fallback. Preserves working setups
 * for users upgrading from the auto-pick era. If multiple vision
 * models exist, leave the config empty so the Settings UI can prompt
 * the user to choose explicitly. If zero exist, do nothing.
 */
export function autoConfigureFallbackVisionModelIfObvious(): void {
  try {
    if (getConfiguredFallbackVisionModelId()) return;
    const candidates = listEnabledVisionModels();
    if (candidates.length !== 1) return;
    const only = candidates[0];
    setConfiguredFallbackVisionModelId(only.id);
    logger.info('Auto-configured fallback vision model (sole candidate)', {
      modelId: only.id, apiModelId: only.apiModelId, providerName: only.providerName,
    });
  } catch (err) {
    logger.warn('autoConfigureFallbackVisionModelIfObvious failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
