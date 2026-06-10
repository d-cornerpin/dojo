// ════════════════════════════════════════
// services/capability-model.ts — generic platform-capability model
// resolver factory.
//
// Several capabilities (image_generation, vision, video_generation,
// audio_generation, transcription) all share the same shape: one
// platform-wide config key points at a model row that has the
// matching capability flag. Without a factory, each new capability
// would re-duplicate ~100 lines of identical lookup + validation.
//
// Use makeCapabilityModelResolver to get:
//   getConfiguredModelId() — raw id from config table, no validation
//   setConfiguredModelId(id) — write (pass null to clear)
//   getEffectiveModel()    — full resolution, returns null if the
//                            configured model is missing, disabled,
//                            or no longer has the capability
//
// Per-capability concerns (e.g. transcription's `local:whisper`
// pseudo-entry) live in their wrapper module, not here.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getModelCapabilities, type Capability } from './capabilities.js';

export interface CapabilityModelChoice {
  modelId: string;
  providerId: string;
  apiModelId: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  api_model_id: string;
  is_enabled: number;
}

export interface CapabilityModelResolver {
  getConfiguredModelId(): string | null;
  setConfiguredModelId(modelId: string | null): void;
  getEffectiveModel(): CapabilityModelChoice | null;
}

export function makeCapabilityModelResolver(opts: {
  configKey: string;
  capability: Capability;
  loggerName: string;
}): CapabilityModelResolver {
  const { configKey, capability, loggerName } = opts;
  const logger = createLogger(loggerName);

  function loadEnabledModel(modelId: string): ModelRow | null {
    try {
      const row = getDb()
        .prepare(`SELECT id, provider_id, api_model_id, is_enabled FROM models WHERE id = ?`)
        .get(modelId) as ModelRow | undefined;
      if (!row) return null;
      if (!row.is_enabled) return null;
      return row;
    } catch {
      return null;
    }
  }

  function rowHasCapability(row: ModelRow | null): boolean {
    if (!row) return false;
    return getModelCapabilities(row.id).includes(capability);
  }

  return {
    getConfiguredModelId(): string | null {
      try {
        const row = getDb()
          .prepare(`SELECT value FROM config WHERE key = ?`)
          .get(configKey) as { value: string } | undefined;
        const v = row?.value?.trim();
        return v && v.length > 0 ? v : null;
      } catch {
        return null;
      }
    },
    setConfiguredModelId(modelId: string | null): void {
      const db = getDb();
      if (modelId === null || modelId.trim().length === 0) {
        db.prepare(`DELETE FROM config WHERE key = ?`).run(configKey);
        return;
      }
      db.prepare(`
        INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(configKey, modelId, modelId);
    },
    getEffectiveModel(): CapabilityModelChoice | null {
      const configuredId = this.getConfiguredModelId();
      if (!configuredId) return null;
      const model = loadEnabledModel(configuredId);
      if (!model || !rowHasCapability(model)) {
        logger.warn('Configured capability model is no longer usable', {
          configKey,
          capability,
          modelId: configuredId,
        });
        return null;
      }
      return {
        modelId: model.id,
        providerId: model.provider_id,
        apiModelId: model.api_model_id,
      };
    },
  };
}
