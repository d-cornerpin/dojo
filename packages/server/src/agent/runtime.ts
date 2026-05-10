// Most of the v1 imports were removed in Phase 9 Stage 2 along with the
// 2055-line runAgentLoop they fed. What stays serves the v2 dispatch shell,
// the helpers re-exported via getAgentRuntime (notifyPrimaryOfInjury,
// stopAgent, preempt, etc.), and shared module-level state.
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { prepareImageForModel } from './image-prep.js';
import { runV2Turn } from './v2/loop.js';

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
// Provider 4xx classification used to live here as
// `classifyRecoverableProviderError`. It moved to agent/v2/recovery.ts in
// Phase 6 (and was removed from runtime.ts in Phase 9 Stage 2 along with
// the v1 catch path that called it).

export function enforceModelCapabilities(
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
  // If the assembled messages contain image blocks and the model has no
  // vision capability, strip the images (keeping any text) and warn the user
  // via a banner so the turn can still proceed on the text alone.
  //
  // PDFs (`document` blocks) are NOT stripped here — every provider translator
  // handles them: Anthropic passes them through natively, the openai-compatible
  // and Ollama paths in model.ts extract text via pdf-extract.ts and inline it
  // into the user message. Stripping documents at this layer was overzealous
  // and broke PDF-on-non-vision-model entirely (fixed 2026-05-04).
  if (!caps.includes('vision')) {
    let imagesStripped = 0;

    // Helper that strips images from a top-level block array AND
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
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          // Recurse into the tool_result's content array.
          const innerKept = stripBlocks(b.content as Array<Record<string, unknown>>);
          // If the tool_result ends up with NO content after stripping
          // (was image-only), replace with a text note. The model
          // needs to know there was a result, just not what it contained.
          if (innerKept.length === 0) {
            kept.push({
              ...b,
              content: [{
                type: 'text',
                text: '(Image attachment removed — this model does not support vision input)',
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

    // Track the index of the LAST user message that had images stripped, so
    // we can inject a system-role nudge right after it. Without the nudge,
    // weak models often hallucinate about prior topics instead of telling
    // the user the image couldn't be processed.
    let lastStrippedUserIdx = -1;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const beforeImg = imagesStripped;
      const kept = stripBlocks(blocks);
      const changed = imagesStripped !== beforeImg;
      if (!changed) continue;

      // If nothing but text remains, collapse to a plain string so older call
      // paths that prefer strings don't choke. Otherwise preserve the array.
      if (kept.length === 0) {
        // User sent ONLY an image. Use a minimal marker so the model knows
        // the user attempted to send something but no caption text exists.
        // The injected system note below carries the actionable instruction.
        messages[i] = { role: 'user', content: '(image attached — see system note)' };
      } else if (kept.every(b => b.type === 'text')) {
        const text = kept.map(b => (b.text as string) ?? '').join('\n');
        messages[i] = { role: 'user', content: text };
      } else {
        messages[i] = { role: 'user', content: kept as unknown as Anthropic.ContentBlockParam[] };
      }
      lastStrippedUserIdx = i;
    }

    if (imagesStripped > 0) {
      // Inject a system-role nudge right after the user message that lost
      // its image(s). Forces the model to respond to THIS specific event
      // (couldn't see the image) instead of hallucinating about prior
      // conversation topics. Transient — only in this turn's messages
      // array, not persisted to the DB.
      if (lastStrippedUserIdx >= 0) {
        const nudge = (
          `[System: The user just sent ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} but your current model does NOT support vision input. ` +
          `The image${imagesStripped === 1 ? '' : 's'} ${imagesStripped === 1 ? 'was' : 'were'} dropped — you literally cannot see ${imagesStripped === 1 ? 'it' : 'them'}. ` +
          `Reply briefly telling the user you can't see images on this model and they need to switch to a vision-capable model in Settings → Models. ` +
          `Do NOT try to describe the image. Do NOT continue any prior topic — respond ONLY about the image${imagesStripped === 1 ? '' : 's'} they just sent.]`
        );
        const sysMsg = { role: 'user' as const, content: nudge };
        messages.splice(lastStrippedUserIdx + 1, 0, sysMsg);
      }

      const userMsg =
        `This model can't see images. ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} skipped — switch to a vision-capable model in Settings → Models to use image input.`;
      logger.warn('Vision gate: stripped images from turn', {
        modelId, imagesStripped,
      }, agentId);
      broadcast({ type: 'chat:error', agentId, error: userMsg, severity: 'warning', retryable: false });
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
      const userMsg =
        `This model can't use tools — the agent will reply with text only. Switch to a tool-capable model in Settings → Models for file access, browser, scheduling, etc.`;
      logger.warn('Tools gate: disabling tools for this turn', { modelId }, agentId);
      broadcast({ type: 'chat:error', agentId, error: userMsg, severity: 'warning', retryable: false });
    }
  }

  return { useTools };
}

// canonicalToolSignature lived here for v1's loop-detector. v2 has its own
// loop classifier in agent/v2/classifiers/loop.ts. Removed in Phase 9 Stage 2.
// broadcastMessage was a v1-internal helper; the runtime no longer broadcasts
// chat:message directly — v2/loop.ts owns that.

const logger = createLogger('runtime');

// Module-level state shared with the v2 runtime — see agent/shared-state.ts
// for the canonical definitions. Even though runtime.ts no longer runs the
// inner loop, it still owns the run lifecycle (stop flags, abort handles,
// wakeup queue, status heartbeats) used by spawner / iMessage bridge / etc.
import {
  activeRuns,
  pendingWakeups,
  stoppedAgents,
  activeAbortControllers,
  preemptedAgents,
  agentStartTimes,
  statusHeartbeats,
} from './shared-state.js';

import { turnBoundary } from './turn-state.js';

// Recovery-streak Map and cap moved to shared-state.ts (Phase 6 2026-05-04)
// so v2/recovery.ts and v1 catch share the same per-agent streak tracking.
// Imported below alongside the other shared state symbols.

// Heartbeat timers — re-broadcast agent:status='working' every 30s while
// the runAgentLoop is active. Used by v1 and v2 alike. The Map lives in
// shared-state; the start/stop helpers below are exported so v2 can reuse.
const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;

export function startStatusHeartbeat(agentId: string): void {
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

export function stopStatusHeartbeat(agentId: string): void {
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
  // Abort any in-flight API call. With the abortSignal threaded through
  // model.ts, this actually cancels the underlying fetch (vs. v1's pre-fix
  // behavior where the call kept running until natural completion).
  const controller = activeAbortControllers.get(agentId);
  if (controller) {
    controller.abort();
    activeAbortControllers.delete(agentId);
  }

  // ── Cosmetic safety net (added 2026-05-04) ──
  // Stop the heartbeat IMMEDIATELY so the dashboard doesn't keep getting
  // periodic 'working' broadcasts while the runtime loop unwinds. Without
  // this, the dashboard would briefly go idle (from the optimistic stop
  // click), then bounce back to 'working' on the next 30s heartbeat tick,
  // confusing the user. Also broadcast agent:status='idle' so any reconnected
  // dashboard sees the stop right away. The runtime loop's own setAgentStatus
  // calls during finalize will broadcast idle again — that's a harmless dupe.
  stopStatusHeartbeat(agentId);
  try {
    const db = getDb();
    db.prepare(`UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?`).run(agentId);
    broadcast({ type: 'agent:status', agentId, status: 'idle' });
  } catch { /* best effort */ }

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

// MAX_TOOL_LOOPS, TURN_TIME_BUDGET_MS, MAX_TURN_AUTO_CONTINUATIONS were
// v1-only constants. v2's loop has its own equivalent constants. Removed
// in Phase 9 Stage 2.

class AgentRuntime {
  async handleMessage(agentId: string, _content: string): Promise<void> {
    // If agent is already running, queue a wakeup so we re-run after current loop finishes
    if (activeRuns.has(agentId)) {
      logger.info('Agent busy — queuing wakeup for after current run', { agentId }, agentId);
      pendingWakeups.add(agentId);
      return;
    }

    activeRuns.add(agentId);
    agentStartTimes.set(agentId, Date.now());

    try {
      // v2 is the only runtime. The v1 dispatch + 2055-line runAgentLoop
      // method below were deleted in Phase 9 Stage 2 (2026-05-06). v2 owns
      // its own recovery cascade (agent/v2/recovery.ts) — anything that
      // escapes runV2Turn into this catch is a bug in the cascade itself.
      await runV2Turn(agentId);
    } catch (err) {
      // Safety-net only. v2/recovery.ts is the primary error handler and is
      // wrapped in v2/loop.ts's own try/catch — escapes here mean recovery
      // itself failed (rare but possible). Without these defensive writes
      // the agent would stay 'working' in the DB forever and the dashboard
      // would show no error banner. Best-effort: status, last_error, toast.
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('v2 runtime escaped its own recovery cascade — bug', {
        agentId,
        error: errMsg.slice(0, 500),
      }, agentId);

      try {
        const db = getDb();
        const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined;
        // Don't clobber 'terminated' — an agent that called complete_task and
        // hit a post-completion error should stay terminated.
        if (row?.status && row.status !== 'terminated') {
          db.prepare(
            "UPDATE agents SET status = 'error', last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(`recovery cascade escape: ${errMsg.slice(0, 400)}`, agentId);
        }
      } catch { /* best effort */ }

      try {
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent hit a problem the recovery system could not handle. Send a new message to retry, or check the Health page.',
          code: 'MODEL_FAILED',
          severity: 'error',
          retryable: false,
        });
      } catch { /* best effort */ }
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
          // Skip the wakeup if the agent has been terminated since the
          // wakeup was queued. Without this guard, an agent that called
          // complete_task could be resurrected by a wakeup queued in the
          // moments around termination — observed in W29VerifyAlpha during
          // the v2 self-test (status flipped terminated → idle).
          const status = (getDb()
            .prepare('SELECT status FROM agents WHERE id = ?')
            .get(agentId) as { status?: string } | undefined)?.status;
          if (status === 'terminated') {
            logger.info('Skipping queued wakeup — agent is terminated', { agentId }, agentId);
            return;
          }
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


  getAgentUptime(agentId: string): number {
    const startTime = agentStartTimes.get(agentId);
    if (!startTime) return 0;
    return Math.floor((Date.now() - startTime) / 1000);
  }
}

/**
 * One image that the engine downscaled at injection time to fit a model's
 * per-image base64 cap (Anthropic 5MB). Returned to the caller so it can
 * persist a one-shot system note for the user — only fires on the first
 * compression pass; later turns hit the on-disk cache and stay silent.
 */
export interface AttachmentResizeEvent {
  filename: string;
  originalSize: number;
  finalSize: number;
}

// Transform messages with image/PDF attachments into content block arrays for the model
export function injectAttachmentBlocks(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): AttachmentResizeEvent[] {
  const db = getDb();
  const freshResizes: AttachmentResizeEvent[] = [];

  // Pre-fetch recent user messages with attachments. We can't reliably
  // match by exact content because the assembler prepends framing
  // ([New Session] notice, stop-marker, etc.) AFTER the user message
  // is persisted but BEFORE this function runs. Instead, we look up
  // the recent attachment-bearing rows and match the assembled
  // message by content suffix (the original DB content is the END of
  // the wrapped message). Bug fix 2026-05-04 — was matching by
  // strict equality and missing every post-reset / post-stop case.
  const recentDbMsgs = db.prepare(`
    SELECT id, content, attachments FROM messages
    WHERE agent_id = ? AND role = 'user' AND attachments IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 10
  `).all(agentId) as Array<{ id: string; content: string; attachments: string }>;

  if (recentDbMsgs.length === 0) return freshResizes;

  // Track which DB rows we've already injected to avoid duplicating
  // the attachment if the same row matches twice (shouldn't happen
  // with current assembly but cheap defense).
  const usedDbIds = new Set<string>();

  // Determine the index of the earliest message that's still part of THIS
  // turn. A turn boundary is an assistant message that ended cleanly (text
  // only, no tool_use). An assistant message containing tool_use blocks is
  // mid-loop — the conversation continues into a tool_result and another
  // model call, so anything before it is still in-turn.
  //
  // Scoping by turn (rather than the prior 2026-05-05 heuristic of "any
  // assistant after = stale") fixes v2.3.16: an iMessage user sending an
  // image where the agent calls a tool on iter 1 lost the image on iter 2,
  // because injectAttachmentBlocks treated iter 1's text+tool_use assistant
  // message as a turn boundary. The model on iter 2 then hallucinated "no
  // image came through" and that text leaked back via iMessage.
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content;
    const hasToolUse = Array.isArray(content)
      && content.some((b) => (b as { type?: string }).type === 'tool_use');
    if (!hasToolUse) {
      // Plain assistant text → previous turn ended here. Anything after
      // index i belongs to the current turn.
      turnStartIndex = i + 1;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

    // Only inject attachments for user messages in the current turn. Older
    // user messages already shaped a prior model reply; re-injecting their
    // images/PDFs floods context (the v2.3.5-era "Kimi keeps seeing the
    // PDF" bug). Within the current turn, every user message — including
    // the trigger message that's now followed by an in-turn tool loop —
    // keeps its attachments visible to the model.
    if (i < turnStartIndex) continue;

    // Find a DB row whose content is the suffix of (or equal to) the
    // assembled message content. Prefer exact-equality matches first,
    // then fall back to suffix.
    const exact = recentDbMsgs.find(
      (r) => !usedDbIds.has(r.id) && r.content === msg.content,
    );
    const dbMsg =
      exact ??
      recentDbMsgs.find(
        (r) =>
          !usedDbIds.has(r.id) &&
          r.content.length > 0 &&
          (msg.content as string).endsWith(r.content),
      );

    if (!dbMsg) continue;
    usedDbIds.add(dbMsg.id);

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

    // Add image blocks. v2.3.18: route through prepareImageForModel so any
    // image whose base64 would blow Anthropic's 5MB-per-image cap gets
    // downscaled with sips. Resized variant is cached on disk (next to
    // original) so the work fires once per upload, not per turn.
    for (const img of imageAttachments) {
      try {
        if (!fs.existsSync(img.path)) continue;
        const prepared = prepareImageForModel(img.path, img.mimeType);
        if (!prepared) continue;
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: prepared.mediaType,
            data: prepared.data.toString('base64'),
          },
        });
        if (prepared.freshlyResized) {
          freshResizes.push({
            filename: img.filename,
            originalSize: prepared.originalSize,
            finalSize: prepared.finalSize,
          });
        }
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

  return freshResizes;
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
