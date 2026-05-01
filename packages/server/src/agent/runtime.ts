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

// ── Recoverable provider 4xx classifier ──
//
// Some provider errors aren't "the agent broke" — they're "the request was
// wrong for this model". The agent can adapt and retry differently if we
// just tell them what went wrong instead of injuring them and waiting for
// a human to intervene.
//
// Returns null if the error is NOT recoverable (real failure, transient
// 5xx, rate limit, network — those should keep their existing flow).
interface RecoverableProviderError {
  kind: 'vision_mismatch' | 'unsupported_modality' | 'unsupported_input' | 'tool_format_rejected' | 'malformed_request';
  userFacingReason: string;
  guidance: string;
}
function classifyRecoverableProviderError(err: string): RecoverableProviderError | null {
  if (!err) return null;
  const lower = err.toLowerCase();

  // Don't recover transient or auth errors — those go through the existing
  // healer / rate-limit retry paths, not in-loop recovery.
  if (lower.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit') ||
      lower.includes('overloaded') || lower.includes('529') ||
      lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('etimedout') ||
      lower.includes('fetch failed') || lower.includes('socket hang up') ||
      lower.includes('timeout') || lower.includes('timed out') ||
      lower.includes('503') || lower.includes('502') || lower.includes('500') ||
      lower.includes('401') || lower.includes('403') || lower.includes('unauthorized') ||
      lower.includes('invalid_api_key') || lower.includes('api key')) {
    return null;
  }

  // Vision / image input not supported — most common case the user hits.
  // Pattern: 404 "no endpoints found that support image input", 400
  // "this model does not support vision", "image_url" rejected, etc.
  if (
    (lower.includes('image') || lower.includes('vision') || lower.includes('image_url')) &&
    (lower.includes('not support') || lower.includes("don't support") || lower.includes('does not support') ||
     lower.includes('unsupported') || lower.includes('endpoints found that support') ||
     lower.includes('no endpoints found') || lower.includes("can't handle") || lower.includes('cannot handle'))
  ) {
    return {
      kind: 'vision_mismatch',
      userFacingReason: 'the configured model does not support image input',
      guidance: 'Continue without trying to look at images. If the user asked you to analyze an image and you have a path to it, describe what you can infer from the filename, surrounding text, or metadata — or tell the user this model can\'t see images and they may want to switch.',
    };
  }

  // Generic "modality not supported" — audio, video, etc.
  if (lower.includes('modality') && (lower.includes('not support') || lower.includes('unsupported'))) {
    return {
      kind: 'unsupported_modality',
      userFacingReason: 'the model does not support the type of input that was sent',
      guidance: 'Try the same request without the unsupported attachment, or use a different tool.',
    };
  }

  // Tool format rejected — agent constructed a malformed tool call. Common
  // pattern: provider says invalid_request_error / "tool_use ids" / "tool calls".
  if ((lower.includes('tool_use') || lower.includes('tool_call') || lower.includes('tool calls')) &&
      (lower.includes('invalid') || lower.includes('malformed') || lower.includes('not found') ||
       lower.includes('does not match'))) {
    return {
      kind: 'tool_format_rejected',
      userFacingReason: 'the tool call format was rejected by the provider',
      guidance: 'Re-issue the tool call with the correct argument types and required fields. Call load_tool_docs for the tool first if you need to recheck its schema.',
    };
  }

  // Generic malformed/unsupported 400 with enough specificity to be safe.
  if (lower.includes('400') &&
      (lower.includes('not support') || lower.includes('unsupported') ||
       lower.includes('invalid_request_error') || lower.includes('malformed') ||
       lower.includes('unrecognized'))) {
    return {
      kind: 'malformed_request',
      userFacingReason: 'the provider rejected the request as malformed or unsupported',
      guidance: 'Adjust your approach — try a different tool, simpler input, or skip the step that triggered this.',
    };
  }

  // 404 specifically about input/endpoint support (catches OpenRouter-style
  // "404 No endpoints found that support image input" even if our other
  // matchers missed). Conservative — only fire on clear input/support phrasing.
  if (lower.includes('404') &&
      (lower.includes('endpoints found that support') ||
       lower.includes('does not support') || lower.includes('not supported'))) {
    return {
      kind: 'unsupported_input',
      userFacingReason: 'the model does not support what was sent',
      guidance: 'Try the same request without the unsupported attachment or tool, or take a different approach.',
    };
  }

  return null;
}

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

    // Helper that strips images/documents from a top-level block array AND
    // recursively from any tool_result blocks. Pre-2026-04-30 this only
    // checked top-level types, so an image returned by file_read (which
    // arrives nested as tool_result.content[0].type='image') sailed past
    // the strip unchanged. The provider 400'd, in-loop recovery fired,
    // wakeup re-ran the same turn, the same nested image was still there,
    // 400 again — runaway loop until something killed the server.
    const stripBlocks = (blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
      const kept: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'image') { imagesStripped++; continue; }
        if (b.type === 'document') { docsStripped++; continue; }
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          // Recurse into the tool_result's content array.
          const innerKept = stripBlocks(b.content as Array<Record<string, unknown>>);
          // If the tool_result ends up with NO content after stripping
          // (was image/doc only), replace with a text note. The model
          // needs to know there was a result, just not what it contained.
          if (innerKept.length === 0) {
            kept.push({
              ...b,
              content: [{
                type: 'text',
                text: '(Image/PDF attachment removed — this model does not support vision input)',
              }],
            });
          } else {
            kept.push({ ...b, content: innerKept });
          }
          continue;
        }
        kept.push(b);
      }
      return kept;
    };

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const beforeImg = imagesStripped;
      const beforeDoc = docsStripped;
      const kept = stripBlocks(blocks);
      const changed = imagesStripped !== beforeImg || docsStripped !== beforeDoc;
      if (!changed) continue;

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
function broadcastMessage(agentId: string, msg: {
  id: string;
  role: string;
  content: string;
  createdAt?: string;
  modelId?: string | null;
  attachments?: Array<{ fileId: string; filename: string; mimeType: string; size: number; path: string; category: 'image' | 'pdf' | 'text' | 'office' | 'unknown' }>;
}) {
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
      attachments: msg.attachments,
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

// Agents that should treat the next aborted model call as a soft-end so a
// queued urgent wakeup can fire promptly. Pre-2026-04-30 a PM poke or user
// message arriving during a busy run got queued in pendingWakeups and didn't
// fire until the active turn naturally ended — which could be 15 minutes
// later if the agent was mid long model call. Now an external caller can
// preempt the current turn for high-priority traffic. The runtime catch
// path checks this flag (same pattern as stoppedAgents) and ends the loop
// cleanly without escalating to injury.
const preemptedAgents = new Set<string>();

// Tracks consecutive in-loop recovery attempts of the same kind per agent.
// In-loop recovery is supposed to handle a one-off provider 4xx by injecting
// a system note + queueing a wakeup. But if the recovery itself can't fix
// the underlying issue (e.g. images nested in tool_result blocks not being
// stripped), each retry hits the same error and fires recovery again,
// creating a runaway loop. Pre-2026-04-30 this could blow through 100+
// iterations in seconds. Now we cap consecutive same-kind recoveries at
// MAX_CONSECUTIVE_INLOOP_RECOVERIES — beyond that, we let the error
// propagate to injury so the Healer takes over.
const recoveryRunStreak = new Map<string, { kind: string; count: number }>();
const MAX_CONSECUTIVE_INLOOP_RECOVERIES = 3;

// Heartbeat timers — re-broadcast agent:status='working' every 30s while
// the runAgentLoop is active. See the call site in runAgentLoop for the
// motivation (clients reconnecting mid-turn don't pick up stale state).
const statusHeartbeats = new Map<string, ReturnType<typeof setInterval>>();
const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;

function startStatusHeartbeat(agentId: string): void {
  // Clear any prior timer for this agent (defensive — shouldn't normally happen)
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      broadcast({ type: 'agent:status', agentId, status: 'working' });
    } catch { /* best effort */ }
  }, STATUS_HEARTBEAT_INTERVAL_MS);
  statusHeartbeats.set(agentId, timer);
}

function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

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

/**
 * Preempt an agent's current turn so a queued urgent wakeup fires now,
 * not whenever the current run happens to end. Aborts the in-flight model
 * call (if any) and marks the agent as preempted so the runtime catch
 * treats the abort as a clean end rather than an error/injury. The next
 * tick of handleMessage's finally block fires the queued wakeup.
 *
 * Returns true if there was an in-flight model call to abort.
 *
 * Use sparingly — every preempt costs whatever in-flight model work was
 * mid-stream. Call it for genuinely urgent traffic only: PM pokes,
 * Healer alerts, direct user messages.
 */
export function preemptAgentForUrgentMessage(agentId: string): boolean {
  const controller = activeAbortControllers.get(agentId);
  if (!controller) return false;
  preemptedAgents.add(agentId);
  controller.abort();
  activeAbortControllers.delete(agentId);
  logger.info('Agent run preempted for urgent wakeup', {}, agentId);
  return true;
}

const MAX_TOOL_LOOPS = 75; // Maximum tool call loops per turn (raised from 25 — real work often needs 30-50+ calls)
const TURN_TIME_BUDGET_MS = 15 * 60 * 1000; // 15 minute max per turn (local Ollama models can be slow)

// When a turn hits the time budget, the engine no longer hard-stops the
// agent and waits for the user to send a follow-up. Instead it forces a
// compaction (the long-running turn has bloated context) and queues a
// wakeup so the agent picks up where it left off. This counter caps the
// number of consecutive auto-continuations per agent, so a genuinely
// stuck/looping agent eventually stops instead of grinding forever.
// At 15 min/budget × 3 caps, that's roughly 45-60 min of autonomous
// work before the engine stops and asks the user for direction.
const MAX_TURN_AUTO_CONTINUATIONS = 3;
const turnContinuationCounts = new Map<string, number>();

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
      const fullErrText = cause ? `${message} ${cause}` : message;

      // ── Context-overflow recovery ──
      // If the provider rejected the request because the prompt exceeded
      // the model's context window, the agent isn't broken — the input was
      // too big. Try to recover by splitting before treating it as an injury.
      // Currently only the Dreamer has a structured pending-batch queue we
      // can re-shape; for other agents we force a compaction and retry once.
      try {
        const { isContextOverflowError, recoverDreamerFromContextOverflow } = await import('../vault/maintenance.js');
        if (isContextOverflowError(fullErrText)) {
          logger.warn(`Context overflow detected: ${message}`, { agentId, code, cause }, agentId);
          const { getDreamerAgentId } = await import('../config/platform.js');
          if (agentId === getDreamerAgentId()) {
            const recovered = await recoverDreamerFromContextOverflow(agentId, fullErrText);
            if (recovered) {
              logger.warn('Recovered from Dreamer context overflow by splitting batch', { agentId }, agentId);
              return; // skip error/injury path entirely
            }
          } else {
            // Non-Dreamer agents: force a compaction so the next turn has a
            // smaller context, then queue a wakeup. This keeps the agent
            // working instead of going into the error/injury loop.
            try {
              const lastModelRow = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
              const compactModelId = lastModelRow?.model_id ?? null;
              if (compactModelId && compactModelId !== 'auto') {
                const cw = getContextWindow(compactModelId);
                await checkAndCompact(agentId, compactModelId, cw, { force: true });
                logger.warn('Forced compaction after context overflow on non-Dreamer agent', { agentId }, agentId);
                pendingWakeups.add(agentId);
                return;
              }
            } catch (compErr) {
              logger.warn('Forced compaction after overflow failed', {
                agentId,
                error: compErr instanceof Error ? compErr.message : String(compErr),
              }, agentId);
            }
          }
        }
      } catch (recovErr) {
        logger.warn('Context overflow recovery attempt failed', {
          agentId,
          error: recovErr instanceof Error ? recovErr.message : String(recovErr),
        }, agentId);
      }

      // ── Provider 4xx in-loop recovery ──
      // When the provider rejects the request for a reason the agent itself
      // can adapt to (capability mismatch, malformed input, unsupported
      // modality), we don't want to halt the agent — that requires user
      // intervention for what is essentially "try a different approach".
      // Instead, persist a [System: ...] note explaining what failed and why,
      // then queue a wakeup. The agent reads the note on the next turn and
      // adapts. No injury status, no healer involvement.
      try {
        const recovery = classifyRecoverableProviderError(fullErrText);
        if (recovery) {
          // Cap consecutive same-kind recoveries. Without this cap, a
          // recovery whose underlying fix can't actually clear the error
          // (e.g. a stripping bug elsewhere, or a model that ignores the
          // injected system note) will loop forever — we saw 132 retries
          // in seconds before manual server kill. After
          // MAX_CONSECUTIVE_INLOOP_RECOVERIES of the same kind, escalate
          // to injury so the Healer takes over.
          const prev = recoveryRunStreak.get(agentId);
          const sameKind = prev?.kind === recovery.kind;
          const newCount = sameKind ? prev!.count + 1 : 1;
          recoveryRunStreak.set(agentId, { kind: recovery.kind, count: newCount });

          if (newCount > MAX_CONSECUTIVE_INLOOP_RECOVERIES) {
            // Give up on in-loop recovery. Clear the streak so a future
            // unrelated error starts fresh, and let the existing injury
            // path handle it (logged below + healer dispatch).
            recoveryRunStreak.delete(agentId);
            logger.error('In-loop recovery cap reached — escalating to injury', {
              agentId, kind: recovery.kind, count: newCount, max: MAX_CONSECUTIVE_INLOOP_RECOVERIES,
            }, agentId);
            // Persist a final system note so the chat surface shows why the
            // agent is being injured (instead of looking like a silent halt).
            const giveUpNote = `[System: Recovery has been attempting to fix the same problem (${recovery.kind}) ${newCount} times in a row without success. Stopping the recovery loop and routing this to the Healer. The underlying issue: ${recovery.userFacingReason}.]`;
            try {
              const noteId = uuidv4();
              getDb().prepare(`
                INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
                VALUES (?, ?, 'system', ?, datetime('now'))
              `).run(noteId, agentId, giveUpNote);
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: noteId, agentId, role: 'system' as const, content: giveUpNote,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch { /* best effort */ }
            // Fall through past the recovery block — the existing injury
            // path below will record the error and notify the Healer.
          } else {
            logger.warn(`Recoverable provider error — injecting system note instead of injuring`, {
              agentId, kind: recovery.kind, count: newCount, message: message.slice(0, 200),
            }, agentId);

            // For vision-mismatch errors, also correct the model's capability
            // cache so the pre-flight gate strips images on every subsequent
            // turn for any agent using this model. Self-healing capability probe.
            if (recovery.kind === 'vision_mismatch') {
              try {
                const lastModelRow = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
                if (lastModelRow?.model_id && lastModelRow.model_id !== 'auto') {
                  const { removeCapability } = await import('../services/capabilities.js');
                  removeCapability(lastModelRow.model_id, 'vision');
                }
              } catch { /* best effort — recovery still proceeds */ }
            }

            // Persist a system note that the agent will see on its next turn.
            // Keep it terse and instructional — the agent needs to know what
            // failed and what to do differently.
            const systemNote = `[System: Your last action failed because the model could not handle the request as sent. Reason: ${recovery.userFacingReason}. ${recovery.guidance} Do not retry the exact same action; adapt your approach and continue.]`;
            const noteId = uuidv4();
            getDb().prepare(`
              INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
              VALUES (?, ?, 'system', ?, datetime('now'))
            `).run(noteId, agentId, systemNote);
            broadcast({
              type: 'chat:message',
              agentId,
              message: {
                id: noteId,
                agentId,
                role: 'system' as const,
                content: systemNote,
                tokenCount: null,
                modelId: null,
                cost: null,
                latencyMs: null,
                createdAt: new Date().toISOString(),
              },
            });

            // Don't mark error/injury. Queue a wakeup so the agent retries with
            // the system note in context.
            pendingWakeups.add(agentId);
            return;
          }
        }
      } catch (recovErr) {
        logger.warn('Provider 4xx recovery attempt failed', {
          agentId,
          error: recovErr instanceof Error ? recovErr.message : String(recovErr),
        }, agentId);
      }

      logger.error(`Agent loop failed: ${message}`, { agentId, code, cause }, agentId);

      // Record error for loop detection
      const paused = recordError(agentId);

      if (!paused) {
        this.setAgentStatus(agentId, 'error');
      }

      // Persist the error details so the injury recovery system can
      // diagnose and attempt auto-recovery without needing the in-memory state.
      try {
        const errDetail = cause ? `${message} (${cause})` : message;
        const errDb = getDb();
        errDb.prepare(`
          UPDATE agents SET last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
        `).run(errDetail.slice(0, 500), agentId);
      } catch { /* best effort */ }

      // Schedule healer notification after grace period. If the agent
      // recovers within 5 minutes, the timer is cancelled automatically.
      import('../healer/injury-recovery.js').then(({ onAgentInjured }) => {
        onAgentInjured(agentId, message);
      }).catch(() => { /* module may not be available */ });

      // The primary agent is notified later — from injury-recovery's
      // notifyHealerOfInjury after the engine auto-wake + grace period
      // have already failed to unstick the agent. Pre-2026-04-30 this
      // fired immediately on every injury, which meant transient rate
      // limits and network blips alerted the primary even when the agent
      // self-recovered seconds later. The new path keeps the primary in
      // the loop only for agents that genuinely need help.

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
      // Safety net for any path that broke out of runAgentLoop without
      // calling stopStatusHeartbeat (e.g., uncaught throw, early return).
      // Idempotent — no-op if the heartbeat was already stopped.
      stopStatusHeartbeat(agentId);

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

    // Heartbeat status re-broadcast every 30s while the loop is active.
    // Pre-2026-04-30 setAgentStatus('working') only broadcast ONCE at the
    // start of a turn. If a dashboard client reconnected mid-turn (which
    // happens on tab focus, network blips, etc.), it missed the original
    // broadcast and the Agents grid showed stale 'idle' state for the
    // entire duration of a long turn — making the agent look like it had
    // stopped working when it was actively running. Heartbeat fixes that
    // self-correctingly: any reconnected client sees a fresh 'working'
    // event within 30s. Tracked in module-level statusHeartbeats so the
    // cleanup is guaranteed even if runAgentLoop throws — handleMessage's
    // finally block clears it via stopStatusHeartbeat().
    startStatusHeartbeat(agentId);

    let loopCount = 0;
    let consecutiveNoResultTools = 0;
    let lastUsedModelId: string = isAutoRouted ? contextModelId : configuredModelId;
    let lastResponseText: string | null = null; // For repetition detection
    let lockedModelId: string | null = null; // For auto-routed agents: lock model during tool loops
    let lockedTier: string | null = null;    // Tier paired with lockedModelId — used so the fallback path always knows which tier to search even when scoring was skipped this iteration
    let nudgedForRepetition = false; // Only nudge once for repetition
    let retriedEmptyResponse = false; // Silent retry before nudging for empty output
    let nudgedForEmptyResponse = false; // Only nudge once for empty output
    let nudgedForNoResults = false; // Only nudge once for empty search results
    let nudgedForTracker = false; // Only nudge once for missing tracker task
    let trackerToolCalled = false; // Whether agent has used any tracker tool this turn
    let nonTrackerToolCalls = 0; // Count of non-tracker tool calls this turn
    let toolCallsExecutedThisTurn = 0; // Total tool calls executed across all loop iterations this turn
    let sentToAgentThisTurn = false; // Whether the agent called send_to_agent during this turn
    let consecutivePermissionDenials = 0; // Count of consecutive [BLOCKED] tool results
    let lastAssistantTextForIM: string | null = null; // Last assistant text this turn — for iMessage routing after loop

    // Detect if this turn was triggered by an incoming iMessage.
    // Two mechanisms — content-based is primary, flag is secondary:
    //   1. Content-based: check if the most recent user message has the iMessage source tag.
    //      Survives race conditions, server restarts, and abnormal loop exits.
    //   2. Flag-based: snapshot pendingIMResponseMap NOW, at the start of the run.
    //      If the flag is set later during the run (new iMessage arrives while we're busy),
    //      we do NOT consume it — the wakeup run will handle it. This prevents the wrong
    //      response (e.g., a mail check) from being sent via iMessage just because an
    //      unrelated iMessage arrived mid-run.
    const triggerRow = db.prepare(
      "SELECT content FROM messages WHERE agent_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).get(agentId) as { content: string } | undefined;
    const triggeredByIMessage = triggerRow?.content?.includes('[SOURCE: IMESSAGE FROM') ?? false;
    const imFlagSetAtRunStart = isAwaitingIMResponse(agentId);

    // Detect if this turn was triggered by an A2A reply-needed intent.
    // Pattern: "[A2A:<INTENT> thread:<id> from:<name>] ..."
    // QUESTION / ASSIGN / BLOCK are open-thread intents where the sender is
    // expecting a reply. If the agent ends its turn with text but no
    // send_to_agent call, that's a missed reply — the text was written in
    // chat (where only the user sees it) instead of being sent to the actual
    // recipient. We catch this at end-of-turn and nudge the agent to retry.
    //
    // ANSWER and DELIVERABLE are NOT nudged — those are content-deliveries
    // on a closed thread; the agent's job is to USE the content (e.g., relay
    // to user), not reply.
    const a2aMatch = triggerRow?.content?.match(/^\[A2A:([A-Z]+)\s+thread:([0-9a-f]{8})\s+from:([^\]]+)\]/);
    const triggeredByA2AReplyIntent = (() => {
      if (!a2aMatch) return null;
      const intent = a2aMatch[1];
      const threadShort = a2aMatch[2];
      const fromName = a2aMatch[3].trim();
      const REPLY_NEEDED_INTENTS = new Set(['QUESTION', 'ASSIGN', 'BLOCK']);
      if (!REPLY_NEEDED_INTENTS.has(intent)) return null;
      return { intent, threadShort, fromName };
    })();

    // In-memory nudge — injected into context on next loop iteration, never persisted to DB
    let pendingNudge: string | null = null;
    let nudgedForMissedA2AReply = false; // Only nudge once per turn for missed A2A replies

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

      // ── Turn time budget — auto-continue, don't halt ──
      // Pre-2026-04-30 this hard-stopped the agent and dumped a "send a
      // follow-up message to continue" note in their chat, defeating
      // autonomy. Now we treat the budget as a *checkpoint*: force a
      // compaction (the long-running turn bloated context), persist a
      // brief system note so the user/agent knows what happened, and
      // queue a wakeup. The agent's next turn picks up where it left
      // off — checks in_progress tracker tasks, resumes work.
      // After MAX_TURN_AUTO_CONTINUATIONS consecutive checkpoints the
      // engine gives up and stops, which usually indicates a stuck loop.
      if (Date.now() - turnStartMs > TURN_TIME_BUDGET_MS) {
        const elapsedMin = Math.round((Date.now() - turnStartMs) / 60000);
        const continuationCount = (turnContinuationCounts.get(agentId) ?? 0) + 1;

        if (continuationCount > MAX_TURN_AUTO_CONTINUATIONS) {
          // Cap hit — stop auto-continuing. Reset the counter so the next
          // run from a fresh user message starts clean.
          turnContinuationCounts.delete(agentId);
          logger.error('Turn auto-continuation cap reached — stopping', {
            elapsedMin, continuationCount, max: MAX_TURN_AUTO_CONTINUATIONS, agentId,
          }, agentId);
          const stuckMsg = `[System: This work has been auto-continuing for ${MAX_TURN_AUTO_CONTINUATIONS + 1} turns of ${TURN_TIME_BUDGET_MS / 60000} minutes each (≈${(MAX_TURN_AUTO_CONTINUATIONS + 1) * (TURN_TIME_BUDGET_MS / 60000)} minutes total) without finishing. Pausing here — this usually means a stuck loop, an over-scoped task, or a slow model. The user can send a follow-up message to resume, or break the work into smaller pieces.]`;
          const stuckId = uuidv4();
          db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(stuckId, agentId, stuckMsg);
          broadcast({ type: 'chat:message', agentId, message: { id: stuckId, agentId, role: 'system' as const, content: stuckMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
          break;
        }

        turnContinuationCounts.set(agentId, continuationCount);
        logger.warn('Turn time budget reached — auto-continuing with forced compaction', {
          elapsedMin, continuationCount, agentId,
        }, agentId);

        // Force a compaction so the next turn starts with summarized
        // history rather than the full bloated context. Best-effort —
        // if it fails we still queue the wakeup. The agent's continuity
        // brief (written by compaction) gives them the "where I left off"
        // context.
        try {
          await checkAndCompact(agentId, lastUsedModelId, getContextWindow(lastUsedModelId), { force: true });
        } catch (compErr) {
          logger.warn('Forced compaction at turn-budget checkpoint failed', {
            agentId, error: compErr instanceof Error ? compErr.message : String(compErr),
          }, agentId);
        }

        const sysMsg = `[System: This turn ran for ${elapsedMin} minutes — pausing for context health and auto-continuing (continuation ${continuationCount} of ${MAX_TURN_AUTO_CONTINUATIONS}). The conversation history has been compacted; you have a continuity brief for context. On the next turn, check tracker_list_active for any in_progress task you were working on and pick up exactly where you left off — do not start over.]`;
        const sysMsgId = uuidv4();
        db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(sysMsgId, agentId, sysMsg);
        broadcast({ type: 'chat:message', agentId, message: { id: sysMsgId, agentId, role: 'system' as const, content: sysMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });

        // Queue a wakeup so the loop fires again after the current turn
        // exits. The handleMessage finally block already processes
        // pendingWakeups with a small delay.
        pendingWakeups.add(agentId);
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
        // If we're mid-tool-loop, keep the same model for consistency.
        // Carry lockedTier into routerTier so the fallback path knows the
        // tier without re-running scoring. Without this, a mid-loop model
        // failure produced selectModel(null, ...) → no fallback → injury.
        if (lockedModelId && loopCount > 1) {
          modelId = lockedModelId;
          routerTier = lockedTier;
          logger.info(`Auto-router: using locked model (mid-task)`, { modelId: lockedModelId, tier: lockedTier }, agentId);
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

      // Guard: never ship an empty messages array to the provider. Anthropic
      // (and others) 400 with "messages: at least one message is required",
      // which the catch path treats as a real error → injury → auto-wake →
      // same empty context → same 400, looping until the error-loop limit
      // pauses the agent. This typically happens when an auto-wake fires
      // for an agent whose entire conversation sits before session_started_at
      // (post-reset state with no new user message yet). The right behavior
      // is "nothing to say, end the run cleanly" — not "page the model with
      // an empty payload".
      if (messages.length === 0) {
        logger.info('Skipping model call: assembled context has zero messages (likely post-reset auto-wake with no new user message)', {
          agentId, loopCount,
        }, agentId);
        this.setAgentStatus(agentId, 'idle');
        return;
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
          // If agent was preempted for an urgent wakeup, end this run
          // cleanly — no error, no injury, no retry. The handleMessage
          // finally block will fire the queued wakeup so the urgent
          // message is processed promptly.
          if (preemptedAgents.has(agentId)) {
            preemptedAgents.delete(agentId);
            activeAbortControllers.delete(agentId);
            logger.info('Run ending due to preempt — queued wakeup will fire', {}, agentId);
            this.setAgentStatus(agentId, 'idle');
            return;
          }
          if (!isAutoRouted || attempt >= maxAttempts - 1) throw err;

          // Auto-routed: try the next model in the fallback chain
          excludedModels.push(modelId);
          // Clear the model lock so fallback can use a different model
          lockedModelId = null;
          lockedTier = null;
          // Fallback tier resolution. Order:
          //   1. routerTier (from this iteration's scoring or carried-over lock)
          //   2. lockedTier (defensive — should already be in routerTier)
          //   3. 'standard' last-resort default — better to try SOMETHING than
          //      injure the agent because tier resolution failed
          const fallbackTier = routerTier ?? lockedTier ?? 'standard';
          const fallback = selectModel(fallbackTier, agentId, excludedModels, ['tools']);
          if (!fallback) {
            logger.error('Auto-router: no fallback models available — all models exhausted or ineligible', {
              failedModel: modelId,
              tier: fallbackTier,
              originalTier: routerTier,
              excludedModels,
              attempt,
              maxAttempts,
            }, agentId);
            throw err;
          }

          logger.warn(`Auto-router: model ${modelId} failed, falling back to ${fallback.modelId}`, {
            failedModel: modelId,
            fallbackModel: fallback.modelId,
            tier: routerTier,
            fallbackUsed: fallback.fallbackUsed,
            excludedModels,
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
        // Phase 1: Silent retry — just re-run the model call without injecting
        // any nudge. Many empty responses are transient (streaming hiccup, model
        // hesitation) and resolve on a simple retry.
        if (!retriedEmptyResponse) {
          retriedEmptyResponse = true;
          logger.warn('Model returned empty response, retrying silently', {
            loopCount, stopReason: result.stopReason,
          }, agentId);
          continue;
        }
        // Phase 2: Explicit nudge — inject a system instruction asking the
        // model to respond or call a tool.
        if (!nudgedForEmptyResponse) {
          nudgedForEmptyResponse = true;
          logger.warn('Model returned empty after silent retry, nudging', {
            loopCount, stopReason: result.stopReason,
          }, agentId);
          pendingNudge = '[System: You returned an empty response. Please respond to the user\'s last message or call a tool to continue your task. If you are finished, say so clearly.]';
          continue; // Re-run the loop — nudge will be injected in-memory at context assembly
        }
        // Phase 3: Give up — toast only, no DB changes
        logger.warn('Model returned empty after nudge, breaking', {
          loopCount, stopReason: result.stopReason,
        }, agentId);
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

      // Drain any attachments queued by show_to_user during prior tool
      // calls in this turn. The runtime owns assistant-message persistence,
      // so we attach here rather than letting the tool insert a synthetic
      // message (that broke alternation and caused show_to_user loops).
      const { drainPendingAttachments } = await import('./pending-attachments.js');
      const queuedAttachments = drainPendingAttachments(agentId);
      const queuedAttachmentsJson = queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

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
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, datetime('now'))
        `).run(
          messageId,
          agentId,
          JSON.stringify(assistantContent),
          queuedAttachmentsJson,
          result.outputTokens,
          modelId,
          null,
        );
        broadcastMessage(agentId, {
          id: messageId,
          role: 'assistant',
          content: JSON.stringify(assistantContent),
          modelId,
          attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
        });
      } else if (result.content) {
        // Text-only response, no tool calls
        db.prepare(`
          INSERT OR IGNORE INTO messages (id, agent_id, role, content, attachments, token_count, model_id, cost, latency_ms, created_at)
          VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, NULL, datetime('now'))
        `).run(
          messageId,
          agentId,
          result.content,
          queuedAttachmentsJson,
          result.outputTokens,
          modelId,
          null,
        );
        // Queue embedding for assistant text responses
        queueEmbedding('message', messageId, agentId, result.content);

        // Broadcast a chat:message ONLY when this text-only message has
        // attachments (e.g. show_to_user queued files). The chunk-stream
        // path already delivered the text live; firing chat:message here
        // unconditionally would dupe-render. With attachments, the
        // dashboard's chat:message handler updates the streaming bubble
        // in-place to attach the files — that's the only way they reach
        // the live UI without a page reload.
        if (queuedAttachments.length > 0) {
          broadcastMessage(agentId, {
            id: messageId,
            role: 'assistant',
            content: result.content,
            modelId,
            attachments: queuedAttachments,
          });
        }
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
        // Engine-level inter-agent silence: if this turn was triggered by
        // an inter-agent message AND the agent already explicitly replied
        // via send_to_agent, the trailing text is ALWAYS filler (the agent
        // already communicated through the proper channel). Suppress it
        // from being persisted — it's noise that clutters the chat and
        // feeds acknowledgement loops.
        //
        // This is a STRUCTURAL check, not pattern matching. It doesn't
        // matter what the text says — if the agent already called
        // send_to_agent, any remaining text is by definition not the
        // primary response.
        const isInterAgentTurn = triggerRow?.content?.includes('[SOURCE: AGENT MESSAGE FROM') ||
                                  triggerRow?.content?.includes('[SOURCE: GROUP BROADCAST FROM') ||
                                  triggerRow?.content?.includes('[SOURCE: PM AGENT POKE FROM') ||
                                  triggerRow?.content?.startsWith('[A2A:');
        if (isInterAgentTurn && sentToAgentThisTurn && result.content) {
          logger.debug('Suppressed trailing text on inter-agent turn (agent already replied via send_to_agent)', {
            agentId, textLength: result.content.trim().length,
          }, agentId);
          result.content = null as unknown as string;
          lastAssistantTextForIM = null;
        }

        // Missed-reply detection: agent received an A2A reply-needed intent
        // (QUESTION/ASSIGN/BLOCK) and ended its turn with text but never
        // called send_to_agent. The text landed in their chat where only
        // the user sees it — the actual sender got nothing. Inject a system
        // note and continue the loop so the agent retries through the proper
        // channel. Fire at most once per turn to avoid an infinite nudge loop.
        if (
          triggeredByA2AReplyIntent &&
          !sentToAgentThisTurn &&
          !nudgedForMissedA2AReply &&
          result.content && result.content.trim().length > 0
        ) {
          nudgedForMissedA2AReply = true;
          const { intent, threadShort, fromName } = triggeredByA2AReplyIntent;
          const nudgeText = `[System: You received an [A2A:${intent}] message from ${fromName} on thread ${threadShort} but you wrote your reply as text in your own chat instead of calling send_to_agent. Other agents CANNOT see your chat — only the user can. ${fromName} got nothing. Retry your reply now using send_to_agent with the same thread_id from the message you received. Choose an intent that matches your response (ANSWER if you're answering a QUESTION, COMPLETE/STATUS/FAIL if you finished or are still working, ASSIGN if delegating further). Then end your turn.]`;
          const nudgeId = uuidv4();
          db.prepare(`
            INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
            VALUES (?, ?, 'system', ?, datetime('now'))
          `).run(nudgeId, agentId, nudgeText);
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: nudgeId,
              agentId,
              role: 'system' as const,
              content: nudgeText,
              tokenCount: null,
              modelId: null,
              cost: null,
              latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          logger.warn('Nudged agent — received A2A reply-needed intent but did not call send_to_agent', {
            agentId, intent, threadShort, fromName,
          }, agentId);
          // Don't break — loop again so the agent reads the nudge and retries
          continue;
        }

        // Final response — unlock model for next user message
        lockedModelId = null;
        lockedTier = null;
        // Clean turn end — reset the time-budget continuation counter so
        // the next turn from a fresh user message starts with a full
        // budget. (If the agent had auto-continued mid-task and finally
        // reached a clean stop, that counts as success.)
        turnContinuationCounts.delete(agentId);
        // Also clear the in-loop recovery streak — the agent reached a
        // clean end without further recovery, so any prior recovery
        // attempts are presumed resolved.
        recoveryRunStreak.delete(agentId);
        break;
      }

      // Tool calls present — lock the model for the rest of this turn's tool loop
      if (isAutoRouted && !lockedModelId) {
        lockedModelId = modelId;
        lockedTier = routerTier;
        logger.info('Auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
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
        if (toolCall.name === 'send_to_agent' || toolCall.name === 'broadcast_to_group') {
          sentToAgentThisTurn = true;
        }
        try {
          toolResult = await executeTool(agentId, toolCall);
          // Transfer content blocks from the tool call (set by file_read for images/PDFs)
          const contentBlocks = (toolCall as unknown as Record<string, unknown>).__contentBlocks as Array<{ type: string; [key: string]: unknown }> | undefined;
          if (contentBlocks) {
            (toolResult as { contentBlocks?: unknown }).contentBlocks = contentBlocks;
          }
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

      // Detect consecutive permission denials — agent keeps trying tools it
      // can't use. After 3, nudge. After 5, break the loop — the agent is
      // stuck and burning tokens on tools that will never succeed.
      const allBlocked = toolResults.every(tr => tr.isError && tr.content.includes('[BLOCKED]'));
      if (allBlocked && toolResults.length > 0) {
        consecutivePermissionDenials += toolResults.length;
        if (consecutivePermissionDenials >= 5) {
          logger.warn('Breaking tool loop: agent stuck on permission-denied tools', {
            agentId, denials: consecutivePermissionDenials,
          }, agentId);
          const blockMsg = `[System: You have been blocked ${consecutivePermissionDenials} times in a row. The tools you are trying to use are NOT available to you. STOP trying them. Use a different tool (file_read, send_to_agent) or call complete_task(status="blocked", summary="Need permission for ...") to report you are stuck.]`;
          const blockMsgId = uuidv4();
          db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(blockMsgId, agentId, blockMsg);
          broadcast({ type: 'chat:message', agentId, message: { id: blockMsgId, agentId, role: 'system' as const, content: blockMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
          break;
        } else if (consecutivePermissionDenials >= 3 && !pendingNudge) {
          pendingNudge = `[System: You have been blocked ${consecutivePermissionDenials} times. These tools are not available to you. Try a completely different approach — use file_read to read files, send_to_agent to ask another agent for help, or complete_task if you are stuck.]`;
        }
      } else {
        consecutivePermissionDenials = 0; // Reset on any successful tool call
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
          // Normal path: store as structured tool_result content blocks.
          // If a tool result has contentBlocks (e.g., file_read on an image),
          // use those instead of the plain string — the model sees the image
          // via its vision capabilities.
          const toolResultContent = toolResults.map(tr => {
            const blocks = (tr as { contentBlocks?: Array<{ type: string; [key: string]: unknown }> }).contentBlocks;
            return {
              type: 'tool_result' as const,
              tool_use_id: tr.toolCallId,
              content: blocks
                ? blocks as unknown as Anthropic.ToolResultBlockParam['content']
                : tr.content,
              is_error: tr.isError,
            };
          }) as Anthropic.ToolResultBlockParam[];

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

    // If the agent hit the tool loop limit but was still actively working
    // (not stuck repeating), auto-continue with a fresh turn instead of
    // dead-stopping and requiring user intervention. This lets multi-step
    // projects (coding tasks, research, etc.) proceed uninterrupted.
    if (loopCount >= MAX_TOOL_LOOPS) {
      logger.warn('Agent hit max tool loop limit — auto-continuing', { agentId, maxLoops: MAX_TOOL_LOOPS }, agentId);
      const sysMsg = `[System: This turn reached ${MAX_TOOL_LOOPS} tool calls. Starting a fresh turn to continue your work. Pick up where you left off.]`;
      const sysMsgId = uuidv4();
      db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(sysMsgId, agentId, sysMsg);
      broadcast({ type: 'chat:message', agentId, message: { id: sysMsgId, agentId, role: 'system' as const, content: sysMsg, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });

      // Schedule a self-continuation after a brief pause (lets DB writes
      // settle and gives the context assembler fresh state). This fires
      // via handleMessage which reassembles context from scratch — the
      // agent sees its full history including the work it just did and
      // continues naturally.
      setTimeout(() => {
        this.handleMessage(agentId, '').catch(err => {
          logger.error('Auto-continuation after tool limit failed', {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          }, agentId);
        });
      }, 1000);
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
        let sentViaIMessage = false;
        // Only route via iMessage if THIS run was triggered by an iMessage.
        // Use the snapshot (imFlagSetAtRunStart) — NOT the live flag, which
        // may have been set mid-run by a NEW iMessage that arrived while we
        // were busy. That new iMessage belongs to the wakeup run, not this one.
        if (triggeredByIMessage || imFlagSetAtRunStart) {
          // Direct reply to an incoming iMessage — send full content
          sendResponseViaIMessage(lastAssistantTextForIM, agentId);
          sentViaIMessage = true;
        } else {
          // Not triggered by iMessage — check if user is away for proactive forwarding
          const { getPresence } = await import('../services/presence.js');
          if (getPresence() === 'away') {
            const { maybeForwardToImessage } = await import('../services/presence.js');
            maybeForwardToImessage(agentId, lastAssistantTextForIM);
            sentViaIMessage = true;
          }
        }

        // Inject a visible system message so both the agent (on future turns)
        // and the user (on the dashboard) can see that this response was
        // delivered via iMessage. Without this tag, outgoing iMessages are
        // invisible in context — the agent can't distinguish which of its
        // past responses went to iMessage vs. dashboard, and blends topics
        // from the two channels together.
        if (sentViaIMessage) {
          const { getOwnerName } = await import('../config/platform.js');
          const imTagId = uuidv4();
          const imTagContent = `[SENT VIA IMESSAGE to ${getOwnerName()}]`;
          db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'system', ?, datetime('now'))`).run(imTagId, agentId, imTagContent);
          broadcast({ type: 'chat:message', agentId, message: { id: imTagId, agentId, role: 'system' as const, content: imTagContent, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
        }
      }
    } catch { /* presence/imessage module may not be available */ }
    // Only clear the flag if it was set when this run STARTED — meaning this
    // run consumed it. If the flag was set mid-run (new iMessage arrived while
    // busy), leave it for the wakeup run. If the flag wasn't set at all, this
    // is a no-op.
    if (imFlagSetAtRunStart) {
      clearIMResponseFlag(agentId);
    }

    // ── Auto-route: REMOVED (v1.15.58) ──
    // The old auto-route mechanism delivered trailing text to the original
    // sender when the agent forgot to call send_to_agent. This was the
    // primary cause of acknowledgement loops. The A2A protocol replaces
    // it structurally: terminal intents don't wake the receiver, thread
    // state prevents post-closure messages, and the hop counter provides
    // a hard backstop. Agents that need to reply must call send_to_agent
    // explicitly with the correct intent and thread_id.

    // Stop the heartbeat — the loop has ended, the agent is going idle (or
    // already terminated). handleMessage's finally also calls
    // stopStatusHeartbeat as a safety net for paths that throw.
    stopStatusHeartbeat(agentId);

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
  // its delegate stalled. Injected as role='system' so the primary sees it
  // on its next turn but is not forced to reply.
  //
  // This is now called from injury-recovery's notifyHealerOfInjury AFTER
  // the engine auto-wake + grace period have run, so the primary is only
  // told about agents that genuinely need help — transient rate-limit /
  // network errors that self-resolve never trigger this alert.
  public async notifyPrimaryOfInjury(
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
        `Auto-recovery (engine retry + grace period) already ran and did not unstick them. Options: (a) reset_session(agent_id="${injuredAgentId}") to heal them and let them retry, (b) reassign their work to another agent, or (c) escalate to the user. The Healer agent is also being notified in parallel — if they post a recovery action shortly, you can wait it out before stepping in.`,
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
      // Clear last_error when the agent recovers (transitions to a healthy state).
      // Keep it when transitioning to error/paused so the injury recovery system
      // can read it to diagnose the problem.
      if (status === 'idle' || status === 'working') {
        // Check if the agent WAS injured — if so, notify healer of recovery
        const prevStatus = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
        db.prepare(`
          UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
        `).run(status, agentId);
        if (prevStatus && (prevStatus.status === 'error' || prevStatus.status === 'paused')) {
          import('../healer/injury-recovery.js').then(({ onAgentRecovered }) => {
            onAgentRecovered(agentId);
          }).catch(() => { /* module may not be available */ });
        }
      } else {
        db.prepare(`
          UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
        `).run(status, agentId);
      }

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
