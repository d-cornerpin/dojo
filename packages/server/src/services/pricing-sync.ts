// Boot-time and on-demand refresh of model pricing for providers whose upstream API exposes live numbers
// (OpenRouter and any other /v1/models-compatible endpoint that returns a `pricing` object). Without a
// passive sync the dashboard prices drift from upstream, while the router and cost tracker use the stale values.
//
// COALESCE-preserve: a price the API returns updates the row; a row the API omits keeps what it had, so a
// transient gap never wipes known data. Same shape as the validate endpoint in gateway/routes/config.ts.
//
// Not synced: Anthropic (static name-to-cost map), OpenAI and DeepSeek (/models returns no pricing), Ollama (local).

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getProviderCredential } from '../config/loader.js';
import { resolveOpenAIBaseUrl } from '../agent/model.js';
import { parsePrice } from './price-per-million.js';

const logger = createLogger('pricing-sync');

interface ProviderRow {
  id: string;
  type: string;
  base_url: string | null;
  is_validated: number;
}

interface OpenAiCompatibleModelResponse {
  data?: Array<{
    id: string;
    name?: string;
    context_length?: number;
    top_provider?: { max_completion_tokens?: number; context_length?: number };
    pricing?: { prompt?: string; completion?: string };
  }>;
}

// DeepSeek's /models returns no pricing, so it is skipped; same detection as gateway/routes/config.ts.
function isDeepSeekBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  return baseUrl.toLowerCase().includes('deepseek.com');
}

/**
 * Where this provider's model catalog is, by the one rule the model client uses (`resolveOpenAIBaseUrl`,
 * `agent/model.ts`): bare-host providers keep their root, everyone else gets `/v1`, and a base URL that
 * already ends in `/v1` is left alone.
 *
 * The modality union rides OpenRouter alone: its `/models` defaults to `output_modalities=text`, which omits
 * image / video / audio-only generators, so without the param those rows never get their prices refreshed.
 * No other provider honours it.
 */
export function providerModelsUrl(baseUrl: string): string {
  const root = resolveOpenAIBaseUrl(baseUrl) ?? baseUrl.replace(/\/+$/, '');
  return root.includes('openrouter.ai')
    ? `${root}/models?output_modalities=text,image,audio,video`
    : `${root}/models`;
}

async function syncOpenAiCompatibleProvider(provider: ProviderRow): Promise<{ updated: number; skipped: boolean }> {
  if (isDeepSeekBaseUrl(provider.base_url)) {
    return { updated: 0, skipped: true };
  }

  const credential = getProviderCredential(provider.id);
  if (!credential) {
    return { updated: 0, skipped: true };
  }

  const modelsUrl = providerModelsUrl(provider.base_url || 'https://openrouter.ai/api');
  const response = await fetch(modelsUrl, {
    headers: {
      Authorization: `Bearer ${credential}`,
      'HTTP-Referer': 'https://dojo.dev',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`provider /v1/models returned ${response.status}`);
  }

  const json = (await response.json()) as OpenAiCompatibleModelResponse;
  const apiModels = json.data ?? [];
  const apiMap = new Map(apiModels.map((m) => [m.id, m]));

  const db = getDb();
  const existing = db
    .prepare('SELECT id, api_model_id FROM models WHERE provider_id = ?')
    .all(provider.id) as Array<{ id: string; api_model_id: string }>;

  const stmt = db.prepare(`
    UPDATE models SET
      input_cost_per_m = COALESCE(?, input_cost_per_m),
      output_cost_per_m = COALESCE(?, output_cost_per_m),
      updated_at = datetime('now')
    WHERE id = ?
  `);

  let updated = 0;
  for (const row of existing) {
    const api = apiMap.get(row.api_model_id);
    if (!api) continue;
    const input = parsePrice(api.pricing?.prompt);
    const output = parsePrice(api.pricing?.completion);
    if (input === null && output === null) continue;
    stmt.run(input, output, row.id);
    updated++;
  }

  return { updated, skipped: false };
}

// Refresh prices across every validated provider whose type we can sync. A provider's error is logged and
// swallowed so one outage never blocks the rest (or boot).
export async function syncAllProviderPricing(): Promise<void> {
  const db = getDb();
  const providers = db
    .prepare('SELECT id, type, base_url, is_validated FROM providers WHERE is_validated = 1')
    .all() as ProviderRow[];

  if (providers.length === 0) {
    logger.info('Pricing sync: no validated providers, nothing to do');
    return;
  }

  let totalUpdated = 0;
  let providersTouched = 0;
  let providersSkipped = 0;

  for (const provider of providers) {
    if (provider.type !== 'openai-compatible') {
      providersSkipped++;
      continue;
    }
    try {
      const { updated, skipped } = await syncOpenAiCompatibleProvider(provider);
      if (skipped) {
        providersSkipped++;
        continue;
      }
      providersTouched++;
      totalUpdated += updated;
      if (updated > 0) {
        logger.info('Pricing sync: refreshed provider', {
          providerId: provider.id,
          modelsUpdated: updated,
        });
      }
    } catch (err) {
      logger.warn('Pricing sync: provider refresh failed', {
        providerId: provider.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Pricing sync complete', {
    providersTouched,
    providersSkipped,
    totalModelsUpdated: totalUpdated,
  });
}
