// Generic platform-capability model resolver factory: one platform-wide config key points at a model row that has
// the matching capability flag. getEffectiveModel() returns null when the configured model is missing, disabled or
// has lost the capability. Per-capability concerns (e.g. transcription's `local:whisper`) live in the wrapper module.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
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
      setConfigValue(configKey, modelId);
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

/** One sentence for a tool result when a stand-in model ran instead of the one chosen in Settings: its name and
 *  its price. Empty when the chosen model ran. */
export function standInSentence(choice: CapabilityModelChoice): string {
  if (choice.source !== 'failover') return '';
  const row = getDb()
    .prepare('SELECT name, input_cost_per_m, output_cost_per_m, cost_per_unit, pricing_unit FROM models WHERE id = ?')
    .get(choice.modelId) as { name: string; input_cost_per_m: number | null; output_cost_per_m: number | null; cost_per_unit: number | null; pricing_unit: string | null } | undefined;
  const price = !row ? 'not set'
    : row.pricing_unit && row.pricing_unit !== 'token' && row.cost_per_unit !== null ? `$${row.cost_per_unit} per ${row.pricing_unit}`
    : row.input_cost_per_m !== null && row.output_cost_per_m !== null ? `$${row.input_cost_per_m} per million input tokens and $${row.output_cost_per_m} per million output tokens`
    : 'not set';
  return ` The model chosen in Settings could not be used, so this ran on the stand-in model "${row?.name ?? choice.modelId}" (price: ${price}). Tell the person which model was used and its price.`;
}
