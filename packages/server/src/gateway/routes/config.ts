import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDb } from '../../db/connection.js';
import { getProviderCredential, setProviderCredential, clearSecretsCache, getSearchApiKey, getSearchProvider, setSearchConfig } from '../../config/loader.js';
import { clearClientCache } from '../../agent/model.js';
import { CreateProviderSchema, EnableModelsSchema } from '../../config/schema.js';
import { createLogger } from '../../logger.js';
import { DEFAULT_SOUL_MD as DEFAULT_SOUL, DEFAULT_USER_MD as DEFAULT_USER } from '../../prompt/templates.js';
import { getOllamaModelInfo } from '../../services/ollama.js';
import type { Provider, Model } from '@dojo/shared';

// ── Model Usage Helper ──

interface ModelUsage {
  modelId: string;
  modelName: string;
  usedBy: Array<{ type: 'agent' | 'pm_model' | 'dreamer_model'; id: string; name: string }>;
}

function getModelUsage(modelId: string): ModelUsage {
  const db = getDb();
  const model = db.prepare('SELECT id, name FROM models WHERE id = ?').get(modelId) as { id: string; name: string } | undefined;
  const usedBy: ModelUsage['usedBy'] = [];

  // Check agents
  const agents = db.prepare(
    "SELECT id, name FROM agents WHERE model_id = ? AND status != 'terminated'"
  ).all(modelId) as Array<{ id: string; name: string }>;
  for (const a of agents) {
    usedBy.push({ type: 'agent', id: a.id, name: a.name });
  }

  // Check PM model config
  const pmModel = db.prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string } | undefined;
  if (pmModel?.value === modelId) {
    usedBy.push({ type: 'pm_model', id: 'pm_agent_model', name: 'PM Agent Default Model' });
  }

  // Check dreamer model config
  const dreamerModel = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
  if (dreamerModel?.value === modelId) {
    usedBy.push({ type: 'dreamer_model', id: 'dreaming_model_id', name: 'Dreamer Model' });
  }

  return { modelId, modelName: model?.name ?? modelId, usedBy };
}

function reassignAffectedAgents(modelIds: string[]): number {
  if (modelIds.length === 0) return 0;

  const db = getDb();
  let reassigned = 0;

  // Find a fallback model — first enabled model not in the affected set
  let fallback: { id: string } | undefined;
  try {
    const placeholders = modelIds.map(() => '?').join(',');
    fallback = db.prepare(
      `SELECT id FROM models WHERE is_enabled = 1 AND id NOT IN (${placeholders}) ORDER BY input_cost_per_m ASC LIMIT 1`
    ).get(...modelIds) as { id: string } | undefined;
  } catch {
    // If query fails, try without the exclusion
    fallback = db.prepare(
      'SELECT id FROM models WHERE is_enabled = 1 ORDER BY input_cost_per_m ASC LIMIT 1'
    ).get() as { id: string } | undefined;
  }

  const fallbackId = fallback?.id ?? null;

  for (const mid of modelIds) {
    // Reassign agents
    const result = db.prepare(
      "UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE model_id = ? AND status != 'terminated'"
    ).run(fallbackId, mid);
    reassigned += result.changes;

    // Clear PM model if it matches
    const pmModel = db.prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string } | undefined;
    if (pmModel?.value === mid && fallbackId) {
      db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'pm_agent_model'").run(fallbackId);
    }

    // Clear dreamer model if it matches
    const dreamerModel = db.prepare("SELECT value FROM config WHERE key = 'dreaming_model_id'").get() as { value: string } | undefined;
    if (dreamerModel?.value === mid && fallbackId) {
      db.prepare("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = 'dreaming_model_id'").run(fallbackId);
    }
  }

  return reassigned;
}

const logger = createLogger('config-routes');

// Fallback Anthropic models — used only if models.list() API call fails
const ANTHROPIC_MODELS_FALLBACK = [
  {
    name: 'Claude Opus 4',
    apiModelId: 'claude-opus-4-6',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 32768,
    inputCostPerM: 15.0,
    outputCostPerM: 75.0,
  },
  {
    name: 'Claude Sonnet 4',
    apiModelId: 'claude-sonnet-4-6',
    capabilities: ['chat', 'code', 'analysis', 'tools'],
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputCostPerM: 3.0,
    outputCostPerM: 15.0,
  },
  {
    name: 'Claude Haiku 3.5',
    apiModelId: 'claude-haiku-4-5',
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

function getAnthropicCost(modelId: string): { input: number; output: number } {
  for (const [key, cost] of Object.entries(ANTHROPIC_COST_MAP)) {
    if (modelId.includes(key)) return cost;
  }
  return { input: 3.0, output: 15.0 }; // default to sonnet pricing
}

// Known OpenAI models — API doesn't return token limits, so we maintain a reference table
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
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPerM: number;
  outputCostPerM: number;
}>> {
  try {
    const models: Array<{
      name: string;
      apiModelId: string;
      capabilities: string[];
      contextWindow: number;
      maxOutputTokens: number;
      inputCostPerM: number;
      outputCostPerM: number;
    }> = [];

    // Fetch all models from Anthropic API
    const response = await client.models.list({ limit: 100 });

    for (const model of response.data) {
      // Only include Claude chat models (skip embeddings, legacy, etc.)
      if (!model.id.startsWith('claude-')) continue;

      // Derive a friendly name from the model ID
      const idParts = model.id.split('-');
      const familyName = idParts.slice(0, 2).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
      const version = idParts.slice(2).join('.');
      const displayName = `${familyName} ${version}`;

      const cost = getAnthropicCost(model.id);

      // The API returns max_tokens (max output tokens) and context_window on model objects
      const apiModel = model as unknown as Record<string, unknown>;
      const maxOutput = (apiModel.max_tokens as number) ?? (apiModel.max_output_tokens as number) ?? 8192;
      const contextWindow = (apiModel.context_window as number) ?? 200000;

      models.push({
        name: model.display_name ?? displayName,
        apiModelId: model.id,
        capabilities: ['chat', 'code', 'analysis', 'tools'],
        contextWindow,
        maxOutputTokens: maxOutput,
        inputCostPerM: cost.input,
        outputCostPerM: cost.output,
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

// ── Providers ──

// GET /providers
configRouter.get('/providers', (c) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM providers ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;

  const providers: Provider[] = rows.map(rowToProvider);
  return c.json({ ok: true, data: providers });
});

// GET /providers/:id
configRouter.get('/providers/:id', (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ ok: false, error: 'Provider not found' }, 404);
  }

  return c.json({ ok: true, data: rowToProvider(row) });
});

// POST /providers
configRouter.post('/providers', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = CreateProviderSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join(', ') }, 400);
  }

  const { id, name, type, baseUrl, authType, credential } = parsed.data;
  const db = getDb();

  // If provider already exists, update it instead of erroring
  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
  if (existing) {
    db.prepare(`
      UPDATE providers SET name = ?, type = ?, base_url = ?, auth_type = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, type, baseUrl ?? null, authType, id);

    if (credential) {
      setProviderCredential(id, credential, authType as 'api_key' | 'oauth');
      clearClientCache(id);
    }

    const updated = db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    return c.json({ ok: true, data: updated });
  }

  // Store credential securely (skip for Ollama which has no auth)
  if (credential) {
    logger.info('Storing provider credential', {
      providerId: id,
      authType,
      credentialPrefix: credential.slice(0, 10) + '...',
    });
    setProviderCredential(id, credential, authType as 'api_key' | 'oauth');
    clearClientCache(id);
  } else {
    logger.info('No credential to store (local provider)', { providerId: id });
  }

  // Insert provider into DB
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, name, type, baseUrl ?? null, authType);

  // Auto-insert models for Anthropic providers (dynamically fetched, with fallback)
  if (type === 'anthropic') {
    let anthropicModels = ANTHROPIC_MODELS_FALLBACK;
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

    // Also try to discover any additional models from the API
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
                128000, 16384, 2.50, 10.0,
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

  const row = db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as Record<string, unknown>;
  logger.info('Provider created', { providerId: id, type });

  return c.json({ ok: true, data: rowToProvider(row) }, 201);
});

// DELETE /providers/:id
configRouter.delete('/providers/:id', (c) => {
  try {
    const db = getDb();
    const id = c.req.param('id');

    const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
    if (!existing) {
      return c.json({ ok: false, error: 'Provider not found' }, 404);
    }

    // Find all models from this provider and reassign affected agents
    const providerModels = db.prepare('SELECT id FROM models WHERE provider_id = ?').all(id) as Array<{ id: string }>;
    const modelIds = providerModels.map(m => m.id);

    // Nullify agent model references first
    for (const mid of modelIds) {
      db.prepare("UPDATE agents SET model_id = NULL WHERE model_id = ?").run(mid);
    }

    // Clear PM and Dreamer model configs if they reference these models
    for (const mid of modelIds) {
      db.prepare("DELETE FROM config WHERE key = 'pm_agent_model' AND value = ?").run(mid);
      db.prepare("DELETE FROM config WHERE key = 'dreaming_model_id' AND value = ?").run(mid);
    }

    // Temporarily disable FK constraints, delete everything, re-enable
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM models WHERE provider_id = ?').run(id);
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    db.exec('PRAGMA foreign_keys = ON');
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
    credentialPrefix: credential ? credential.slice(0, 10) + '...' : 'none',
  });

  if (!credential && provider.type !== 'ollama') {
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
      const updateModel = db.prepare(`
        UPDATE models SET context_window = ?, max_output_tokens = ?, updated_at = datetime('now')
        WHERE provider_id = ? AND api_model_id = ?
      `);

      for (const m of ollamaModels) {
        const capabilities = ['chat'];
        const nameLower = m.name.toLowerCase();
        if (nameLower.includes('code') || nameLower.includes('coder') || nameLower.includes('deepseek')) capabilities.push('code');
        if (nameLower.includes('vision') || nameLower.includes('llava')) capabilities.push('vision');

        // Fetch actual model metadata from Ollama
        const modelInfo = await getOllamaModelInfo(m.name, baseUrl);
        const contextWindow = modelInfo?.contextWindow ?? 128000;
        const maxOutputTokens = modelInfo?.maxOutputTokens ?? 8192;

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
      // Minimal API call to validate the credential
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      logger.info('Provider validation: Anthropic API call succeeded', { providerId: id });

      // Sync model metadata (max_output_tokens, context_window) from the API
      try {
        const freshModels = await fetchAnthropicModels(client);
        const updateModel = db.prepare(`
          UPDATE models SET max_output_tokens = ?, context_window = ?, updated_at = datetime('now')
          WHERE provider_id = ? AND api_model_id = ?
        `);
        const insertModel = db.prepare(`
          INSERT OR IGNORE INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `);
        for (const m of freshModels) {
          const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(id, m.apiModelId);
          if (existing) {
            updateModel.run(m.maxOutputTokens, m.contextWindow, id, m.apiModelId);
          } else {
            insertModel.run(uuidv4(), id, m.name, m.apiModelId, JSON.stringify(m.capabilities), m.contextWindow, m.maxOutputTokens, m.inputCostPerM, m.outputCostPerM);
          }
        }
        logger.info('Synced Anthropic model metadata', { providerId: id, modelCount: freshModels.length });
      } catch (syncErr) {
        logger.warn('Failed to sync Anthropic model metadata', { error: syncErr instanceof Error ? syncErr.message : String(syncErr) });
      }
    } else if (provider.type === 'openai') {
      // Direct OpenAI provider — validate against api.openai.com
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

      // Discover any new models from the API and merge with known models
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
            // New model not in our reference table — insert with defaults
            const existing = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(id, m.id);
            if (!existing) {
              insertModel.run(
                uuidv4(), id, m.id, m.id,
                JSON.stringify(['chat', 'code', 'tools']),
                128000, 16384, 2.50, 10.0,
              );
            }
          }
        }
        logger.info('Synced OpenAI models from API', { providerId: id, apiModelCount: apiModels.length });
      } catch (syncErr) {
        logger.warn('Failed to sync OpenAI models', { error: syncErr instanceof Error ? syncErr.message : String(syncErr) });
      }
    } else if (provider.type === 'openai-compatible') {
      // OpenRouter and other OpenAI-compatible providers — validate credential only.
      // Models are NOT bulk-inserted; users browse and add individual models via the UI.
      const baseUrl = (provider.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');
      logger.info('Provider validation: checking OpenAI-compatible API', { providerId: id, baseUrl });

      const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
        headers: {
          'Authorization': `Bearer ${credential}`,
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

        // Update existing models (ones the user previously added)
        const existingModels = db.prepare('SELECT id, api_model_id FROM models WHERE provider_id = ?').all(id) as Array<{ id: string; api_model_id: string }>;
        const updateModel = db.prepare(`
          UPDATE models SET context_window = ?, max_output_tokens = ?, input_cost_per_m = ?, output_cost_per_m = ?, updated_at = datetime('now')
          WHERE id = ?
        `);

        let updated = 0;
        for (const existing of existingModels) {
          const apiModel = apiMap.get(existing.api_model_id);
          if (apiModel) {
            const contextWindow = apiModel.context_length ?? apiModel.top_provider?.context_length ?? 128000;
            const maxOutputTokens = apiModel.top_provider?.max_completion_tokens ?? Math.min(Math.floor(contextWindow / 4), 16384);
            const inputCostPerM = apiModel.pricing?.prompt ? parseFloat(apiModel.pricing.prompt) * 1_000_000 : 0;
            const outputCostPerM = apiModel.pricing?.completion ? parseFloat(apiModel.pricing.completion) * 1_000_000 : 0;
            updateModel.run(contextWindow, maxOutputTokens, inputCostPerM, outputCostPerM, existing.id);
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

    // Mark as validated
    db.prepare(`
      UPDATE providers SET is_validated = 1, validated_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(id);

    logger.info('Provider validated successfully', { providerId: id });
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

// ── Models ──

// GET /providers/:id/models
configRouter.get('/providers/:id/models', (c) => {
  const db = getDb();
  const providerId = c.req.param('id');

  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId);
  if (!existing) {
    return c.json({ ok: false, error: 'Provider not found' }, 404);
  }

  const rows = db.prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY name').all(providerId) as Array<Record<string, unknown>>;
  const models: Model[] = rows.map(rowToModel);

  return c.json({ ok: true, data: models });
});

// GET /models (all enabled models)
configRouter.get('/models', (c) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM models ORDER BY name').all() as Array<Record<string, unknown>>;
  const models: Model[] = rows.map(rowToModel);

  return c.json({ ok: true, data: models });
});

// GET /providers/:id/browse-models?q=search — live search of provider's model catalog (not stored in DB)
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
  if (!credential) return c.json({ ok: false, error: 'No credential found' }, 400);

  const baseUrl = (provider.baseUrl || 'https://openrouter.ai/api').replace(/\/+$/, '');

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${credential}`,
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
        pricing?: { prompt?: string; completion?: string };
        architecture?: { modality?: string };
      }>;
    };

    const allModels = data.data ?? [];

    // Get already-added model IDs for this provider
    const addedIds = new Set(
      (db.prepare('SELECT api_model_id FROM models WHERE provider_id = ?').all(providerId) as Array<{ api_model_id: string }>)
        .map(r => r.api_model_id),
    );

    // Filter by search query and exclude already-added models
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

        return {
          apiModelId: m.id,
          name: m.name || m.id.split('/').pop() || m.id,
          contextWindow,
          maxOutputTokens,
          inputCostPerM,
          outputCostPerM,
        };
      });

    return c.json({ ok: true, data: filtered });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: `Failed to browse models: ${msg}` }, 502);
  }
});

// POST /providers/:id/add-model — add a single model from the provider's catalog to the DB
configRouter.post('/providers/:id/add-model', async (c) => {
  const db = getDb();
  const providerId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  if (!body?.apiModelId) return c.json({ ok: false, error: 'apiModelId is required' }, 400);

  const existing = db.prepare('SELECT id FROM providers WHERE id = ?').get(providerId);
  if (!existing) return c.json({ ok: false, error: 'Provider not found' }, 404);

  // Check if already added
  const alreadyAdded = db.prepare('SELECT id FROM models WHERE provider_id = ? AND api_model_id = ?').get(providerId, body.apiModelId);
  if (alreadyAdded) return c.json({ ok: false, error: 'Model already added' }, 409);

  const capabilities = ['chat'];
  const idLower = (body.apiModelId as string).toLowerCase();
  if (idLower.includes('code') || idLower.includes('deepseek') || idLower.includes('coder')) capabilities.push('code');
  if (idLower.includes('vision') || idLower.includes('llava')) capabilities.push('vision');
  if (idLower.includes('tool') || idLower.includes('claude') || idLower.includes('gpt-4') || idLower.includes('gpt-5')) capabilities.push('tools');

  const modelId = uuidv4();
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(
    modelId, providerId,
    body.name ?? body.apiModelId,
    body.apiModelId,
    JSON.stringify(capabilities),
    body.contextWindow ?? null,
    body.maxOutputTokens ?? null,
    body.inputCostPerM ?? null,
    body.outputCostPerM ?? null,
  );

  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as Record<string, unknown>;
  logger.info('Model added from catalog', { providerId, apiModelId: body.apiModelId });

  return c.json({ ok: true, data: rowToModel(row) }, 201);
});

// PUT /models/:id/pricing — update model pricing
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

  const inputCost = typeof body.inputCostPerM === 'number' ? body.inputCostPerM : undefined;
  const outputCost = typeof body.outputCostPerM === 'number' ? body.outputCostPerM : undefined;

  if (inputCost !== undefined) {
    db.prepare("UPDATE models SET input_cost_per_m = ?, updated_at = datetime('now') WHERE id = ?").run(inputCost, id);
  }
  if (outputCost !== undefined) {
    db.prepare("UPDATE models SET output_cost_per_m = ?, updated_at = datetime('now') WHERE id = ?").run(outputCost, id);
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

  return c.json({ ok: true, data: { enabled: modelIds.length } });
});

// POST /models/check-usage — check which agents use these models before disabling/deleting
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
  const { modelIds } = parsed.data;

  const updateStmt = db.prepare(`
    UPDATE models SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?
  `);

  const disableMany = db.transaction((ids: string[]) => {
    for (const id of ids) {
      updateStmt.run(id);
    }
  });

  disableMany(modelIds);

  // Reassign any agents using the disabled models to a fallback
  const reassigned = reassignAffectedAgents(modelIds);

  logger.info('Models disabled', { count: modelIds.length, agentsReassigned: reassigned });

  return c.json({ ok: true, data: { disabled: modelIds.length, agentsReassigned: reassigned } });
});

// ── Identity (Prompt Files) ──

// ── Platform Settings (key-value config) ──

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
  db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, body.value);

  // Clear platform config cache when platform keys are updated
  const platformKeys = ['platform_name', 'owner_name', 'primary_agent_id', 'primary_agent_name', 'pm_agent_id', 'pm_agent_name', 'pm_agent_enabled', 'setup_completed'];
  if (platformKeys.includes(key)) {
    const { clearPlatformConfigCache } = await import('../../config/platform.js');
    clearPlatformConfigCache();
  }

  return c.json({ ok: true, data: { key, value: body.value } });
});

// GET /settings — get all settings
configRouter.get('/settings', (c) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM config').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return c.json({ ok: true, data: settings });
});

const PROMPTS_DIR = path.join(os.homedir(), '.dojo', 'prompts');

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

  const {
    agentName = 'Agent',
    communicationStyle = 'balanced',
    rules = '',
    userName = 'User',
    userRole = '',
    userPreferences = '',
  } = body;

  const styleGuide: Record<string, string> = {
    casual:
      '- Be casual and relaxed. Use contractions, humor when appropriate.\n- Keep things light but stay helpful.',
    balanced:
      '- Be direct and concise. Skip filler.\n- Match the user\'s energy — casual is fine, don\'t be overly formal.',
    formal:
      '- Be professional and precise.\n- Use clear, structured language. Avoid slang.',
  };

  const soul = `# Identity

You are ${agentName}, a personal AI assistant and orchestrator.

# Communication Style

${styleGuide[communicationStyle] || styleGuide.balanced}
- When uncertain, say so. Don't guess.
- Prefer autonomous action over asking permission for routine tasks.

# Rules

- Never modify your own system prompt files or platform configuration.
- Always confirm before deleting files or running destructive commands.
- If a task will take multiple steps, briefly outline the plan before starting.
- When you encounter an error, explain what went wrong and what you'll try next.
${rules ? `\n# Additional Rules\n\n${rules}` : ''}
`;

  const user = `# User Profile

- Name: ${userName}
${userRole ? `- Role: ${userRole}` : ''}

# Preferences

${userPreferences || '- Prefers concise, direct communication\n- Values autonomous action for routine tasks'}
`;

  // Write SOUL.md (always generated from the form inputs)
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROMPTS_DIR, 'SOUL.md'), soul, 'utf-8');

  // Only write USER.md if it doesn't already exist (the user may have already
  // written a detailed profile in the "Your Profile" setup step -- don't overwrite it)
  const userMdPath = path.join(PROMPTS_DIR, 'USER.md');
  if (!fs.existsSync(userMdPath) || fs.readFileSync(userMdPath, 'utf-8').trim().length < 20) {
    fs.writeFileSync(userMdPath, user, 'utf-8');
  }

  logger.info('Identity files generated', { agentName, userName });
  return c.json({ ok: true, data: { soul, user } });
});

// ── Search Config ──

// GET /search — returns current search provider config
configRouter.get('/search', (c) => {
  const provider = getSearchProvider();
  const hasKey = !!getSearchApiKey();
  return c.json({ ok: true, data: { provider: provider ?? 'brave', hasKey } });
});

// PUT /search — save search provider and API key
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

// POST /search/validate — test the search API key
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

// ── Helpers ──

function rowToProvider(row: Record<string, unknown>): Provider {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as Provider['type'],
    baseUrl: row.base_url as string | null,
    authType: row.auth_type as Provider['authType'],
    isValidated: Boolean(row.is_validated),
    validatedAt: row.validated_at as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToModel(row: Record<string, unknown>): Model {
  return {
    id: row.id as string,
    providerId: row.provider_id as string,
    name: row.name as string,
    apiModelId: row.api_model_id as string,
    capabilities: JSON.parse(row.capabilities as string),
    contextWindow: row.context_window as number | null,
    maxOutputTokens: row.max_output_tokens as number | null,
    inputCostPerM: row.input_cost_per_m as number | null,
    outputCostPerM: row.output_cost_per_m as number | null,
    isEnabled: Boolean(row.is_enabled),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export { configRouter };
