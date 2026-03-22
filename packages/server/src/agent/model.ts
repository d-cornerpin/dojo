import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { getProviderCredential } from '../config/loader.js';
import { createLogger } from '../logger.js';
import { AgentError } from './errors.js';
import { toolDefinitions, getFilteredTools } from './tools.js';
import { recordCost } from '../costs/tracker.js';
import { checkBudget } from '../costs/budget.js';
import { updateRateLimits } from '../router/rate-limits.js';
import { recordProviderSuccess, recordProviderError } from '../gateway/routes/services.js';
import { broadcast } from '../gateway/ws.js';
import { isPrimaryAgent, getPrimaryAgentId } from '../config/platform.js';
import type { ToolCall } from '@dojo/shared';

const logger = createLogger('model');

// Client cache is defined below after CachedClient type

export interface ModelCallParams {
  agentId: string;
  modelId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>;
  systemPrompt: string;
  tools?: boolean;
  onChunk?: (chunk: string) => void;
  routerTier?: string; // populated by auto-router
}

export interface ModelCallResult {
  content: string;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

// OAuth tokens require specific beta headers per Anthropic's API
// claude-code-20250219 is required for OAuth tokens to access Sonnet/Opus models
const OAUTH_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
];

// Auto-detect OAuth tokens by prefix (sk-ant-oat*)
function isOAuthToken(credential: string): boolean {
  return credential.includes('sk-ant-oat');
}

function getProviderAuthType(providerId: string): 'api_key' | 'oauth' {
  const db = getDb();
  const row = db.prepare('SELECT auth_type FROM providers WHERE id = ?').get(providerId) as { auth_type: string } | undefined;
  return (row?.auth_type === 'oauth' ? 'oauth' : 'api_key');
}

interface CachedClient {
  client: Anthropic;
  isOAuth: boolean;
}

const clientCache = new Map<string, CachedClient>();

function getClient(providerId: string): CachedClient {
  const cached = clientCache.get(providerId);
  if (cached) return cached;

  const credential = getProviderCredential(providerId);
  if (!credential) {
    logger.error(`No credential found for provider "${providerId}" — check ~/.dojo/secrets.yaml providers.${providerId}`, {
      providerId,
    });
    throw new AgentError(`No credential found for provider: ${providerId}`, '', {
      code: 'NO_API_KEY',
      retryable: false,
    });
  }

  // Determine auth mode: check DB auth_type first, then auto-detect from token prefix
  const dbAuthType = getProviderAuthType(providerId);
  const useOAuth = dbAuthType === 'oauth' || isOAuthToken(credential);

  logger.info('Creating Anthropic client', {
    providerId,
    authType: useOAuth ? 'oauth' : 'api_key',
    credentialPrefix: credential.slice(0, 14) + '...',
  });

  let client: Anthropic;
  if (useOAuth) {
    // OAuth: Authorization: Bearer header + required beta headers
    client = new Anthropic({
      authToken: credential,
      defaultHeaders: {
        'anthropic-beta': OAUTH_BETAS.join(','),
        'User-Agent': 'dojo-platform',
      },
    });
  } else {
    // API Key: standard x-api-key header
    client = new Anthropic({ apiKey: credential });
  }

  const entry: CachedClient = { client, isOAuth: useOAuth };
  clientCache.set(providerId, entry);
  return entry;
}

// Determine max output tokens based on model family
function getMaxOutputTokens(apiModelId: string, providerType: string): number {
  if (providerType === 'ollama') return 8192; // Ollama models typically support 8k output

  // Anthropic model families
  if (apiModelId.includes('opus')) return 32768;
  if (apiModelId.includes('sonnet')) return 64000;
  if (apiModelId.includes('haiku')) return 8192;

  // Default for unknown models
  return 16384;
}

function getModelInfo(modelId: string): { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null } {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.provider_id, m.api_model_id, m.context_window, m.max_output_tokens, p.type as provider_type, p.base_url as provider_base_url
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.id = ?
  `).get(modelId) as { provider_id: string; api_model_id: string; context_window: number | null; max_output_tokens: number | null; provider_type: string; provider_base_url: string | null } | undefined;

  if (!row) {
    throw new AgentError(`Model not found: ${modelId}`, '', {
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    });
  }

  return {
    providerId: row.provider_id,
    apiModelId: row.api_model_id,
    contextWindow: row.context_window ?? 200000,
    // Use the provider-reported value from DB, fall back to derived value for older records
    maxOutputTokens: row.max_output_tokens ?? getMaxOutputTokens(row.api_model_id, row.provider_type),
    providerType: row.provider_type,
    providerBaseUrl: row.provider_base_url,
  };
}

// ── Ollama Call Path (OpenAI-compatible API) ──

import { getOllamaLock } from '../services/ollama-lock.js';

async function callOllamaModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; providerType: string; providerBaseUrl: string | null },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, onChunk, routerTier } = params;
  const baseUrl = (modelInfo.providerBaseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const ollamaModelName = modelInfo.apiModelId;

  // Acquire the Ollama model lock (waits if a different model is in use)
  const lock = getOllamaLock();
  await lock.acquire(ollamaModelName);

  const startTime = Date.now();

  // Build OpenAI-compatible messages
  const ollamaMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ];
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    ollamaMessages.push({ role: m.role, content });
  }

  logger.info('Calling Ollama model', {
    model: ollamaModelName,
    baseUrl,
    messageCount: ollamaMessages.length,
  }, agentId);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModelName,
        messages: ollamaMessages,
        stream: false,
      }),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new AgentError(`Ollama call failed: HTTP ${response.status} ${errorText.slice(0, 200)}`, agentId, {
        code: 'MODEL_CALL_FAILED',
        retryable: response.status >= 500,
      });
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const latencyMs = Date.now() - startTime;

    if (onChunk && content) {
      onChunk(content);
    }

    // Record cost ($0 for local models)
    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens,
      outputTokens,
      latencyMs,
      requestType: routerTier ?? 'ollama',
    });

    recordProviderSuccess(modelInfo.providerId);

    logger.info('Ollama call completed', {
      model: ollamaModelName,
      inputTokens,
      outputTokens,
      latencyMs,
    }, agentId);

    return {
      content,
      toolCalls: [],
      inputTokens,
      outputTokens,
      stopReason: 'end_turn',
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    recordProviderError(modelInfo.providerId);
    logger.error(`Ollama call failed: ${message}`, {
      model: ollamaModelName,
      baseUrl,
      latencyMs,
    }, agentId);
    throw err instanceof AgentError ? err : new AgentError(`Ollama call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: true,
    });
  } finally {
    lock.release(ollamaModelName);
  }
}

// ── OpenAI Call Path ──

const openaiClientCache = new Map<string, OpenAI>();

function getOpenAIClient(providerId: string, baseUrl?: string | null): OpenAI {
  const cacheKey = `${providerId}:${baseUrl ?? 'default'}`;
  const cached = openaiClientCache.get(cacheKey);
  if (cached) return cached;

  const credential = getProviderCredential(providerId);
  if (!credential) {
    throw new AgentError(`No credential found for OpenAI provider: ${providerId}`, '', {
      code: 'NO_API_KEY',
      retryable: false,
    });
  }

  const client = new OpenAI({
    apiKey: credential,
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/+$/, '') + '/v1' } : {}),
  });

  openaiClientCache.set(cacheKey, client);
  return client;
}

async function callOpenAIModel(
  params: ModelCallParams,
  modelInfo: { providerId: string; apiModelId: string; contextWindow: number; maxOutputTokens: number; providerType: string; providerBaseUrl: string | null },
): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;
  const startTime = Date.now();

  const client = getOpenAIClient(modelInfo.providerId, modelInfo.providerBaseUrl);

  // Build OpenAI messages
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        openaiMessages.push({ role: 'user', content: m.content });
      } else if (Array.isArray(m.content)) {
        // Handle tool_result blocks from Anthropic format
        const blocks = m.content as unknown as Array<Record<string, unknown>>;
        const toolResults = blocks.filter(b => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            openaiMessages.push({
              role: 'tool',
              tool_call_id: tr.tool_use_id as string,
              content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          // Text content blocks
          const text = blocks.map(b => (b.text as string) ?? '').join('\n');
          openaiMessages.push({ role: 'user', content: text });
        }
      }
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        openaiMessages.push({ role: 'assistant', content: m.content });
      } else if (Array.isArray(m.content)) {
        // Handle tool_use blocks from Anthropic format
        const blocks = m.content as unknown as Array<Record<string, unknown>>;
        const textBlocks = blocks.filter(b => b.type === 'text');
        const toolUseBlocks = blocks.filter(b => b.type === 'tool_use');

        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: textBlocks.map(b => (b.text as string) ?? '').join('\n') || null,
        };

        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map(tc => ({
            id: tc.id as string,
            type: 'function' as const,
            function: {
              name: tc.name as string,
              arguments: JSON.stringify(tc.input ?? {}),
            },
          }));
        }

        openaiMessages.push(assistantMsg);
      }
    }
  }

  // Build tools in OpenAI format
  const openaiTools: OpenAI.ChatCompletionTool[] | undefined = tools
    ? getFilteredTools(agentId).map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema as Record<string, unknown>,
        },
      }))
    : undefined;

  // Determine the right max tokens parameter
  // o-series models use max_completion_tokens, others use max_tokens
  const isReasoningModel = modelInfo.apiModelId.match(/^o[1-4]/);

  const requestParams: OpenAI.ChatCompletionCreateParams = {
    model: modelInfo.apiModelId,
    messages: openaiMessages,
    stream: true,
    ...(isReasoningModel
      ? { max_completion_tokens: modelInfo.maxOutputTokens }
      : { max_tokens: modelInfo.maxOutputTokens }),
    ...(openaiTools && openaiTools.length > 0 ? { tools: openaiTools } : {}),
  };

  logger.info('Calling OpenAI model', {
    model: modelInfo.apiModelId,
    provider: modelInfo.providerId,
    messageCount: openaiMessages.length,
    toolCount: openaiTools?.length ?? 0,
    maxOutputTokens: modelInfo.maxOutputTokens,
  }, agentId);

  try {
    const stream = await client.chat.completions.create(requestParams);

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        fullText += delta.content;
        if (onChunk) onChunk(delta.content);
      }

      // Tool calls come in incrementally
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulator.has(idx)) {
            toolCallAccumulator.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const acc = toolCallAccumulator.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    // Finalize tool calls
    for (const [, acc] of toolCallAccumulator) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(acc.args); } catch {}
      toolCalls.push({
        id: acc.id,
        name: acc.name,
        arguments: parsedArgs,
      });
    }

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (OpenAI streaming doesn't always give usage in stream mode)
    const inputTokens = Math.ceil((systemPrompt.length + JSON.stringify(openaiMessages).length) / 4);
    const outputTokens = Math.ceil((fullText.length + JSON.stringify(toolCalls).length) / 4);

    // Calculate cost
    const costPerM = getOpenAICost(modelInfo.apiModelId);
    const totalCost = (inputTokens / 1_000_000) * costPerM.input + (outputTokens / 1_000_000) * costPerM.output;

    // Audit log
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
      VALUES (?, ?, 'model_call', ?, 'success', ?, ?, datetime('now'))
    `).run(
      uuidv4(), agentId, modelInfo.apiModelId,
      JSON.stringify({ inputTokens, outputTokens, latencyMs }),
      totalCost,
    );

    recordCost({
      agentId, modelId,
      providerId: modelInfo.providerId,
      inputTokens, outputTokens, latencyMs,
      requestType: routerTier ?? 'agent_turn',
    });

    recordProviderSuccess(modelInfo.providerId);

    logger.info('OpenAI call completed', {
      model: modelInfo.apiModelId,
      inputTokens, outputTokens, latencyMs,
      cost: totalCost.toFixed(6),
      toolCallCount: toolCalls.length,
    }, agentId);

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    recordProviderError(modelInfo.providerId);

    logger.error(`OpenAI call failed: ${message}`, {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
    }, agentId);

    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529') || message.includes('503');

    throw new AgentError(`OpenAI call failed: ${message}`, agentId, {
      code: 'MODEL_CALL_FAILED',
      retryable: isRateLimited || isOverloaded,
    });
  }
}

// OpenAI pricing per million tokens
function getOpenAICost(apiModelId: string): { input: number; output: number } {
  const id = apiModelId.toLowerCase();
  if (id.includes('gpt-5')) return { input: 10.0, output: 40.0 };
  if (id.includes('gpt-4.1-nano')) return { input: 0.10, output: 0.40 };
  if (id.includes('gpt-4.1-mini')) return { input: 0.40, output: 1.60 };
  if (id.includes('gpt-4.1')) return { input: 2.0, output: 8.0 };
  if (id.includes('gpt-4o-mini')) return { input: 0.15, output: 0.60 };
  if (id.includes('gpt-4o')) return { input: 2.50, output: 10.0 };
  if (id.includes('o4-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o3-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o3')) return { input: 10.0, output: 40.0 };
  if (id.includes('o1-mini')) return { input: 1.10, output: 4.40 };
  if (id.includes('o1-pro')) return { input: 100.0, output: 400.0 };
  if (id.includes('o1')) return { input: 15.0, output: 60.0 };
  return { input: 2.50, output: 10.0 }; // default to gpt-4o pricing
}

export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  const { agentId, modelId, messages, systemPrompt, tools = true, onChunk, routerTier } = params;

  const modelInfo = getModelInfo(modelId);

  // Ollama uses OpenAI-compatible API, not Anthropic SDK
  if (modelInfo.providerType === 'ollama') {
    return callOllamaModel(params, modelInfo);
  }

  // OpenAI and OpenAI-compatible providers
  if (modelInfo.providerType === 'openai' || modelInfo.providerType === 'openai-compatible') {
    return callOpenAIModel(params, modelInfo);
  }

  const { client, isOAuth } = getClient(modelInfo.providerId);

  const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role: m.role,
    content: m.content,
  }));

  // OAuth tokens require the system parameter as an array with a specific
  // passphrase as the first block for Sonnet/Opus model access
  const OAUTH_SYSTEM_PASSPHRASE = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
  const systemParam: string | Anthropic.TextBlockParam[] = isOAuth
    ? [
        { type: 'text' as const, text: OAUTH_SYSTEM_PASSPHRASE },
        { type: 'text' as const, text: systemPrompt },
      ]
    : systemPrompt;

  const requestParams: Anthropic.MessageCreateParams = {
    model: modelInfo.apiModelId,
    max_tokens: modelInfo.maxOutputTokens,
    system: systemParam,
    messages: anthropicMessages,
    ...(tools ? { tools: getFilteredTools(agentId).map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    })) } : {}),
  };

  // Budget check before making the API call
  const budgetCheck = checkBudget(agentId, 0.01);
  if (!budgetCheck.allowed) {
    if (budgetCheck.freeModelFallback) {
      // Budget exceeded but free model available — redirect to it
      const fb = budgetCheck.freeModelFallback;
      logger.warn(`Budget exceeded, falling back to free model: ${fb.modelName}`, {
        agentId,
        dailySpend: budgetCheck.dailySpend,
        dailyLimit: budgetCheck.dailyLimit,
        freeModel: fb.modelName,
      }, agentId);

      // Notify the agent's chat
      const notifyMsg = `[System] Daily budget reached ($${budgetCheck.dailySpend?.toFixed(2)} of $${budgetCheck.dailyLimit?.toFixed(2)}). Using ${fb.modelName} (free) instead.`;
      try {
        const db = getDb();
        const msgId = uuidv4();
        db.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))").run(msgId, agentId, notifyMsg);
        broadcast({
          type: 'chat:message',
          agentId,
          message: { id: msgId, agentId, role: 'system' as const, content: notifyMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
        });

        // Also notify primary agent if this is a sub-agent
        const primaryId = getPrimaryAgentId();
        if (!isPrimaryAgent(agentId)) {
          const primaryMsgId = uuidv4();
          const primaryNotify = `[System] Agent "${agentId}" switched to free model (${fb.modelName}) due to budget limits.`;
          db.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))").run(primaryMsgId, primaryId, primaryNotify);
          broadcast({
            type: 'chat:message',
            agentId: primaryId,
            message: { id: primaryMsgId, agentId: primaryId, role: 'system' as const, content: primaryNotify, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
          });
        }
      } catch { /* notification is best-effort */ }

      // Recursively call with the free model
      return callModel({
        ...params,
        modelId: fb.modelId,
        routerTier: 'budget_fallback',
      });
    }

    // No free models — block the call with clear message
    const blockMsg = budgetCheck.reason ?? `Daily budget limit reached ($${budgetCheck.dailySpend?.toFixed(2)} spent of $${budgetCheck.dailyLimit?.toFixed(2)} limit). No free models available.`;
    throw new AgentError(blockMsg, agentId, {
      code: 'BUDGET_EXCEEDED',
      retryable: false,
    });
  }

  // Log request details for debugging
  const msgPreview = anthropicMessages.map((m, i) => ({
    idx: i,
    role: m.role,
    contentType: typeof m.content === 'string' ? 'string' : 'array',
    contentLen: typeof m.content === 'string' ? m.content.length : (m.content as unknown[]).length,
  }));

  logger.info('Calling model', {
    model: modelInfo.apiModelId,
    provider: modelInfo.providerId,
    messageCount: messages.length,
    systemPromptLength: systemPrompt.length,
    messages: msgPreview,
    toolCount: tools ? getFilteredTools(agentId).length : 0,
  }, agentId);

  const startTime = Date.now();

  try {
    const stream = client.messages.stream(requestParams);

    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let currentToolName = '';
    let currentToolInput = '';
    let currentToolId = '';

    stream.on('text', (text) => {
      fullText += text;
      if (onChunk) {
        onChunk(text);
      }
    });

    stream.on('contentBlock', (block) => {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    });

    const finalMessage = await stream.finalMessage();

    const latencyMs = Date.now() - startTime;
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;

    // Calculate cost
    const inputCost = modelInfo.apiModelId.includes('opus')
      ? (inputTokens / 1_000_000) * 15.0
      : modelInfo.apiModelId.includes('sonnet')
        ? (inputTokens / 1_000_000) * 3.0
        : (inputTokens / 1_000_000) * 0.80;

    const outputCost = modelInfo.apiModelId.includes('opus')
      ? (outputTokens / 1_000_000) * 75.0
      : modelInfo.apiModelId.includes('sonnet')
        ? (outputTokens / 1_000_000) * 15.0
        : (outputTokens / 1_000_000) * 4.0;

    const totalCost = inputCost + outputCost;

    // Audit log for model call
    const db = getDb();
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, cost, created_at)
      VALUES (?, ?, 'model_call', ?, 'success', ?, ?, datetime('now'))
    `).run(
      uuidv4(),
      agentId,
      modelInfo.apiModelId,
      JSON.stringify({ inputTokens, outputTokens, latencyMs }),
      totalCost,
    );

    // Record cost in the Phase 4 cost_records table
    recordCost({
      agentId,
      modelId,
      providerId: modelInfo.providerId,
      inputTokens,
      outputTokens,
      latencyMs,
      requestType: routerTier ?? (tools ? 'agent_turn' : 'completion'),
    });

    // Update rate limits from response headers (if available from stream)
    try {
      const rawResponse = (stream as unknown as { response?: { headers?: Record<string, string> } }).response;
      if (rawResponse?.headers) {
        const headers: Record<string, string> = {};
        if (typeof rawResponse.headers === 'object') {
          for (const [key, value] of Object.entries(rawResponse.headers)) {
            if (typeof value === 'string') headers[key] = value;
          }
        }
        updateRateLimits(modelId, headers);
      }
    } catch {
      // Rate limit header extraction is best-effort
    }

    // Track provider health
    recordProviderSuccess(modelInfo.providerId);

    logger.info('Model call completed', {
      model: modelInfo.apiModelId,
      inputTokens,
      outputTokens,
      latencyMs,
      cost: totalCost.toFixed(6),
      stopReason: finalMessage.stop_reason,
      toolCallCount: toolCalls.length,
    }, agentId);

    return {
      content: fullText,
      toolCalls,
      inputTokens,
      outputTokens,
      stopReason: finalMessage.stop_reason,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    // Extract detailed error info from Anthropic SDK
    // Track provider health
    recordProviderError(modelInfo.providerId);

    const errorDetail: Record<string, unknown> = {
      model: modelInfo.apiModelId,
      providerId: modelInfo.providerId,
      latencyMs,
      error: message,
    };

    if (err instanceof Anthropic.APIError) {
      errorDetail.status = err.status;
      errorDetail.errorBody = err.error;
      errorDetail.requestId = err.headers?.['request-id'];
    } else if (err instanceof Error) {
      errorDetail.stack = err.stack?.split('\n').slice(0, 3).join(' | ');
    }

    // Put the key info in the message itself so it's visible in the log viewer
    const statusStr = err instanceof Anthropic.APIError ? `[${err.status}] ` : '';
    logger.error(`Model call failed: ${statusStr}${message}`, errorDetail, agentId);

    // Determine if retryable
    const isRateLimited = message.includes('rate_limit') || message.includes('429');
    const isOverloaded = message.includes('overloaded') || message.includes('529');
    const isServerError = message.includes('500') || message.includes('503');

    throw new AgentError(`Model call failed: ${message}`, agentId, {
      retryable: isRateLimited || isOverloaded || isServerError,
      code: 'MODEL_CALL_FAILED',
      cause: err instanceof Error ? err : undefined,
    });
  }
}

export function clearClientCache(providerId?: string): void {
  if (providerId) {
    clientCache.delete(providerId);
    // Also clear OpenAI client cache entries for this provider
    for (const key of openaiClientCache.keys()) {
      if (key.startsWith(`${providerId}:`)) openaiClientCache.delete(key);
    }
  } else {
    clientCache.clear();
    openaiClientCache.clear();
  }
}

export function getContextWindow(modelId: string): number {
  try {
    const info = getModelInfo(modelId);
    return info.contextWindow;
  } catch {
    return 200000; // Default fallback
  }
}
