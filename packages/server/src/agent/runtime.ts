// Most of the v1 imports were removed in Phase 9 Stage 2 along with the
// 2055-line runAgentLoop they fed. What stays serves the v2 dispatch shell,
// the helpers re-exported via getAgentRuntime (notifyPrimaryOfInjury,
// stopAgent, preempt, etc.), and shared module-level state.
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/connection.js';
import { postAgentNotice } from './agent-notice.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { prepareImageForModel } from './image-prep.js';
import { rectifyAttachment } from './input-rectification.js';
import { runV2Turn } from './v2/loop.js';

// One-shot dedup so the "model does not support tools" banner only fires once
// per (agent, model) pair for the lifetime of the server process. Without
// this we'd broadcast the same banner on every single turn.
const toolsUnavailableNotified = new Set<string>();

// ── Recoverable provider 4xx classifier ──
//
// Some provider errors aren't "the agent broke", they're "the request was
// wrong for this model". The agent can adapt and retry differently if we
// just tell them what went wrong instead of injuring them and waiting for
// a human to intervene.
//
// Provider 4xx classification used to live here as
// `classifyRecoverableProviderError`. It moved to agent/v2/recovery.ts in
// Phase 6 (and was removed from runtime.ts in Phase 9 Stage 2 along with
// the v1 catch path that called it).

export async function enforceModelCapabilities(
  agentId: string,
  modelId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): Promise<{ useTools: boolean }> {
  const caps = getModelCapabilities(modelId);

  // Unknown capability set → don't gate. We'd rather optimistically try and
  // let the provider error out than lock users out of a working model whose
  // probe failed or simply returned nothing.
  if (caps.length === 0) {
    return { useTools: true };
  }

  // ── Vision gate ──
  // If the assembled messages contain image blocks and the model has no
  // vision capability, two paths are possible:
  //   (a) If the platform has a fallback vision model configured
  //       (Settings → Dojo), route each image through the fallback for a
  //       text description and inline that description in place of the
  //       image. The agent gets to respond intelligently to what the
  //       user actually sent.
  //   (b) Otherwise strip the images (keeping any text) and warn the
  //       agent so the turn can still proceed on the text alone.
  //
  // PDFs (`document` blocks) are NOT stripped here, every provider translator
  // handles them: Anthropic passes them through natively, the openai-compatible
  // and Ollama paths in model.ts extract text via pdf-extract.ts and inline it
  // into the user message. Stripping documents at this layer was overzealous
  // and broke PDF-on-non-vision-model entirely (fixed 2026-05-04).
  if (!caps.includes('vision')) {
    // Resolve fallback vision model up front. We only need one resolution
    // per call; the helper does its own validity check.
    const { getEffectiveVisionModel } = await import('../services/vision-model.js');
    const fallback = getEffectiveVisionModel(agentId);
    // The agent's own model already lacks vision (we wouldn't be in this
    // branch otherwise), so the helper can only return source='fallback'
    // or null, but be defensive.
    const fallbackUsable = !!fallback && fallback.source === 'fallback';

    let imagesStripped = 0;
    let imagesCaptioned = 0;

    // Pull the data URL / base64 out of an Anthropic-shape image block.
    // We support the two common shapes we ourselves emit upstream:
    //   { type: 'image', source: { type: 'base64', media_type, data } }
    //   { type: 'image', source: { type: 'url', url } }
    function extractImageSource(block: Record<string, unknown>): {
      base64?: string; mediaType?: string; url?: string;
    } | null {
      const src = block.source as Record<string, unknown> | undefined;
      if (!src) return null;
      if (src.type === 'base64' && typeof src.data === 'string') {
        return {
          base64: src.data,
          mediaType: typeof src.media_type === 'string' ? src.media_type : 'image/png',
        };
      }
      if (src.type === 'url' && typeof src.url === 'string') {
        return { url: src.url };
      }
      return null;
    }

    // Run one image through the fallback model and get a short text
    // description back. Returns null on any failure, caller treats that
    // as "fall through to strip" so a captioning glitch never blocks the
    // turn entirely.
    async function captionOne(block: Record<string, unknown>): Promise<string | null> {
      if (!fallbackUsable || !fallback) return null;
      const src = extractImageSource(block);
      if (!src) return null;
      try {
        // Mutual recursion: callModel calls enforceModelCapabilities for
        // its own gating, but with the fallback's own modelId, the
        // fallback IS vision-capable so the vision branch won't re-enter.
        // Keep the prompt short and focused, the calling agent will use
        // this text to talk about the image to the user.
        const { callModel } = await import('./model.js');
        const captionMsg = [{
          role: 'user' as const,
          content: [
            (src.base64
              ? {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: (src.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') ?? 'image/png',
                    data: src.base64,
                  },
                }
              : {
                  type: 'image' as const,
                  source: { type: 'url' as const, url: src.url as string },
                }
            ) as Anthropic.ContentBlockParam,
            {
              type: 'text' as const,
              text:
                'Describe this image in detail for an assistant who cannot see it but will use your description to discuss it with the user. ' +
                'Include: what is shown, notable text and signage, layout / composition, mood or context, anything else relevant. ' +
                'Plain text only, no preamble like "This image shows", just the description.',
            },
          ],
        }];
        const result = await callModel({
          agentId,
          modelId: fallback.modelId,
          messages: captionMsg,
          systemPrompt: 'You are an accessibility describer producing concise, useful image descriptions for a downstream agent.',
          tools: false,
        });
        const text = (result.content ?? '').trim();
        return text.length > 0 ? text : null;
      } catch (err) {
        logger.warn('Fallback vision caption failed, falling back to strip for this image', {
          modelId, fallbackModelId: fallback.modelId,
          error: err instanceof Error ? err.message : String(err),
        }, agentId);
        return null;
      }
    }

    // Walk a block array. For each image block, try to caption via the
    // fallback; if that returns null, strip it. Recurses into tool_result
    // content the same way the pre-fallback strip used to. Returns the
    // new block array.
    async function processBlocks(blocks: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
      const kept: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'image') {
          const caption = await captionOne(b);
          if (caption) {
            kept.push({
              type: 'text',
              text: `[Image content (described by fallback vision model "${fallback?.apiModelId}"): ${caption}]`,
            });
            imagesCaptioned++;
          } else {
            imagesStripped++;
          }
          continue;
        }
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          const innerKept = await processBlocks(b.content as Array<Record<string, unknown>>);
          if (innerKept.length === 0) {
            kept.push({
              ...b,
              content: [{
                type: 'text',
                text: fallbackUsable
                  ? '(Image attachment could not be described, fallback vision model returned no useful text)'
                  : '(Image attachment removed, this model does not support vision input)',
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
    }

    // Track the index of the LAST user message that had images touched, so
    // we can inject a system-role nudge right after it. Without the nudge,
    // weak models often hallucinate about prior topics instead of telling
    // the user the image couldn't be processed.
    let lastTouchedUserIdx = -1;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const beforeTouches = imagesStripped + imagesCaptioned;
      const kept = await processBlocks(blocks);
      const changed = (imagesStripped + imagesCaptioned) !== beforeTouches;
      if (!changed) continue;

      // If nothing but text remains, collapse to a plain string so older call
      // paths that prefer strings don't choke. Otherwise preserve the array.
      if (kept.length === 0) {
        messages[i] = { role: 'user', content: '(image attached, see system note)' };
      } else if (kept.every(b => b.type === 'text')) {
        const text = kept.map(b => (b.text as string) ?? '').join('\n');
        messages[i] = { role: 'user', content: text };
      } else {
        messages[i] = { role: 'user', content: kept as unknown as Anthropic.ContentBlockParam[] };
      }
      lastTouchedUserIdx = i;
    }

    if (imagesStripped + imagesCaptioned > 0) {
      if (lastTouchedUserIdx >= 0) {
        let nudge: string;
        if (imagesCaptioned > 0 && imagesStripped === 0) {
          // Pure success: every image was captioned. Tell the agent how
          // to use the captions, the description text is authoritative
          // about what the image shows; don't go beyond it.
          nudge = (
            `[System: Your current model can't see images directly, but the user sent ${imagesCaptioned} image${imagesCaptioned === 1 ? '' : 's'} and the platform's fallback vision model (` +
            `${fallback?.apiModelId}` +
            `) described ${imagesCaptioned === 1 ? 'it' : 'them'} for you above. ` +
            `Respond based on those descriptions. Treat them as the authoritative account of what the image${imagesCaptioned === 1 ? '' : 's'} contain${imagesCaptioned === 1 ? 's' : ''}, do NOT speculate about details outside what was described. ` +
            `If the user asks something the description doesn't cover, say so and offer to ask the fallback for a more specific look (re-uploading helps).]`
          );
        } else if (imagesCaptioned > 0 && imagesStripped > 0) {
          // Mixed: some captioned, some failed.
          nudge = (
            `[System: Your current model can't see images directly. The platform's fallback vision model (${fallback?.apiModelId}) described ${imagesCaptioned} of the user's image${imagesCaptioned === 1 ? '' : 's'} (you can see those descriptions in the messages above), but ${imagesStripped} other image${imagesStripped === 1 ? '' : 's'} could not be captioned (network or model error). ` +
            `Respond based on the descriptions you DO have. For the missing one${imagesStripped === 1 ? '' : 's'}, tell the user you couldn't read ${imagesStripped === 1 ? 'it' : 'them'} and suggest they re-upload.]`
          );
        } else {
          // Pure strip (no fallback configured or every caption failed).
          nudge = (
            `[System: The user just sent ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} but your current model does NOT support vision input. ` +
            `The image${imagesStripped === 1 ? '' : 's'} ${imagesStripped === 1 ? 'was' : 'were'} dropped, you literally cannot see ${imagesStripped === 1 ? 'it' : 'them'}. ` +
            (fallbackUsable
              ? `The platform's fallback vision model is configured but every caption attempt failed (network or provider error). `
              : `The platform also has no fallback vision model configured, once one is set in Settings → Dojo, future uploads will be auto-captioned for you. `) +
            `Reply briefly telling the user you couldn't read the image${imagesStripped === 1 ? '' : 's'} this turn. ` +
            `Do NOT try to describe the image. Do NOT continue any prior topic, respond ONLY about the image${imagesStripped === 1 ? '' : 's'} they just sent.]`
          );
        }
        const sysMsg = { role: 'user' as const, content: nudge };
        messages.splice(lastTouchedUserIdx + 1, 0, sysMsg);
      }

      if (imagesStripped > 0) {
        const userMsg = fallbackUsable
          ? `Couldn't describe ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} via the fallback vision model, check Settings → Dojo and the model's provider status.`
          : `This model can't see images. ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} skipped, pick a fallback vision model in Settings → Dojo or switch this agent to a vision-capable model in Settings → Models.`;
        logger.warn('Vision gate: stripped images from turn', {
          modelId, imagesStripped, imagesCaptioned, fallbackUsable,
        }, agentId);
        broadcast({ type: 'chat:error', agentId, error: userMsg, severity: 'warning', retryable: false });
      } else if (imagesCaptioned > 0) {
        logger.info('Vision gate: captioned images via fallback', {
          modelId, imagesCaptioned, fallbackModelId: fallback?.modelId,
        }, agentId);
      }
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
        `This model can't use tools, the agent will reply with text only. Switch to a tool-capable model in Settings → Models for file access, browser, scheduling, etc.`;
      logger.warn('Tools gate: disabling tools for this turn', { modelId }, agentId);
      broadcast({ type: 'chat:error', agentId, error: userMsg, severity: 'warning', retryable: false });
    }
  }

  return { useTools };
}

// canonicalToolSignature lived here for v1's loop-detector. v2 has its own
// loop classifier in agent/v2/classifiers/loop.ts. Removed in Phase 9 Stage 2.
// broadcastMessage was a v1-internal helper; the runtime no longer broadcasts
// chat:message directly, v2/loop.ts owns that.

const logger = createLogger('runtime');

// Module-level state shared with the v2 runtime, see agent/shared-state.ts
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

import { turnBoundary, forceA2ATurn, a2aTurnRetries, MAX_A2A_TURN_RETRIES, lastTurnWasA2A, drainHead, MAX_DRAIN_STUCK, currentTurnKind } from './turn-state.js';
import { getWaitingHumanConversations, getPendingEngineEvent, getNextEngineEventRetryAt, quarantineWaitingConversation } from './v2/counterparty.js';
import { findUnrepliedAssignForAgent, recordA2AReply } from './a2a-replies.js';

// Recovery-streak Map and cap moved to shared-state.ts (Phase 6 2026-05-04)
// so v2/recovery.ts and v1 catch share the same per-agent streak tracking.
// Imported below alongside the other shared state symbols.

// Heartbeat timers, re-broadcast agent:status='working' every 30s while
// the runAgentLoop is active. Used by v1 and v2 alike. The Map lives in
// shared-state; the start/stop helpers below are exported so v2 can reuse.
const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;

export function startStatusHeartbeat(agentId: string): void {
  // Clear any prior timer for this agent (defensive, shouldn't normally happen)
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: currentTurnKind.get(agentId) ?? 'user' });
      // D18: heartbeat updated_at while the turn runs. updated_at is otherwise
      // written only at turn START, so recoverStuckAgents (which reaps
      // status='working' rows whose updated_at is stale) would flip a legitimately
      // long turn (budget is 15 min x up to 4 continuations) to idle and DELETE
      // its activeRuns entry mid-turn, letting a new inbound start a SECOND
      // concurrent turn on the same agent's context. Keeping updated_at fresh
      // means only a genuinely dead turn goes stale.
      getDb().prepare("UPDATE agents SET updated_at = datetime('now') WHERE id = ? AND status = 'working'").run(agentId);
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

/** Stop a running agent, aborts in-flight API call and halts the loop.
 *
 * Sets a `stopMarkerPending` flag on the agent's `config` JSON so the next
 * context assembly will inject a one-shot stop marker into the user's next
 * turn, telling the model its prior plan is cancelled. The marker is
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
  // calls during finalize will broadcast idle again, that's a harmless dupe.
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
 * Use sparingly, every preempt costs whatever in-flight model work was
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

// FA-A2: explicit stop states. 'terminated' is a hard end; 'paused' (error-loop)
// and 'error' (Tier-D) are "stop and let a human or the Healer look" states. The
// self-triggered re-run paths (the post-turn drain and the queued self-wakeup)
// must NOT auto-resume any of these. A genuinely NEW inbound (handleMessage, which
// only blocks 'terminated') and an explicit dashboard resume/reset still wake the
// agent, and transient recovery still flows through the injury-recovery auto-wake,
// all of which enter via handleMessage rather than these gates.
function isSelfResumeBlockedStatus(status: string | undefined): boolean {
  return status === 'terminated' || status === 'paused' || status === 'error';
}

class AgentRuntime {
  async handleMessage(agentId: string, _content: string): Promise<void> {
    // C20: never run a terminated agent (defense-in-depth for every entry path, the
    // terminated guard previously existed only on the queued-wakeup path, so the boot
    // re-drain / an A2A kick could still run a dead agent, flip it to 'working', and emit
    // a zombie reply). Mirrors the check at the wakeup-processing path below.
    const st = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined;
    if (st?.status === 'terminated') {
      logger.info('Skipping run, agent is terminated', { agentId }, agentId);
      return;
    }
    // If agent is already running, queue a wakeup so we re-run after current loop finishes
    if (activeRuns.has(agentId)) {
      logger.info('Agent busy, queuing wakeup for after current run', { agentId }, agentId);
      pendingWakeups.add(agentId);
      return;
    }

    activeRuns.add(agentId);
    agentStartTimes.set(agentId, Date.now());

    try {
      // v2 is the only runtime. The v1 dispatch + 2055-line runAgentLoop
      // method below were deleted in Phase 9 Stage 2 (2026-05-06). v2 owns
      // its own recovery cascade (agent/v2/recovery.ts), anything that
      // escapes runV2Turn into this catch is a bug in the cascade itself.
      await runV2Turn(agentId);
    } catch (err) {
      // Safety-net only. v2/recovery.ts is the primary error handler and is
      // wrapped in v2/loop.ts's own try/catch, escapes here mean recovery
      // itself failed OR the error fired BEFORE the cascade got control
      // (e.g. preflight throws like NO_MODEL / AGENT_NOT_FOUND).
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = (err as { code?: string } | null | undefined)?.code;
      logger.error('v2 runtime escaped its own recovery cascade', {
        agentId,
        code: errCode,
        error: errMsg.slice(0, 500),
      }, agentId);

      try {
        const db = getDb();
        const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined;
        // Don't clobber 'terminated', an agent that called complete_task and
        // hit a post-completion error should stay terminated.
        if (row?.status && row.status !== 'terminated') {
          db.prepare(
            "UPDATE agents SET status = 'error', last_error = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(`recovery cascade escape: ${errMsg.slice(0, 400)}`, agentId);
        }
      } catch { /* best effort */ }

      // v2.3.19, when the escape is a known preflight error code, use a
      // specific plain-English message instead of the generic fallback.
      // These are the cases where the cascade couldn't even RUN because
      // preflight validation threw first. Each one points the user at
      // the actual fix, config, restart, or Settings.
      let toastError: string;
      let toastCode: 'NO_MODEL' | 'AGENT_NOT_FOUND' | 'MODEL_FAILED';
      if (errCode === 'NO_MODEL' || /no model configured/i.test(errMsg)) {
        toastError = "This agent isn't pointed at a model right now. Open Settings → Agents and pick a model for it. (Sometimes a provider's API-key change can clear the link, re-selecting the model fixes it.)";
        toastCode = 'NO_MODEL';
      } else if (errCode === 'AGENT_NOT_FOUND') {
        toastError = "I couldn't find that agent in the database. It may have been deleted. Refresh the page and check the Agents list.";
        toastCode = 'AGENT_NOT_FOUND';
      } else {
        toastError = 'Agent hit a problem the recovery system could not handle. Send a new message to retry, or check the Vitals page.';
        toastCode = 'MODEL_FAILED';
      }

      try {
        broadcast({
          type: 'chat:error',
          agentId,
          error: toastError,
          code: toastCode,
          severity: 'error',
          retryable: false,
        });
      } catch { /* best effort */ }
    } finally {
      activeRuns.delete(agentId);
      // Safety net for any path that broke out of runAgentLoop without
      // calling stopStatusHeartbeat (e.g., uncaught throw, early return).
      // Idempotent, no-op if the heartbeat was already stopped.
      stopStatusHeartbeat(agentId);

      // ── A2A re-trigger (v3.1.10) ──
      // If a wake-intent A2A is still unreplied after this turn, give it its
      // OWN dedicated turn rather than letting it bleed into the next user
      // reply. This is what makes "strip A2A from user turns" safe: a deferred
      // A2A is reintroduced as an isolated A2A turn, never ignored. Bounded by
      // MAX_A2A_TURN_RETRIES so a model that never produces a clean reply can't
      // spin, after the cap we record a synthetic reply (stops the enforcer)
      // and log it, accepting that the sender gets no answer over an infinite
      // loop or a polluted user turn.
      try {
        const status = (getDb()
          .prepare('SELECT status FROM agents WHERE id = ?')
          .get(agentId) as { status?: string } | undefined)?.status;
        if (status !== 'terminated') {
          const owed = findUnrepliedAssignForAgent(agentId);
          const wasA2ATurn = lastTurnWasA2A.has(agentId);
          lastTurnWasA2A.delete(agentId);
          if (owed) {
            if (wasA2ATurn) {
              // A dedicated A2A turn ran and STILL didn't clear the reply, 
              // a genuinely failed attempt. Count it against the cap.
              const tries = (a2aTurnRetries.get(agentId) ?? 0) + 1;
              if (tries <= MAX_A2A_TURN_RETRIES) {
                a2aTurnRetries.set(agentId, tries);
                forceA2ATurn.add(agentId);
                pendingWakeups.add(agentId);
                logger.info('Retrying dedicated A2A turn for unreplied inbound', {
                  agentId, intent: owed.intent, thread: owed.threadShort, attempt: tries,
                }, agentId);
              } else {
                logger.warn('A2A reply gave up after max dedicated turns, recording synthetic reply', {
                  agentId, intent: owed.intent, thread: owed.threadShort, from: owed.fromName,
                }, agentId);
                recordA2AReply({ assignMessageId: owed.messageId, agentId, threadId: owed.threadShort, replyIntent: 'ABANDONED' });
                // D13: the synthetic ABANDONED silences the missed-reply enforcer on
                // THIS agent, but the asker may hold an owner question parked on this
                // thread. Fail that park CLOSED now, the owner gets a deterministic
                // "could not get an answer" notice on the park's own channel, instead
                // of permanent silence. Fire-and-forget; the TTL sweep is the backstop.
                // (Dynamic import: a2a-transport statically imports this module.)
                import('./a2a-transport.js')
                  .then((m) => m.failParksForAbandonedAsk(owed.messageId, owed.threadShort, agentId))
                  .catch(() => { /* best effort, TTL sweep backstops */ });
                a2aTurnRetries.delete(agentId);
                forceA2ATurn.delete(agentId);
              }
            } else {
              // A user/normal turn deferred the A2A (user took priority, or the
              // A2A just arrived), give it its own turn next. No penalty: it
              // hasn't actually had a turn to fail yet.
              forceA2ATurn.add(agentId);
              pendingWakeups.add(agentId);
              logger.info('Queuing dedicated A2A turn for deferred inbound', {
                agentId, intent: owed.intent, thread: owed.threadShort,
              }, agentId);
            }
          } else {
            // Handled (or none owed), clear bookkeeping.
            a2aTurnRetries.delete(agentId);
            forceA2ATurn.delete(agentId);
          }
        }
      } catch (err) {
        logger.warn('A2A re-trigger check failed', {
          agentId, error: err instanceof Error ? err.message : String(err),
        }, agentId);
      }

      // v2.3.19 (finding #195), clear any stale preempt flag so the
      // next run (the queued wakeup we're about to fire) starts with a
      // clean slate. Pre-spec, when a preempted in-flight model call
      // returned "successfully" with partial content (race: abort
      // landed during the response stream so the SDK returned what it
      // had instead of throwing), the v2 loop took the natural "no tool
      // calls, exit" path and never hit the preempt check at the top
      // of its outer iteration. The flag stayed set across the
      // handleMessage boundary, and the NEXT (queued-wakeup) run exited
      // immediately on entering the loop, stalling the queued user
      // message. Cleared here as a hard guarantee.
      preemptedAgents.delete(agentId);

      // ── Human conversation drain (turn continuity) ──
      // A turn serves ONE counterparty. If other human conversations are still
      // waiting (their messages arrived during a long turn and got no reply yet),
      // queue a wakeup so the agent works through them instead of going idle with
      // messages stranded, the failure the realistic battery exposed, where a
      // big first task ate every wakeup and the other senders were never
      // answered. Bounded by MAX_DRAIN_STUCK: if the head (oldest-waiting)
      // conversation doesn't advance across re-triggers, the agent can't serve it
      // (no terminal reply), so we stop self-spinning and idle until a new inbound.
      try {
        const drainStatus = (getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined)?.status;
        // FA-A2: honor the stop states. Do not self-re-queue a wakeup for a
        // paused/errored agent just because conversations are waiting; those
        // messages are persisted and served on the next real inbound or resume.
        if (!isSelfResumeBlockedStatus(drainStatus)) {
          const waiting = getWaitingHumanConversations(agentId);
          if (waiting.length > 0) {
            const head = waiting[0].oldestWaitingRowid;
            const prev = drainHead.get(agentId);
            const stuck = prev && prev.rowid === head ? prev.stuck + 1 : 0;
            if (stuck < MAX_DRAIN_STUCK) {
              drainHead.set(agentId, { rowid: head, stuck });
              // D2: cap self-re-triggers so a multi-row backlog can't spin into
              // hundreds of full-context turns. A real new inbound still wakes it.
              if (underWakeBudget(agentId)) pendingWakeups.add(agentId);
            } else {
              // D9: the head conversation has failed to advance across
              // MAX_DRAIN_STUCK serves, it's poisoned (bad attachment, per-thread
              // provider 400, oversized context). Before, the drain simply STOPPED
              // here, so that one un-servable conversation starved every OTHER
              // waiting message, and each new inbound re-picked the same poisoned
              // head (FIFO). Now: quarantine it (skip, never drop, swept_at keeps
              // its identity), tell the owner, and serve the NEXT conversation.
              const poisoned = waiting[0];
              const quarantined = quarantineWaitingConversation(agentId, poisoned.key);
              logger.error('drain: quarantined a poisoned conversation after repeated failed serves; serving the next instead', { agentId, convKey: poisoned.key, rowsQuarantined: quarantined, headRowid: head }, agentId);
              try {
                broadcast({ type: 'chat:error', agentId, error: `Couldn't process a message from ${poisoned.key} after several tries, set it aside so your other messages get through.`, code: 'STUCK_REPEATING', severity: 'warning', retryable: false });
              } catch { /* best effort */ }
              drainHead.delete(agentId);
              const remaining = getWaitingHumanConversations(agentId);
              if (remaining.length > 0 && underWakeBudget(agentId)) pendingWakeups.add(agentId);
            }
          } else if (getPendingEngineEvent(agentId)) {
            // E-A2: a human is no longer waiting but an engine event (scheduler/
            // reminder/tracker/healer) is still UNPROCESSED, it was out-raced by a
            // human and would otherwise be silently starved. Give it its own turn.
            // It is stamped served at pickup, so this fires at most once per event
            // (no spin), and only when no human is owed.
            drainHead.delete(agentId);
            if (underWakeBudget(agentId)) pendingWakeups.add(agentId);
          } else {
            drainHead.delete(agentId);
            // D8: nothing is due NOW, but an engine event may be parked on a retry
            // backoff (its delivery aborted and the claim was reverted with
            // next_attempt_at in the future). On an otherwise-idle box nothing
            // would re-fire the drain when the backoff clears, so arm a one-shot
            // timer for the earliest retry. Crash-durable via the boot re-drain,
            // which consults the same eligibility.
            scheduleEngineEventRetryWake(agentId, (id) => {
              this.handleMessage(id, '').catch((err) => {
                logger.error('Engine-event retry wake failed', { agentId: id, error: err instanceof Error ? err.message : String(err) }, id);
              });
            });
          }
        }
      } catch (err) {
        logger.warn('drain re-trigger check failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      }

      // If a message arrived while we were busy, re-trigger the loop.
      // Don't clear turnBoundary yet, clear it AFTER the wakeup starts
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
          // moments around termination, observed in W29VerifyAlpha during
          // the v2 self-test (status flipped terminated → idle).
          const status = (getDb()
            .prepare('SELECT status FROM agents WHERE id = ?')
            .get(agentId) as { status?: string } | undefined)?.status;
          // FA-A2: a wakeup queued before the agent stopped (e.g. a new inbound
          // arrived during a turn that then errored) must not self-resume a
          // paused/errored/terminated agent. The message stays persisted and is
          // served on the next real inbound or an explicit resume.
          if (isSelfResumeBlockedStatus(status)) {
            logger.info('Skipping queued wakeup, agent is in a stop state', { agentId, status }, agentId);
            return;
          }
          logger.info('Processing queued wakeup', { agentId }, agentId);
          // Don't pass empty content, the wakeup will pick up all new
          // messages from the DB via context assembly. The content param
          // is unused by runAgentLoop (it reads from DB).
          this.handleMessage(agentId, '').catch(err => {
            logger.error('Queued wakeup failed', {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        }, 500); // Reduced from 1500ms, 500ms is enough for DB writes
      } else {
        // No wakeup pending, safe to clear turnBoundary immediately
        turnBoundary.delete(agentId);
      }
    }
  }


  // When a sub-agent transitions into 'error' or 'paused' (injured/paused),
  // make the primary agent AWARE that its delegate stalled. Delivered via
  // postAgentNotice (role='user' origin_kind='engine', the awareness lane), so the
  // primary's model actually sees it on its next turn and may act or surface it,
  // but is not forced to reply. (This site formerly dropped a bare role='system'
  // row, which the model-message builder strips, so the alert was invisible to the
  // model; see the comms-audit note on the postAgentNotice call below.)
  //
  // This is now called from injury-recovery's notifyHealerOfInjury AFTER
  // the engine auto-wake + grace period have run, so the primary is only
  // told about agents that genuinely need help, transient rate-limit /
  // network errors that self-resolve never trigger this alert.
  public async notifyPrimaryOfInjury(
    injuredAgentId: string,
    errorMessage: string,
    pausedByLoop: boolean,
  ): Promise<void> {
    const { isPrimaryAgent, getPrimaryAgentId } = await import('../config/platform.js');

    // Don't notify the primary about itself, the user sees the error
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

      // Find any tracker tasks currently assigned to this agent, those are
      // the ones that just stalled.
      interface StalledTaskRow { id: string; title: string; status: string }
      const stalledTasks = db.prepare(`
        SELECT id, title, status FROM tasks
        WHERE assigned_to = ? AND status IN ('in_progress', 'on_deck')
        ORDER BY updated_at DESC
        LIMIT 5
      `).all(injuredAgentId) as StalledTaskRow[];

      const stateLabel = pausedByLoop ? 'paused (hit an error loop)' : 'injured';
      const firstLineOfError = errorMessage.split('\n')[0].slice(0, 80);
      const errorHint = firstLineOfError ? ` ("${firstLineOfError}")` : '';
      const stalledNote = stalledTasks.length > 0
        ? ` ${stalledTasks.length} of its task${stalledTasks.length === 1 ? '' : 's'} stalled.`
        : '';

      // comms-audit rank 6: this used to dump a role='system' multi-item report (state +
      // raw error + a bulleted stalled-task list with IDs + a 3-option recovery paragraph)
      // into the primary's messages + the owner's dashboard chat. Two problems: (1) a
      // firehose the primary does not need verbatim; (2) role='system' is SKIPPED by the
      // model-context builder, so the primary's MODEL never saw the alert and could never
      // take the reset/reassign action it was being told to take, a real correctness bug.
      // Now a brief, self-attributed note in the awareness lane (role='user'
      // origin_kind='engine'), so the primary actually sees it and can act or surface it.
      // The full error + stalled-task list + recovery options live on the Healer's A2A
      // thread (injury-recovery) for deliberate pull.
      postAgentNotice({
        toAgentId: primaryId,
        fromName: 'Healer',
        brief: `${injured.name} got ${stateLabel}${errorHint} and auto-recovery couldn't unstick it.${stalledNote} Want me to reset it or hand its work to another agent? I'm also on it in parallel.`,
        intent: 'agent_health',
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
 * One attachment the engine rectified at injection time (downscaled
 * image, dropped oversized PDF, etc.). Returned to the caller so it can
 * persist a one-shot system note for the user. v2.3.19 (Phase 4): now
 * carries the rectifier's agent-facing `note` directly, older callers
 * formatted from originalSize/finalSize, which only made sense for the
 * image-downscale case.
 */
export interface AttachmentResizeEvent {
  filename: string;
  /** Plain-language note from the rectifier. Persisted as a `[System: …]`
   *  message so the agent can mention what changed to the user. */
  note: string;
  /** Legacy fields, preserved for back-compat with v2.3.18 callers. */
  originalSize?: number;
  finalSize?: number;
}

// A dropped attachment must be visible to the model as a fact, not a silent
// gap: the persisted pointer text says an attachment exists, so an empty hole
// here makes the model hallucinate contents or deny the attachment was sent.
// The skip behavior itself stays (a broken file must never kill the turn);
// this note is what makes the skip honest.
function droppedAttachmentNote(kind: string, filename: string, reason: string): Anthropic.ContentBlockParam {
  return {
    type: 'text',
    text: `[Engine note: the attached ${kind} "${filename}" ${reason}, so it is NOT shown to you. Do not describe or assume its contents. If the user asks about it, say it failed to load and ask them to re-send it.]`,
  };
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
  // the wrapped message). Bug fix 2026-05-04, was matching by
  // strict equality and missing every post-reset / post-stop case.
  // A-4 (comms-audit): fetch the recent 10, then order OLDEST-first. The assembled
  // `messages` are processed oldest-first below, so with a newest-first db list the
  // `.find` for two BYTE-IDENTICAL user messages (same text, DIFFERENT attachments)
  // returned the NEWEST unused row for the OLDEST message, swapping their
  // attachments. Oldest-first here makes identical-content matches resolve in
  // chronological order (oldest message → oldest row), so the right files attach.
  const recentDbMsgs = (db.prepare(`
    SELECT id, content, attachments FROM messages
    WHERE agent_id = ? AND role = 'user' AND attachments IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 10
  `).all(agentId) as Array<{ id: string; content: string; attachments: string }>).reverse();

  if (recentDbMsgs.length === 0) return freshResizes;

  // Track which DB rows we've already injected to avoid duplicating
  // the attachment if the same row matches twice (shouldn't happen
  // with current assembly but cheap defense).
  const usedDbIds = new Set<string>();

  // Determine the index of the earliest message that's still part of THIS
  // turn. A turn boundary is an assistant message that ended cleanly (text
  // only, no tool_use). An assistant message containing tool_use blocks is
  // mid-loop, the conversation continues into a tool_result and another
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
    // PDF" bug). Within the current turn, every user message, including
    // the trigger message that's now followed by an in-turn tool loop, 
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

    // Add image blocks. v2.3.19 (error-handling-spec Phase 4): route
    // through the input-rectification registry. Today the only registered
    // rectifier is the v2.3.18 image-downscale flow (sips → cache →
    // re-encode), but new rectifiers (PDF size, HEIC fallback, etc.)
    // plug in without touching this call site.
    for (const img of imageAttachments) {
      try {
        if (!fs.existsSync(img.path)) {
          blocks.push(droppedAttachmentNote('image', img.filename, 'is missing on disk'));
          continue;
        }
        const result = rectifyAttachment(img);
        if (!result || !result.kept || !result.data || !result.mediaType) {
          blocks.push(droppedAttachmentNote('image', img.filename, 'could not be processed'));
          continue;
        }
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: result.mediaType,
            data: result.data.toString('base64'),
          },
        });
        if (result.freshlyApplied && result.agentNote) {
          // Surface fresh rectifications so the loop can persist a
          // one-shot system note for the user. The rectifier already
          // formatted the message; the loop just wraps + broadcasts.
          freshResizes.push({
            filename: img.filename,
            note: result.agentNote,
          });
        }
      } catch {
        blocks.push(droppedAttachmentNote('image', img.filename, 'could not be read'));
      }
    }

    // Add PDF blocks. Anthropic's `document` type supports an optional
    // `title` field (used by the UI + for model grounding); we also use it
    // downstream by the Ollama translator to label extracted-text sections
    // so the model knows which file a passage belongs to.
    for (const pdf of pdfAttachments) {
      try {
        if (!fs.existsSync(pdf.path)) {
          blocks.push(droppedAttachmentNote('PDF', pdf.filename, 'is missing on disk'));
          continue;
        }
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
        blocks.push(droppedAttachmentNote('PDF', pdf.filename, 'could not be read'));
      }
    }

    messages[i] = { role: 'user', content: blocks };
  }

  return freshResizes;
}

// ── D2: per-agent self-wake budget ──
// The human-conversation drain re-queues a wakeup while ANY conversation is
// "waiting". A turn's assembled context contains (and its reply answers) the
// whole backlog, but the pickup stamp claims only ONE row served (per-message
// claim, OPEN-12), so N trivial waiting rows become N full-context turns ~500ms
// apart. Measured: ~450 calls/hr peaks overnight, $110 in a week on the cheapest
// model. This is a deterministic circuit breaker independent of any single
// counter: at most WAKE_BUDGET_MAX self-re-triggers per WAKE_BUDGET_WINDOW_MS
// per agent, then trip (loud log + agent:status) until the rolling window clears.
// A genuine NEW inbound still wakes the agent via handleMessage, this caps only
// the engine's SELF re-trigger, never real user messages.
const WAKE_BUDGET_WINDOW_MS = 10 * 60 * 1000;
const WAKE_BUDGET_MAX = 30;
const wakeupTimes = new Map<string, number[]>();
const wakeBudgetTripped = new Set<string>();

function underWakeBudget(agentId: string): boolean {
  const now = Date.now();
  const cutoff = now - WAKE_BUDGET_WINDOW_MS;
  const arr = (wakeupTimes.get(agentId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= WAKE_BUDGET_MAX) {
    wakeupTimes.set(agentId, arr);
    if (!wakeBudgetTripped.has(agentId)) {
      wakeBudgetTripped.add(agentId);
      logger.error('Wake budget tripped: too many self-wakeups in the window; pausing the self-drain for this agent until it clears (a new inbound still wakes it)', {
        agentId, wakeupsInWindow: arr.length, windowMinutes: WAKE_BUDGET_WINDOW_MS / 60000,
      }, agentId);
      try { broadcast({ type: 'agent:status', agentId, status: 'idle' }); } catch { /* best effort */ }
      // AUDIT-FIX: on an otherwise-idle box nothing re-fires the drain when the
      // window clears, so a durable backlog would stall until the next inbound or
      // a restart. Schedule a one-shot resume for when the oldest wakeup ages out;
      // re-queue only if work is still owed (no empty wake turns).
      const resumeInMs = Math.max((arr[0] ?? now) + WAKE_BUDGET_WINDOW_MS - now, 5_000);
      const t = setTimeout(() => {
        try {
          if (getWaitingHumanConversations(agentId).length > 0 || getPendingEngineEvent(agentId) !== null) {
            pendingWakeups.add(agentId);
            logger.info('Wake budget window cleared; resuming the self-drain for owed work', { agentId }, agentId);
          }
        } catch { /* best effort */ }
      }, resumeInMs);
      t.unref?.();
    }
    return false;
  }
  arr.push(now);
  wakeupTimes.set(agentId, arr);
  wakeBudgetTripped.delete(agentId);
  return true;
}

// ── D8: engine-event retry timer ──
// A failed engine-event delivery reverts the claim and parks the event on a
// backoff (next_attempt_at, migration 084). The drain only re-triggers when an
// event is due NOW, so on an otherwise-idle agent nothing would fire when the
// backoff clears; this one-shot timer covers that gap. One timer per agent
// (re-armed on every drain pass, newest schedule wins), unref'd so it never
// holds the process open, and every fire re-checks the DB truth: terminated
// agents are skipped, the D2 wake budget is respected (the budget breaker's own
// resume timer re-checks pending engine events, so a budget-blocked retry is
// not lost), and getPendingEngineEvent re-validates eligibility at fire time.
// Timers are in-memory only by design: a crash loses them, and the boot
// re-drain (index.ts 4b2) consults the same eligibility to rescue the event.
const engineRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleEngineEventRetryWake(agentId: string, wake: (agentId: string) => void): void {
  try {
    const existing = engineRetryTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      engineRetryTimers.delete(agentId);
    }
    const at = getNextEngineEventRetryAt(agentId);
    if (at == null) return;
    // +1s grace so next_attempt_at has strictly passed at fire time; floor 5s
    // against clock skew; ceiling just above the max (60m) backoff.
    const delay = Math.min(Math.max(at - Date.now() + 1_000, 5_000), 61 * 60_000);
    const t = setTimeout(() => {
      engineRetryTimers.delete(agentId);
      try {
        const status = (getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined)?.status;
        if (status === 'terminated') return;
        if (getPendingEngineEvent(agentId) === null) return; // delivered/expired meanwhile
        if (!underWakeBudget(agentId)) return; // budget breaker's resume re-checks engine events
        logger.info('Engine-event retry backoff cleared; waking agent to deliver it', { agentId }, agentId);
        wake(agentId);
      } catch { /* best effort */ }
    }, delay);
    t.unref?.();
    engineRetryTimers.set(agentId, t);
  } catch { /* best effort */ }
}

// ── Stuck-Agent Recovery ──
// If the runtime crashes mid-turn after setting status to 'working' but before
// the finally block clears it, the agent stays stuck. This periodic check
// resets agents that have been 'working' for too long (10+ minutes).
const STUCK_AGENT_CHECK_MS = 5 * 60 * 1000; // Check every 5 minutes
// D18: comfortably above the legal turn budget (15 min) x (1 + up to 3
// continuations) plus overshoot, so a long-but-live turn is never reaped. The
// 30s heartbeat keeps updated_at fresh, and the activeRuns guard below is the
// real safety, this threshold only catches a genuinely dead process's rows.
const STUCK_AGENT_THRESHOLD_MINUTES = 75;

function recoverStuckAgents(): void {
  try {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT id, name FROM agents
      WHERE status = 'working'
        AND updated_at < datetime('now', '-${STUCK_AGENT_THRESHOLD_MINUTES} minutes')
    `).all() as Array<{ id: string; name: string }>;

    for (const agent of stuck) {
      // D18: never reap a run THIS process knows is live. activeRuns is the
      // in-memory concurrency guard; deleting it out from under a running turn
      // let a new inbound start a second concurrent turn on the same context.
      // A row can be stale in the DB (>75 min) yet still be an active run here
      // only if the heartbeat also stalled, which means the turn really is wedged
      // in THIS process, so skip it and let the process-level watchdog handle it.
      if (activeRuns.has(agent.id)) {
        logger.warn('Stuck-agent check: row is stale but run is live in-process, not reaping', { agentId: agent.id, agentName: agent.name });
        continue;
      }
      db.prepare("UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?").run(agent.id);
      activeRuns.delete(agent.id);
      pendingWakeups.delete(agent.id);
      broadcast({ type: 'agent:status', agentId: agent.id, status: 'idle' });
      logger.warn('Recovered stuck agent from permanent working state', { agentId: agent.id, agentName: agent.name });
    }
  } catch (err) {
    logger.error('recoverStuckAgents failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // RC-15 follow-up (owner ruled 2026-07-16): piggyback the Dreamer health
  // sweep on this same recovery tick so a mid-day dream-cycle stall (stuck
  // 'working' corpse or a dropped batch continuation) recovers within minutes
  // instead of waiting for the nightly window. The sweep is idempotent and
  // guards against live batches itself; dynamic import keeps this module free
  // of a static vault dependency.
  void import('../vault/maintenance.js')
    .then(m => m.sweepDreamerHealth())
    .catch(err => {
      logger.warn('Dreamer health sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });
}

// ── Orphaned model_id repair (v2.3.19) ──
//
// If an agent's model_id points at a row that no longer exists in the
// models table (e.g. because the user re-created the provider, or
// because some upstream code path nuked the model row), the agent will
// throw "Agent has no model configured" on the very next message, and
// that error fires BEFORE the v2 recovery cascade can do anything,
// landing in the safety-net catch.
//
// Best fix: detect orphans on startup AND every 5 minutes, repair by
// setting them to 'auto' so the auto-router picks a working model at
// runtime. Logged loudly so the user can see what was repaired.
function repairOrphanedModelPointers(): void {
  try {
    const db = getDb();
    const orphans = db.prepare(`
      SELECT a.id, a.name, a.model_id FROM agents a
      LEFT JOIN models m ON m.id = a.model_id
      WHERE a.model_id IS NOT NULL
        AND a.model_id != 'auto'
        AND a.status != 'terminated'
        AND m.id IS NULL
    `).all() as Array<{ id: string; name: string; model_id: string }>;

    for (const agent of orphans) {
      db.prepare(`
        UPDATE agents SET model_id = 'auto', updated_at = datetime('now') WHERE id = ?
      `).run(agent.id);
      logger.warn('Repaired orphaned model_id pointer, set to auto-router', {
        agentId: agent.id,
        agentName: agent.name,
        deadModelId: agent.model_id,
      });
      // Broadcast a chat:error so the user knows what happened in plain
      // English. severity:warning so it surfaces in the dashboard but
      // doesn't iMessage them.
      try {
        broadcast({
          type: 'chat:error',
          agentId: agent.id,
          error: `${agent.name} was pointed at a model that no longer exists. I switched them to auto-routing so they keep working, pick a specific model in Settings if you want one.`,
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: false,
        });
      } catch { /* best effort */ }
    }
  } catch (err) {
    logger.error('repairOrphanedModelPointers failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Start the stuck-agent recovery check + the orphaned model_id repair (v2.3.19,
// catches a provider re-create nuking a model row and leaving agents on a dead
// UUID). Both run on the same cadence.
setInterval(recoverStuckAgents, STUCK_AGENT_CHECK_MS);
setInterval(repairOrphanedModelPointers, STUCK_AGENT_CHECK_MS);

// Also run once immediately on startup to clean up after a crash, but ONLY once
// the schema exists. This module is imported during boot BEFORE main() runs the
// migrations that CREATE the agents table, so on a FRESH install these sweeps
// would log a spurious "no such table: agents" error. A fresh install has no
// agents to recover, so skipping the immediate pass there is correct; every
// established box has the table and runs the real sweep. The intervals above
// then cover both cases on their normal cadence.
try {
  const agentsTablePresent = getDb()
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .get();
  if (agentsTablePresent) {
    recoverStuckAgents();
    repairOrphanedModelPointers();
  }
} catch { /* best effort: the intervals still run once the schema is ready */ }

// Singleton
let runtimeInstance: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime();
  }
  return runtimeInstance;
}

export { AgentRuntime };
