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
import type { Message } from '@dojo/shared';

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

// Track the last message ID processed per agent to avoid re-processing
const lastProcessedMessageId = new Map<string, string>();

// Agents that should halt on the next loop iteration
const stoppedAgents = new Set<string>();

// AbortControllers for in-flight API calls — aborting these kills the request immediately
const activeAbortControllers = new Map<string, AbortController>();

/** Stop a running agent — aborts in-flight API call and halts the loop */
export function stopAgent(agentId: string): void {
  stoppedAgents.add(agentId);
  // Abort any in-flight API call
  const controller = activeAbortControllers.get(agentId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(agentId);
  }
  logger.info('Agent stop requested', {}, agentId);
}

const MAX_TOOL_LOOPS = 25; // Maximum tool call loops per turn

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

      // Broadcast error to dashboard
      broadcast({
        type: 'chat:error',
        agentId,
        error: message,
      });

      // For rate limit errors, inject a visible system message into the chat
      // so the user knows what's happening (the error banner can be missed)
      const isRateLimit = message.toLowerCase().includes('429') || message.toLowerCase().includes('rate_limit') || message.toLowerCase().includes('overloaded');
      if (isRateLimit) {
        const msgId = uuidv4();
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        const errDb = getDb();
        errDb.prepare("INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, ?)").run(
          msgId, agentId, '[Rate limited] The model provider returned a rate limit error. Retrying shortly...', now
        );
        broadcast({ type: 'chat:message', agentId, message: { id: msgId, agentId, role: 'system', content: '[Rate limited] The model provider returned a rate limit error. Retrying shortly...', tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: now } });
      }
    } finally {
      activeRuns.delete(agentId);

      // If a message arrived while we were busy, re-trigger the loop
      // BUT only if there's a genuinely new user message we haven't processed yet
      // Delay slightly to batch rapid-fire messages from multiple sub-agents
      if (pendingWakeups.has(agentId)) {
        pendingWakeups.delete(agentId);
        setTimeout(() => {
          const lastUserMsg = getDb().prepare(
            "SELECT id, role FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
          ).get(agentId) as { id: string; role: string } | undefined;
          const lastProcessed = lastProcessedMessageId.get(agentId);
          if (lastUserMsg && lastUserMsg.id !== lastProcessed) {
            logger.info('Processing queued wakeup (new user message found)', { agentId, msgId: lastUserMsg.id }, agentId);
            this.handleMessage(agentId, '').catch(err => {
              logger.error('Queued wakeup failed', {
                agentId,
                error: err instanceof Error ? err.message : String(err),
              }, agentId);
            });
          } else {
            logger.debug('Skipping queued wakeup (no new user messages since last run)', { agentId }, agentId);
          }
        }, 2000); // 2 second delay to batch rapid messages
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

    // Track the latest user message so wakeup queue knows what we've already seen
    const latestUserMsg = db.prepare(
      "SELECT id FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).get(agentId) as { id: string } | undefined;
    if (latestUserMsg) {
      lastProcessedMessageId.set(agentId, latestUserMsg.id);
    }

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

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
          const selected = selectModel(scoringResult.tier, agentId, excludedModels.length > 0 ? excludedModels : undefined);
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

      // Call model with retry logic — for auto-routed agents, try fallback models on failure
      const messageId = uuidv4();
      const streamedChunks: string[] = [];

      let callSucceeded = false;
      let result;
      const maxAttempts = isAutoRouted ? 3 : 1;

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
                tools: true,
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
          const fallback = selectModel(routerTier!, agentId, excludedModels);
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

      // If this is a final text response (no tool calls), flush the buffered chunks to the client
      if (result.toolCalls.length === 0) {
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
      // If there are tool calls, we must store them as content blocks alongside any text
      if (result.toolCalls.length > 0) {
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
          INSERT INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, created_at)
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
          INSERT INTO messages (id, agent_id, role, content, token_count, model_id, cost, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, datetime('now'))
        `).run(
          messageId,
          agentId,
          result.content,
          result.outputTokens,
          modelId,
          null,
        );
        // Text-only messages are also streamed via chat:chunk, so broadcastMessage is redundant here

        // Queue embedding for assistant text responses
        queueEmbedding('message', messageId, agentId, result.content);
      }

      // Broadcast completion for streaming (include modelId so UI can show it)
      broadcast({
        type: 'chat:chunk',
        agentId,
        messageId,
        content: '',
        done: true,
        modelId,
      });

      // If no tool calls, we're done
      if (result.toolCalls.length === 0) {
        if (result.content) {
          try {
            const { getPresence } = await import('../services/presence.js');
            const { isPrimaryAgent } = await import('../config/platform.js');
            const presence = getPresence();

            if (presence === 'away' && isPrimaryAgent(agentId)) {
              // Rule 1: User is "away from the dojo" → always send via iMessage
              sendResponseViaIMessage(result.content, agentId);
              clearIMResponseFlag(agentId);
            } else if (isAwaitingIMResponse(agentId)) {
              // Rule 2: User is "in the dojo" but this turn was triggered by an iMessage → reply via iMessage
              sendResponseViaIMessage(result.content, agentId);
              clearIMResponseFlag(agentId);
            }
          } catch { /* presence/imessage module may not be available */ }
        }

        // Final response — unlock model for next user message
        lockedModelId = null;
        break;
      }

      // Tool calls present — lock the model for the rest of this turn's tool loop
      if (isAutoRouted && !lockedModelId) {
        lockedModelId = modelId;
        logger.info('Auto-router: locking model for tool loop', { modelId }, agentId);
      }

      // Execute each tool call
      const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];

      for (const toolCall of result.toolCalls) {
        // Broadcast tool call to dashboard
        broadcast({
          type: 'chat:tool_call',
          agentId,
          tool: toolCall.name,
          args: toolCall.arguments,
        });

        const toolResult = await executeTool(agentId, toolCall);
        toolResults.push(toolResult);

        // Broadcast tool result
        broadcast({
          type: 'chat:tool_result',
          agentId,
          tool: toolCall.name,
          result: toolResult.content.slice(0, 500), // Truncate for WS
        });
      }

      // Persist tool result messages
      // These need to be stored as a single "user" turn with tool_result content blocks
      const toolResultContent: Anthropic.ToolResultBlockParam[] = toolResults.map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.toolCallId,
        content: tr.content,
        is_error: tr.isError,
      }));

      const toolMessageId = uuidv4();
      db.prepare(`
        INSERT INTO messages (id, agent_id, role, content, created_at)
        VALUES (?, ?, 'tool', ?, datetime('now'))
      `).run(toolMessageId, agentId, JSON.stringify(toolResultContent));
      broadcastMessage(agentId, { id: toolMessageId, role: 'tool', content: JSON.stringify(toolResultContent) });

      // Clear error records on successful tool execution
      clearErrors(agentId);

      // If complete_task was called, the agent is done — stop the loop
      const calledCompleteTask = result.toolCalls.some(tc => tc.name === 'complete_task');
      if (calledCompleteTask) {
        logger.info('Agent called complete_task, exiting loop', { agentId }, agentId);
        break;
      }

      // Detect repetition: if the model produced the same text AND same tool calls as last iteration
      const currentResponseSig = (result.content ?? '') + '|' + result.toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).sort().join(',');
      if (lastResponseText === currentResponseSig) {
        logger.warn('Breaking tool loop: agent is repeating itself (same response and tool calls)', {
          loopCount,
        }, agentId);
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
          logger.warn('Breaking tool loop: consecutive empty search results', {
            loopCount,
            consecutiveNoResultTools,
          }, agentId);
          break;
        }
      } else {
        consecutiveNoResultTools = 0;
      }

      // Loop continues - model will see tool results and respond
    }

    if (loopCount >= MAX_TOOL_LOOPS) {
      logger.warn('Agent hit max tool loop limit', { agentId, maxLoops: MAX_TOOL_LOOPS }, agentId);
    }

    // ── Auto-route: if this turn was triggered by a send_to_agent message and the
    // agent responded with text but forgot to call send_to_agent back, automatically
    // deliver the response to the original sender. ──
    try {
      // Get the message that triggered this run
      const triggerMsg = db.prepare(
        "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      ).get(agentId) as { content: string } | undefined;

      if (triggerMsg?.content) {
        const senderMatch = triggerMsg.content.match(/^\[Message from .+? \(agent ID: ([^)]+)\)\]/);
        if (senderMatch) {
          const senderId = senderMatch[1];

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
              const replyContent = `[Message from ${senderName} (agent ID: ${agentId})] ${lastResponse.content}\n\n[To reply, call: send_to_agent(agent="${agentId}", message="your reply")]`;
              db.prepare(`
                INSERT INTO messages (id, agent_id, role, content, created_at)
                VALUES (?, ?, 'user', ?, datetime('now'))
              `).run(replyMsgId, senderId, replyContent);

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

    // Add PDF blocks (Anthropic supports document type)
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
        } as Anthropic.ContentBlockParam);
      } catch {
        // Skip if file can't be read
      }
    }

    messages[i] = { role: 'user', content: blocks };
  }
}

// Singleton
let runtimeInstance: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime();
  }
  return runtimeInstance;
}

export { AgentRuntime };
