import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDb } from '../../db/connection.js';
import { getProviderCredential, setProviderCredential, clearSecretsCache, getSearchApiKey, getSearchProvider, setSearchConfig } from '../../config/loader.js';
import { clearClientCache, resolveOpenAIBaseUrl, THINKING_OUTPUT_FLOOR_TOKENS, getContextWindow } from '../../agent/model.js';
import { clearOn } from '../../memory/writer.js';
import { CreateProviderSchema, EditProviderSchema, EnableModelsSchema, ProviderPatienceSchema, ProviderPrefillThroughputSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { DEFAULT_SOUL_MD as DEFAULT_SOUL, DEFAULT_USER_MD as DEFAULT_USER } from '../../prompt/templates.js';
import { getOllamaModelInfo } from '../../services/ollama.js';
import { STANDARD_DECISION_MODEL, STANDARD_ROW_STAYS, isStandardModelRow } from '../../services/local-standard.js';
import type { Provider, Model, ThinkingLevel } from '@dojo/shared';
import { contractForModel } from '../../agent/model-contract.js';
import { noteRouteFailure, routeFailure } from './route-failure.js';
import { renameAgent, roleNameKeyToIdKey } from '../../prompt/agent-rename.js';
import { homeDir } from '../../home.js';
import { findOpenRouterProvider, findDeepSeekProvider, readOpenRouterCredits, readDeepSeekBalance } from '../../costs/provider-balance-check.js';
import { dismissOwnerNotice, ownerToldOf } from '../../healer/owner-notices.js';
import { servedOwnerNotices } from '../../healer/owner-notice-kinds.js';
import { writeOobeSoul } from '../../prompt/soul-rerun.js';
import { isPastFirstRun } from '../../config/setup-state.js';
import { refuseUnfitLocalModel } from '../../agent/local-model-fit.js';
import { refuseAgentModel, refuseSmallMainModel, passesMainModelFloor, reassignAffectedAgents, windowOf, MAIN_MODEL_SETTING_KEYS, LOCAL_MODEL_SETTING_KEYS } from '../../agent/main-model-floor.js';
import { setAgentModel, modelKeyAgentId } from '../../agent/model-switch.js';
import { parsePrice } from '../../services/price-per-million.js';
import { refuseBadClockTime, CLOCK_TIME_SETTING_KEYS } from '../../config/clock-time.js';
import { refuseStaleWholeDocument } from './whole-document-guard.js';
import { readUserProfile, readUserProfileForEditor, writeUserProfile, composeUserProfile, userProfileIsEngineSeeded, renameOwnerInProfile } from '../../prompt/user-profile.js';
import { ownerMailboxes } from '../../services/owner-mailboxes.js';
import { TERMINAL_JOB_STATUS_SQL } from '../../services/media-job-status.js';


interface ModelUsage {
  modelId: string;
  modelName: string;
  usedBy: Array<{ type: 'agent' | 'pm_model' | 'dreamer_model'; id: string; name: string }>;
}

function getModelUsage(modelId: string): ModelUsage {
  const db = getDb();
  const model = db.prepare('SELECT id, name FROM models WHERE id = ?').get(modelId) as { id: string; name: string } | undefined;
  const usedBy: ModelUsage['usedBy'] = [];

  const agents = db.prepare(
    "SELECT id, name FROM agents WHERE model_id = ? AND status != 'terminated'"
  ).all(modelId) as Array<{ id: string; name: string }>;
  for (const a of agents) {
    usedBy.push({ type: 'agent', id: a.id, name: a.name });
  }

  const pmModel = db.prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string } | undefined;
  if (pmModel?.value === modelId) {
    usedBy.push({ type: 'pm_model', id: 'pm_agent_model', name: 'PM Agent Default Model' });
  }

  const dreamerModel = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  if (dreamerModel?.value === modelId) {
    usedBy.push({ type: 'dreamer_model', id: 'dreaming_model_id', name: 'Dreamer Model' });
  }

  return { modelId, modelName: model?.name ?? modelId, usedBy };
}

const logger = createLogger('config-routes');

// Fallback Anthropic models, used only if the models.list() API call fails
const ANTHROPIC_MODELS_FALLBACK = [
  {
    name: 'Claude Opus 4.6',
    apiModelId: 'claude-opus-4-6',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 32768,
    inputCostPerM: 15.0,
    outputCostPerM: 75.0,
  },
  {
    name: 'Claude Opus 4',
    apiModelId: 'claude-opus-4-0-20250415',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 32768,
    inputCostPerM: 15.0,
    outputCostPerM: 75.0,
  },
  {
    name: 'Claude Sonnet 4.6',
    apiModelId: 'claude-sonnet-4-6',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputCostPerM: 3.0,
    outputCostPerM: 15.0,
  },
  {
    name: 'Claude Sonnet 4',
    apiModelId: 'claude-sonnet-4-0-20250514',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputCostPerM: 3.0,
    outputCostPerM: 15.0,
  },
  {
    name: 'Claude Sonnet 3.5 v2',
    apiModelId: 'claude-3-5-sonnet-20241022',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputCostPerM: 3.0,
    outputCostPerM: 15.0,
  },
  {
    name: 'Claude Haiku 4.5',
    apiModelId: 'claude-haiku-4-5-20251001',
    capabilities: ['chat', 'code', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputCostPerM: 0.80,
    outputCostPerM: 4.0,
  },
];

// Cost lookup for Anthropic models (per million tokens)
const ANTHROPIC_COST_MAP: Record<string, { input: number; output: number }> = {
  opus: { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.80, output: 4.0 },
};

// A family the catalog does not list has NO price (NULL, which the Models page flags as unknown),
// never another family's price.
function getAnthropicCost(modelId: string): { input: number; output: number } | null {
  for (const [key, cost] of Object.entries(ANTHROPIC_COST_MAP)) {
    if (modelId.includes(key)) return cost;
  }
  return null;
}

// DeepSeek models: OpenAI-compatible provider at https://api.deepseek.com.
//   - The base host has no /v1 segment; `resolveOpenAIBaseUrl` (agent/model.ts) keeps bare-host roots.
//   - The legacy `deepseek-chat` and `deepseek-reasoner` IDs are deprecated and map to the v4-flash family.
//   - Current models are `deepseek-v4-flash` and `deepseek-v4-pro`: 1M-token context, 384K max output,
//     tool calling and a thinking-mode toggle; neither supports vision content blocks.
//   - Thinking is a per-call toggle, not a separate model; v4-pro defaults to thinking-on.
//   - Costs are the cache-miss rate. The cost tracker does not model cache hits, so this slightly
//     over-records cost, which is the safe direction.
const DEEPSEEK_MODELS = [
  {
    name: 'DeepSeek V4 Flash',
    apiModelId: 'deepseek-v4-flash',
    capabilities: ['chat', 'code', 'tools', 'thinking'],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,   // the everyday cap; a cut-off call may be given up to the contract's 384K once
    inputCostPerM: 0.14,
    outputCostPerM: 0.28,
  },
  {
    name: 'DeepSeek V4 Pro',
    apiModelId: 'deepseek-v4-pro',
    capabilities: ['chat', 'code', 'tools', 'thinking'],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    inputCostPerM: 0.435,
    outputCostPerM: 0.87,
  },
];

const DEEPSEEK_HOSTS = ['api.deepseek.com', 'deepseek.com'];

// IDs DeepSeek's /models endpoint still lists but that we do not seed: they are deprecated and map
// internally to v4-flash, so seeding them would only duplicate entries on the Models page.
const DEEPSEEK_DEPRECATED_IDS = new Set(['deepseek-chat', 'deepseek-reasoner']);

function isDeepSeekProvider(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return DEEPSEEK_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

/**
 * Where an OpenAI-compatible provider's API actually is, by the one rule the model client uses
 * (`resolveOpenAIBaseUrl`, `agent/model.ts`): bare-host providers keep their root, everyone else
 * gets `/v1`, and a base URL that already ends in `/v1` is left alone (never `/v1/v1/models`).
 */
function openAiCompatibleApiRoot(baseUrl: string): string {
  return resolveOpenAIBaseUrl(baseUrl) ?? baseUrl;
}

/** The auth header, when there is auth: a keyless local server is handed nothing, never `Bearer null`. */
function openAiCompatibleAuthHeaders(credential: string | null | undefined): Record<string, string> {
  return credential ? { 'Authorization': `Bearer ${credential}` } : {};
}

/**
 * Idempotent DeepSeek model seed: inserts the reference catalog and any non-deprecated model IDs the
 * live /models endpoint reports that are not already in the database. Safe to call repeatedly (create
 * and validate both call it); presence is checked on `(provider_id, api_model_id)`.
 */
async function seedDeepSeekModels(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  providerId: string,
  baseUrl: string | null | undefined,
  credential: string | undefined,
): Promise<void> {
  const cleanedBase = (baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');

  const existsStmt = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `);

  // Heal zero-cost rows from earlier seeds: update pricing only when both costs are 0, so
  // user-customized prices are kept.
  const healZeroCostStmt = db.prepare(`
    UPDATE models
    SET input_cost_per_m = ?, output_cost_per_m = ?, updated_at = datetime('now')
    WHERE provider_id = ?
      AND api_model_id = ?
      AND COALESCE(input_cost_per_m, 0) = 0
      AND COALESCE(output_cost_per_m, 0) = 0
  `);

  let referenceInserted = 0;
  let referenceSkipped = 0;
  let referenceHealed = 0;
  for (const model of DEEPSEEK_MODELS) {
    const existing = existsStmt.get(providerId, model.apiModelId);
    if (existing) {
      const result = healZeroCostStmt.run(model.inputCostPerM, model.outputCostPerM, providerId, model.apiModelId);
      if (result.changes > 0) referenceHealed++;
      else referenceSkipped++;
      continue;
    }
    insertStmt.run(
      uuidv4(), providerId, model.name, model.apiModelId,
      JSON.stringify(model.capabilities),
      model.contextWindow, model.maxOutputTokens,
      model.inputCostPerM, model.outputCostPerM,
    );
    referenceInserted++;
  }

  let liveInserted = 0;
  let liveSkipped = 0;
  if (credential) {
    try {
      const liveResp = await fetch(`${cleanedBase}/models`, {
        headers: { 'Authorization': `Bearer ${credential}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (liveResp.ok) {
        const liveData = (await liveResp.json()) as { data?: Array<{ id: string }> };
        const referenceIds = new Set(DEEPSEEK_MODELS.map((m) => m.apiModelId));
        for (const m of liveData.data ?? []) {
          if (referenceIds.has(m.id) || DEEPSEEK_DEPRECATED_IDS.has(m.id)) {
            liveSkipped++;
            continue;
          }
          if (existsStmt.get(providerId, m.id)) {
            liveSkipped++;
            continue;
          }
          insertStmt.run(
            uuidv4(), providerId, m.id, m.id,
            JSON.stringify(['chat', 'code', 'tools']),
            null, null, null, null,   // a live-listed id the reference catalog does not know has no known window, cap or price
          );
          liveInserted++;
        }
      } else {
        logger.warn('DeepSeek /models live fetch returned non-OK', { providerId, status: liveResp.status });
      }
    } catch (err) {
      logger.warn('DeepSeek /models live fetch failed (reference catalog still applied)', {
        providerId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('DeepSeek model seed complete', {
    providerId,
    referenceInserted,
    referenceSkipped,
    referenceHealed,
    liveInserted,
    liveSkipped,
  });
}

// Known OpenAI models: the API does not return token limits, so we keep a reference table
const OPENAI_MODELS = [
  { name: 'GPT-5', apiModelId: 'gpt-5', contextWindow: 400000, maxOutputTokens: 128000, inputCostPerM: 10.0, outputCostPerM: 40.0 },
  { name: 'GPT-4.1', apiModelId: 'gpt-4.1', contextWindow: 1047576, maxOutputTokens: 32768, inputCostPerM: 2.0, outputCostPerM: 8.0 },
  { name: 'GPT-4.1 Mini', apiModelId: 'gpt-4.1-mini', contextWindow: 1047576, maxOutputTokens: 32768, inputCostPerM: 0.40, outputCostPerM: 1.60 },
  { name: 'GPT-4.1 Nano', apiModelId: 'gpt-4.1-nano', contextWindow: 1047576, maxOutputTokens: 32768, inputCostPerM: 0.10, outputCostPerM: 0.40 },
  { name: 'GPT-4o', apiModelId: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384, inputCostPerM: 2.50, outputCostPerM: 10.0 },
  { name: 'GPT-4o Mini', apiModelId: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384, inputCostPerM: 0.15, outputCostPerM: 0.60 },
  { name: 'o3', apiModelId: 'o3', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerM: 10.0, outputCostPerM: 40.0 },
  { name: 'o3 Mini', apiModelId: 'o3-mini', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerM: 1.10, outputCostPerM: 4.40 },
  { name: 'o4 Mini', apiModelId: 'o4-mini', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerM: 1.10, outputCostPerM: 4.40 },
  { name: 'o1', apiModelId: 'o1', contextWindow: 200000, maxOutputTokens: 100000, inputCostPerM: 15.0, outputCostPerM: 60.0 },
  { name: 'o1 Mini', apiModelId: 'o1-mini', contextWindow: 128000, maxOutputTokens: 65536, inputCostPerM: 1.10, outputCostPerM: 4.40 },
];

// Fetch models dynamically from Anthropic's models.list() API
async function fetchAnthropicModels(client: Anthropic): Promise<Array<{
  name: string;
  apiModelId: string;
  capabilities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputCostPerM: number | null;
  outputCostPerM: number | null;
}>> {
  try {
    const models: Array<{
      name: string;
      apiModelId: string;
      capabilities: string[];
      contextWindow: number | null;
      maxOutputTokens: number | null;
      inputCostPerM: number | null;
      outputCostPerM: number | null;
    }> = [];

    const response = await client.models.list({ limit: 100 });

    for (const model of response.data) {
      // Only include Claude chat models (skip embeddings, legacy, etc.)
      if (!model.id.startsWith('claude-')) continue;

      const idParts = model.id.split('-');
      const familyName = idParts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      const version = idParts.slice(2).join('.');
      const displayName = `${familyName} ${version}`;

      const cost = getAnthropicCost(model.id);

      // The API reports `max_input_tokens` (the window) and `max_tokens` (the output cap). A figure it
      // does not report is NULL, not a stand-in: a stand-in is stored looking like a real one.
      const apiModel = model as unknown as Record<string, unknown>;
      const positive = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
      const maxOutput = positive(apiModel.max_tokens) ?? positive(apiModel.max_output_tokens);
      const contextWindow = positive(apiModel.max_input_tokens) ?? positive(apiModel.context_window);

      models.push({
        name: model.display_name ?? displayName,
        apiModelId: model.id,
        capabilities: ['chat', 'code', 'analysis', 'tools'],
        contextWindow,
        maxOutputTokens: maxOutput,
        inputCostPerM: cost?.input ?? null,
        outputCostPerM: cost?.output ?? null,
      });
    }

    if (models.length === 0) {
      logger.warn('Anthropic models.list() returned no claude models, using fallback');
      return ANTHROPIC_MODELS_FALLBACK;
    }

    logger.info('Fetched Anthropic models dynamically', { count: models.length, models: models.map(m => m.apiModelId) });
    return models;
  } catch (err) {
    logger.warn('Failed to fetch Anthropic models dynamically, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    return ANTHROPIC_MODELS_FALLBACK;
  }
}

const configRouter = new Hono();


// GET /providers
configRouter.get('/providers', (c) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM providers WHERE id != '__system__' ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;

  const providers: Provider[] = rows.map(rowToProvider);
  return c.json({ ok: true, data: providers });
});

// POST /providers
configRouter.post('/providers', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  const { id, name, type, baseUrl, authType, credential, behavesLike, firstChunkTimeoutMs, streamIdleTimeoutMs, prefillTokensPerSec } = parsed.data;
  const db = getDb();

  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
  if (existing) {
    db.prepare(`
      UPDATE providers SET name = ?, type = ?, base_url = ?, auth_type = ?, behaves_like = ?, first_chunk_timeout_ms = ?, stream_idle_timeout_ms = ?, prefill_tokens_per_sec = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, type, baseUrl ?? null, authType, behavesLike ?? null, firstChunkTimeoutMs ?? null, streamIdleTimeoutMs ?? null, prefillTokensPerSec ?? null, id);

    if (credential) {
      setProviderCredential(id, credential, authType as 'api_key' | 'oauth');
      clearClientCache(id);
    }

    const updated = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    clearOn({ kind: 'writer-answered', providerKey: id });   // the owner saved this provider: a summary span waiting on a writer there is re-tested
    return c.json({ ok: true, data: updated });
  }

  // Store credential securely (skip for Ollama which has no auth)
  if (credential) {
    logger.info('Storing provider credential', {
      providerId: id,
      authType,
      credentialLength: credential.length, // never log secret bytes
    });
    setProviderCredential(id, credential, authType as 'api_key' | 'oauth');
    clearClientCache(id);
  } else {
    logger.info('No credential to store (local provider)', { providerId: id });
  }

  // Insert provider into DB. `behaves_like` (the owner's declared dialect behind the URL) is NULL for
  // every preset. A re-POST over an existing id is a full replace of the identity fields, which includes
  // `behaves_like`, the patience pair and the prefill throughput (omitting one clears it), so the
  // dashboard edits the last two through their own PATCH routes, never a re-POST.
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like, first_chunk_timeout_ms, stream_idle_timeout_ms, prefill_tokens_per_sec, is_validated, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, name, type, baseUrl ?? null, authType, behavesLike ?? null, firstChunkTimeoutMs ?? null, streamIdleTimeoutMs ?? null, prefillTokensPerSec ?? null);

  // Auto-insert models for Anthropic providers (dynamically fetched, with fallback)
  if (type === 'anthropic') {
    let anthropicModels: Awaited<ReturnType<typeof fetchAnthropicModels>> = ANTHROPIC_MODELS_FALLBACK;
    if (credential) {
      try {
        const useOAuth = authType === 'oauth' || credential.includes('sk-ant-oat');
        const client = useOAuth
          ? new Anthropic({
              authToken: credential,
              defaultHeaders: {
                'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14',
                'User-Agent': 'dojo-platform',
              },
            })
          : new Anthropic({ apiKey: credential });
        anthropicModels = await fetchAnthropicModels(client);
      } catch {
        logger.warn('Could not fetch models dynamically at provider creation, using fallback');
      }
    }

    const insertModel = db.prepare(`
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `);

    for (const model of anthropicModels) {
      insertModel.run(
        uuidv4(),
        id,
        model.name,
        model.apiModelId,
        JSON.stringify(model.capabilities),
        model.contextWindow,
        model.maxOutputTokens,
        model.inputCostPerM,
        model.outputCostPerM,
      );
    }
    logger.info('Auto-inserted Anthropic models', { providerId: id, count: anthropicModels.length });
  }

  // Auto-insert known models for OpenAI providers
  if (type === 'openai') {
    const insertModel = db.prepare(`
      INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `);

    for (const model of OPENAI_MODELS) {
      const capabilities = ['chat', 'code', 'tools'];
      if (model.apiModelId.includes('gpt-4o') || model.apiModelId.includes('gpt-5')) {
        capabilities.push('vision');
      }
      insertModel.run(
        uuidv4(), id, model.name, model.apiModelId,
        JSON.stringify(capabilities),
        model.contextWindow, model.maxOutputTokens,
        model.inputCostPerM, model.outputCostPerM,
      );
    }

    if (credential) {
      try {
        const response = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${credential}` },
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          const data = await response.json() as { data?: Array<{ id: string; owned_by?: string }> };
          const apiModels = (data.data ?? []).filter(m => m.id.startsWith('gpt-') || m.id.match(/^o[1-4]/));
          const knownIds = new Set(OPENAI_MODELS.map(m => m.apiModelId));
          const insertExtra = db.prepare(`
            INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
          `);
          for (const m of apiModels) {
            if (!knownIds.has(m.id)) {
              insertExtra.run(
                uuidv4(), id, m.id, m.id,
                JSON.stringify(['chat', 'code', 'tools']),
                null, null, null, null,   // a model the catalog does not list has no known window, cap or price
              );
            }
          }
        }
      } catch {
        logger.warn('Could not discover additional OpenAI models from API');
      }
    }

    logger.info('Auto-inserted OpenAI models', { providerId: id, count: OPENAI_MODELS.length });
  }

  // Auto-insert DeepSeek models when the provider is openai-compatible AND the baseUrl points at
  // api.deepseek.com: the hardcoded reference catalog (metadata /models does not return: window, max
  // output, capabilities, costs) plus a live /models fetch for IDs we do not know yet.
  if (type === 'openai-compatible' && isDeepSeekProvider(baseUrl)) {
    await seedDeepSeekModels(db, id, baseUrl, credential);
  }

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider created', { providerId: id, type });
  clearOn({ kind: 'writer-answered', providerKey: id });   // its models may be a waiting summary span's writers

  return c.json({ ok: true, data: rowToProvider(row) }, 201);
});

/**
 * Remove every reference the rest of the DB still holds to a model: the router tier rows it
 * sits in and the config keys that can point at it. Shared by the provider delete (which
 * forgets several models at once, with FKs off) and the single-model delete, so the two
 * forget-lists cannot drift.
 */
function forgetModelReferences(modelId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM router_tier_models WHERE model_id = ?').run(modelId);
  for (const key of LOCAL_MODEL_SETTING_KEYS) {
    db.prepare('DELETE FROM config WHERE key = ? AND value = ?').run(key, modelId);
  }
}

// DELETE /providers/:id
configRouter.delete('/providers/:id', (c) => {
  try {
    const db = getDb();
    const id = c.req.param('id');

    const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
    if (!existing) {
      return c.json({ ok: false, error: 'Provider not found' }, 404);
    }

    const providerModels = db.prepare('SELECT id FROM models WHERE provider_id = ?').all(id) as Array<{ id: string }>;
    const modelIds = providerModels.map(m => m.id);

    // The Dojo's own two models live on the local provider; deleting it would take the Dojo's memory work down.
    if (modelIds.some(isStandardModelRow)) {
      return c.json({ ok: false, error: 'The Dojo itself runs on a model from this provider for memory summaries and quick checks, so this provider stays.' }, 409);
    }

    // Agents and service-agent settings on these models move to the cheapest working model, with the usual
    // change note; with none, the loop below leaves them without a model, as before.
    reassignAffectedAgents(modelIds);

    for (const mid of modelIds) {
      db.prepare("UPDATE agents SET model_id = NULL WHERE model_id = ?").run(mid);
    }

    // Remove tier rows and clear the model config keys (same forget list as the model delete)
    for (const mid of modelIds) {
      forgetModelReferences(mid);
    }

    // Temporarily disable FK constraints, delete everything, re-enable, always restore the
    // pragma, even when a delete throws, so the shared connection is never left unguarded.
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM models WHERE provider_id = ?').run(id);
      db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
    clearClientCache(id);
    clearSecretsCache();
    logger.info('Provider deleted', { providerId: id, modelsRemoved: modelIds.length });

    return c.json({ ok: true, data: { message: 'Provider deleted' } });
  } catch (err) {
    logger.error('Failed to delete provider', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Delete failed' }, 500);
  }
});

// POST /providers/:id/validate
configRouter.post('/providers/:id/validate', async (c) => {
  const db = getDb();
  const id = c.req.param('id');

  logger.info('Provider validation requested', { providerId: id });

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) {
    logger.warn('Provider validation: provider not found', { providerId: id });
    return c.json({ ok: false, error: 'Provider not found' }, 404);
  }

  const provider = rowToProvider(row);
  const credential = getProviderCredential(id);
  logger.info('Provider validation: credential lookup', {
    providerId: id,
    providerType: provider.type,
    hasCredential: !!credential,
    credentialLength: credential ? credential.length : 0, // never log secret bytes
  });

  // `auth_type='none'` is a provider that declares it has no key (a local OpenAI-compatible server:
  // ollama / vLLM / LM Studio). A provider that claims a key and has none is still refused.
  if (!credential && provider.type !== 'ollama' && provider.authType !== 'agent-sdk' && provider.authType !== 'none') {
    return c.json({ ok: false, error: 'No credential found for this provider' }, 400);
  }

  try {
    if (provider.type === 'ollama') {
      const baseUrl = provider.baseUrl || 'http://localhost:11434';
      logger.info('Provider validation: checking Ollama', { providerId: id, baseUrl });
      const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) {
        return c.json({ ok: false, error: `Ollama responded with status ${response.status}` }, 400);
      }
      const data = await response.json() as { models?: Array<{ name: string; size: number; details?: { parameter_size?: string; family?: string } }> };
      const ollamaModels = data.models ?? [];
      logger.info('Provider validation: Ollama responded', { providerId: id, modelCount: ollamaModels.length });

      // Auto-insert/update discovered models with per-model metadata from /api/show
      const insertModel = db.prepare(`
        INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, datetime('now'), datetime('now'))
      `);
      // A figure is written only when the server reported one. NULL keeps what the row already holds
      // (seeded, or typed in the Model Limits editor); a new row the server says nothing about is "not set".
      const updateModel = db.prepare(`
        UPDATE models SET context_window = COALESCE(?, context_window), max_output_tokens = COALESCE(?, max_output_tokens), updated_at = datetime('now')
        WHERE provider_id = ? AND api_model_id = ?
      `);

      for (const m of ollamaModels) {
        if (m.name === STANDARD_DECISION_MODEL.windowTag) continue;   // the Dojo's own window tag, never a pickable model
        const capabilities = ['chat'];
        const nameLower = m.name.toLowerCase();
        if (nameLower.includes('code') || nameLower.includes('coder') || nameLower.includes('deepseek')) capabilities.push('code');
        if (nameLower.includes('vision') || nameLower.includes('llava')) capabilities.push('vision');

        const modelInfo = await getOllamaModelInfo(m.name, baseUrl);
        const contextWindow = modelInfo?.contextWindow ?? null;
        const maxOutputTokens = modelInfo?.maxOutputTokens ?? null;

        const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(id, m.name);
        if (existing) {
          updateModel.run(contextWindow, maxOutputTokens, id, m.name);
        } else {
          insertModel.run(
            uuidv4(),
            id,
            m.name,
            m.name,
            JSON.stringify(capabilities),
            contextWindow,
            maxOutputTokens,
          );
        }
      }
      logger.info('Ollama models synced', { providerId: id, count: ollamaModels.length });
    } else if (provider.type === 'anthropic' && provider.authType === 'agent-sdk') {
      logger.info('Provider validation: checking Agent SDK auth', { providerId: id });
      const { checkSdkAuth } = await import('../../providers/anthropic-sdk-auth.js');
      const sdkResult = await checkSdkAuth();
      if (!sdkResult.authenticated) {
        return c.json({ ok: false, error: `Agent SDK auth failed: ${sdkResult.error ?? 'not authenticated'}` }, 400);
      }
      logger.info('Provider validation: Agent SDK auth verified', { providerId: id });

      // Agent SDK models: family-level only (SDK always uses the latest version)
      const sdkModels = [
        { name: 'Claude Opus (latest)', apiModelId: 'opus', contextWindow: 200000, maxOutputTokens: 32768, inputCostPerM: 15.0, outputCostPerM: 75.0 },
        { name: 'Claude Sonnet (latest)', apiModelId: 'sonnet', contextWindow: 200000, maxOutputTokens: 64000, inputCostPerM: 3.0, outputCostPerM: 15.0 },
        { name: 'Claude Haiku (latest)', apiModelId: 'haiku', contextWindow: 200000, maxOutputTokens: 8192, inputCostPerM: 0.80, outputCostPerM: 4.0 },
      ];
      const insertModel = db.prepare(`
        INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const m of sdkModels) {
        const modelId = `${id}_${m.apiModelId}`;
        insertModel.run(modelId, id, m.name, m.apiModelId, JSON.stringify(['chat', 'code', 'analysis', 'tools']), m.contextWindow, m.maxOutputTokens, m.inputCostPerM, m.outputCostPerM);
      }
    } else if (provider.type === 'anthropic') {
      const useOAuth = provider.authType === 'oauth' || credential!.includes('sk-ant-oat');
      logger.info('Provider validation: calling Anthropic API', { providerId: id, authType: useOAuth ? 'oauth' : 'api_key' });
      let client: Anthropic;
      if (useOAuth) {
        client = new Anthropic({
          authToken: credential,
          defaultHeaders: {
            'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14',
            'User-Agent': 'dojo-platform',
          },
        });
      } else {
        client = new Anthropic({ apiKey: credential });
      }
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      logger.info('Provider validation: Anthropic API call succeeded', { providerId: id });

      // Sync model metadata (max_output_tokens, context_window, pricing) from the API.
      // Pricing fields use COALESCE so a temporary gap in the API response
      // doesn't wipe out known prices.
      try {
        const freshModels = await fetchAnthropicModels(client);
        const updateModel = db.prepare(`
          UPDATE models SET
            max_output_tokens = COALESCE(?, max_output_tokens),
            context_window = COALESCE(?, context_window),
            input_cost_per_m = COALESCE(?, input_cost_per_m),
            output_cost_per_m = COALESCE(?, output_cost_per_m),
            updated_at = datetime('now')
          WHERE provider_id = ? AND api_model_id = ?
        `);
        const insertModel = db.prepare(`
          INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `);
        for (const m of freshModels) {
          const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(id, m.apiModelId);
          if (existing) {
            updateModel.run(m.maxOutputTokens, m.contextWindow, m.inputCostPerM ?? null, m.outputCostPerM ?? null, id, m.apiModelId);
          } else {
            insertModel.run(uuidv4(), id, m.name, m.apiModelId, JSON.stringify(m.capabilities), m.contextWindow, m.maxOutputTokens, m.inputCostPerM, m.outputCostPerM);
          }
        }
        logger.info('Synced Anthropic model metadata', { providerId: id, modelCount: freshModels.length });
      } catch (syncErr) {
        logger.warn('Failed to sync Anthropic model metadata', { error: syncErr instanceof Error ? syncErr.message : String(syncErr) });
      }
    } else if (provider.type === 'openai') {
      logger.info('Provider validation: checking OpenAI API', { providerId: id });

      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${credential}` },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return c.json({ ok: false, error: `OpenAI API responded with status ${response.status}: ${errText.slice(0, 200)}` }, 400);
      }

      logger.info('Provider validation: OpenAI API call succeeded', { providerId: id });

      try {
        const data = await response.json() as { data?: Array<{ id: string; owned_by?: string }> };
        const apiModels = (data.data ?? []).filter(m => m.id.startsWith('gpt-') || m.id.match(/^o[1-4]/));
        const knownMap = new Map(OPENAI_MODELS.map(m => [m.apiModelId, m]));

        const insertModel = db.prepare(`
          INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `);

        for (const m of apiModels) {
          const known = knownMap.get(m.id);
          if (!known) {
            const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(id, m.id);
            if (!existing) {
              insertModel.run(
                uuidv4(), id, m.id, m.id,
                JSON.stringify(['chat', 'code', 'tools']),
                null, null, null, null,   // a model the catalog does not list has no known window, cap or price
              );
            }
          }
        }
        logger.info('Synced OpenAI models from API', { providerId: id, apiModelCount: apiModels.length });
      } catch (syncErr) {
        logger.warn('Failed to sync OpenAI models', { error: syncErr instanceof Error ? syncErr.message : String(syncErr) });
      }
    } else if (provider.type === 'openai-compatible') {
      // OpenRouter and other OpenAI-compatible providers: validate the credential only. Models are not
      // bulk-inserted; users add them via the UI. Exception: DeepSeek (and other first-class presets) get
      // their default catalog auto-inserted on validation, as a backfill.
      const baseUrl = (provider.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');
      const isDeepSeek = isDeepSeekProvider(baseUrl);
      if (isDeepSeek) {
        await seedDeepSeekModels(db, id, baseUrl, credential ?? undefined);
      }
      logger.info('Provider validation: checking OpenAI-compatible API', { providerId: id, baseUrl });

      const modelsResponse = await fetch(`${openAiCompatibleApiRoot(baseUrl)}/models`, {
        headers: {
          ...openAiCompatibleAuthHeaders(credential),
          'HTTP-Referer': 'https://dojo.dev',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!modelsResponse.ok) {
        const errText = await modelsResponse.text().catch(() => '');
        return c.json({ ok: false, error: `API responded with status ${modelsResponse.status}: ${errText.slice(0, 200)}` }, 400);
      }

      logger.info('Provider validation: OpenAI-compatible API call succeeded', { providerId: id });

      // Only update metadata for models the user has already added
      try {
        const modelsData = await modelsResponse.json() as {
          data?: Array<{
            id: string;
            name?: string;
            context_length?: number;
            top_provider?: { max_completion_tokens?: number; context_length?: number };
            pricing?: { prompt?: string; completion?: string };
          }>;
        };

        const apiModels = modelsData.data ?? [];
        const apiMap = new Map(apiModels.map(m => [m.id, m]));

        // Update existing models (ones the user previously added). Pricing is COALESCE(?, current):
        // written only when the API gave a number, `"0"` stores 0 (truly free), missing/empty stores
        // null (unknown).
        const existingModels = db.prepare('SELECT id, api_model_id, max_output_tokens FROM models WHERE provider_id = ?').all(id) as Array<{ id: string; api_model_id: string; max_output_tokens: number | null }>;
        // The window and the cap follow the same rule: written only when the provider reported one, so a
        // /models list that says nothing about a model changes nothing.
        const updateModel = db.prepare(`
          UPDATE models SET
            context_window = COALESCE(?, context_window),
            max_output_tokens = COALESCE(?, max_output_tokens),
            input_cost_per_m = COALESCE(?, input_cost_per_m),
            output_cost_per_m = COALESCE(?, output_cost_per_m),
            updated_at = datetime('now')
          WHERE id = ?
        `);

        let updated = 0;
        for (const existing of existingModels) {
          const apiModel = apiMap.get(existing.api_model_id);
          if (apiModel) {
            const reported = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);
            const reportedWindow = reported(apiModel.context_length) ?? reported(apiModel.top_provider?.context_length);
            // The derived cap `floor(cw / 4)` is exactly 1024 for a 4096-window model (llama.cpp's
            // default `n_ctx`), and a stored cap of 1024 guarantees an empty answer for anything that
            // reasons before it writes, so a derived cap may not fall below the floor; a provider-stated
            // `max_completion_tokens` is taken verbatim. The derivation only fills a blank cap, and only
            // from a window the provider reported.
            const maxOutputTokens = reported(apiModel.top_provider?.max_completion_tokens)
              ?? (reportedWindow !== null && existing.max_output_tokens === null
                ? Math.max(THINKING_OUTPUT_FLOOR_TOKENS, Math.min(Math.floor(reportedWindow / 4), 16384))
                : null);
            const inputCostPerM = parsePrice(apiModel.pricing?.prompt);
            const outputCostPerM = parsePrice(apiModel.pricing?.completion);
            updateModel.run(reportedWindow, maxOutputTokens, inputCostPerM, outputCostPerM, existing.id);
            updated++;
          }
        }
        if (updated > 0) logger.info('Updated metadata for existing OpenRouter models', { providerId: id, count: updated });
      } catch (syncErr) {
        logger.warn('Failed to update OpenRouter model metadata', { error: syncErr instanceof Error ? syncErr.message : String(syncErr) });
      }
    } else {
      return c.json({ ok: false, error: `Validation not implemented for provider type: ${provider.type}` }, 400);
    }

    db.prepare(`
      UPDATE providers SET is_validated = 1, validated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    logger.info('Provider validated successfully', { providerId: id });
    clearOn({ kind: 'writer-answered', providerKey: id });   // a waiting summary writer there is re-tested
    return c.json({ ok: true, data: { valid: true } });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorDetail = err instanceof Anthropic.APIError
      ? { status: err.status, errorBody: err.error, message: err.message }
      : { message: errorMsg };
    logger.warn('Provider validation failed', {
      providerId: id,
      error: errorMsg,
      detail: errorDetail,
    });
    return c.json({ ok: false, error: 'Validation failed: ' + errorMsg }, 400);
  }
});


// GET /models (all enabled models)
configRouter.get('/models', (c) => {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM models WHERE id != 'auto' ORDER BY name").all() as Array<Record<string, unknown>>;
  const models: Model[] = rows.map(rowToModel);

  return c.json({ ok: true, data: models });
});

// GET /generation-jobs?status=active: list run-once media generation jobs
// (image / audio / music). MERGED with video_jobs so the orb can
// fetch one list covering every generator. Each row is normalized with a
// `kind` field; video rows are tagged kind='video'.
configRouter.get('/generation-jobs', (c) => {
  const db = getDb();
  const statusFilter = c.req.query('status');
  const activeOnly = statusFilter === 'active';

  let genRows: Array<Record<string, unknown>> = [];
  try {
    genRows = (activeOnly
      ? db.prepare(
          `SELECT id, kind, agent_id, model_id, provider_id, prompt, title, status, started_at, updated_at, finished_at, duration_seconds, cost_usd, error FROM generation_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL}) ORDER BY started_at DESC`
        ).all()
      : db.prepare(
          "SELECT id, kind, agent_id, model_id, provider_id, prompt, title, status, started_at, updated_at, finished_at, duration_seconds, cost_usd, error FROM generation_jobs ORDER BY started_at DESC LIMIT 50"
        ).all()) as Array<Record<string, unknown>>;
  } catch { /* table may not exist on a pre-migration DB */ }

  let vidRows: Array<Record<string, unknown>> = [];
  try {
    vidRows = (activeOnly
      ? db.prepare(
          `SELECT id, agent_id, model_id, provider_id, prompt, title, status, started_at, updated_at, finished_at, duration_seconds, cost_usd, error FROM video_jobs WHERE status NOT IN (${TERMINAL_JOB_STATUS_SQL}) ORDER BY started_at DESC`
        ).all()
      : db.prepare(
          "SELECT id, agent_id, model_id, provider_id, prompt, title, status, started_at, updated_at, finished_at, duration_seconds, cost_usd, error FROM video_jobs ORDER BY started_at DESC LIMIT 50"
        ).all()) as Array<Record<string, unknown>>;
  } catch { /* table may not exist on a pre-migration DB */ }

  const normalize = (r: Record<string, unknown>, kind: string) => ({
    id: r.id,
    kind: (r.kind as string | undefined) ?? kind,
    agentId: r.agent_id,
    modelId: r.model_id,
    providerId: r.provider_id,
    prompt: r.prompt,
    title: r.title,
    status: r.status,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    durationSeconds: r.duration_seconds,
    costUsd: r.cost_usd,
    error: r.error,
  });

  const data = [...genRows.map((r) => normalize(r, 'image')), ...vidRows.map((r) => normalize(r, 'video'))]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return c.json({ ok: true, data });
});

// GET /pricing-sync/status: last LiteLLM price-index run (success/failure,
// timestamp, count). Powers the status pill on the Costs page.
configRouter.get('/pricing-sync/status', async (c) => {
  const { getLitellmSyncStatus } = await import('../../services/litellm-pricing-sync.js');
  return c.json({ ok: true, data: getLitellmSyncStatus() });
});

// POST /pricing-sync/run: kick off a LiteLLM refresh on demand. Returns
// the fresh status when the run completes (synchronous, but it's a single
// HTTP fetch + a small loop so well under HTTP timeouts).
configRouter.post('/pricing-sync/run', async (c) => {
  const { syncLitellmPricing } = await import('../../services/litellm-pricing-sync.js');
  const status = await syncLitellmPricing();
  return c.json({ ok: true, data: status });
});

// GET /providers/:id/browse-models?q=search: live search of provider's model catalog (not stored in DB)
configRouter.get('/providers/:id/browse-models', async (c) => {
  const db = getDb();
  const providerId = c.req.param('id');
  const query = (c.req.query('q') ?? '').toLowerCase().trim();

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(providerId) as Record<string, unknown> | undefined;
  if (!row) return c.json({ ok: false, error: 'Provider not found' }, 404);

  const provider = rowToProvider(row);

  if (provider.type !== 'openai-compatible') {
    return c.json({ ok: false, error: 'Browse is only available for OpenRouter / OpenAI-compatible providers' }, 400);
  }

  const credential = getProviderCredential(providerId);
  // A provider that declares no auth is not one missing its key, and browsing is how a model gets
  // attached to a local server at all.
  if (!credential && provider.authType !== 'none') return c.json({ ok: false, error: 'No credential found' }, 400);

  const baseUrl = (provider.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');
  const apiRoot = openAiCompatibleApiRoot(baseUrl);

  // OpenRouter's /v1/models defaults to output_modalities=text, so image /
  // video / audio-only generators (flux, seedance, etc.) are absent unless we
  // ask for them explicitly. Request the full modality union so the catalog
  // search can surface media-generation models, not just chat/LLMs. Harmless
  // for plain OpenAI-compatible providers, but only OpenRouter honours it.
  const modelsUrl = baseUrl.includes('openrouter.ai')
    ? `${apiRoot}/models?output_modalities=text,image,audio,video`
    : `${apiRoot}/models`;

  try {
    const response = await fetch(modelsUrl, {
      headers: {
        ...openAiCompatibleAuthHeaders(credential),
        'HTTP-Referer': 'https://dojo.dev',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return c.json({ ok: false, error: `Provider API returned ${response.status}` }, 502);
    }

    const data = await response.json() as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        top_provider?: { max_completion_tokens?: number; context_length?: number };
        pricing?: Record<string, string | undefined>;
        architecture?: { modality?: string; output_modalities?: string[] };
      }>;
    };

    const allModels = data.data ?? [];

    const addedIds = new Set(
      (db.prepare('SELECT api_model_id FROM models WHERE provider_id = ?').all(providerId) as Array<{ api_model_id: string }>)
        .map(r => r.api_model_id),
    );

    const filtered = allModels
      .filter(m => {
        if (!m.id) return false;
        if (addedIds.has(m.id)) return false;
        if (!query) return true;
        const searchable = `${m.id} ${m.name ?? ''}`.toLowerCase();
        return query.split(/\s+/).every(term => searchable.includes(term));
      })
      .slice(0, 50) // Limit results
      .map(m => {
        const contextWindow = m.context_length ?? m.top_provider?.context_length ?? null;
        const maxOutputTokens = m.top_provider?.max_completion_tokens ?? null;
        const inputCostPerM = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : null;
        const outputCostPerM = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : null;

        // priceAvailable = the catalog reports at least one nonzero price
        // for this model. OpenRouter lists media-only generators (seedance,
        // lyria, flux) with all-zero pricing, so they surface as
        // price-unavailable and the Add modal asks the user to enter one.
        const priceAvailable = Object.values(m.pricing ?? {}).some(v => {
          const n = parseFloat(String(v));
          return Number.isFinite(n) && n > 0;
        });
        const outputModalities = m.architecture?.output_modalities ?? [];

        return {
          apiModelId: m.id,
          name: m.name || m.id.split('/').pop() || m.id,
          contextWindow,
          maxOutputTokens,
          inputCostPerM,
          outputCostPerM,
          priceAvailable,
          outputModalities,
        };
      });

    return c.json({ ok: true, data: filtered });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 502, prefix: 'Failed to browse models: ' });
  }
});

// POST /providers/:id/add-model: add a single model from the provider's catalog to the DB
configRouter.post('/providers/:id/add-model', async (c) => {
  const db = getDb();
  const providerId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  if (!body?.apiModelId) return c.json({ ok: false, error: 'apiModelId is required' }, 400);

  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId);
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  const alreadyAdded = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(providerId, body.apiModelId);
  if (alreadyAdded) return c.json({ ok: false, error: 'Model already added' }, 409);

  // If the caller provided explicit capabilities (manual add for models
  // not in the provider catalog), use those directly. Otherwise start
  // empty and probe.
  const explicitCapabilities = Array.isArray(body.capabilities)
    ? body.capabilities.filter((c: unknown) => typeof c === 'string')
    : null;

  // Token rows use the input/output $/M-token columns; every other unit (megapixel / second / minute /
  // character / item) stores a single cost_per_unit and leaves the token columns null. A null
  // cost_per_unit means "unknown" (the user left it blank). costPerMegapixel is still mirrored to the legacy column.
  const ADD_VALID_UNITS = ['token', 'megapixel', 'second', 'character', 'minute', 'item'] as const;
  const pricingUnit: typeof ADD_VALID_UNITS[number] =
    ADD_VALID_UNITS.includes(body.pricingUnit) ? body.pricingUnit : 'token';
  const isTokenPriced = pricingUnit === 'token';
  // Prefer the unified costPerUnit; fall back to the legacy
  // costPerMegapixel when a client still sends that for megapixel rows.
  const rawUnitCost =
    typeof body.costPerUnit === 'number' && body.costPerUnit >= 0
      ? body.costPerUnit
      : pricingUnit === 'megapixel' && typeof body.costPerMegapixel === 'number' && body.costPerMegapixel >= 0
        ? body.costPerMegapixel
        : null;
  const costPerUnit = isTokenPriced ? null : rawUnitCost;
  const costPerMegapixel = pricingUnit === 'megapixel' ? rawUnitCost : null;

  const modelId = uuidv4();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, pricing_unit, cost_per_unit, cost_per_megapixel, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(
    modelId, providerId,
    body.name ?? body.apiModelId,
    body.apiModelId,
    JSON.stringify(explicitCapabilities ?? []),
    body.contextWindow ?? null,
    body.maxOutputTokens ?? null,
    isTokenPriced ? (body.inputCostPerM ?? null) : null,
    isTokenPriced ? (body.outputCostPerM ?? null) : null,
    pricingUnit,
    costPerUnit,
    costPerMegapixel,
  );

  // Probe capabilities from the provider catalog only if the caller supplied none: for a manually-added
  // model the probe would return empty and overwrite the user's selection.
  if (!explicitCapabilities) {
    try {
      const { probeAndStoreCapabilities } = await import('../../services/capabilities.js');
      await probeAndStoreCapabilities(modelId);
    } catch (err) {
      logger.warn('Capability probe failed on add-model', {
        providerId,
        apiModelId: body.apiModelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // For Ollama models, compute and persist a RAM-aware num_ctx recommendation
  // so the Settings UI has a sensible pre-filled default. Non-Ollama
  // providers are a no-op inside the helper.
  try {
    const { computeAndStoreRecommendedNumCtx } = await import('../../services/num-ctx-calculator.js');
    await computeAndStoreRecommendedNumCtx(modelId);
  } catch (err) {
    logger.warn('num_ctx recommendation failed on add-model', {
      providerId,
      apiModelId: body.apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Seed the generation parameter spec from the family registry. Runs after
  // the capability probe (it keys off video_generation) and is a no-op for
  // non-video models or rows that already carry a spec.
  try {
    const { seedGenerationParams } = await import('../../services/generation-params.js');
    seedGenerationParams(modelId);
  } catch (err) {
    logger.warn('Generation-params seed failed on add-model', {
      providerId,
      apiModelId: body.apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Seed the TTS voice catalog from the family registry. No-op for
  // non-audio-generation models, models with no family seed, or rows that
  // already carry a catalog.
  try {
    const { seedVoiceCatalog } = await import('../../services/voice-catalog.js');
    seedVoiceCatalog(modelId);
  } catch (err) {
    logger.warn('Voice-catalog seed failed on add-model', {
      providerId,
      apiModelId: body.apiModelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as Record<string, unknown>;
  logger.info('Model added from catalog', { providerId, apiModelId: body.apiModelId });

  return c.json({ ok: true, data: rowToModel(row) }, 201);
});

// PATCH /providers/:id: edit a provider that already exists. Body: any of
// { name, baseUrl, behavesLike, credential }; ONLY what the body names is changed (an absent field
// is not a request).
//
// A re-POST over the existing id is a full replace of the identity fields and would clear a dialect
// declaration, patience pair or base URL by omission; this door cannot. It is one of the narrow doors
// (`host-ram`, `response-patience`, this) that each own their own properties; patience stays at its
// own door and the dashboard's one Save calls both.
//
// `type`, `id` and `authType` are refused by name: they identify what the provider IS (the id is the
// key `models.provider_id`, `~/.dojo/secrets.yaml` and every cache resolve through), so delete and
// re-add is the correct move and the message says so.
configRouter.patch('/providers/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);

  const raw = (body ?? {}) as Record<string, unknown>;
  const identity = ['type', 'id', 'authType'].filter(k => k in raw);
  if (identity.length > 0) {
    return c.json({
      ok: false,
      error: `A provider's ${identity.join(', ')} cannot be edited, a provider that speaks a different API, or authenticates a different way, is a different provider. Delete this one and add it again. This door edits name, baseUrl, behavesLike and credential.`,
    }, 400);
  }

  // The patience pair has its own door. Named here rather than left to `.strict()`, whose
  // "Unrecognized key(s)" does not tell a caller where the right door is.
  const patience = ['firstChunkTimeoutMs', 'streamIdleTimeoutMs'].filter(k => k in raw);
  if (patience.length > 0) {
    return c.json({
      ok: false,
      error: `${patience.join(' and ')} belong to PATCH /providers/:id/response-patience, which is where this provider's streaming bounds are set`,
    }, 400);
  }

  // Same reasoning: `prefillTokensPerSec` has its own narrow PATCH.
  if ('prefillTokensPerSec' in raw) {
    return c.json({
      ok: false,
      error: 'prefillTokensPerSec belongs to PATCH /providers/:id/prefill-throughput, which is where this provider\'s declared prefill speed is set',
    }, 400);
  }

  const parsed = EditProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  // The engine's own sentinel: `GET /providers` filters it out of the list, but nothing refused it at
  // a write door, and this door rewrites identity with the router's 'auto' pointer hanging off that row.
  if (id === '__system__') {
    return c.json({ ok: false, error: 'The System provider is part of the engine and cannot be edited' }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  const { name, baseUrl, behavesLike, credential } = parsed.data;
  // A blank key is an untouched password field, not an erasure.
  const rotatedCredential = credential?.trim() ? credential.trim() : null;

  const nextName = name === undefined ? existing.name : name;
  const nextBaseUrl = baseUrl === undefined ? existing.base_url ?? null : baseUrl;
  const nextBehavesLike = behavesLike === undefined ? existing.behaves_like ?? null : behavesLike;

  // `is_validated` is a claim about a CONNECTION: this base URL, with this key, answered. A
  // rename does not touch that, and neither does declaring a dialect (nothing in the validate
  // route reads `behaves_like`). Resetting on those would teach the owner to ignore the badge.
  const baseUrlChanged = nextBaseUrl !== (existing.base_url ?? null);
  const connectionChanged = baseUrlChanged || rotatedCredential !== null;

  if (rotatedCredential) {
    logger.info('Rotating provider credential', {
      providerId: id,
      credentialLength: rotatedCredential.length, // never log secret bytes
    });
    // The existing store, and the provider's OWN auth type picks the slot, so an OAuth
    // provider's token does not land in the api_key field and read back as the wrong kind.
    setProviderCredential(id, rotatedCredential, existing.auth_type === 'oauth' ? 'oauth' : 'api_key');
  }

  db.prepare(`
    UPDATE providers SET name = ?, base_url = ?, behaves_like = ?,
      is_validated = ?, validated_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    nextName, nextBaseUrl, nextBehavesLike,
    connectionChanged ? 0 : existing.is_validated,
    connectionChanged ? null : existing.validated_at,
    id,
  );

  // The stale client: `getOpenAIClient` caches on `${providerId}:${baseUrl}` and closes over the
  // credential it read at build time, and `setProviderCredential` records its own mtime so the loader's
  // changed-file invalidation (config/loader.ts) does not fire for our own write. Without this line a
  // rotated key leaves the cache key unchanged and every later call sends the replaced key.
  // Test: `agent/__tests__/an-edited-provider-is-the-one-that-gets-called.test.ts`.
  if (connectionChanged) clearClientCache(id);

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider edited', {
    providerId: id,
    changed: Object.keys(parsed.data).filter(k => k !== 'credential'),
    credentialRotated: rotatedCredential !== null,
    connectionChanged,
  });

  // `revalidationRequired` is the caller's cue to run `POST /providers/:id/validate`. Kept as two calls
  // rather than validating here: a DB write door that makes a network call to a possibly unreachable
  // local box would hold the user's Save hostage until that box times out.
  return c.json({ ok: true, data: rowToProvider(row), revalidationRequired: connectionChanged });
});

// PATCH /providers/:id/host-ram: set or clear the manually-entered RAM
// (in GB) for a remote Ollama provider. Body: { ramGb: number | null }.
// On success, every model belonging to this provider is re-run through
// the num_ctx calculator so the Settings UI sees fresh recommendations
// immediately after the user enters a RAM value. Only meaningful for
// provider type 'ollama', the server accepts and stores the value for
// any provider type but the calculator only reads it from Ollama rows.
configRouter.patch('/providers/:id/host-ram', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || !('ramGb' in body)) {
    return c.json({ ok: false, error: 'Request body must include a `ramGb` field (number or null)' }, 400);
  }

  const ramGb = body.ramGb;
  if (ramGb !== null) {
    if (typeof ramGb !== 'number' || !Number.isInteger(ramGb)) {
      return c.json({ ok: false, error: '`ramGb` must be an integer (in GB) or null' }, 400);
    }
    if (ramGb < 1 || ramGb > 2048) {
      return c.json({ ok: false, error: '`ramGb` must be between 1 and 2048' }, 400);
    }
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  db.prepare("UPDATE providers SET host_ram_gb = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ramGb, id);

  // Recompute num_ctx for every model belonging to this provider so the
  // dashboard reflects the new RAM immediately.
  let recomputeSummary: { probed: number; populated: number } = { probed: 0, populated: 0 };
  try {
    const { recomputeAllModelsForProvider } = await import('../../services/num-ctx-calculator.js');
    recomputeSummary = await recomputeAllModelsForProvider(id);
  } catch (err) {
    logger.warn('host-ram update: recompute failed', {
      providerId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider host_ram_gb updated', { providerId: id, ramGb, recomputeSummary });
  return c.json({ ok: true, data: rowToProvider(row), recomputed: recomputeSummary });
});

// PATCH /providers/:id/response-patience: set or clear how long this provider's streaming
// calls may wait, in milliseconds. Body: { firstChunkTimeoutMs?: number | null,
// streamIdleTimeoutMs?: number | null }. Null on a field means "use the standard bound".
//
// Its own narrow door, not a re-POST, because `POST /providers` over an existing id full-replaces the
// identity fields and a timeout edit must not rewrite a base URL. It changes these two columns only.
configRouter.patch('/providers/:id/response-patience', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = ProviderPatienceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  // A field the body did not name keeps its stored value; a field named as null is cleared.
  // Those are different requests and the schema's `.optional().nullable()` is what keeps them
  // distinguishable, collapsing them would make "set the first bound" silently clear the
  // second.
  const nextFirst = parsed.data.firstChunkTimeoutMs === undefined
    ? existing.first_chunk_timeout_ms ?? null
    : parsed.data.firstChunkTimeoutMs;
  const nextIdle = parsed.data.streamIdleTimeoutMs === undefined
    ? existing.stream_idle_timeout_ms ?? null
    : parsed.data.streamIdleTimeoutMs;

  db.prepare("UPDATE providers SET first_chunk_timeout_ms = ?, stream_idle_timeout_ms = ?, updated_at = datetime('now') WHERE id = ?")
    .run(nextFirst, nextIdle, id);

  // The HTTP client's own clock derives from these columns (a declaration past the standing 300 s gets
  // an undici dispatcher built to carry it), so a cached client would keep the old patience until a
  // restart. Invalidate it, as the edit door does for a rotated credential.
  clearClientCache(id);

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider response patience updated', {
    providerId: id, firstChunkTimeoutMs: nextFirst, streamIdleTimeoutMs: nextIdle,
  });
  return c.json({ ok: true, data: rowToProvider(row) });
});

// PATCH /providers/:id/prefill-throughput: set or clear how many tokens per second this provider's
// owner says it chews through a prompt at. Body: { prefillTokensPerSec: number | null }. Null clears
// it to "undeclared", which turns `resolveDoomCeiling` (and the pre-dial gate it feeds) off for this
// provider.
//
// Same narrow-door shape as the patience door; it changes this one column only.
configRouter.patch('/providers/:id/prefill-throughput', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = ProviderPrefillThroughputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  // Undefined never reaches here (the schema's `.refine()` requires the field); the ternary matches
  // the patience door so both handlers read as one idiom.
  const nextThroughput = parsed.data.prefillTokensPerSec === undefined
    ? existing.prefill_tokens_per_sec ?? null
    : parsed.data.prefillTokensPerSec;

  db.prepare("UPDATE providers SET prefill_tokens_per_sec = ?, updated_at = datetime('now') WHERE id = ?")
    .run(nextThroughput, id);

  // No client cache to invalidate here, unlike the patience door: this column never shapes an HTTP
  // client. It is read fresh off the row at the one place that checks it (`agent/model.ts`'s pre-dial
  // gate, via `resolveDoomCeiling`), so an edit takes effect on the provider's very next call.
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider prefill throughput updated', { providerId: id, prefillTokensPerSec: nextThroughput });
  return c.json({ ok: true, data: rowToProvider(row) });
});

/** The live agents whose main model this is. */
function agentsOnModel(modelId: string): Array<{ id: string; name: string }> {
  return getDb().prepare("SELECT id, name FROM agents WHERE model_id = ? AND status != 'terminated'").all(modelId) as Array<{ id: string; name: string }>;
}

// DELETE /models/:id: remove a model from the DB. Checks for active usage
// by agents first and refuses (409) while a live agent uses it. Removes from router tiers,
// clears config references (PM model, dreamer model).
configRouter.delete('/models/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const model = db.prepare('SELECT id, name, api_model_id FROM models WHERE id = ?').get(id) as
    | { id: string; name: string; api_model_id: string }
    | undefined;
  if (!model) return c.json({ ok: false, error: 'Model not found' }, 404);
  if (isStandardModelRow(id)) return c.json({ ok: false, error: STANDARD_ROW_STAYS }, 409);

  const agents = agentsOnModel(id);
  if (agents.length > 0) {
    const names = agents.map(a => a.name).join(', ');
    return c.json({
      ok: false,
      error: `Cannot delete, model is in use by: ${names}. Change their model first.`,
    }, 409);
  }

  forgetModelReferences(id);

  db.prepare('DELETE FROM models WHERE id = ?').run(id);
  logger.info('Model deleted', { modelId: id, name: model.name, apiModelId: model.api_model_id });

  return c.json({ ok: true });
});

// PUT /models/:id/capabilities: write capabilities directly. Used by
// the dashboard's Edit Capabilities UI when a probe missed a model's
// true capabilities (e.g. OpenRouter not advertising an audio-output
// modality on a newly-launched SKU). Body: { capabilities: string[] }.
// Validates each string against the known vocabulary; unknown entries
// are dropped silently. Returns the updated model row.
configRouter.put('/models/:id/capabilities', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  if (!exists) return c.json({ ok: false, error: 'Model not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const raw = Array.isArray(body?.capabilities) ? body.capabilities : null;
  if (!raw) {
    return c.json({ ok: false, error: 'Request body must include `capabilities` as an array of strings' }, 400);
  }
  const VALID = new Set([
    'tools', 'vision', 'thinking', 'embedding',
    'image_generation', 'video_generation', 'audio_generation', 'music_generation', 'transcription',
    'text',
  ]);
  const filtered = Array.from(new Set(
    raw.filter((v: unknown): v is string => typeof v === 'string' && VALID.has(v)),
  )).sort();

  db.prepare(`
    UPDATE models SET capabilities = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(filtered), id);

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Model capabilities set manually', { modelId: id, capabilities: filtered });

  // Newly granted vision capability may make this model the sole obvious
  // fallback. Same auto-config call refresh-capabilities makes.
  try {
    const { autoConfigureFallbackVisionModelIfObvious } = await import('../../services/vision-model.js');
    autoConfigureFallbackVisionModelIfObvious();
  } catch { /* best-effort */ }

  return c.json({ ok: true, data: rowToModel(row), capabilities: filtered });
});

// PUT /models/:id/generation-params: write the per-model generation param
// spec (the editable model-card panel for image/video/audio generators).
// Body: { generationParams: GenerationParamSpec }, a record of canonical
// param name -> field config. We validate the field shape and store it as
// JSON; this is the user-confirmed source of truth that overrides the
// family-seeded defaults and is never clobbered by the boot backfill.
configRouter.put('/models/:id/generation-params', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  if (!exists) return c.json({ ok: false, error: 'Model not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const raw = body?.generationParams;
  if (raw === null) {
    // Explicit null clears the spec and lets the family seed re-apply.
    db.prepare("UPDATE models SET generation_params = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    const cleared = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
    logger.info('Model generation params cleared', { modelId: id });
    return c.json({ ok: true, data: rowToModel(cleared) });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json({ ok: false, error: '`generationParams` must be an object keyed by param name (or null to clear)' }, 400);
  }

  const errors: string[] = [];
  const spec: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof field !== 'object' || field === null || Array.isArray(field)) {
      errors.push(`${name}: field must be an object`);
      continue;
    }
    const f = field as Record<string, unknown>;
    if (typeof f.accepted !== 'boolean') errors.push(`${name}.accepted must be a boolean`);
    if (!Array.isArray(f.values) || !f.values.every((v) => typeof v === 'string' || typeof v === 'number')) {
      errors.push(`${name}.values must be an array of strings or numbers`);
    }
    if (f.min !== undefined && typeof f.min !== 'number') errors.push(`${name}.min must be a number`);
    if (f.max !== undefined && typeof f.max !== 'number') errors.push(`${name}.max must be a number`);
    if (typeof f.default !== 'string' && typeof f.default !== 'number') errors.push(`${name}.default must be a string or number`);
    if (typeof f.wireField !== 'string' || f.wireField.trim() === '') errors.push(`${name}.wireField must be a non-empty string`);
    if (f.wireType !== 'string' && f.wireType !== 'number') errors.push(`${name}.wireType must be 'string' or 'number'`);
    if (errors.length === 0) {
      spec[name] = {
        accepted: f.accepted,
        values: f.values,
        ...(f.min !== undefined ? { min: f.min } : {}),
        ...(f.max !== undefined ? { max: f.max } : {}),
        default: f.default,
        wireField: f.wireField,
        wireType: f.wireType,
      };
    }
  }
  if (errors.length > 0) {
    return c.json({ ok: false, error: `Invalid generation params:\n- ${errors.join('\n- ')}` }, 400);
  }

  db.prepare("UPDATE models SET generation_params = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(spec), id);
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Model generation params set', { modelId: id, params: Object.keys(spec) });
  return c.json({ ok: true, data: rowToModel(row) });
});

// PUT /models/:id/voice-catalog: write the per-model TTS voice catalog (the
// editable model-card panel for audio-generation models).
// Body: { voiceCatalog: VoiceOption[] | null }, an array of { id,
// description, gender }. null clears the catalog and lets the family seed
// re-apply on the next backfill. The stored catalog is the user-confirmed
// source of truth and is never clobbered by the boot backfill.
configRouter.put('/models/:id/voice-catalog', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const exists = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  if (!exists) return c.json({ ok: false, error: 'Model not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const raw = body?.voiceCatalog;
  if (raw === null) {
    db.prepare("UPDATE models SET voice_catalog = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    const cleared = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
    logger.info('Model voice catalog cleared', { modelId: id });
    return c.json({ ok: true, data: rowToModel(cleared) });
  }
  if (!Array.isArray(raw)) {
    return c.json({ ok: false, error: '`voiceCatalog` must be an array of voice options (or null to clear)' }, 400);
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  const catalog: Array<{ id: string; description: string; gender: string }> = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`voice ${i}: must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const vid = typeof e.id === 'string' ? e.id.trim() : '';
    if (!vid) errors.push(`voice ${i}: id must be a non-empty string`);
    if (vid && seen.has(vid.toLowerCase())) errors.push(`voice ${i}: duplicate id "${vid}"`);
    if (typeof e.description !== 'string') errors.push(`voice ${i}: description must be a string`);
    if (e.gender !== 'male' && e.gender !== 'female' && e.gender !== 'neutral') {
      errors.push(`voice ${i}: gender must be 'male', 'female', or 'neutral'`);
    }
    if (errors.length === 0) {
      seen.add(vid.toLowerCase());
      catalog.push({ id: vid, description: (e.description as string).trim(), gender: e.gender as string });
    }
  });
  if (errors.length > 0) {
    return c.json({ ok: false, error: `Invalid voice catalog:\n- ${errors.join('\n- ')}` }, 400);
  }

  db.prepare("UPDATE models SET voice_catalog = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(catalog), id);
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Model voice catalog set', { modelId: id, voices: catalog.length });
  return c.json({ ok: true, data: rowToModel(row) });
});

// PATCH /models/:id/num-ctx: set or clear the per-model Ollama num_ctx override
// (null clears it; 512 to 2_097_152; only Ollama translates it at call time).
configRouter.patch('/models/:id/num-ctx', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || !('override' in body)) {
    return c.json({ ok: false, error: 'Request body must include an `override` field (number or null)' }, 400);
  }

  const override = body.override;
  if (override !== null) {
    if (typeof override !== 'number' || !Number.isInteger(override)) {
      return c.json({ ok: false, error: '`override` must be an integer or null' }, 400);
    }
    if (override < 512 || override > 2_097_152) {
      return c.json({ ok: false, error: '`override` must be between 512 and 2097152' }, 400);
    }
  }

  const db = getDb();
  // An agent's model may not be narrowed under the floor every door that sets a main model enforces.
  const after = windowOf(id, override);
  const narrowed = after && after.window < after.now && agentsOnModel(id).length > 0 ? refuseSmallMainModel(id, null, override) : null;
  if (narrowed) return c.json({ ok: false, error: narrowed }, 409);
  if (db.prepare("UPDATE models SET num_ctx_override = ?, updated_at = datetime('now') WHERE id = ?").run(override, id).changes === 0) {
    return c.json({ ok: false, error: 'Model not found' }, 404);
  }

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;

  // The recommendation is the default cap and an override still wins. It is sized to what this box can
  // afford (`services/num-ctx-calculator.ts`), so an override above it is the owner choosing to spend
  // memory the sizer says is not there: the response says what the recommendation was and by how much
  // the override exceeds it, and refuses nothing.
  const recommended = typeof row.num_ctx_recommended === 'number' ? row.num_ctx_recommended : null;
  const exceedsRecommended = typeof override === 'number' && recommended !== null && override > recommended;
  const notice = exceedsRecommended
    ? `This override is ${(override - recommended!).toLocaleString()} tokens above the `
      + `${recommended!.toLocaleString()}-token window auto-sized for this machine's RAM. It will be used `
      + 'as you set it; if the model starts failing to load or the box starts swapping, this is the dial to lower.'
    : null;

  logger.info('Model num_ctx override updated', {
    modelId: id, override, recommended, exceedsRecommended,
  });
  await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged();   // a window changed; no-fit locks get another look
  return c.json({ ok: true, data: rowToModel(row), notice });
});

// PATCH /models/:id/limits: the two numbers that decide how much answer fits.
//
// Body: { maxOutputTokens?: number | null, contextWindow?: number | null }
//
// `max_output_tokens` and `context_window` set `max_tokens` on every request through
// `resolveOutputBudget`, and for a manual provider both are guesses (browse-add stores NULL,
// provider-validate stores `context_length ?? 128000` and a derived cap, and vLLM's `max_model_len` /
// LM Studio's `max_context_length` are not read). Every other writer is a discovery sync, so this is
// the only way to correct either.
//
// Partial, in the shape of `/models/:id/num-ctx`: only the fields present in the body move. NULL is not
// the same as absent: it hands the field back to discovery.
configRouter.patch('/models/:id/limits', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const names = ['maxOutputTokens', 'contextWindow'] as const;
  if (!body || !names.some((n) => n in body)) {
    return c.json({ ok: false, error: 'Request body must include `maxOutputTokens` and/or `contextWindow` (integer or null)' }, 400);
  }

  // One ceiling per field, generous on purpose: this door exists because our own guesses were
  // wrong, so it is not the place to hold an opinion about what hardware can do. It refuses
  // only what cannot be a bound at all.
  const CEILINGS: Record<string, number> = { maxOutputTokens: 1_000_000, contextWindow: 2_097_152 };
  const updates: Array<[string, number | null]> = [];
  for (const name of names) {
    if (!(name in body)) continue;
    const v = body[name];
    if (v === null) { updates.push([name, null]); continue; }
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > CEILINGS[name]) {
      return c.json({ ok: false, error: `\`${name}\` must be a positive integer up to ${CEILINGS[name]}, or null` }, 400);
    }
    updates.push([name, v]);
  }

  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  if (!model) return c.json({ ok: false, error: 'Model not found' }, 404);

  const COLUMN: Record<string, string> = {
    maxOutputTokens: 'max_output_tokens',
    contextWindow: 'context_window',
  };
  const sets = updates.map(([name]) => `${COLUMN[name]} = ?`).join(', ');
  // A window narrowed under the floor while agents run on the model is refused (as at num-ctx) and rolled back.
  const before = windowOf(id);
  let narrowed: string | null = null;
  try {
    db.transaction(() => {
      db.prepare(`UPDATE models SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...updates.map(([, v]) => v), id);
      const after = windowOf(id);
      narrowed = before && after && after.window < before.window && agentsOnModel(id).length > 0 ? refuseSmallMainModel(id) : null;
      if (narrowed) throw new Error(narrowed);
    })();
  } catch (err) { if (!narrowed) throw err; }
  if (narrowed) return c.json({ ok: false, error: narrowed }, 409);

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Model limits updated', { modelId: id, ...Object.fromEntries(updates) });
  await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged();   // a window changed; no-fit locks get another look
  return c.json({ ok: true, data: rowToModel(row) });
});

// PATCH /models/:id/thinking: toggle per-model thinking/reasoning, and/or set its level
// Body: { enabled?: boolean, level?: 'low' | 'high' | 'max' } (at least one)
// The level is stored for any model but only SENT to a model whose contract lists it
// (`model-contract.ts` `thinkingLevels`). A level the contract does not offer is refused here,
// so the stored value is always one the wire would accept.
// Only meaningful when the model's capabilities include 'thinking'; the update is accepted for any
// model but only affects call-time behavior on providers we've wired (ollama, openrouter).
configRouter.patch('/models/:id/thinking', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const hasEnabled = !!body && body.enabled !== undefined;
  const hasLevel = !!body && body.level !== undefined;
  if (!body || (!hasEnabled && !hasLevel) || (hasEnabled && typeof body.enabled !== 'boolean')
    || (hasLevel && typeof body.level !== 'string')) {
    return c.json({ ok: false, error: 'Request body must be { enabled?: boolean, level?: string } with at least one' }, 400);
  }

  const db = getDb();
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!model) {
    return c.json({ ok: false, error: 'Model not found' }, 404);
  }

  if (hasLevel) {
    const offered = thinkingLevelsForRow(model);
    if (!(offered as readonly string[]).includes(body.level)) {
      return c.json({
        ok: false,
        error: offered.length === 0
          ? 'This model has no thinking levels'
          : `Thinking level must be one of: ${offered.join(', ')}`,
      }, 400);
    }
    db.prepare("UPDATE models SET thinking_level = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.level, id);
  }
  if (hasEnabled) {
    db.prepare("UPDATE models SET thinking_enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.enabled ? 1 : 0, id);
  }

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Model thinking setting updated', { modelId: id, enabled: hasEnabled ? body.enabled : undefined, level: hasLevel ? body.level : undefined });
  return c.json({ ok: true, data: rowToModel(row) });
});

// PUT /models/:id/pricing: update model pricing
configRouter.put('/models/:id/pricing', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ ok: false, error: 'Request body required' }, 400);
  }

  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  if (!model) {
    return c.json({ ok: false, error: 'Model not found' }, 404);
  }

  // A price below zero would make cost totals go down. Refuse the whole save before anything
  // is written, so a 200 always means everything sent was kept.
  for (const field of ['inputCostPerM', 'outputCostPerM', 'costPerUnit', 'costPerMegapixel'] as const) {
    const v = body[field];
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) {
      return c.json({ ok: false, error: `${field} must be zero or more` }, 400);
    }
  }

  const inputCost = typeof body.inputCostPerM === 'number' ? body.inputCostPerM : undefined;
  const outputCost = typeof body.outputCostPerM === 'number' ? body.outputCostPerM : undefined;
  const VALID_UNITS = ['token', 'megapixel', 'second', 'character', 'minute', 'item'] as const;
  const pricingUnit = VALID_UNITS.includes(body.pricingUnit)
    ? (body.pricingUnit as typeof VALID_UNITS[number])
    : undefined;
  // costPerUnit is the new unified column. null is meaningful (unknown).
  // Negative numbers and non-numerics are silently ignored.
  const costPerUnit =
    body.costPerUnit === null
      ? null
      : typeof body.costPerUnit === 'number' && body.costPerUnit >= 0
        ? body.costPerUnit
        : undefined;
  // costPerMegapixel is the legacy field. Accept it during the compat
  // window; new clients should send costPerUnit instead.
  const costPerMegapixel =
    body.costPerMegapixel === null
      ? null
      : typeof body.costPerMegapixel === 'number' && body.costPerMegapixel >= 0
        ? body.costPerMegapixel
        : undefined;

  if (inputCost !== undefined) {
    db.prepare("UPDATE models SET input_cost_per_m = ?, updated_at = datetime('now') WHERE id = ?").run(inputCost, id);
  }
  if (outputCost !== undefined) {
    db.prepare("UPDATE models SET output_cost_per_m = ?, updated_at = datetime('now') WHERE id = ?").run(outputCost, id);
  }
  if (pricingUnit !== undefined) {
    db.prepare("UPDATE models SET pricing_unit = ?, updated_at = datetime('now') WHERE id = ?").run(pricingUnit, id);
  }
  if (costPerUnit !== undefined) {
    db.prepare("UPDATE models SET cost_per_unit = ?, updated_at = datetime('now') WHERE id = ?").run(costPerUnit, id);
  }
  if (costPerMegapixel !== undefined) {
    db.prepare("UPDATE models SET cost_per_megapixel = ?, updated_at = datetime('now') WHERE id = ?").run(costPerMegapixel, id);
    // Mirror the legacy field into cost_per_unit too so megapixel rows
    // stay in sync regardless of which field a client wrote.
    if (costPerUnit === undefined) {
      db.prepare("UPDATE models SET cost_per_unit = ? WHERE id = ?").run(costPerMegapixel, id);
    }
  }

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ ok: true, data: rowToModel(row) });
});

// POST /models/enable
configRouter.post('/models/enable', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = EnableModelsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'modelIds array required' }, 400);
  }

  const db = getDb();
  const { modelIds } = parsed.data;

  const updateStmt = db.prepare(`
    UPDATE models SET is_enabled = 1, updated_at = datetime('now') WHERE id = ?
  `);

  const enableMany = db.transaction((ids: string[]) => {
    for (const id of ids) {
      updateStmt.run(id);
    }
  });

  enableMany(modelIds);
  logger.info('Models enabled', { count: modelIds.length });
  await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged();   // a model is available; no-fit locks get another look

  // If the platform now has exactly one enabled vision-capable model and no fallback is configured,
  // set it, so the Settings > Models warning does not linger.
  try {
    const { autoConfigureFallbackVisionModelIfObvious } = await import('../../services/vision-model.js');
    autoConfigureFallbackVisionModelIfObvious();
  } catch { /* best-effort */ }

  return c.json({ ok: true, data: { enabled: modelIds.length } });
});

// POST /models/check-usage: check which agents use these models before disabling/deleting
configRouter.post('/models/check-usage', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = EnableModelsSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'modelIds array required' }, 400);

  const usages = parsed.data.modelIds.map(id => getModelUsage(id)).filter(u => u.usedBy.length > 0);
  return c.json({ ok: true, data: { usages } });
});

// POST /models/disable
configRouter.post('/models/disable', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = EnableModelsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'modelIds array required' }, 400);
  }

  const db = getDb();
  // The Dojo's own pair is hard-wired: it leaves the batch, and a batch of only the pair is refused.
  const modelIds = parsed.data.modelIds.filter((id) => !isStandardModelRow(id));
  if (modelIds.length === 0) return c.json({ ok: false, error: STANDARD_ROW_STAYS }, 409);

  const updateStmt = db.prepare(`
    UPDATE models SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?
  `);

  const disableMany = db.transaction((ids: string[]) => {
    for (const id of ids) {
      updateStmt.run(id);
    }
  });

  disableMany(modelIds);

  const moved = reassignAffectedAgents(modelIds);

  logger.info('Models disabled', { count: modelIds.length, ...moved });

  return c.json({ ok: true, data: { disabled: modelIds.length, ...moved } });
});



// GET /settings/:key
configRouter.get('/settings/:key', (c) => {
  const db = getDb();
  const key = c.req.param('key');
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return c.json({ ok: true, data: { key, value: row?.value ?? null } });
});

// PUT /settings/:key
configRouter.put('/settings/:key', async (c) => {
  const db = getDb();
  const key = c.req.param('key');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.value !== 'string') {
    return c.json({ ok: false, error: 'value string is required' }, 400);
  }

  if (CLOCK_TIME_SETTING_KEYS.includes(key)) {
    const badTime = refuseBadClockTime(body.value);
    if (badTime) return c.json({ ok: false, error: badTime }, 400);
  }

  // A channel safe-sender list is saved WHOLE, and it decides who the agent may auto-reply to. A save
  // must name the exact value it was built on (`base`: the stored string, or null when nothing was
  // saved). If the stored value has moved since (another tab, the agent adding a sender) or the
  // client never read it (a failed load looks blank), the save is refused and nothing is written.
  if ((await import('../../contacts/from-safe-senders.js')).configKeyToChannel(key)) {
    const stored = (db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    if (!('base' in body) || (body.base !== null && typeof body.base !== 'string')) {
      return c.json({ ok: false, error: 'This list could not be saved because the page did not say which saved list it was built on. Reload the page and try again.' }, 400);
    }
    if ((body.base || null) !== (stored || null)) {
      return c.json({ ok: false, error: 'This list changed since you loaded it, so it was not saved. Reload it and make your change again.' }, 409);
    }
    // Who the OWNER is changes only on purpose: a save that adds, moves or removes the starred entry must
    // say so (`ownerChange: true`). Deleting a row, or any other edit, never moves the star as a side effect.
    // Judged by the ONE reader every other part of the platform uses, on both sides - so a bare-address list,
    // or an unstarred list whose legacy default-sender key names an entry, has the owner it is read as having.
    const { parseSafeSenders } = await import('../../services/safe-senders.js');
    const owners = (raw: string | null): string =>
      parseSafeSenders(raw).filter((e) => e.is_primary).map((e) => e.address.trim().toLowerCase()).sort().join('|');
    if (owners(body.value) !== owners(stored) && body.ownerChange !== true) {
      return c.json({ ok: false, error: 'This change would add, move or remove the owner entry. Change the owner on purpose (star the entry, or confirm removing it) and save again.' }, 409);
    }
  }

  // The 32K main-model floor for a service agent's MAIN model, and the memory fit for every local-model
  // key. Refused before any write; re-saving the stored value never is.
  if (LOCAL_MODEL_SETTING_KEYS.includes(key)) {
    const agentKey = MAIN_MODEL_SETTING_KEYS.includes(key);   // judged against what its agent runs on, not the stored setting
    const current = agentKey
      ? (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(modelKeyAgentId(key)) as { model_id: string | null } | undefined)?.model_id
      : (db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const refused = await (agentKey ? refuseAgentModel(body.value, current) : refuseUnfitLocalModel(body.value, current, 'job'));
    if (refused) return c.json({ ok: false, error: refused }, 400);
  }

  // `<role>_agent_name` is the display name for the primary / PM / trainer / healer / dreamer:
  // `config/platform.ts`'s getters read this key, not the `agents` row, and `substitutePlatformNames`
  // bakes it into the stored soul at seed time. So a rename goes through the one door that writes the
  // row, writes this key and re-fills the souls. The generic upsert below still runs and is idempotent.
  const roleIdKey = roleNameKeyToIdKey(key);
  if (roleIdKey) {
    const idRow = db.prepare('SELECT value FROM config WHERE key = ?').get(roleIdKey) as { value: string } | undefined;
    const targetId = idRow?.value;
    if (targetId && db.prepare('SELECT id FROM agents WHERE id = ?').get(targetId)) {
      const renameOutcome = renameAgent(targetId, body.value);
      // The rename door refuses a case-variant clash with another live agent. Short-circuit before the
      // generic upsert, so the config key does not move with the row.
      if (renameOutcome.refusal) return c.json({ ok: false, error: renameOutcome.refusal }, 400);
    }
  }

  const previousName = key === 'owner_name' ? (db.prepare("SELECT value FROM config WHERE key = 'owner_name'").get() as { value: string } | undefined)?.value ?? '' : '';
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, body.value);
  if (key === 'owner_name') {
    try { renameOwnerInProfile(previousName, body.value); }   // the name is saved either way; an unreadable USER.md keeps its old line
    catch (err) { logger.warn('The owner name was saved but USER.md could not be updated', { error: err instanceof Error ? err.message : String(err) }); }
  }

  // Mirror channel safe-sender lists into the contacts store so a name the user
  // just trusted (e.g. "Alex" on the iMessage list) resolves when they later
  // say "text Alex about ...". The dashboard replaces the whole list on save;
  // the mirror is idempotent + additive (it never deletes contacts) and
  // best-effort (a contacts hiccup must not fail the setting write).
  try {
    const { configKeyToChannel, syncSafeSendersToContacts } = await import('../../contacts/from-safe-senders.js');
    const channel = configKeyToChannel(key);
    if (channel) {
      const { parseSafeSenders } = await import('../../services/imessage-bridge.js');
      syncSafeSendersToContacts(channel, parseSafeSenders(body.value), null);
    }
  } catch (err) {
    const { createLogger } = await import('../../logger.js');
    createLogger('config').warn('Failed to mirror safe senders to contacts', {
      key, error: err instanceof Error ? err.message : String(err),
    });
  }

  if (key === 'router.context_window') await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged();   // the router window changed; no-fit locks get another look

  const platformKeys = ['owner_name', 'primary_agent_id', 'primary_agent_name', 'pm_agent_id', 'pm_agent_name', 'trainer_agent_id', 'trainer_agent_name', 'setup_completed'];
  if (platformKeys.includes(key)) {
    const { clearPlatformConfigCache } = await import('../../config/platform.js');
    clearPlatformConfigCache();
  }

  // iMessage bridge holds approvedSenders in module-local state, populated
  // only at startIMBridge(). When the dashboard adds a new approved sender,
  // the DB row updates but the bridge keeps matching against the original
  // list, messages from the new sender arrive in Messages.app but never
  // reach the agent. Hot-reload the in-memory list on config save.
  if (key === 'imessage_approved_senders') {
    try {
      const { reloadApprovedSenders } = await import('../../services/imessage-bridge.js');
      reloadApprovedSenders();
    } catch (err) {
      const { createLogger } = await import('../../logger.js');
      createLogger('config').error('Failed to reload iMessage approved senders', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // iMessage bridge runs from in-memory state. Just writing imessage_enabled
  // to the config table does nothing, the bridge keeps polling until the
  // server restarts. Toggle the actual bridge in lockstep with the setting.
  if (key === 'imessage_enabled') {
    try {
      if (body.value === 'true') {
        const recipientRow = db
          .prepare("SELECT value FROM config WHERE key = 'imessage_recipient'")
          .get() as { value: string } | undefined;
        if (recipientRow?.value) {
          const { startIMBridge } = await import('../../services/imessage-bridge.js');
          startIMBridge(recipientRow.value);
        }
      } else {
        const { stopIMBridge } = await import('../../services/imessage-bridge.js');
        stopIMBridge();
      }
    } catch (err) {
      // Don't fail the setting write, log and continue. The user can retry.
      const { createLogger } = await import('../../logger.js');
      createLogger('config').error('Failed to toggle iMessage bridge in lockstep with setting', {
        enabled: body.value,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A service agent's model setting moves that agent too, through the one model setter. An empty value
  // means "Auto" in Settings and moves no agent row, as the Healer and Dreamer doors already do.
  const roleAgent = body.value ? modelKeyAgentId(key) : null;
  if (roleAgent) await setAgentModel(roleAgent, body.value);

  return c.json({ ok: true, data: { key, value: body.value } });
});

const PROMPTS_DIR = path.join(homeDir(), '.dojo', 'prompts');

const IDENTITY_FILES: Record<string, { filename: string; defaultContent: string }> = {
  soul: { filename: 'SOUL.md', defaultContent: DEFAULT_SOUL },
  user: { filename: 'USER.md', defaultContent: DEFAULT_USER },
  'SOUL.md': { filename: 'SOUL.md', defaultContent: DEFAULT_SOUL },
  'USER.md': { filename: 'USER.md', defaultContent: DEFAULT_USER },
};

// GET /identity/:file
configRouter.get('/identity/:file', (c) => {
  const fileKey = c.req.param('file');
  const entry = IDENTITY_FILES[fileKey];
  if (!entry) {
    return c.json({ ok: false, error: `Unknown identity file: ${fileKey}` }, 400);
  }

  // USER.md goes through its one source of truth; the route neither computes the path nor composes the default.
  if (entry.filename === 'USER.md') {
    try {
      return c.json({ ok: true, data: { content: readUserProfileForEditor(), mailboxes: ownerMailboxes() } });
    } catch (err) {
      noteRouteFailure(c, logger, err);
      return c.json({ ok: false, error: 'Your profile could not be read. Try again.' }, 500);   // never the shipped default
    }
  }

  const filePath = path.join(PROMPTS_DIR, entry.filename);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    content = entry.defaultContent;
  }

  return c.json({ ok: true, data: { content } });
});

// PUT /identity/:file
configRouter.put('/identity/:file', async (c) => {
  const fileKey = c.req.param('file');
  const entry = IDENTITY_FILES[fileKey];
  if (!entry) {
    return c.json({ ok: false, error: `Unknown identity file: ${fileKey}` }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== 'string') {
    return c.json({ ok: false, error: 'content string is required' }, 400);
  }

  // Saved whole: it must be built on the text the page read (`base`), and a blank is never silently saved over a real one.
  {
    let current: string;
    try {
      current = entry.filename === 'USER.md'
        ? readUserProfileForEditor()
        : (() => { const f = path.join(PROMPTS_DIR, entry.filename); return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : entry.defaultContent; })();
    } catch (err) {
      noteRouteFailure(c, logger, err);
      return c.json({ ok: false, error: 'The saved document could not be read, so nothing was changed. Try again.' }, 500);
    }
    const refusal = refuseStaleWholeDocument('document', body.content, body.base, current);
    if (refusal) return c.json({ ok: false, error: refusal.error }, refusal.status);
  }

  // The dashboard edit door for USER.md, the same door the OOBE writes through.
  if (entry.filename === 'USER.md') {
    writeUserProfile(body.content, 'dashboard');
    return c.json({ ok: true, data: { message: 'Updated' } });
  }

  const filePath = path.join(PROMPTS_DIR, entry.filename);
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(filePath, body.content, 'utf-8');

  logger.info('Identity file updated', { file: fileKey });
  return c.json({ ok: true, data: { message: 'Updated' } });
});

// POST /identity/generate
configRouter.post('/identity/generate', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ ok: false, error: 'Request body required' }, 400);
  }

  // The OOBE substitutes into the shipped defaults and composes nothing: both composers live beside the
  // text they seed from (`prompt/oobe-soul.ts`, `prompt/user-profile.ts`) and the writes go through the
  // one soul door and the one profile door.
  const { communicationStyle = 'balanced', rules = '', userName = '', userRole = '', userPreferences = '' } = body;

  // Past first run an edited soul is kept unless the owner changed style/rules (then backed up).
  const { soul, backup: soulBackup } = writeOobeSoul({ communicationStyle, rules }, isPastFirstRun(), body.restyle === true);

  // Only while no human has written in it: a guard of "absent, or under 20 characters" cannot tell the
  // engine's own ~600-byte seed from an owner's profile.
  if (userProfileIsEngineSeeded()) {
    writeUserProfile(composeUserProfile({ userName, userRole, userPreferences }), 'oobe');
  }
  // The response is what is on disk, not what we composed: the guard above declines to overwrite a
  // profile a person wrote, so echoing the composed text would claim the owner's words were replaced.
  const user = readUserProfile();

  logger.info('Identity files generated', { style: communicationStyle, namedOwner: !!String(userName).trim() });
  return c.json({ ok: true, data: { soul, user, soulBackup } });
});


// GET /search: returns current search provider config
configRouter.get('/search', (c) => {
  const provider = getSearchProvider();
  const hasKey = !!getSearchApiKey();
  return c.json({ ok: true, data: { provider: provider ?? 'brave', hasKey } });
});

// PUT /search: save search provider and API key
configRouter.put('/search', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.provider !== 'string' || typeof body.apiKey !== 'string') {
    return c.json({ ok: false, error: 'provider and apiKey are required' }, 400);
  }

  setSearchConfig(body.provider, body.apiKey);
  clearSecretsCache();
  logger.info('Search config updated', { provider: body.provider });
  return c.json({ ok: true, data: { provider: body.provider, hasKey: true } });
});

// POST /search/validate: test the search API key
configRouter.post('/search/validate', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.apiKey !== 'string') {
    return c.json({ ok: false, error: 'apiKey is required' }, 400);
  }

  try {
    const response = await fetch('https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': body.apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return c.json({ ok: true, data: { valid: true } });
    }

    const errorText = await response.text().catch(() => '');
    logger.warn('Search key validation failed', { status: response.status, body: errorText.slice(0, 200) });
    return c.json({ ok: false, error: `Validation failed (HTTP ${response.status})` }, 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Search key validation error', { error: msg });
    return c.json({ ok: false, error: `Validation failed: ${msg}` }, 400);
  }
});


function rowToProvider(row: Record<string, unknown>): Provider {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as Provider['type'],
    baseUrl: row.base_url as string | null,
    authType: row.auth_type as Provider['authType'],
    behavesLike: (row.behaves_like ?? null) as Provider['behavesLike'],
    // Read back as stored: a row read through an old path may lack these columns, and `?? null` says
    // "declared nothing" rather than inventing a number.
    firstChunkTimeoutMs: typeof row.first_chunk_timeout_ms === 'number' ? row.first_chunk_timeout_ms : null,
    streamIdleTimeoutMs: typeof row.stream_idle_timeout_ms === 'number' ? row.stream_idle_timeout_ms : null,
    prefillTokensPerSec: typeof row.prefill_tokens_per_sec === 'number' ? row.prefill_tokens_per_sec : null,
    // Measured prefill is READ-ONLY (no write door): it is the engine's own observation, and a form that
    // let a person edit it would turn a measurement back into the declaration it exists to stop asking for.
    measuredPrefillTokensPerSec: typeof row.measured_prefill_tokens_per_sec === 'number' ? row.measured_prefill_tokens_per_sec : null,
    measuredPrefillAt: typeof row.measured_prefill_at === 'string' ? row.measured_prefill_at : null,
    isValidated: Boolean(row.is_validated),
    validatedAt: row.validated_at as string | null,
    hostRamGb: typeof row.host_ram_gb === 'number' ? row.host_ram_gb : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** The thinking levels this model's wire accepts, from the one model contract. Empty: no level control. */
function thinkingLevelsForRow(row: Record<string, unknown>): ThinkingLevel[] {
  try {
    const provider = getDb().prepare('SELECT base_url, behaves_like FROM providers WHERE id = ?')
      .get(row.provider_id as string) as { base_url: string | null; behaves_like: string | null } | undefined;
    if (!provider) return [];
    return [...contractForModel({
      providerBaseUrl: provider.base_url,
      apiModelId: row.api_model_id as string,
      providerBehavesLike: provider.behaves_like,
    }).thinkingLevels];
  } catch {
    return [];
  }
}

/** The window the engine budgets a model with when none is stored (`getContextWindow`'s own answer). */
function engineWindowFor(modelId: unknown): number | null {
  try { return typeof modelId === 'string' ? getContextWindow(modelId) : null; } catch { return null; }
}

function rowToModel(row: Record<string, unknown>): Model {
  // thinking_enabled may be missing on pre-migration reads in rare paths;
  // default to true so the behavior matches the migration default.
  const thinkingEnabledRaw = row.thinking_enabled;
  const thinkingEnabled = thinkingEnabledRaw === undefined || thinkingEnabledRaw === null
    ? true
    : Boolean(thinkingEnabledRaw);

  // num_ctx_override: null means "use the computed recommendation (or
  // Modelfile default if that's also null)".
  const numCtxOverrideRaw = row.num_ctx_override;
  const numCtxOverride = typeof numCtxOverrideRaw === 'number' ? numCtxOverrideRaw : null;
  const numCtxRecommendedRaw = row.num_ctx_recommended;
  const numCtxRecommended = typeof numCtxRecommendedRaw === 'number' ? numCtxRecommendedRaw : null;

  // Default to 'token': an older row may lack the column, and this keeps every existing model as it was.
  const pricingUnitRaw = row.pricing_unit;
  const pricingUnit: 'token' | 'megapixel' | 'second' | 'character' | 'minute' | 'item' =
    pricingUnitRaw === 'megapixel' || pricingUnitRaw === 'second' ||
    pricingUnitRaw === 'character' || pricingUnitRaw === 'minute' || pricingUnitRaw === 'item'
      ? pricingUnitRaw
      : 'token';

  // cost_per_unit may be null on a megapixel row that predates it; fall back to cost_per_megapixel so
  // the dashboard and cost tracker see the right number.
  const costPerUnitRaw = row.cost_per_unit;
  const costPerMegapixelRaw = row.cost_per_megapixel;
  const costPerUnit =
    typeof costPerUnitRaw === 'number'
      ? costPerUnitRaw
      : pricingUnit === 'megapixel' && typeof costPerMegapixelRaw === 'number'
        ? costPerMegapixelRaw
        : null;
  // Keep costPerMegapixel populated alongside costPerUnit while readers still use it.
  const costPerMegapixel =
    pricingUnit === 'megapixel'
      ? (typeof costPerMegapixelRaw === 'number' ? costPerMegapixelRaw : costPerUnit)
      : null;

  // priceUnknown (derived, no column): the rate that applies to this model is NULL in the DB rather
  // than an explicit 0 (for token rows a missing input or output $/M; otherwise a missing cost_per_unit).
  // The biller bills an unknown rate as $0, so this flag surfaces the "price unknown, set a rate" state
  // and keeps a paid model with a failed price lookup from being silently hidden at $0.
  const priceUnknown = pricingUnit === 'token'
    ? (row.input_cost_per_m === null || row.input_cost_per_m === undefined ||
       row.output_cost_per_m === null || row.output_cost_per_m === undefined)
    : costPerUnit === null;

  // generation_params: per-model canonical-to-wire param spec for generation tools; null when not seeded.
  let generationParams: Model['generationParams'] = null;
  if (typeof row.generation_params === 'string' && row.generation_params) {
    try {
      generationParams = JSON.parse(row.generation_params) as Model['generationParams'];
    } catch {
      generationParams = null;
    }
  }

  // voice_catalog: per-model TTS voice list; null when not seeded.
  let voiceCatalog: Model['voiceCatalog'] = null;
  if (typeof row.voice_catalog === 'string' && row.voice_catalog) {
    try {
      const parsed = JSON.parse(row.voice_catalog);
      voiceCatalog = Array.isArray(parsed) ? (parsed as Model['voiceCatalog']) : null;
    } catch {
      voiceCatalog = null;
    }
  }

  return {
    id: row.id as string,
    providerId: row.provider_id as string,
    name: row.name as string,
    apiModelId: row.api_model_id as string,
    capabilities: JSON.parse(row.capabilities as string),
    contextWindow: row.context_window as number | null,
    // A window that is not set is not a silent gap. The row names the figure the engine budgets with.
    assumedContextWindow: typeof row.context_window === 'number' && row.context_window > 0 ? null : engineWindowFor(row.id),
    maxOutputTokens: row.max_output_tokens as number | null,
    inputCostPerM: row.input_cost_per_m as number | null,
    outputCostPerM: row.output_cost_per_m as number | null,
    pricingUnit,
    costPerUnit,
    costPerMegapixel,
    priceUnknown,
    isEnabled: Boolean(row.is_enabled),
    tooSmallForAgents: !passesMainModelFloor(row.id as string),
    thinkingEnabled,
    thinkingLevel: row.thinking_level === 'low' || row.thinking_level === 'max' ? row.thinking_level : 'high',
    thinkingLevels: thinkingLevelsForRow(row),
    numCtxOverride,
    numCtxRecommended,
    generationParams,
    voiceCatalog,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}


// GET /api/config/agent-sdk/status: check if Claude CLI is installed and authenticated
configRouter.get('/agent-sdk/status', async (c) => {
  try {
    const { isClaudeCliInstalled, getClaudeCliVersion, isSdkPackageAvailable } = await import('../../providers/anthropic-sdk-auth.js');
    const cliInstalled = isClaudeCliInstalled();
    const version = cliInstalled ? getClaudeCliVersion() : null;
    const packageAvailable = isSdkPackageAvailable();

    return c.json({
      ok: true,
      data: {
        cliInstalled,
        version,
        packageAvailable,
      },
    });
  } catch (err) {
    noteRouteFailure(c, logger, err);
    return c.json({ ok: true, data: { cliInstalled: false, version: null, packageAvailable: false } });
  }
});

// POST /api/config/agent-sdk/verify: test auth by running a minimal query
configRouter.post('/agent-sdk/verify', async (c) => {
  try {
    const { checkSdkAuth } = await import('../../providers/anthropic-sdk-auth.js');
    const result = await checkSdkAuth();
    return c.json({ ok: true, data: result });
  } catch (err) {
    noteRouteFailure(c, logger, err);
    return c.json({ ok: true, data: { authenticated: false, error: err instanceof Error ? err.message : String(err) } });
  }
});

// The owner's cards: the dashboard asks on load and on every reconnect for the standing notices the one
// writer recorded (`healer/owner-notice-kinds.ts`). Dismissing stamps that notice, so it stays dismissed
// across reloads and restarts, and a NEW incident is a new card.

// GET /api/config/owner-notices: the owner cards still standing
configRouter.get('/owner-notices', (c) => c.json({ ok: true, data: servedOwnerNotices() }));

// POST /api/config/owner-notices/dismiss: { cardKey }, the card's X
configRouter.post('/owner-notices/dismiss', async (c) => {
  const body = await c.req.json().catch(() => null) as { cardKey?: unknown } | null;
  if (typeof body?.cardKey !== 'string') return c.json({ ok: false, error: 'cardKey is required' }, 400);
  const hit = ownerToldOf(body.cardKey);
  if (hit) dismissOwnerNotice(body.cardKey);
  return c.json({ ok: true, data: { dismissed: hit ? 1 : 0 } });
});

// GET /api/config/openrouter/credits: fetch OpenRouter account balance. READ ONLY: the warning-threshold
// check is the background check in `costs/provider-balance-check.ts`, on the scheduler's clock; this
// route reads through the same reader and decides nothing.
configRouter.get('/openrouter/credits', async (c) => {
  const provider = findOpenRouterProvider();
  if (!provider) {
    return c.json({ ok: false, error: 'No OpenRouter provider configured' }, 404);
  }

  const credential = getProviderCredential(provider.id);
  if (!credential) {
    return c.json({ ok: false, error: 'No API key found for OpenRouter provider' }, 400);
  }

  try {
    const read = await readOpenRouterCredits(credential);
    if (!read.ok) return c.json({ ok: false, error: read.error }, 502);
    return c.json({ ok: true, data: read.data });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// GET /api/config/openrouter/threshold: get saved warning threshold
configRouter.get('/openrouter/threshold', (c) => {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'openrouter_warning_threshold'").get() as { value: string } | undefined;
  return c.json({ ok: true, data: { value: row?.value ?? '' } });
});

// DeepSeek balance + warning threshold, mirroring the OpenRouter pattern. DeepSeek exposes account
// balance at https://api.deepseek.com/user/balance (balance_infos[]: currency, total_balance,
// granted_balance, topped_up_balance).

// GET /api/config/deepseek/balance: fetch DeepSeek account balance
//
// READ ONLY, like the OpenRouter route above: the threshold check is the background check.
configRouter.get('/deepseek/balance', async (c) => {
  const provider = findDeepSeekProvider();
  if (!provider) {
    return c.json({ ok: false, error: 'No DeepSeek provider configured' }, 404);
  }

  const credential = getProviderCredential(provider.id);
  if (!credential) {
    return c.json({ ok: false, error: 'No API key found for DeepSeek provider' }, 400);
  }

  try {
    const read = await readDeepSeekBalance(credential);
    if (!read.ok) return c.json({ ok: false, error: read.error }, 502);
    return c.json({ ok: true, data: read.data });
  } catch (err) {
    return routeFailure(c, logger, err, { status: 500 });
  }
});

// GET /api/config/deepseek/threshold: get saved warning threshold
configRouter.get('/deepseek/threshold', (c) => {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = 'deepseek_warning_threshold'").get() as { value: string } | undefined;
  return c.json({ ok: true, data: { value: row?.value ?? '' } });
});

// POST /api/config/deepseek/threshold: save warning threshold
configRouter.post('/deepseek/threshold', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.threshold !== 'number') {
    return c.json({ ok: false, error: 'threshold (number) is required' }, 400);
  }
  if (!Number.isFinite(body.threshold) || body.threshold < 0) {
    return c.json({ ok: false, error: 'threshold must be zero or more' }, 400);
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('deepseek_warning_threshold', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(String(body.threshold), String(body.threshold));
  // The latch is NOT reset here: the background check re-arms on its own when the balance sits above the
  // new line, and a balance still under it after a threshold edit is not a new crossing.
  return c.json({ ok: true });
});

// POST /api/config/openrouter/threshold: save warning threshold
configRouter.post('/openrouter/threshold', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.threshold !== 'number') {
    return c.json({ ok: false, error: 'threshold (number) is required' }, 400);
  }
  if (!Number.isFinite(body.threshold) || body.threshold < 0) {
    return c.json({ ok: false, error: 'threshold must be zero or more' }, 400);
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES ('openrouter_warning_threshold', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(String(body.threshold), String(body.threshold));
  return c.json({ ok: true });
});

export { configRouter };
