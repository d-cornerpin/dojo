// Generic platform-capability model resolver factory: one platform-wide config key points at a model row that has
// the matching capability flag. getEffectiveModel() returns null when the configured model is missing, disabled or
// has lost the capability. Per-capability concerns (e.g. transcription's `local:whisper`) live in the wrapper module.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getModelCapabilities, type Capability } from './capabilities.js';

export interface CapabilityModelChoice {
  modelId: string;
  providerId: string;
  apiModelId: string;
  /** 'configured' = the user's pick; 'failover' = an enabled same-capability model stood in for an unusable pick. */
  source: 'configured' | 'failover';
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
      // Unconfigured stays null (choosing no model is legitimate); failover only covers an unusable pick.
      if (!configuredId) return null;
      const model = loadEnabledModel(configuredId);
      if (model && rowHasCapability(model)) {
        return {
          modelId: model.id,
          providerId: model.provider_id,
          apiModelId: model.api_model_id,
          source: 'configured',
        };
      }

      logger.warn('Configured capability model is no longer usable — trying failover', {
        configKey,
        capability,
        modelId: configuredId,
      });

      // Bounded failover: one pass over the user's ENABLED models with this capability (enabling a model is the
      // consent boundary), preferring the configured pick's provider, then name order. No retries.
      try {
        const configuredProvider = (getDb()
          .prepare(`SELECT provider_id FROM models WHERE id = ?`)
          .get(configuredId) as { provider_id: string } | undefined)?.provider_id ?? null;
        const candidates = getDb()
          .prepare(`SELECT id, provider_id, api_model_id, is_enabled FROM models WHERE is_enabled = 1 AND id != ? ORDER BY name ASC`)
          .all(configuredId) as ModelRow[];
        const ordered = [
          ...candidates.filter((c) => c.provider_id === configuredProvider),
          ...candidates.filter((c) => c.provider_id !== configuredProvider),
        ];
        for (const candidate of ordered) {
          if (!rowHasCapability(candidate)) continue;
          logger.warn('Capability failover engaged', {
            configKey,
            capability,
            from: configuredId,
            to: candidate.id,
          });
          return {
            modelId: candidate.id,
            providerId: candidate.provider_id,
            apiModelId: candidate.api_model_id,
            source: 'failover',
          };
        }
      } catch { /* fall through to null */ }

      logger.error('Capability has no usable model (configured pick down, no enabled fallback)', {
        configKey,
        capability,
        modelId: configuredId,
      });
      return null;
    },
  };
}
