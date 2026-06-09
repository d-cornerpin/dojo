// ════════════════════════════════════════
// services/image-gen-model.ts — centralized image-generation model
// resolution. Replaces the Imaginer agent's per-agent image_model
// config: image generation is a model capability, not an agent role,
// so it lives at the platform-config level alongside the fallback
// vision model picker.
//
// Resolution: a single platform-wide config key
// `dojo_image_gen_model_id` points at one image-capable model that
// the `image_create` tool calls directly. There is no agent-own
// fallback (every Sensei / Ronin / Apprentice gets the same image
// gen model) because the calling agent's own model is virtually
// never an image-gen model (those don't support tool calling and
// can't carry a conversation, so they're never primary agent models).
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getModelCapabilities } from './capabilities.js';

const logger = createLogger('image-gen-model');

export const IMAGE_GEN_MODEL_CONFIG_KEY = 'dojo_image_gen_model_id';

export interface ImageGenModelChoice {
  modelId: string;
  providerId: string;
  apiModelId: string;
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

function rowHasImageGen(row: ModelRow | null): boolean {
  if (!row) return false;
  const caps = getModelCapabilities(row.id);
  return caps.includes('image_generation');
}

/**
 * Read the configured image-gen model ID (or null if unset). Does NOT
 * validate that the model still exists or is enabled — use
 * getEffectiveImageGenModel() for the full resolution including
 * validation.
 */
export function getConfiguredImageGenModelId(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM config WHERE key = ?`)
      .get(IMAGE_GEN_MODEL_CONFIG_KEY) as { value: string } | undefined;
    const v = row?.value?.trim();
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Set (or clear) the configured image-gen model. Pass null to clear.
 */
export function setConfiguredImageGenModelId(modelId: string | null): void {
  const db = getDb();
  if (modelId === null || modelId.trim().length === 0) {
    db.prepare(`DELETE FROM config WHERE key = ?`).run(IMAGE_GEN_MODEL_CONFIG_KEY);
    return;
  }
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(IMAGE_GEN_MODEL_CONFIG_KEY, modelId, modelId);
}

/**
 * Resolve the image-gen model. Returns null if no usable image-gen
 * path exists (no model configured, or the configured model is
 * disabled / missing / no longer has image_generation capability).
 */
export function getEffectiveImageGenModel(): ImageGenModelChoice | null {
  const configuredId = getConfiguredImageGenModelId();
  if (!configuredId) return null;
  const model = loadEnabledModel(configuredId);
  if (!model || !rowHasImageGen(model)) {
    logger.warn('getEffectiveImageGenModel: configured model is no longer usable', {
      modelId: configuredId,
    });
    return null;
  }
  return {
    modelId: model.id,
    providerId: model.provider_id,
    apiModelId: model.api_model_id,
  };
}
