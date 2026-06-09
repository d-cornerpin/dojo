// Refresh Anthropic / OpenAI / DeepSeek model pricing from the LiteLLM
// community-maintained price index. Those providers' own APIs don't
// expose pricing, and DOJO previously shipped a static cost map that
// drifted out of date whenever a provider re-priced. This service
// fetches the LiteLLM JSON on boot, matches it against existing DB
// rows by api_model_id, and COALESCE-updates pricing in place.
//
// Source: https://github.com/BerriAI/litellm — they publish a single
// JSON file (`model_prices_and_context_window.json`) keyed by API model
// id, with `input_cost_per_token` / `output_cost_per_token` as decimal
// per-token numbers. We multiply by 1e6 to land in DOJO's $/M-tokens
// unit.
//
// Run status (success/failure, timestamp, error, models-updated count)
// is persisted into the config table so the Costs page can render a
// little green-check / red-x box. Boot fires this in the background;
// users can also trigger it on demand.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('litellm-pricing-sync');

const LITELLM_JSON_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Status config keys — read by the /pricing-sync/status endpoint.
const KEY_STATUS = 'litellm_sync_status';        // 'success' | 'failure'
const KEY_AT = 'litellm_sync_at';                // ISO timestamp
const KEY_UPDATED_COUNT = 'litellm_sync_updated_count'; // string number
const KEY_ERROR = 'litellm_sync_error';          // last error message (cleared on success)
const KEY_PROVIDERS_TOUCHED = 'litellm_sync_providers_touched'; // string number

interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  litellm_provider?: string;
  mode?: string;
}

// DOJO provider-type → which litellm_provider strings we accept for it.
// (LiteLLM keys are unique across providers, but we still gate by
// litellm_provider to avoid matching e.g. an "openrouter/" namespaced
// entry against an OpenAI row that happens to share an id.)
function acceptedLiteLlmProvidersForRow(
  providerType: string,
  providerBaseUrl: string | null,
): string[] | null {
  if (providerType === 'anthropic') return ['anthropic'];
  if (providerType === 'openai') return ['openai'];
  if (providerType === 'openai-compatible') {
    const lower = (providerBaseUrl ?? '').toLowerCase();
    if (lower.includes('deepseek.com')) return ['deepseek'];
    // OpenRouter has its own live /v1/models pricing — handled by the
    // sibling `pricing-sync.ts` service. Skipping it here avoids two
    // sources writing to the same rows.
    return null;
  }
  return null;
}

function persistStatus(status: 'success' | 'failure', meta: {
  updatedCount: number;
  providersTouched: number;
  error?: string;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO config (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);
  upsert.run(KEY_STATUS, status);
  upsert.run(KEY_AT, now);
  upsert.run(KEY_UPDATED_COUNT, String(meta.updatedCount));
  upsert.run(KEY_PROVIDERS_TOUCHED, String(meta.providersTouched));
  if (status === 'success') {
    // Clear any stale error on a clean run.
    db.prepare('DELETE FROM config WHERE key = ?').run(KEY_ERROR);
  } else if (meta.error) {
    upsert.run(KEY_ERROR, meta.error);
  }
}

export interface LitellmSyncStatus {
  lastStatus: 'success' | 'failure' | null;
  lastRunAt: string | null;
  lastUpdatedCount: number | null;
  lastProvidersTouched: number | null;
  lastError: string | null;
}

export function getLitellmSyncStatus(): LitellmSyncStatus {
  const db = getDb();
  const read = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const status = read(KEY_STATUS);
  return {
    lastStatus: status === 'success' || status === 'failure' ? status : null,
    lastRunAt: read(KEY_AT),
    lastUpdatedCount: read(KEY_UPDATED_COUNT) ? Number(read(KEY_UPDATED_COUNT)) : null,
    lastProvidersTouched: read(KEY_PROVIDERS_TOUCHED) ? Number(read(KEY_PROVIDERS_TOUCHED)) : null,
    lastError: read(KEY_ERROR),
  };
}

export async function syncLitellmPricing(): Promise<LitellmSyncStatus> {
  try {
    logger.info('Fetching LiteLLM price index', { url: LITELLM_JSON_URL });
    const response = await fetch(LITELLM_JSON_URL, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`LiteLLM JSON fetch returned HTTP ${response.status}`);
    }
    const text = await response.text();
    const json = JSON.parse(text) as Record<string, LiteLlmEntry>;

    const db = getDb();
    // Pull every model row alongside the parent provider's type / baseUrl
    // so we know which litellm_provider strings count as a valid match.
    const rows = db.prepare(`
      SELECT m.id AS model_id, m.api_model_id, p.type AS provider_type, p.base_url
      FROM models m
      JOIN providers p ON p.id = m.provider_id
    `).all() as Array<{
      model_id: string;
      api_model_id: string;
      provider_type: string;
      base_url: string | null;
    }>;

    const update = db.prepare(`
      UPDATE models SET
        input_cost_per_m = COALESCE(?, input_cost_per_m),
        output_cost_per_m = COALESCE(?, output_cost_per_m),
        updated_at = datetime('now')
      WHERE id = ?
    `);

    let updatedCount = 0;
    const providersWithMatches = new Set<string>();

    for (const row of rows) {
      const accepted = acceptedLiteLlmProvidersForRow(row.provider_type, row.base_url);
      if (!accepted) continue;
      const entry = json[row.api_model_id];
      if (!entry) continue;
      if (entry.litellm_provider && !accepted.includes(entry.litellm_provider)) continue;
      const input =
        typeof entry.input_cost_per_token === 'number' && entry.input_cost_per_token >= 0
          ? entry.input_cost_per_token * 1_000_000
          : null;
      const output =
        typeof entry.output_cost_per_token === 'number' && entry.output_cost_per_token >= 0
          ? entry.output_cost_per_token * 1_000_000
          : null;
      if (input === null && output === null) continue;
      update.run(input, output, row.model_id);
      updatedCount++;
      providersWithMatches.add(row.provider_type);
    }

    persistStatus('success', {
      updatedCount,
      providersTouched: providersWithMatches.size,
    });
    logger.info('LiteLLM pricing sync complete', {
      updatedCount,
      providersTouched: providersWithMatches.size,
    });
    return getLitellmSyncStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('LiteLLM pricing sync failed', { error: message });
    persistStatus('failure', { updatedCount: 0, providersTouched: 0, error: message });
    return getLitellmSyncStatus();
  }
}
