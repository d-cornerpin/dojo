// Centralized vision-model resolution. Order: (1) the calling agent's own model if enabled and vision-capable;
// (2) the configured fallback (`dojo_fallback_vision_model_id`) if it still points at an enabled vision model;
// (3) null, and the caller degrades. There is deliberately no auto-pick of the cheapest vision model, so the
// user always knows which model is doing the seeing.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
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

/** The configured fallback vision model ID, or null. Not validated; getEffectiveVisionModel does that. */
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

/** Set (or clear, with null) the configured fallback vision model. */
export function setConfiguredFallbackVisionModelId(modelId: string | null): void {
  const db = getDb();
  if (modelId === null || modelId.trim().length === 0) {
    db.prepare(`DELETE FROM config WHERE key = ?`).run(FALLBACK_VISION_MODEL_CONFIG_KEY);
    return;
  }
  setConfigValue(FALLBACK_VISION_MODEL_CONFIG_KEY, modelId);
}

/** The vision model for a calling agent, or null when neither its own model nor a valid fallback can see. */
export function getEffectiveVisionModel(agentId: string | null): VisionModelChoice | null {
  // Step 1: the agent's own model.
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

  // Step 2: the configured fallback.
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
    // Fallback configured but unusable (disabled, deleted, lost vision): log and fall through.
    logger.warn('Configured fallback vision model is no longer usable', {
      configuredId: fallbackId,
      enabled: !!fallbackModel,
      hasVision: rowHasVision(fallbackModel),
    });
  }

  // Step 3: no usable path.
  return null;
}

/** One enabled vision-capable model, as listed for the Settings fallback dropdown and the boot auto-configure. */
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
 * Boot helper: with no fallback configured and exactly one enabled vision-capable model, set it as the
 * fallback; with several, leave it empty so the Settings UI prompts the user.
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
