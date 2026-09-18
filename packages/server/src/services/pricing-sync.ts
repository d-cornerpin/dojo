// Boot-time + on-demand refresh of model pricing for providers whose
// upstream API exposes live numbers (currently: OpenRouter and any other
// /v1/models-compatible endpoint that returns a `pricing` object).
//
// Why this exists: validate ("Sync Models and Pricing") refreshes prices
// already, but users rarely click it. Without a passive sync, the prices
// in the dashboard drift from upstream silently — confusingly, since the
// router and cost tracker still use the stale values. Boot is a natural
// cadence: every process restart re-pulls fresh prices.
//
// Semantics: COALESCE-preserve. If the API returns a price we update it.
// If the API doesn't return a price for a row we already know about, we
// keep what we had — a transient API gap should never wipe known data.
// Same shape as the validate endpoint at gateway/routes/config.ts.
//
// What's NOT synced here:
//   - Anthropic: prices come from a static name→cost map, not the API.
//     Refresh adds no information.
//   - OpenAI: /v1/models doesn't return pricing.
//   - DeepSeek: API doesn't return pricing; static catalog covers it.
//   - Ollama: local models, no pricing.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getProviderCredential } from '../config/loader.js';
import { resolveOpenAIBaseUrl } from '../agent/model.js';

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

const parsePrice = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s) * 1_000_000;
  return Number.isFinite(n) ? n : null;
};

// DeepSeek's API doesn't return pricing on /models, so we skip it. Same
// detection logic as gateway/routes/config.ts to stay consistent.
function isDeepSeekBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  return baseUrl.toLowerCase().includes('deepseek.com');
}

/**
 * T77b — where this provider's model catalog is, by the ONE rule the model client itself uses
 * (`resolveOpenAIBaseUrl`, `agent/model.ts`): bare-host providers keep their root, everyone
 * else gets `/v1`, and a base URL that ALREADY ends in `/v1` is left alone.
 *
 * This used to be `${baseUrl}/v1/models` built by hand — the third copy of the URL rule, and
 * the one T63 missed when it deleted the other two from `gateway/routes/config.ts`. It is
 * byte-identical for OpenRouter (`…/api` → `…/api/v1/models`) and wrong for exactly the case
 * T63 exists for: the base URL a local server prints for you to paste already ends in `/v1`,
 * so the hand-build asked for `…/v1/v1/models` and the boot refresh took a 404 against a box
 * that validates and chats perfectly well.
 *
 * The modality union still rides OpenRouter alone. OpenRouter's `/models` defaults to
 * `output_modalities=text`, which omits image / video / audio-only generators; without the
 * param a user's flux / seedance rows are invisible here and never get their prices refreshed.
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

// Run a price refresh across every validated provider whose type we
// know how to sync. Errors per-provider are logged and swallowed so one
// provider's outage never blocks the rest (or boot itself).
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
