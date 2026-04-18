import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { assembleContext } from '../memory/assembler.js';
import { checkAndCompact } from '../memory/compaction.js';
import { callModel, getContextWindow } from './model.js';
import { executeTool } from './tools.js';
import { AgentError, recordError, clearErrors, withRetry } from './errors.js';
import { checkTimeouts } from './spawner.js';
import { isAwaitingIMResponse, clearIMResponseFlag, sendResponseViaIMessage } from '../services/imessage-bridge.js';
import { scoreQuery } from '../router/scorer.js';
import { selectModel } from '../router/selector.js';
import { queueEmbedding } from '../memory/embeddings.js';
import { getModelCapabilities } from '../services/capabilities.js';
import type { Message } from '@dojo/shared';

// One-shot dedup so the "model does not support tools" banner only fires once
// per (agent, model) pair for the lifetime of the server process. Without
// this we'd broadcast the same banner on every single turn.
const toolsUnavailableNotified = new Set<string>();

function enforceModelCapabilities(
  agentId: string,
  modelId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): { useTools: boolean } {
  const caps = getModelCapabilities(modelId);

  // Unknown capability set → don't gate. We'd rather optimistically try and
  // let the provider error out than lock users out of a working model whose
  // probe failed or simply returned nothing.
  if (caps.length === 0) {
    return { useTools: true };
  }

  // ── Vision gate ──
  // If the assembled messages contain image or document blocks and the model
  // has no vision capability, strip those blocks (keeping any text) and warn
  // the user via a banner so the turn can still proceed on the text alone.
  if (!caps.includes('vision')) {
    let imagesStripped = 0;
    let docsStripped = 0;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const hasMedia = blocks.some(b => b.type === 'image' || b.type === 'document');
      if (!hasMedia) continue;

      const kept = blocks.filter(b => {
        if (b.type === 'image') { imagesStripped++; return false; }
        if (b.type === 'document') { docsStripped++; return false; }
        return true;
      });

      // If nothing but text remains, collapse to a plain string so older call
      // paths that prefer strings don't choke. Otherwise preserve the array.
      if (kept.length === 0) {
        messages[i] = { role: 'user', content: '(Image/PDF attachment removed — this model does not support vision input)' };
      } else if (kept.every(b => b.type === 'text')) {
        const text = kept.map(b => (b.text as string) ?? '').join('\n');
        messages[i] = { role: 'user', content: text };
      } else {
        messages[i] = { role: 'user', content: kept as unknown as Anthropic.ContentBlockParam[] };
      }
    }

    if (imagesStripped > 0 || docsStripped > 0) {
      const parts: string[] = [];
      if (imagesStripped > 0) parts.push(`${imagesStripped} image${imagesStripped === 1 ? '' : 's'}`);
      if (docsStripped > 0) parts.push(`${docsStripped} PDF${docsStripped === 1 ? '' : 's'}`);
      const what = parts.join(' and ');
      const errorMsg =
        `This model can't see ${what}. The attachment was dropped and the agent will respond to your text only. ` +
        `Switch to a vision-capable model (look for the "Vision" badge in Settings → Models) to use image or PDF input.`;
      logger.warn('Vision gate: stripped media from turn', {
        modelId, imagesStripped, docsStripped,
      }, agentId);
      broadcast({ type: 'chat:error', agentId, error: errorMsg });
    }
  }

  // ── Tools gate ──
  // If the model is known not to support tools, tell callModel to skip
  // sending the tool definitions entirely (so we don't waste tokens or
  // trigger a provider-side 400), and surface a one-time banner.
  let useTools = true;
  if (!caps.includes('tools')) {
    useTools = false;
    const dedupKey = `${agentId}:${modelId}`;
    if (!toolsUnavailableNotified.has(dedupKey)) {
      toolsUnavailableNotified.add(dedupKey);
      const errorMsg =
        `This model doesn't support tool calling, so the agent can only respond in plain text on this turn. ` +
        `Browser automation, file access, scheduling, and other tool-based actions won't work. ` +
        `Switch to a model with the "Tools" badge in Settings → Models for full capabilities.`;
      logger.warn('Tools gate: disabling tools for this turn', { modelId }, agentId);
      broadcast({ type: 'chat:error', agentId, error: errorMsg });
    }
  }

  return { useTools };
}

// Broadcast a persisted message to the dashboard so it appears in real-time
function broadcastMessage(agentId: string, msg: { id: string; role: string; content: string; createdAt?: string; modelId?: string | null }) {
  broadcast({
    type: 'chat:message',
    agentId,
    message: {
      id: msg.id,
      agentId,
      role: msg.role as Message['role'],
      content: msg.content,
      tokenCount: null,
      modelId: msg.modelId ?? null,
      cost: null,
      latencyMs: null,
      createdAt: msg.createdAt ?? new Date().toISOString(),
    },
  });
}

const logger = createLogger('runtime');

// Track agent start times for uptime calculation
const agentStartTimes = new Map<string, number>();

// Track active agent runs to prevent concurrent processing
const activeRuns = new Set<string>();

// Queue for messages that arrive while an agent is busy
const pendingWakeups = new Set<string>();

import { turnBoundary } from './turn-state.js';

// Agents that should halt on the next loop iteration
const stoppedAgents = new Set<string>();

// AbortControllers for in-flight API calls — aborting these kills the request immediately
const activeAbortControllers = new Map<string, AbortController>();

/** Stop a running agent — aborts in-flight API call and halts the loop.
 *
 * Sets a `stopMarkerPending` flag on the agent's `config` JSON so the next
 * context assembly will inject a one-shot stop marker into the user's next
 * turn — telling the model its prior plan is cancelled. The marker is
 * injected in-memory at assembly time only; it is NEVER persisted to the
 * messages table or broadcast to the dashboard, so the user does not see
 * it in the chat feed. The flag survives server restarts because it lives
 * in the DB. */
export function stopAgent(agentId: string): void {
  stoppedAgents.add(agentId);
  // Clear any queued wakeup so the agent doesn't immediately restart after stopping
  pendingWakeups.delete(agentId);
  // Abort any in-flight API call
  const controller = activeAbortControllers.get(agentId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(agentId);
  }

  // Mark stopMarkerPending in the agent's config. The memory assembler
  // picks this up on the next turn, injects the marker text into the
  // last user message (in-memory only), and clears the flag.
  try {
    const db = getDb();
    const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
    const config = row?.config ? JSON.parse(row.config) as Record<string, unknown> : {};
    config.stopMarkerPending = true;
    db.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(config), agentId);
  } catch (err) {
    logger.warn('Failed to set stopMarkerPending flag', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  logger.info('Agent stop requested', {}, agentId);
}

const MAX_TOOL_LOOPS = 25; // Maximum tool call loops per turn
const TURN_TIME_BUDGET_MS = 15 * 60 * 1000; // 15 minute max per turn (local Ollama models can be slow)

class AgentRuntime {
  async handleMessage(agentId: string, content: string): Promise<void> {
    // If agent is already running, queue a wakeup so we re-run after current loop finishes
    if (activeRuns.has(agentId)) {
      logger.info('Agent busy — queuing wakeup for after current run', { agentId }, agentId);
      pendingWakeups.add(agentId);
      return;
    }

    activeRuns.add(agentId);
    agentStartTimes.set(agentId, Date.now());

    try {
      await this.runAgentLoop(agentId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof AgentError && err.cause instanceof Error ? err.cause.message : undefined;
      const code = err instanceof AgentError ? err.code : undefined;
      logger.error(`Agent loop failed: ${message}`, { agentId, code, cause }, agentId);

      // Record error for loop detection
      const paused = recordError(agentId);

      if (!paused) {
        this.setAgentStatus(agentId, 'error');
      }

      // Notify the primary agent that a sub-agent is now injured so it
      // knows work delegated to that agent has stalled. Without this, the
      // primary has no way to tell its delegate hit a wall and will keep
      // waiting forever. Skip when the injured agent IS the primary
      // (no point notifying yourself), or is a known system agent whose
      // state the primary isn't supposed to manage.
      this.notifyPrimaryOfInjury(agentId, message, paused).catch(err => {
        logger.warn('notifyPrimaryOfInjury failed', {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // Broadcast error to dashboard with structured code — include root cause
      const isRateLimit = message.toLowerCase().includes('429') || message.toLowerCase().includes('rate_limit') || message.toLowerCase().includes('overloaded');
      const errorMsg = paused
        ? `Agent paused due to repeated errors. Last error: ${message}`
        : message;
      broadcast({
        type: 'chat:error',
        agentId,
        error: errorMsg,
        code: isRateLimit ? 'RATE_LIMITED' : paused ? 'ERROR_LOOP' : 'MODEL_FAILED',
        severity: isRateLimit ? 'warning' : 'error',
        retryable: isRateLimit,
      });

      // For rate limit errors, inject a visible system message into the chat
      // so the user knows what's happening (the error banner can be missed)
      if (isRateLimit) {
        const msgId = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const errDb = getDb();
        errDb.prepare("INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, ?)").run(
          msgId, agentId, '[Rate limited] The model provider returned a rate limit error. Retrying shortly...', now
        );
        broadcast({ type: 'chat:message', agentId, message: { id: msgId, agentId, role: 'system', content: '[Rate limited] The model provider returned a rate limit error. Retrying shortly...', tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: now } });
      }
    } finally {
      activeRuns.delete(agentId);

      // If a message arrived while we were busy, re-trigger the loop.
      // Don't clear turnBoundary yet — clear it AFTER the wakeup starts
      // so messages arriving during the delay window are handled correctly.
      if (pendingWakeups.has(agentId)) {
        pendingWakeups.delete(agentId);
        // Clear turnBoundary BEFORE the wakeup so the new run sees all messages
        turnBoundary.delete(agentId);
        // Use a short delay to let any in-flight DB writes finish
        setTimeout(() => {
          logger.info('Processing queued wakeup', { agentId }, agentId);
          // Don't pass empty content — the wakeup will pick up all new
          // messages from the DB via context assembly. The content param
          // is unused by runAgentLoop (it reads from DB).
          this.handleMessage(agentId, '').catch(err => {
            logger.error('Queued wakeup failed', {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        }, 500); // Reduced from 1500ms — 500ms is enough for DB writes
      } else {
        // No wakeup pending — safe to clear turnBoundary immediately
        turnBoundary.delete(agentId);
      }
    }
  }

  private async runAgentLoop(agentId: string): Promise<void> {
    const db = getDb();

    // Get agent config
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
    }

    const configuredModelId = agent.model_id as string | null;
    const isAutoRouted = configuredModelId === 'auto';

    if (!configuredModelId) {
      throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
    }

    // For context assembly, use a placeholder for window size estimation when auto-routing
    const contextModelId: string = isAutoRouted ? '__auto__' : configuredModelId;

    // Set agent to working
    this.setAgentStatus(agentId, 'working');

    let loopCount = 0;
    let consecutiveNoResultTools = 0;
    let lastUsedModelId: string = isAutoRouted ? contextModelId : configuredModelId;
    let lastResponseText: string | null = null; // For repetition detection
    let lockedModelId: string | null = null; // For auto-routed agents: lock model during tool loops
    let nudgedForRepetition = false; // Only nudge once for repetition
    let nudgedForEmptyResponse = false; // Only nudge once for empty output
    let nudgedForNoResults = false; // Only nudge once for empty search results
    let nudgedForTracker = false; // Only nudge once for missing tracker task
    let trackerToolCalled = false; // Whether agent has used any tracker tool this turn
    let nonTrackerToolCalls = 0; // Count of non-tracker tool calls this turn
    let toolCallsExecutedThisTurn = 0; // Total tool calls executed across all loop iterations this turn
    let lastAssistantTextForIM: string | null = null; // Last assistant text this turn — for iMessage routing after loop

    // Detect if this turn was triggered by an incoming iMessage (content-based, not flag-based).
    // This survives race conditions, server restarts, and abnormal loop exits — the flag alone does not.
    const triggerRow = db.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).get(agentId) as { content: string } | undefined;
    const triggeredByIMessage = triggerRow?.content?.includes('[SOURCE: IMESSAGE FROM') ?? false;
    // In-memory nudge — injected into context on next loop iteration, never persisted to DB
    let pendingNudge: string | null = null;

    // Determine if this agent should be nudged about tracker usage.
    // Nudge agents that have tracker tools, EXCEPT the PM (who manages the
    // tracker but shouldn't create tasks for herself) and background system
    // agents (Healer, Dreamer, Imaginer) that don't do user-facing work.
    const agentToolsPolicy = JSON.parse((agent.tools_policy as string) || '{}');
    const hasTrackerTools = !agentToolsPolicy.allow || (Array.isArray(agentToolsPolicy.allow) && agentToolsPolicy.allow.some((t: string) => t.startsWith('tracker_')));
    let shouldNudgeTracker = hasTrackerTools;
    try {
      const { getPMAgentId, getHealerAgentId, getDreamerAgentId, getImaginerAgentId } = await import('../config/platform.js');
      const excludedIds = [getPMAgentId(), getHealerAgentId(), getDreamerAgentId(), getImaginerAgentId()];
      if (excludedIds.includes(agentId)) shouldNudgeTracker = false;
    } catch { /* platform config not ready */ }
    // If the agent already has in_progress tasks, don't nudge — they're continuing existing work
    if (shouldNudgeTracker) {
      const activeTask = db.prepare("SELECT id FROM tasks WHERE assigned_to = ? AND status = 'in_progress' LIMIT 1").get(agentId);
      if (activeTask) shouldNudgeTracker = false;
    }

    // Snapshot the turn boundary so context assembly ignores messages that
    // arrive mid-loop. Without this, a reply from another agent gets baked
    // into the context while the LLM is focused on the current task — the
    // LLM generates a response that follows the reply in the timeline, and
    // on the wakeup re-run it looks like the reply was already handled.
    const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    turnBoundary.set(agentId, turnStartedAt);

    const turnStartMs = Date.now();

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // Check turn time budget
      if (Date.now() - turnStartMs > TURN_TIME_BUDGET_MS) {
        logger.warn('Turn time budget exceeded', { elapsed: Date.now() - turnStartMs, agentId }, agentId);
        const sysMsg = `[System: This turn exceeded the ${TURN_TIME_BUDGET_MS / 60000} minute time budget and has been stopped. Send a follow-up message to continue.]`;
        const sysMsgId = uuidv4();
        db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(sysMsgId, agentId, sysMsg);
        broadcast({ type: 'chat:message', agentId, message: { id: sysMsgId, agentId, role: 'system' as const, content: sysMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
        break;
      }

      // Check if agent was stopped
      if (stoppedAgents.has(agentId)) {
        stoppedAgents.delete(agentId);
        logger.info('Agent stopped by user', {}, agentId);
        this.setAgentStatus(agentId, 'idle');
        break;
      }

      // Assemble context: system prompt + summaries + fresh tail
      const context = await assembleContext(agentId, contextModelId);
      const systemPrompt = context.systemPrompt;
      const messages = context.messages;

      // Inject image/PDF attachment content blocks into user messages
      injectAttachmentBlocks(messages, agentId);

      // Inject in-memory nudge if one is pending (never persisted to DB).
      // Only add the user message — no synthetic assistant response, because
      // the API requires the conversation to end with a user message.
      if (pendingNudge) {
        // If the last message is assistant, the nudge goes after it (correct alternation)
        // If the last message is user, we need to merge or skip
        if (messages.length === 0 || messages[messages.length - 1].role === 'assistant') {
          messages.push({ role: 'user', content: pendingNudge });
        }
        pendingNudge = null;
      }

      // Resolve the actual model to call
      let modelId: string;
      let routerTier: string | null = null;
      const excludedModels: string[] = [];

      if (isAutoRouted) {
        // If we're mid-tool-loop, keep the same model for consistency
        if (lockedModelId && loopCount > 1) {
          modelId = lockedModelId;
          logger.info(`Auto-router: using locked model (mid-task)`, { modelId: lockedModelId }, agentId);
        } else {
          const scoringResult = scoreQuery(systemPrompt, messages as Array<{ role: string; content: string | object[] }>);
          routerTier = scoringResult.tier;
          const selected = selectModel(scoringResult.tier, agentId, excludedModels.length > 0 ? excludedModels : undefined, ['tools']);
          if (!selected) {
            throw new AgentError('Auto-router: no models available in any tier', agentId, { code: 'NO_MODEL' });
          }
          modelId = selected.modelId;
          // Log detailed scoring for debugging
          const topScores = scoringResult.scores
            .filter(s => Math.abs(s.weighted) > 0.05)
            .sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted))
            .slice(0, 5)
            .map(s => `${s.dimension}=${s.weighted.toFixed(2)}`);
          logger.info(`Auto-router: tier=${scoringResult.tier} score=${scoringResult.rawScore.toFixed(2)} [${topScores.join(', ')}]`, {
            tier: scoringResult.tier,
            rawScore: scoringResult.rawScore,
            confidence: scoringResult.confidence,
            modelId,
            fallback: selected.fallbackUsed,
            topDimensions: topScores,
          }, agentId);
        }
      } else {
        modelId = configuredModelId;
      }
      lastUsedModelId = modelId;

      // Pre-flight capability enforcement: strip unsupported image/PDF blocks,
      // decide whether to send tool definitions, and broadcast banners so the
      // user knows what the model can't do. Runs once per outer turn after
      // the final modelId has been resolved.
      const { useTools } = enforceModelCapabilities(agentId, modelId, messages);

      // If tools are disabled, inject a note into the context so the model
      // knows it can only respond with text (not tool calls).
      // Only inject if alternation is safe (last message must be assistant).
      if (!useTools && loopCount === 1 && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        const toolNote = `[System note: Your current model does not support tool calling. You can only respond with text. If the user asks you to do something that requires tools (file access, web search, tracker, etc.), explain that your model doesn't support it and suggest they switch to a tool-capable model in Settings.]`;
        messages.push({ role: 'user', content: toolNote });
      }

      // Call model with retry logic — for auto-routed agents, try fallback models on failure
      const messageId = uuidv4();
      const streamedChunks: string[] = [];

      let callSucceeded = false;
      let result;
      const maxAttempts = isAutoRouted ? 3 : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          // Set up abort controller so stopAgent() can kill the in-flight request
          const abortController = new AbortController();
          activeAbortControllers.set(agentId, abortController);

          result = await withRetry(
            () => {
              if (abortController.signal.aborted) throw new Error('Agent stopped');
              return callModel({
                agentId,
                modelId,
                messages,
                systemPrompt,
                tools: useTools,
                routerTier: routerTier ?? undefined,
                onChunk: (chunk) => {
                  if (abortController.signal.aborted) return;
                  streamedChunks.push(chunk);
                },
              });
            },
            agentId,
            { maxRetries: isAutoRouted ? 1 : 2 },
          );

          activeAbortControllers.delete(agentId);
          callSucceeded = true;
          break; // success, exit retry loop
        } catch (err) {
          // If agent was stopped, break out cleanly
          if (stoppedAgents.has(agentId)) {
            stoppedAgents.delete(agentId);
            activeAbortControllers.delete(agentId);
            this.setAgentStatus(agentId, 'idle');
            return;
          }
          if (!isAutoRouted || attempt >= maxAttempts - 1) throw err;

          // Auto-routed: try the next model in the fallback chain
          excludedModels.push(modelId);
          // Clear the model lock so fallback can use a different model
          lockedModelId = null;
          const fallback = selectModel(routerTier!, agentId, excludedModels, ['tools']);
          if (!fallback) throw err; // no more models to try

          logger.warn(`Auto-router: model ${modelId} failed, falling back to ${fallback.modelId}`, {
            failedModel: modelId,
            fallbackModel: fallback.modelId,
            error: err instanceof Error ? err.message.slice(0, 100) : String(err),
          }, agentId);
          modelId = fallback.modelId;
          lastUsedModelId = modelId;
          streamedChunks.length = 0; // clear any partial chunks
        }
      }

      if (!callSucceeded || !result) {
        throw new AgentError('Model call failed after all attempts', agentId, { code: 'MODEL_CALL_FAILED' });
      }

      // Flush the buffered text chunks to the client if there's actual content.
      // This applies to BOTH text-only responses AND text+tool_call responses.
      if (result.content && result.content.trim().length > 0) {
        for (const chunk of streamedChunks) {
          broadcast({
            type: 'chat:chunk',
            agentId,
            messageId,
            content: chunk,
            done: false,
          });
        }
      }

      // Empty/whitespace response detection — never go silent on the user.
      // EXCEPTION: if the agent already executed one or more tools in this
      // turn and now returns with no text and no further tool calls, that's
      // a legitimate end-of-turn ("I did the work, nothing more to say").
      // This is expected behavior for agents responding to sub-agent messages
      // where the system prompt explicitly tells them to end silently after
      // calling send_to_agent. Without this carve-out the runtime nudges the
      // model, and on the second empty returns a misleading "empty response"
      // error toast even though the agent's work completed fine.
      if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
        if (toolCallsExecutedThisTurn > 0) {
          logger.debug('Empty response after tool calls — clean end-of-turn', {
            loopCount, toolCallsExecutedThisTurn,
          }, agentId);
          break;
        }
        if (!nudgedForEmptyResponse) {
          nudgedForEmptyResponse = true;
          logger.warn('Model returned empty response, will nudge on next iteration', { loopCount }, agentId);
          pendingNudge = '[System: You returned an empty response. Please respond to the user\'s last message or call a tool to continue your task. If you are finished, say so clearly.]';
          continue; // Re-run the loop — nudge will be injected in-memory at context assembly
        }
        // Nudge didn't work — toast only, no DB changes
        logger.warn('Model returned empty after nudge, breaking', { loopCount }, agentId);
        pendingNudge = null;
        broadcast({ type: 'chat:error', agentId, error: 'The model returned an empty response. Try sending your message again.', code: 'MODEL_FAILED', severity: 'warning', retryable: true });
        break;
      }

      // Track the last non-empty text the agent produces this turn.
      // Used after the loop to route the response via iMessage if needed.
      if (result.content && result.content.trim().length > 0) {
        lastAssistantTextForIM = result.content.trim();
      }

      // Sanitize model output — weak models sometimes produce literal "\n" strings
      // or excessive whitespace. Only apply to plain text, not JSON content.
      if (result.content && result.content.trim().length > 0) {
        const trimmed = result.content.trim();
        const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        if (!isJson) {
          result.content = result.content
            .replace(/\\n/g, '\n')        // literal \n → real newline
            .replace(/\n{3,}/g, '\n\n')   // collapse 3+ newlines to 2
            .trim();
        }
      }

      // Dedup check: if the model produced the exact same text as the last assistant message,
      // skip persisting it. This catches cases where multiple triggers cause the agent to
      // generate the same response repeatedly.
      if (result.content && result.toolCalls.length === 0) {
        const lastAssistant = db.prepare(
          "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ).get(agentId) as { content: string } | undefined;
        if (lastAssistant && lastAssistant.content === result.content) {
          logger.warn('Skipping duplicate assistant response (identical to last message)', { agentId }, agentId);
          break;
        }
      }

      // Build the full content to persist
      // If there are tool calls, we must store them as content blocks alongside any text.
      // EXCEPTION: If tool calls came from the XML text-fallback parser (synthetic IDs
      // starting with "text_tool_"), store as plain text instead of structured blocks.
      // Structured blocks with synthetic IDs break providers like MiniMax on the next
      // turn because they reject tool_result blocks referencing IDs they didn't generate.
      const hasXmlFallbackTools = result.toolCalls.some(tc => tc.id.startsWith('text_tool_'));

      if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
        const assistantContent: Anthropic.ContentBlockParam[] = [];

        if (result.content) {
          assistantContent.push({ type: 'text', text: result.content });
        }

        for (const tc of result.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }

        // Always INSERT — content includes both text and tool_use blocks
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, datetime('now'))
        `).run(
          messageId,
          agentId,
          JSON.stringify(assistantContent),
          result.outputTokens,
          modelId,
          null,
        );
        broadcastMessage(agentId, { id: messageId, role: 'assistant', content: JSON.stringify(assistantContent), modelId });
      } else if (result.content) {
        // Text-only response, no tool calls
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, datetime('now'))
        `).run(
          messageId,
          agentId,
          result.content,
          result.outputTokens,
          modelId,
          null,
        );
        // Queue embedding for assistant text responses
        queueEmbedding('message', messageId, agentId, result.content);
      }

      // Broadcast completion for streaming — only if we actually sent content or have tool calls.
      // Don't broadcast done for empty responses (creates ghost bubbles in the UI).
      if ((result.content && result.content.trim().length > 0) || result.toolCalls.length > 0) {
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
          modelId,
        });
      }

      // If no tool calls, we're done — iMessage routing happens after the loop
      if (result.toolCalls.length === 0) {

        // Final response — unlock model for next user message
        lockedModelId = null;
        break;
      }

      // Tool calls present — lock the model for the rest of this turn's tool loop
      if (isAutoRouted && !lockedModelId) {
        lockedModelId = modelId;
        logger.info('Auto-router: locking model for tool loop', { modelId }, agentId);
      }

      // Execute each tool call — check stop flag between each one
      const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];
      let stoppedMidToolLoop = false;

      for (const toolCall of result.toolCalls) {
        // Check stop flag before each tool execution
        if (stoppedAgents.has(agentId)) {
          stoppedAgents.delete(agentId);
          logger.info('Agent stopped mid-tool-loop by user', { executed: toolResults.length, remaining: result.toolCalls.length - toolResults.length }, agentId);
          // Fill in synthetic "cancelled" results for any remaining tool calls
          // so the conversation history stays valid (tool_use blocks need matching tool_results)
          for (const remaining of result.toolCalls.slice(toolResults.length)) {
            toolResults.push({
              toolCallId: remaining.id,
              content: 'Cancelled by user (agent stopped).',
              isError: true,
            });
          }
          stoppedMidToolLoop = true;
          break;
        }

        // Broadcast tool call to dashboard
        try {
          broadcast({
            type: 'chat:tool_call',
            agentId,
            tool: toolCall.name,
            args: toolCall.arguments,
          });
        } catch { /* broadcast failure is non-fatal */ }

        let toolResult: { toolCallId: string; content: string; isError: boolean; name: string; errorCode?: string };
        toolCallsExecutedThisTurn++;
        try {
          toolResult = await executeTool(agentId, toolCall);
        } catch (toolErr) {
          // Tool threw an unhandled exception — don't crash the agent loop.
          // Convert to an error result so the model sees the failure and can adapt.
          const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          logger.error('Tool execution threw unhandled exception', {
            tool: toolCall.name, error: errMsg,
          }, agentId);
          toolResult = {
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: `Error: Tool "${toolCall.name}" crashed unexpectedly: ${errMsg}. This is a platform error, not something you did wrong. Try a different approach or skip this step.`,
            isError: true,
          };
        }
        toolResults.push(toolResult);

        // Broadcast tool result
        try {
          broadcast({
            type: 'chat:tool_result',
            agentId,
            tool: toolCall.name,
            result: toolResult.content.slice(0, 500),
          });
        } catch { /* broadcast failure is non-fatal */ }
      }

      // Persist tool result messages
      {
        if (hasXmlFallbackTools) {
          // XML fallback path: collapse tool calls + results into a single plain-text
          // assistant message. This prevents synthetic tool IDs from entering the
          // message history where they'd break providers on the next turn.
          const collapsedParts: string[] = [];
          if (result.content) collapsedParts.push(result.content);
          for (let i = 0; i < result.toolCalls.length; i++) {
            const tc = result.toolCalls[i];
            const tr = toolResults[i];
            // Preserve full arguments and results — don't truncate
            const argJson = JSON.stringify(tc.arguments);
            collapsedParts.push(`[Called ${tc.name}: ${argJson}]`);
            if (tr) {
              collapsedParts.push(`[Result${tr.isError ? ' ERROR' : ''}: ${tr.content}]`);
            }
          }
          const collapsedText = collapsedParts.join('\n');
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, created_at)
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, datetime('now'))
          `).run(messageId, agentId, collapsedText, result.outputTokens, modelId, null);
          broadcastMessage(agentId, { id: messageId, role: 'assistant', content: collapsedText, modelId });

          logger.info('Collapsed XML-fallback tool calls into plain text', {
            toolCount: result.toolCalls.length,
            tools: result.toolCalls.map(tc => tc.name),
          }, agentId);
        } else {
          // Normal path: store as structured tool_result content blocks
          const toolResultContent: Anthropic.ToolResultBlockParam[] = toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: tr.content,
            is_error: tr.isError,
          }));

          const toolMessageId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
            VALUES (?, ?, 'tool', ?, datetime('now'))
          `).run(toolMessageId, agentId, JSON.stringify(toolResultContent));
          broadcastMessage(agentId, { id: toolMessageId, role: 'tool', content: JSON.stringify(toolResultContent) });
        }
      }

      // Clear error records on successful tool execution
      clearErrors(agentId);

      // If we were stopped mid-tool-loop, exit now after persisting results
      if (stoppedMidToolLoop) {
        this.setAgentStatus(agentId, 'idle');
        break;
      }

      // If complete_task was called, the agent is done — stop the loop
      const calledCompleteTask = result.toolCalls.some(tc => tc.name === 'complete_task');
      if (calledCompleteTask) {
        logger.info('Agent called complete_task, exiting loop', { agentId }, agentId);
        break;
      }

      // Track whether the agent is using the tracker. If it makes 3+ non-tracker
      // tool calls without creating or updating a task, nudge it once.
      if (shouldNudgeTracker && !nudgedForTracker) {
        for (const tc of result.toolCalls) {
          if (tc.name.startsWith('tracker_')) {
            trackerToolCalled = true;
          } else if (!['get_current_time', 'load_tool_docs', 'complete_task', 'vault_search', 'vault_remember', 'memory_grep'].includes(tc.name)) {
            nonTrackerToolCalls++;
          }
        }
        if (!trackerToolCalled && nonTrackerToolCalls >= 3) {
          nudgedForTracker = true;
          pendingNudge = '[System: You have made multiple tool calls without creating a tracker task. For any multi-step work, you MUST call tracker_create_task first so the PM can monitor progress. Create the task now, then continue your work.]';
        }
      }

      // image_create is "fire and forget" — the image will appear in the
      // chat automatically when the background generation finishes. The
      // agent's text response before the tool call IS the user-facing
      // acknowledgment ("On it, I'll generate that for you"). We don't
      // need a follow-up model call to respond to the tool result because
      // there's nothing more to say — calling the model again just
      // produces a redundant "I'm generating that image now" message.
      const calledImageCreate = result.toolCalls.some(tc => tc.name === 'image_create');
      if (calledImageCreate) {
        logger.info('Agent called image_create, exiting loop (delivery is async)', { agentId }, agentId);
        // iMessage routing for the ack text is handled after the loop
        break;
      }

      // Detect repetition: if the model produced the same text AND same tool calls as last iteration
      const currentResponseSig = (result.content ?? '') + '|' + result.toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).sort().join(',');
      if (lastResponseText === currentResponseSig) {
        if (!nudgedForRepetition) {
          nudgedForRepetition = true;
          logger.warn('Agent repeating itself, will nudge on next iteration', { loopCount }, agentId);
          pendingNudge = '[System: You are repeating yourself — your last two responses were identical. Try a different approach. If the task is complete, call complete_task or tracker_update_status. If you need help, explain what you are stuck on.]';
          continue;
        }
        logger.warn('Breaking tool loop: agent still repeating after nudge', { loopCount }, agentId);
        broadcast({ type: 'chat:error', agentId, error: 'Agent stopped: repeating the same response after being nudged. Send a follow-up message to retry.', code: 'STUCK_REPEATING', severity: 'warning', retryable: true });
        break;
      }
      lastResponseText = currentResponseSig;

      // Detect if the model is stuck retrying searches that return no results
      const allNoResults = toolResults.every(tr =>
        tr.content.includes('No results found') || tr.content.includes('not in memory'),
      );
      if (allNoResults && toolResults.every(tr => tr.isError === false)) {
        consecutiveNoResultTools++;
        if (consecutiveNoResultTools >= 2) {
          if (!nudgedForNoResults) {
            nudgedForNoResults = true;
            logger.warn('Consecutive empty search results, will nudge on next iteration', { loopCount, consecutiveNoResultTools }, agentId);
            pendingNudge = '[System: Multiple searches returned no results. The information may not exist in memory. Try responding based on what you already know, or ask the user for clarification.]';
            consecutiveNoResultTools = 0;
            continue;
          }
          logger.warn('Breaking tool loop: still no results after nudge', { loopCount, consecutiveNoResultTools }, agentId);
          broadcast({ type: 'chat:error', agentId, error: 'Agent stopped: multiple searches returned no results. The information may not be in memory.', code: 'NO_RESULTS', severity: 'warning', retryable: true });
          break;
        }
      } else {
        consecutiveNoResultTools = 0;
      }

      // Loop continues - model will see tool results and respond
    }

    // Surface visible messages when the loop ends abnormally
    if (loopCount >= MAX_TOOL_LOOPS) {
      logger.warn('Agent hit max tool loop limit', { agentId, maxLoops: MAX_TOOL_LOOPS }, agentId);
      const sysMsg = `[System: This turn used the maximum number of tool calls (${MAX_TOOL_LOOPS}). The agent has paused. You may need to send a follow-up message to continue.]`;
      const sysMsgId = uuidv4();
      db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(sysMsgId, agentId, sysMsg);
      broadcast({ type: 'chat:message', agentId, message: { id: sysMsgId, agentId, role: 'system' as const, content: sysMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
    }

    // ── iMessage response routing ──
    // Runs AFTER the loop regardless of exit path (text-only, tool+text, abnormal
    // exit). Replaces the old in-loop check that only fired for text-only
    // responses, missing cases where the agent produced text alongside tool calls
    // (e.g., text + vault_remember, text + tracker_update_status).
    //
    // Two independent detection mechanisms (belt and suspenders):
    //   1. Content-based: triggeredByIMessage — checks if the last user message
    //      in the DB has [SOURCE: IMESSAGE FROM]. Survives race conditions, server
    //      restarts, and abnormal loop exits.
    //   2. Flag-based: isAwaitingIMResponse — the traditional pendingIMResponseMap.
    //      Handles edge cases where content detection might miss (e.g., message was
    //      compacted away between detection and loop end).
    //
    // For presence=away, use maybeForwardToImessage which filters out system
    // messages, distills for text length, and prefixes with agent name.
    try {
      const { isPrimaryAgent: isPrimary } = await import('../config/platform.js');
      if (isPrimary(agentId) && lastAssistantTextForIM) {
        if (triggeredByIMessage || isAwaitingIMResponse(agentId)) {
          // Direct reply to an incoming iMessage — send full content
          sendResponseViaIMessage(lastAssistantTextForIM, agentId);
        } else {
          // Not triggered by iMessage — check if user is away for proactive forwarding
          const { getPresence } = await import('../services/presence.js');
          if (getPresence() === 'away') {
            const { maybeForwardToImessage } = await import('../services/presence.js');
            maybeForwardToImessage(agentId, lastAssistantTextForIM);
          }
        }
      }
    } catch { /* presence/imessage module may not be available */ }
    // ALWAYS clear the flag so stale entries don't contaminate future turns
    clearIMResponseFlag(agentId);

    // ── Auto-route: if this turn was triggered by a send_to_agent message and the
    // agent responded with text but forgot to call send_to_agent back, automatically
    // deliver the response to the original sender. ──
    try {
      // Get the message that triggered this run — use source_agent_id column
      // for reliable inter-agent detection, fall back to regex for older messages
      const triggerMsg = db.prepare(
        "SELECT content, source_agent_id FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ).get(agentId) as { content: string; source_agent_id: string | null } | undefined;

      if (triggerMsg?.content) {
        // Prefer structured source_agent_id, fall back to regex for backwards compat
        const senderId = triggerMsg.source_agent_id
          ?? triggerMsg.content.match(/\(agent ID: ([^)]+)\)/)?.[1]
          ?? null;
        if (senderId) {

          // Check if the agent already called send_to_agent targeting this sender during the loop
          const sentReply = db.prepare(`
            SELECT id FROM audit_log
            WHERE agent_id = ? AND action_type = 'tool_call' AND target = 'send_to_agent'
              AND detail LIKE ? AND created_at >= datetime('now', '-2 minutes')
            LIMIT 1
          `).get(agentId, `%${senderId}%`) as { id: string } | undefined;

          if (!sentReply) {
            // Agent didn't call send_to_agent — auto-route the last assistant response
            const lastResponse = db.prepare(
              "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1"
            ).get(agentId) as { content: string } | undefined;

            if (lastResponse?.content && typeof lastResponse.content === 'string' && lastResponse.content.trim().length > 0) {
              // Get sender agent name for context
              const senderAgent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined;
              const senderName = senderAgent?.name ?? agentId;

              // Deliver to the original sender's messages table (same as send_to_agent does)
              const replyMsgId = uuidv4();
              const replyContent = `[SOURCE: AGENT MESSAGE FROM ${senderName.toUpperCase()} (agent ID: ${agentId}) — this is NOT a message from the user, it's an auto-routed reply from another agent] ${lastResponse.content}\n\n[To reply, call: send_to_agent(agent="${agentId}", message="your reply")]`;
              db.prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, created_at)
                VALUES (?, ?, 'user', ?, ?, datetime('now'))
              `).run(replyMsgId, senderId, replyContent, agentId);

              broadcast({
                type: 'chat:message',
                agentId: senderId,
                message: {
                  id: replyMsgId,
                  agentId: senderId,
                  role: 'user' as const,
                  content: replyContent,
                  tokenCount: null,
                  modelId: null,
                  cost: null,
                  latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });

              // Trigger the sender's runtime so they process the reply
              this.handleMessage(senderId, replyContent).catch(err => {
                logger.error('Auto-route reply delivery failed', {
                  senderId,
                  error: err instanceof Error ? err.message : String(err),
                }, agentId);
              });

              logger.info('Auto-routed text response to original sender', {
                agentId,
                senderId,
                responseLength: lastResponse.content.length,
              }, agentId);
            }
          }
        }
      }
    } catch (err) {
      logger.debug('Auto-route check failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Set agent back to idle — but only if it wasn't already terminated (e.g., by complete_task)
    const currentAgent = db.prepare('SELECT status, task_id FROM agents WHERE id = ?').get(agentId) as { status: string; task_id: string | null } | undefined;
    if (currentAgent && currentAgent.status !== 'terminated') {
      this.setAgentStatus(agentId, 'idle');
    }

    // After turn: check compaction
    checkAndCompact(agentId, lastUsedModelId, getContextWindow(lastUsedModelId)).catch(err => {
      logger.error('Post-turn compaction failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    });

    // After turn: check for timed-out agents
    try {
      checkTimeouts();
    } catch (err) {
      logger.error('Post-turn timeout check failed', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // When a sub-agent transitions into 'error' or 'paused' (injured/paused),
  // drop a [SYSTEM] message into the primary agent's chat so it finds out
  // immediately instead of discovering later that its delegate never
  // responded. Injected as role='system' so the primary sees it on its
  // next turn but is not forced to reply.
  private async notifyPrimaryOfInjury(
    injuredAgentId: string,
    errorMessage: string,
    pausedByLoop: boolean,
  ): Promise<void> {
    const { isPrimaryAgent, getPrimaryAgentId } = await import('../config/platform.js');

    // Don't notify the primary about itself — the user sees the error
    // banner for the primary agent directly.
    if (isPrimaryAgent(injuredAgentId)) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId || primaryId === injuredAgentId) return;

    try {
      const db = getDb();
      const injured = db.prepare('SELECT name, classification FROM agents WHERE id = ?').get(injuredAgentId) as
        | { name: string; classification: string }
        | undefined;
      if (!injured) return;

      // Find any tracker tasks currently assigned to this agent — those are
      // the ones that just stalled.
      interface StalledTaskRow { id: string; title: string; status: string }
      const stalledTasks = db.prepare(`
        SELECT id, title, status FROM tasks
        WHERE assigned_to = ? AND status IN ('in_progress', 'on_deck')
        ORDER BY updated_at DESC
        LIMIT 5
      `).all(injuredAgentId) as StalledTaskRow[];

      const stateLabel = pausedByLoop ? 'PAUSED (hit error loop)' : 'INJURED';
      const firstLineOfError = errorMessage.split('\n')[0].slice(0, 200);

      const parts: string[] = [];
      parts.push(
        `[SOURCE: AGENT HEALTH ALERT — automated notification, not a message from the user] ⚠️ ${injured.name} (${injured.classification}, ID: ${injuredAgentId}) is now ${stateLabel}.`,
      );
      parts.push(`Last error: ${firstLineOfError}`);
      if (stalledTasks.length > 0) {
        parts.push('');
        parts.push(`Tracker tasks now stalled on ${injured.name}:`);
        for (const t of stalledTasks) {
          parts.push(`  • ${t.title} (${t.status}, ID: ${t.id})`);
        }
      }
      parts.push('');
      parts.push(
        `Options: (a) reset_session(agent_id="${injuredAgentId}") to heal them and let them retry, (b) reassign their work to another agent, or (c) escalate to the user. Do NOT wait indefinitely — they will not recover on their own.`,
      );

      const content = parts.join('\n');
      const msgId = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'system', ?, datetime('now'))
      `).run(msgId, primaryId, content);

      broadcast({
        type: 'chat:message',
        agentId: primaryId,
        message: {
          id: msgId,
          agentId: primaryId,
          role: 'system' as const,
          content,
          tokenCount: null,
          modelId: null,
          cost: null,
          latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });

      logger.info('Primary agent notified of sub-agent injury', {
        injuredAgentId,
        injuredName: injured.name,
        stalledTaskCount: stalledTasks.length,
      }, primaryId);
    } catch (err) {
      logger.warn('Failed to notify primary of injury', {
        injuredAgentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private setAgentStatus(agentId: string, status: string): void {
    try {
      const db = getDb();
      db.prepare(`
        UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);

      broadcast({
        type: 'agent:status',
        agentId,
        status,
      });

      logger.info('Agent status changed', { agentId, status }, agentId);
    } catch (err) {
      logger.error('Failed to update agent status', {
        agentId,
        status,
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  getAgentUptime(agentId: string): number {
    const startTime = agentStartTimes.get(agentId);
    if (!startTime) return 0;
    return Math.floor((Date.now() - startTime) / 1000);
  }
}

// Transform messages with image/PDF attachments into content block arrays for the model
function injectAttachmentBlocks(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): void {
  const db = getDb();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

    // Check the DB for attachments on recent user messages
    // We need to find the DB message that matches this content
    const dbMsg = db.prepare(`
      SELECT id, attachments FROM messages
      WHERE agent_id = ? AND role = 'user' AND attachments IS NOT NULL
      AND content = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(agentId, msg.content) as { id: string; attachments: string } | undefined;

    if (!dbMsg) continue;

    let attachments: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: string }>;
    try {
      attachments = JSON.parse(dbMsg.attachments);
    } catch { continue; }

    const imageAttachments = attachments.filter(a => a.category === 'image');
    const pdfAttachments = attachments.filter(a => a.category === 'pdf');

    if (imageAttachments.length === 0 && pdfAttachments.length === 0) continue;

    // Convert to content block array
    const blocks: Anthropic.ContentBlockParam[] = [];

    // Add text content first
    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }

    // Add image blocks
    for (const img of imageAttachments) {
      try {
        if (!fs.existsSync(img.path)) continue;
        const data = fs.readFileSync(img.path).toString('base64');
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            data,
          },
        });
      } catch {
        // Skip if file can't be read
      }
    }

    // Add PDF blocks. Anthropic's `document` type supports an optional
    // `title` field (used by the UI + for model grounding); we also use it
    // downstream by the Ollama translator to label extracted-text sections
    // so the model knows which file a passage belongs to.
    for (const pdf of pdfAttachments) {
      try {
        if (!fs.existsSync(pdf.path)) continue;
        const data = fs.readFileSync(pdf.path).toString('base64');
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data,
          },
          title: pdf.filename,
        } as Anthropic.ContentBlockParam);
      } catch {
        // Skip if file can't be read
      }
    }

    messages[i] = { role: 'user', content: blocks };
  }
}

// ── Stuck-Agent Recovery ──
// If the runtime crashes mid-turn after setting status to 'working' but before
// the finally block clears it, the agent stays stuck. This periodic check
// resets agents that have been 'working' for too long (10+ minutes).
const STUCK_AGENT_CHECK_MS = 5 * 60 * 1000; // Check every 5 minutes
const STUCK_AGENT_THRESHOLD_MINUTES = 10;

function recoverStuckAgents(): void {
  try {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT id, name FROM agents
      WHERE status = 'working'
        AND updated_at < datetime('now', '-${STUCK_AGENT_THRESHOLD_MINUTES} minutes')
    `).all() as Array<{ id: string; name: string }>;

    for (const agent of stuck) {
      db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(agent.id);
      activeRuns.delete(agent.id);
      pendingWakeups.delete(agent.id);
      broadcast({ type: 'agent:status', agentId: agent.id, status: 'idle' });
      logger.warn('Recovered stuck agent from permanent working state', { agentId: agent.id, agentName: agent.name });
    }
  } catch (err) {
    logger.error('recoverStuckAgents failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// Start the stuck-agent recovery check
setInterval(recoverStuckAgents, STUCK_AGENT_CHECK_MS);
// Also run immediately on startup to clean up after crashes
recoverStuckAgents();

// Singleton
let runtimeInstance: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime();
  }
  return runtimeInstance;
}

export { AgentRuntime };
