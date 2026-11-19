// The v2 dispatch shell, helpers re-exported via getAgentRuntime, and run lifecycle state shared with v2.
import { orphanedModelRepairText } from './engine-lines.js';
import { tellAgentWhatDojoSent } from './dojo-voice.js';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentStatus } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { getPrimaryAgentId, isPrimaryAgent } from '../config/platform.js';
import { postAgentNotice } from './agent-notice.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getModelCapabilities } from '../services/capabilities.js';
import { cancelAgentGenerationJobs } from '../services/generation-jobs.js';
import { notifyUserStop } from './stop-waiters.js';
import { insertMessageIfAbsent, sweepByRowid } from '../memory/message-store.js';
import { tagMessageLane } from '../memory/message-lane-tag.js';
import { rectifyAttachment } from './input-rectification.js';
import { runV2Turn } from './v2/loop.js';
import { writeAgentStatus } from './agent-status.js';
import { STUCK_AGENT_THRESHOLD_MINUTES } from './stuck-thresholds.js';
import { handBackOrphansOf } from '../work/orphaned-claims.js';
import { transition, joinPieces, isTerminal } from '../work/store.js';
import { withUnit, afterCommit } from '../db/unit.js';
import { suppressQueuedReplies } from './v2/deliveries.js';
import { setAgentModel } from './model-switch.js';

// Dedup: the "model does not support tools" banner fires once per (agent, model) pair per process.
const toolsUnavailableNotified = new Set<string>();

// Recoverable provider 4xx classification lives in agent/v2/recovery.ts: telling beats injuring.

export async function enforceModelCapabilities(
  agentId: string,
  modelId: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
): Promise<{ useTools: boolean }> {
  const caps = getModelCapabilities(modelId);

  // Unknown capability set must not gate: better a provider error than locking out a working model.
  if (caps.length === 0) {
    return { useTools: true };
  }

  // No vision: describe each image via the configured fallback model; with none, strip and keep text.
  // PDF document blocks are NOT stripped here: every provider translator extracts or passes through.
  if (!caps.includes('vision')) {
    // Resolve the fallback vision model once per call; the helper checks validity itself.
    const { getEffectiveVisionModel } = await import('../services/vision-model.js');
    const fallback = getEffectiveVisionModel(agentId);
    // The agent's model lacks vision in this branch, so only 'fallback' or null returns; be defensive.
    const fallbackUsable = !!fallback && fallback.source === 'fallback';

    let imagesStripped = 0;
    let imagesCaptioned = 0;
    // imagesRecalled counts STORE-resolved images: they force the rewrite, never the toast or nudge.
    let imagesRecalled = 0;
    const { imageFingerprint, lookupVisionCaption, recordVisionCaption, UNCAPTIONED_IMAGE_STUB } =
      await import('../services/vision-captions.js');

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

    // One image through the fallback for a short description; null means fall through to strip.
    async function captionOne(block: Record<string, unknown>): Promise<string | null> {
      if (!fallbackUsable || !fallback) return null;
      const src = extractImageSource(block);
      if (!src) return null;
      try {
        // Mutual recursion is safe: callModel re-enters with the fallback's own (vision-capable) modelId.
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
                `Describe this image in detail for an assistant who cannot see it but will use your description to discuss it with ${userWords(currentAddress(agentId))}. ` +
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

    async function processBlocks(blocks: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
      const kept: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'image') {
          // Store first: a stored verdict is REPLAYED, never re-litigated; first sighting is 'this turn'.
          const fp = imageFingerprint(b);
          const prior = fp ? lookupVisionCaption(fp) : null;
          if (prior) {
            kept.push(prior.outcome === 'captioned' && prior.caption
              ? {
                  type: 'text',
                  text: `[Image content (described by fallback vision model "${prior.modelId ?? fallback?.apiModelId}"): ${prior.caption}]`,
                }
              : { type: 'text', text: UNCAPTIONED_IMAGE_STUB });
            imagesRecalled++;
            continue;
          }
          const caption = await captionOne(b);
          if (caption) {
            if (fp) recordVisionCaption(fp, 'captioned', caption, fallback?.apiModelId ?? null);
            kept.push({
              type: 'text',
              text: `[Image content (described by fallback vision model "${fallback?.apiModelId}"): ${caption}]`,
            });
            imagesCaptioned++;
          } else {
            // Never strip silently: the model would invent limits; leave the honest stub in its place.
            if (fp) recordVisionCaption(fp, 'failed', null, fallback?.apiModelId ?? null);
            kept.push({ type: 'text', text: UNCAPTIONED_IMAGE_STUB });
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

    // Track the LAST user message with touched images: the nudge goes after it; weak models else invent.
    let lastTouchedUserIdx = -1;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;

      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const beforeTouches = imagesStripped + imagesCaptioned;
      const beforeAny = beforeTouches + imagesRecalled;
      const kept = await processBlocks(blocks);
      // The array is rewritten whenever ANY image resolved; the nudge index moves only for a fresh one.
      const changed = (imagesStripped + imagesCaptioned + imagesRecalled) !== beforeAny;
      const fresh = (imagesStripped + imagesCaptioned) !== beforeTouches;
      if (!changed) continue;

      // All-text result collapses to a plain string: older call paths choke on arrays.
      if (kept.length === 0) {
        messages[i] = { role: 'user', content: '(image attached, see system note)' };
      } else if (kept.every(b => b.type === 'text')) {
        const text = kept.map(b => (b.text as string) ?? '').join('\n');
        messages[i] = { role: 'user', content: text };
      } else {
        messages[i] = { role: 'user', content: kept as unknown as Anthropic.ContentBlockParam[] };
      }
      if (fresh) lastTouchedUserIdx = i;
    }

    if (imagesStripped + imagesCaptioned > 0) {
      if (lastTouchedUserIdx >= 0) {
        let nudge: string;
        if (imagesCaptioned > 0 && imagesStripped === 0) {
          // Pure success: captions are the authoritative account; tell the agent not to go beyond them.
          nudge = (
            `[System: Your current model can't see images directly, but ${userWords(currentAddress(agentId))} sent ${imagesCaptioned} image${imagesCaptioned === 1 ? '' : 's'} and the platform's fallback vision model (` +
            `${fallback?.apiModelId}` +
            `) described ${imagesCaptioned === 1 ? 'it' : 'them'} for you above. ` +
            `Respond based on those descriptions. Treat them as the authoritative account of what the image${imagesCaptioned === 1 ? '' : 's'} contain${imagesCaptioned === 1 ? 's' : ''}, do NOT speculate about details outside what was described. ` +
            `If ${userWords(currentAddress(agentId))} asks something the description doesn't cover, say so and offer to ask the fallback for a more specific look (re-uploading helps).]`
          );
        } else if (imagesCaptioned > 0 && imagesStripped > 0) {
          nudge = (
            `[System: Your current model can't see images directly. The platform's fallback vision model (${fallback?.apiModelId}) described ${imagesCaptioned} of ${userWords(currentAddress(agentId))}'s image${imagesCaptioned === 1 ? '' : 's'} (you can see those descriptions in the messages above), but ${imagesStripped} other image${imagesStripped === 1 ? '' : 's'} could not be captioned (network or model error). ` +
            `Respond based on the descriptions you DO have. For the missing one${imagesStripped === 1 ? '' : 's'}, tell ${userWords(currentAddress(agentId))} you couldn't read ${imagesStripped === 1 ? 'it' : 'them'} and suggest they re-upload.]`
          );
        } else {
          nudge = (
            `[System: ${userWords(currentAddress(agentId), true)} just sent ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} but your current model does NOT support vision input. ` +
            `The image${imagesStripped === 1 ? '' : 's'} ${imagesStripped === 1 ? 'was' : 'were'} dropped, you literally cannot see ${imagesStripped === 1 ? 'it' : 'them'}. ` +
            (fallbackUsable
              ? `The platform's fallback vision model is configured but every caption attempt failed (network or provider error). `
              : `The platform also has no fallback vision model configured, once one is set in Settings → Models → Fallback Vision Model, future uploads will be auto-captioned for you. `) +
            `Reply briefly telling ${userWords(currentAddress(agentId))} you couldn't read the image${imagesStripped === 1 ? '' : 's'} this turn. ` +
            `Do NOT try to describe the image. Do NOT continue any prior topic, respond ONLY about the image${imagesStripped === 1 ? '' : 's'} they just sent.]`
          );
        }
        // Raw positional splice, not pushEngineMessage (that channel only appends). The lane tag is a symbol
        // JSON.stringify drops, so no prompt bytes carry it, and the stored row is stripped.
        const sysMsg = tagMessageLane({ role: 'user' as const, content: nudge }, 'engine.vision-gate');
        messages.splice(lastTouchedUserIdx + 1, 0, sysMsg);
        try { insertMessageIfAbsent({ id: uuidv4(), agentId, role: 'system', content: nudge, turnNumber: null }); } catch { /* best effort */ }
      }

      if (imagesStripped > 0) {
        const userMsg = fallbackUsable
          ? `Couldn't describe ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} via the fallback vision model, check Settings → Models → Fallback Vision Model and the model's provider status.`
          : `This model can't see images. ${imagesStripped} image${imagesStripped === 1 ? '' : 's'} skipped, pick a fallback vision model in Settings → Models → Fallback Vision Model or switch this agent to a vision-capable model in Settings → Models.`;
        logger.warn('Vision gate: stripped images from turn', {
          modelId, imagesStripped, imagesCaptioned, fallbackUsable,
        }, agentId);
        broadcast({ type: 'chat:error', cardClass: 'informational', agentId, error: userMsg, severity: 'warning', retryable: false });
      } else if (imagesCaptioned > 0) {
        logger.info('Vision gate: captioned images via fallback', {
          modelId, imagesCaptioned, fallbackModelId: fallback?.modelId,
        }, agentId);
      }
    }
  }

  // Tools gate: no tools capability, so skip the definitions: wasted tokens or a provider 400.
  let useTools = true;
  if (!caps.includes('tools')) {
    useTools = false;
    const dedupKey = `${agentId}:${modelId}`;
    if (!toolsUnavailableNotified.has(dedupKey)) {
      toolsUnavailableNotified.add(dedupKey);
      const userMsg =
        `This model can't use tools, the agent will reply with text only. Switch to a tool-capable model in Settings → Models for file access, browser, scheduling, etc.`;
      logger.warn('Tools gate: disabling tools for this turn', { modelId }, agentId);
      broadcast({ type: 'chat:error', cardClass: 'informational', agentId, error: userMsg, severity: 'warning', retryable: false });
    }
  }

  return { useTools };
}

const logger = createLogger('runtime');

// Shared with v2; canonical defs live in agent/shared-state.ts; runtime still owns the run lifecycle.
import {
  activeRuns,
  pendingWakeups,
  stoppedAgents,
  preemptedAgents,
  agentStartTimes,
  statusHeartbeats,
  // Run-scoped stop fence + the registry's ONLY THREE doors; raised by stopAgent, retired by its finally.
  stopFencedRuns,
  isStopFenced,
  // The unwind stamp: written by the run-exit finally below and by nothing else.
  lastRunEndedAt,
  abortInFlight,
  // The count preempt checks first: a background media job is not something a barge-in may tear down.
  countAbortable,
  // The ONE self-wake door: refuses while the user's stop is live, so a stopped run cannot self-restart.
  queueSelfWake,
  // Per-agent preempt cool-down: the voice barge-in path's only governor.
  lastA2APreemptAt,
  A2A_PREEMPT_MIN_INTERVAL_MS,
  // Turn-scoped marker: patience is decided per turn, never by a stale agents.last_error read.
  declaredPatienceHonestFailTurn,
  noteArrivalWhileBusy,
} from './shared-state.js';
import { currentTurnNumber, markTurnsTerminated } from './v2/turn-record.js';

import { turnBoundary } from './turn-state.js';
import { replacePlaceholdersInBackground } from '../memory/out-of-view.js';
import { armOwedClock, stoppedRequestsOf, type StoppedRequests } from './v2/owed.js';
import { runIsLive } from './ended-mid-run.js';
import { announceLiveWork } from './live-work.js';
import { noteOwnerStop } from '../migration/import-agents.js';
import { serveLater } from './v2/serve-later.js';
import { A2A_THREAD_SHORT_LENGTH } from '@dojo/shared';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';
import { attachmentFenceOf, bracketed, droppedAttachmentNote } from '../tools/inbound-fences.js';
import { userWords, currentAddress } from './v2/turn-address.js';
import { workingExpr, setHold } from '../work/done/hold.js';


export function stopStatusHeartbeat(agentId: string): void {
  const timer = statusHeartbeats.get(agentId);
  if (timer) {
    clearInterval(timer);
    statusHeartbeats.delete(agentId);
  }
}

// Stop a running agent: abort in-flight calls, halt the loop, and set stopMarkerPending so the
// next assembly injects a one-shot marker: in memory only, never persisted; the flag lives in the DB.
export function stopAgent(agentId: string): void {
  stoppedAgents.add(agentId);
  // RAISE THE FENCE: stoppedAgents can be lifted by outside doors; only this run's exit lowers the fence.
  const runInFlight = activeRuns.has(agentId);
  if (runInFlight) stopFencedRuns.set(agentId, Date.now());
  // Clear any queued wakeup so the agent doesn't immediately restart after stopping
  pendingWakeups.delete(agentId);
  // Abort EVERY in-flight call: model.ts's one dial door (openAgentCall) covers compaction, brief, media.
  // scope:'all' is said in ONLY TWO places; the engine narrows to 'turn' so a barge-in spares a render.
  const cut = abortInFlight(agentId, 'user-stop', { scope: 'all' });
  notifyUserStop(agentId); // and every WAIT on a tool call ends now (stop-waiters.ts)

  // Run-once media jobs need explicit cancel: the registry can't reach them; video keeps its own cancel.
  try {
    cancelAgentGenerationJobs(agentId);
  } catch (err) {
    // A bookkeeping table must never stop a stop.
    logger.warn('stop: cancelling open generation jobs failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // THE STATUS DOES NOT LIE: idle only when nothing is in flight; stopping: true is broadcast-only,
  // the CHECK stays unwidened; the unwinding run keeps 'working' plus heartbeat, safe from the reaper.
  try {
    const status = (getDb().prepare('SELECT status FROM agents WHERE id = ?')
      .get(agentId) as { status?: string } | undefined)?.status ?? 'working';
    if (runInFlight) {
      broadcast({ type: 'agent:status', agentId, status: status as AgentStatus, stopping: true });
    } else {
      stopStatusHeartbeat(agentId);
      // Only a working agent goes idle; a paused or errored one keeps its status.
      if (status === 'working') { writeAgentStatus(agentId, 'idle'); broadcast({ type: 'agent:status', agentId, status: 'idle' }); }
    }
  } catch { /* best effort */ }

  // The assembler reads it next turn; the delivering turn clears it (see clearConsumedOneShotFlags).
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

  logger.info('Agent stop requested', { runInFlight, callsAborted: cut }, agentId);
}

/** The owner's Stop ends the request being served (`stoppedRequestsOf`) in one transaction: its unsent replies, its
 *  pieces, the request, its job tasks (no due; held unless a schedule); then the agent stops, whatever that did, and
 *  the run is settled. Nothing running and nothing to end: nothing is done. What the Stop button does, for every door;
 *  import and terminate call `stopAgent`. */
export function stopByOwner(agentId: string): { ended: number; repliesNotSent: number; nothingRunning?: true } {
  let s: StoppedRequests = { liveRun: false, asks: [], runTasks: [], requests: [], jobs: [] };
  try { s = stoppedRequestsOf(agentId); } catch (err) { logger.error('stop: the request being served could not be read', { error: String(err) }, agentId); }
  if (s.asks.length + s.runTasks.length + s.requests.length + s.jobs.length === 0 && !runIsLive(agentId)) return { ended: 0, repliesNotSent: 0, nothingRunning: true };
  try {
    return withUnit(() => {
      const dropped = suppressQueuedReplies(agentId, s.liveRun ? s.asks : undefined);
      let ended = s.requests.length + s.runTasks.length;
      for (const id of new Set([...s.asks, ...dropped.askIds])) {
        for (const p of joinPieces(id)) if (!isTerminal(p.state)) transition(p.childId, { to: 'abandoned', by: 'owner', reason: 'the owner stopped the request this piece was for' });
        const r = transition(id, { to: 'abandoned', by: 'owner', reason: 'called off by the owner: he pressed Stop' });
        if (r.kind === 'applied') ended++; else logger.debug('stop: a request was not called off', { workId: id, outcome: r.kind }, agentId);
      }
      for (const r of s.requests) sweepByRowid({ rowid: r.rowid, agentId });
      for (const t of s.jobs) {
        serveLater({ kind: 'task', id: t }, null, 'owner stop');
        if (getDb().prepare('SELECT 1 FROM work WHERE id = ? AND schedule_status IS NULL').get(t)) setHold(t, 'paused', 'stopped by you', 'owner');
      }
      afterCommit(() => void Promise.all([import('../scheduler/runner.js'), import('./a2a-transport.js')]).then(async ([runner, transport]) => {
        for (const t of s.runTasks) await runner.onTaskRunComplete(t, 'skipped', 'stopped by the owner');
        for (const r of s.requests) await transport.failJoinPieceForAbandonedAsk(r.messageId, r.threadId.slice(0, A2A_THREAD_SHORT_LENGTH), agentId, 'the owner stopped this work');
      }).catch((err: unknown) => logger.warn('stop: its run or the asker was not settled', { error: String(err) }, agentId)));
      return { ended, repliesNotSent: dropped.repliesNotSent };
    });
  } catch (err) {
    logger.error('stop: the request could not be ended; the agent is stopped anyway', { error: err instanceof Error ? err.message : String(err) }, agentId);
    return { ended: 0, repliesNotSent: 0 };
  } finally {
    stopAgent(agentId);
    noteOwnerStop(agentId);   // a failed import in flight must not lift the owner's own stop
    announceLiveWork(agentId);   // the frame that takes the stop control away, not waited for
  }
}

// Clear one-shot markers (stopAgent, a2a-transport); the DELIVERING turn clears, never the assembler,
// assembly is an outside-turn read; the two clears are ONE transaction, so neither edit is lost.
export function clearConsumedOneShotFlags(
  agentId: string,
  consumed?: { a2aPreemptPending?: boolean; stopMarkerPending?: boolean },
): void {
  if (!consumed || (!consumed.a2aPreemptPending && !consumed.stopMarkerPending)) return;
  try {
    const db = getDb();
    db.transaction(() => {
      const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(agentId) as { config: string } | undefined;
      if (!row?.config) return;
      const config = JSON.parse(row.config) as Record<string, unknown>;
      let changed = false;
      if (consumed.a2aPreemptPending && config.a2aPreemptPending !== undefined) {
        delete config.a2aPreemptPending;
        changed = true;
      }
      if (consumed.stopMarkerPending && config.stopMarkerPending === true) {
        config.stopMarkerPending = false;
        changed = true;
      }
      if (changed) {
        db.prepare("UPDATE agents SET config = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(config), agentId);
      }
    })();
  } catch (err) {
    logger.warn('Failed to clear consumed one-shot markers', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// Preempt the current turn so a queued urgent wakeup fires now: abort, mark preempted (catch reads
// a clean end, finally fires the wake). Urgent only; every preempt costs in-flight work. The first
// cool-down fire is immediate (voice barge-in), later ones coalesce onto the unwinding call.
export function preemptAgentForUrgentMessage(agentId: string): boolean {
  const now = Date.now();
  const lastPreemptAt = lastA2APreemptAt.get(agentId);
  if (lastPreemptAt !== undefined && now - lastPreemptAt < A2A_PREEMPT_MIN_INTERVAL_MS) {
    logger.info('Preempt coalesced: within this agent\'s cool-down window, not re-aborting', {
      agentId, sinceLastPreemptMs: now - lastPreemptAt,
    }, agentId);
    return false;
  }
  // The registry holds a SET per agent: size it from TURN-scoped entries only, and the abort matches.
  // Counting a poller returns true on a lie: it burns the cool-down, coalesces the next barge-in,
  // and leaves preemptedAgents armed to read a later unrelated failure as a silent preempt.
  if (countAbortable(agentId, 'turn') === 0) return false;
  lastA2APreemptAt.set(agentId, now);
  preemptedAgents.add(agentId);
  abortInFlight(agentId, 'urgent-preempt', { scope: 'turn' });
  logger.info('Agent run preempted for urgent wakeup', {}, agentId);
  return true;
}

// Self re-runs must NOT resume 'terminated'/'paused'/'error'; inbound, dashboard resume and injury-wake may.
function isSelfResumeBlockedStatus(status: string | undefined): boolean {
  return status === 'terminated' || status === 'paused' || status === 'error';
}

// Declines only when the marker names the agent's latest turn (recordInjury is the only writer, so any
// other turn number is stale); acting on the marker consumes it.
function turnJustEndedOnDeclaredPatience(agentId: string): boolean {
  const markedTurn = declaredPatienceHonestFailTurn.get(agentId);
  if (markedTurn === undefined) return false;
  if (markedTurn !== currentTurnNumber(agentId)) return false;
  declaredPatienceHonestFailTurn.delete(agentId);
  return true;
}

// What handleMessage did (ran/queued/none): a queued call returns before its turn, so judges must know.
export type RunOutcome = 'ran' | 'queued' | 'not-run';

// Waiters resolve at the end of the run that STARTS next after asking; 'not-run' if terminated first.
const queuedRunWaiters = new Map<string, Array<(o: RunOutcome) => void>>();

// Queued turn dead (terminated/stopped): waiters get 'not-run' now, so no promise stays pending.
function declineQueuedWaiters(agentId: string): void {
  for (const w of queuedRunWaiters.get(agentId) ?? []) w('not-run');
  queuedRunWaiters.delete(agentId);
}

class AgentRuntime {
  // Resolves when the queued turn has run, with its outcome: judges only a turn that actually happened.
  whenQueuedRunEnds(agentId: string): Promise<RunOutcome> {
    return new Promise<RunOutcome>((resolve) => {
      const list = queuedRunWaiters.get(agentId) ?? [];
      list.push(resolve);
      queuedRunWaiters.set(agentId, list);
    });
  }

  async handleMessage(agentId: string, _content: string): Promise<RunOutcome> {
    // Never run a terminated agent: boot re-drain or an A2A kick could otherwise emit a zombie reply.
    const st = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined;
    if (st?.status === 'terminated') {
      logger.info('Skipping run, agent is terminated', { agentId }, agentId);
      declineQueuedWaiters(agentId);
      return 'not-run';
    }
    if (st?.status === 'paused') await (await import('./v2/honest-stop-notes.js')).noteWaitingOfParked(agentId);   // a message to a parked agent is answered on arrival
    // Busy: the ONE direct add. A user stop must not eat an inbound; self-wakes use queueSelfWake only.
    if (activeRuns.has(agentId)) {
      logger.info('Agent busy, queuing wakeup for after current run', { agentId }, agentId);
      pendingWakeups.add(agentId);
      noteArrivalWhileBusy(agentId);   // a command waiting on "your messages come first" is told
      return 'queued';
    }

    activeRuns.add(agentId);
    // A stop pressed while nothing ran raised no fence, so it is stale now; a fenced stop still holds this run.
    if (!stopFencedRuns.has(agentId)) stoppedAgents.delete(agentId);
    const servedWaiters = queuedRunWaiters.get(agentId) ?? [];
    queuedRunWaiters.delete(agentId);
    agentStartTimes.set(agentId, Date.now());

    try {
      // v2 is the only runtime; it owns its recovery cascade, so escaping here is a cascade bug.
      await runV2Turn(agentId);
    } catch (err) {
      // Safety net: recovery.ts is primary (wrapped in v2/loop.ts), so an escape means recovery failed.
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
        // Don't clobber 'terminated': an agent that hit a post-completion error stays terminated.
        if (row?.status && row.status !== 'terminated') {
          // The policy stays HERE, the writer owns the statement: same columns, same 400-char slice.
          writeAgentStatus(agentId, 'error', { lastError: `recovery cascade escape: ${errMsg.slice(0, 400)}` });
        }
      } catch { /* best effort */ }

      // Known preflight codes point at the actual fix: preflight threw before the cascade could run.
      let toastError: string;
      let toastCode: 'NO_MODEL' | 'AGENT_NOT_FOUND' | 'MODEL_FAILED';
      if (errCode === 'NO_MODEL' || /no model configured/i.test(errMsg)) {
        toastError = "This agent isn't pointed at a model right now. Open the Agents page, choose this agent and pick a model for it. (Sometimes a provider's API-key change can clear the link, re-selecting the model fixes it.)";
        toastCode = 'NO_MODEL';
      } else if (errCode === 'AGENT_NOT_FOUND') {
        toastError = "That agent couldn't be found in the database. It may have been deleted. Refresh the page and check the Agents list.";
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
          // Only a model the user must pick is sticky and red; other codes are not theirs to act on.
          severity: toastCode === 'NO_MODEL' ? 'error' : 'warning',
          cardClass: toastCode === 'NO_MODEL' ? 'action' : 'informational',
          retryable: false,
        });
      } catch { /* best effort */ }
    } finally {
      activeRuns.delete(agentId);
      // STAMP it: this finally releases activeRuns, then awaits a long tail; isRunUnwinding reads it.
      lastRunEndedAt.set(agentId, Date.now());
      replacePlaceholdersInBackground(agentId);   // the background folder yielded to this turn; it resumes now
      // Safety net: any throwing or early-return path still stops the heartbeat; the stop is idempotent.
      stopStatusHeartbeat(agentId);

      // A delegated answer that arrived mid-turn goes out now: this finally is where every exit lands.
      try { await (await import('./a2a-transport.js')).releaseDeferredJoinRelays(agentId); } catch (err) {
        logger.warn('deferred join relay not released; the join reaper and boot re-drain still find it', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
      }

      // Clear a stale preempt flag: a mid-stream abort can skip the loop's own check, and a left-over
      // flag would end the next queued run on entry and stall its message.
      preemptedAgents.delete(agentId);

      // Compile-pending joins: close the loop whatever the model did with the compile steer.
      try {
        const { resolveCompilePendingJoins } = await import('./a2a-transport.js');
        const drive = await resolveCompilePendingJoins(agentId);
        // The compile order is only a rider, never a turn's own reason, so without a wakeup it is never seen:
        // queue one (the storm law and a ladder of three bound it).
        if (drive.wakeWanted) {
          queueSelfWake(agentId, 'compile-drive');
          logger.info('compile drive: queued a wakeup so the re-driven agent actually sees the owed step', {
            agentId, drives: drive.drives,
          }, agentId);
        }
      } catch { /* best effort; the TTL sweep backstops */ }

      if (pendingWakeups.has(agentId)) {
        pendingWakeups.delete(agentId);
        // Clear turnBoundary BEFORE the wakeup so the new run sees all messages
        turnBoundary.delete(agentId);
        // Use a short delay to let any in-flight DB writes finish
        setTimeout(() => {
          // Consult WHY the prior turn ended before the status read: re-driving a declared-patience
          // exhaustion is a cold redial; the injury path already told the human, so this only declines.
          // Requeue via queueSelfWake, never a raw add: this file holds exactly one direct add, so a
          // live stop is honoured. Turn-scoped test: an unscoped read declines an unrelated turn's retry.
          if (turnJustEndedOnDeclaredPatience(agentId)) {
            queueSelfWake(agentId, 'declared-patience-decline-requeue');
            logger.info('Queued wakeup declined: the prior turn ended on a declared-patience exhaustion, not auto-redialing the identical request', { agentId }, agentId);
            return;
          }
          // A stop landing while this timer is armed is still a stop: it fires 500 ms later, finds
          // pendingWakeups already consumed, nothing left for stopAgent to clear. Same gate as
          // queueSelfWake; a NEW message arrives via handleMessage's own door, ungated.
          if (isStopFenced(agentId)) {
            logger.info('Queued wakeup declined: the user stopped this agent', { agentId }, agentId);
            declineQueuedWaiters(agentId);
            return;
          }
          // Skip a wake queued before termination: complete_task then a stale wake would revive it.
          const status = (getDb()
            .prepare('SELECT status FROM agents WHERE id = ?')
            .get(agentId) as { status?: string } | undefined)?.status;
          // Never self-resume a blocked status: the message stays persisted for the next inbound or resume.
          if (isSelfResumeBlockedStatus(status)) {
            logger.info('Skipping queued wakeup, agent is in a stop state', { agentId, status }, agentId);
            declineQueuedWaiters(agentId);
            return;
          }
          logger.info('Processing queued wakeup', { agentId }, agentId);
          // Empty content: the wake picks up new messages via context assembly; the param is unused.
          this.handleMessage(agentId, '').catch(err => {
            logger.error('Queued wakeup failed', {
              agentId,
              error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        }, 500); // 500ms is enough for in-flight DB writes to land
      } else {
        turnBoundary.delete(agentId);
      }

      // THE ONE OWNER OF THE STOP FLAG'S CLEAR: a checkpoint that sees the stop honours it (pre-call
      // gate, model-call catch, executor); only this finally retires it, at the end of the run it stopped.
      // A new run's start lifts a FLAG that has no fence (a stop pressed while nothing ran); nothing lifts
      // the FENCE elsewhere.
      stoppedAgents.delete(agentId);
      stopFencedRuns.delete(agentId);
      // The one clock decides when this agent runs next for anything still owed, and sends due replies.
      armOwedClock();
    }
    for (const w of servedWaiters) w('ran');
    return 'ran';
  }


  // When a sub-agent enters 'error'/'paused', make the primary AWARE via postAgentNotice, the
  // awareness lane (role='user'): a role='system' row is stripped by the model-message builder,
  // so it could not reach the model at all. The model may act or surface it, never forced to reply.
  // Called only after the auto-wake grace period: errors that self-resolve never alert the primary.
  public async notifyPrimaryOfInjury(
    injuredAgentId: string,
    errorMessage: string,
    pausedByLoop: boolean,
  ): Promise<void> {
    // The user sees the primary's own error banner; never notify the primary about itself.
    if (isPrimaryAgent(injuredAgentId)) return;

    const primaryId = getPrimaryAgentId();
    if (!primaryId || primaryId === injuredAgentId) return;

    try {
      const db = getDb();
      const injured = db.prepare('SELECT name, classification FROM agents WHERE id = ?').get(injuredAgentId) as
        | { name: string; classification: string }
        | undefined;
      if (!injured) return;

      interface StalledTaskRow { id: string; title: string; status: string }
      const stalledTasks = db.prepare(`
        SELECT w.id AS id, w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w', true)}
        ORDER BY w.updated_at DESC
        LIMIT 5
      `).all(injuredAgentId) as StalledTaskRow[];

      const stateLabel = pausedByLoop ? 'paused (hit an error loop)' : 'injured';
      const firstLineOfError = errorMessage.split('\n')[0].slice(0, 80);
      const errorHint = firstLineOfError ? ` ("${firstLineOfError}")` : '';
      const stalledNote = stalledTasks.length > 0
        ? ` ${stalledTasks.length} of its task${stalledTasks.length === 1 ? '' : 's'} stalled.`
        : '';

      // Brief, self-attributed, never the firehose: full error, task list and options stay on the Healer.
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

// One attachment the engine rectified at injection time (downscaled image, dropped oversized PDF).
// Returned so the caller persists a one-shot note; it carries the rectifier's own `note` verbatim.
export interface AttachmentResizeEvent {
  filename: string;
  /** Plain-language note from the rectifier, persisted as a `[System: …]` message for the agent. */
  note: string;
  /** Back-compat only: notes are formatted from `note`, not from these sizes. */
  originalSize?: number;
  finalSize?: number;
}

export function injectAttachmentBlocks(
  messages: Array<{ role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }>,
  agentId: string,
): AttachmentResizeEvent[] {
  const db = getDb();
  const freshResizes: AttachmentResizeEvent[] = [];

  // Exact-content matching is unreliable: framing is prepended after the row is stored, so match by
  // content SUFFIX (the DB content is the END of the wrapped message), which also covers rows from
  // before resets and stops. Fetch recent 10, reverse: processing is oldest-first, so two
  // byte-identical texts with DIFFERENT attachments pair oldest-message to oldest-row: no file swap.
  const recentDbMsgs = (db.prepare(`
    SELECT id, content, attachments, inbound_meta FROM messages
    WHERE agent_id = ? AND role = 'user' AND attachments IS NOT NULL
    ORDER BY created_at DESC, rowid DESC LIMIT 10
  `).all(agentId) as Array<{ id: string; content: string; attachments: string; inbound_meta: string | null }>).reverse();

  if (recentDbMsgs.length === 0) return freshResizes;

  // Rows already injected: a cheap defense against the same row's files attaching twice.
  const usedDbIds = new Set<string>();

  // Index of the earliest message still in THIS turn: a clean text-only assistant ends a turn;
  // an assistant holding tool_use is mid-loop (a tool_result and another model call follow), so
  // anything before it is in-turn. Scoping by "next assistant" instead is the bug: it reads a
  // mid-loop assistant as a boundary and drops the image, so the model answers that none came.
  let turnStartIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content;
    const hasToolUse = Array.isArray(content)
      && content.some((b) => (b as { type?: string }).type === 'tool_use');
    if (!hasToolUse) {
      // Plain assistant text: the prior turn ended here; anything after index i is the current turn.
      turnStartIndex = i + 1;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;

    // Only this turn's user messages get attachments: older ones shaped a prior reply, re-injecting
    // floods context. Within the turn every message keeps its files, the trigger message included.
    if (i < turnStartIndex) continue;

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
    const fence = attachmentFenceOf(dbMsg.inbound_meta, dbMsg.id);   // a contact's file is fenced (tools/inbound-fences.ts)

    const blocks: Anthropic.ContentBlockParam[] = [];

    if (msg.content) {
      blocks.push({ type: 'text', text: msg.content });
    }

    // Image blocks go through the rectification registry: a new rectifier plugs in without a call-site edit.
    for (const img of imageAttachments) {
      try {
        if (!fs.existsSync(img.path)) {
          blocks.push(droppedAttachmentNote(fence, 'image', img.filename, 'is missing on disk'));
          continue;
        }
        const result = rectifyAttachment(img);
        if (!result || !result.kept || !result.data || !result.mediaType) {
          blocks.push(droppedAttachmentNote(fence, 'image', img.filename, 'could not be processed'));
          continue;
        }
        blocks.push(...bracketed(fence, {
          type: 'image',
          source: {
            type: 'base64',
            media_type: result.mediaType,
            data: result.data.toString('base64'),
          },
        }));
        if (result.freshlyApplied && result.agentNote) {
          // Surface fresh rectifications so the caller persists a one-shot note for the user;
          // the rectifier formatted the message, the caller only wraps and broadcasts it.
          freshResizes.push({
            filename: img.filename,
            note: result.agentNote,
          });
        }
      } catch {
        blocks.push(droppedAttachmentNote(fence, 'image', img.filename, 'could not be read'));
      }
    }

    // PDF blocks; `title` labels extracted-text sections so the model knows which file a passage is from.
    for (const pdf of pdfAttachments) {
      try {
        if (!fs.existsSync(pdf.path)) {
          blocks.push(droppedAttachmentNote(fence, 'PDF', pdf.filename, 'is missing on disk'));
          continue;
        }
        const data = fs.readFileSync(pdf.path).toString('base64');
        blocks.push(...bracketed(fence, {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data,
          },
          title: pdf.filename,
        } as Anthropic.ContentBlockParam));
      } catch {
        blocks.push(droppedAttachmentNote(fence, 'PDF', pdf.filename, 'could not be read'));
      }
    }

    messages[i] = { role: 'user', content: blocks };
  }

  return freshResizes;
}

// Stuck-agent recovery: resets 'working' rows past the threshold (agent/stuck-thresholds.ts owns it).
const STUCK_AGENT_CHECK_MS = 5 * 60 * 1000;

function recoverStuckAgents(): string[] {
  const reaped: string[] = [];
  try {
    const db = getDb();
    const stuck = db.prepare(`
      SELECT id, name FROM agents
      WHERE status = 'working'
        AND updated_at < datetime('now', '-${STUCK_AGENT_THRESHOLD_MINUTES} minutes')
    `).all() as Array<{ id: string; name: string }>;

    for (const agent of stuck) {
      // Never reap a run live in THIS process: activeRuns is the concurrency guard; deleting it
      // starts a second concurrent turn. A stalled heartbeat means wedged in-process: that watchdog's.
      if (activeRuns.has(agent.id)) {
        logger.warn('Stuck-agent check: row is stale but run is live in-process, not reaping', { agentId: agent.id, agentName: agent.name });
        continue;
      }
      writeAgentStatus(agent.id, 'idle');
      activeRuns.delete(agent.id);
      pendingWakeups.delete(agent.id);
      broadcast({ type: 'agent:status', agentId: agent.id, status: 'idle' });
      // The turn this verdict abandons is CLOSED as `terminated`, by `turn-record.ts` (the module owning
      // `turns`). The stale-row case only; a crash restarted inside the hour is agent-status.ts's boot sweep.
      const closedTurns = markTurnsTerminated(agent.id);
      reaped.push(agent.id);
      logger.warn('Recovered stuck agent from permanent working state', {
        agentId: agent.id, agentName: agent.name, turnsClosedAsTerminated: closedTurns,
      });
    }

    // THE STOPPED-THEN-WEDGED RUN. A stopped run keeps its `working` row and heartbeat alive so a
    // long unwind is not mistaken for a dead turn; the cost: a teardown that genuinely WEDGES is
    // invisible to the stale query and to the activeRuns guard, so nothing else can reap it. Reap
    // the narrowest case: an EXPLICITLY stopped run past this reaper's own threshold. A stop means
    // wind down in seconds; hours later nothing is left to protect. Ordinary turns keep the guard.
    // Residual: a merely-catatonic run that resumes can overlap a new turn, bounded because its
    // in-flight calls abort before the entry releases (nothing live to finish) and `finally` is idempotent.
    const fenceThresholdMs = STUCK_AGENT_THRESHOLD_MINUTES * 60_000;
    for (const [agentId, stoppedAt] of stopFencedRuns) {
      const fencedForMs = Date.now() - stoppedAt;
      if (fencedForMs < fenceThresholdMs) continue;
      // `'all'` at two sites only; this is the second and last: the user's own stop should have cut this.
      abortInFlight(agentId, 'stuck-stopped-run-reap', { scope: 'all' });
      stopStatusHeartbeat(agentId);
      stopFencedRuns.delete(agentId);
      stoppedAgents.delete(agentId);
      activeRuns.delete(agentId);
      pendingWakeups.delete(agentId);
      const status = (db.prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status?: string } | undefined)?.status;
      if (status === 'working') {
        writeAgentStatus(agentId, 'idle');
        broadcast({ type: 'agent:status', agentId, status: 'idle' });
      }
      logger.error('Recovered a STOPPED agent whose run never tore down', {
        agentId, fencedForMinutes: Math.round(fencedForMs / 60_000), statusWas: status,
      }, agentId);
    }
  } catch (err) {
    logger.error('recoverStuckAgents failed', { error: err instanceof Error ? err.message : String(err) });
  }

  // Piggyback the Dreamer sweep on this tick: a mid-day stall recovers in minutes, not nightly.
  // The sweep is idempotent, guards live batches, and the dynamic import keeps vault off this module.
  void import('../vault/maintenance.js')
    .then(m => m.sweepDreamerHealth())
    .catch(err => {
      logger.warn('Dreamer health sweep failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });
  return reaped;
}

// Orphaned model_id: its row is gone from the models table, so the next message throws before
// any recovery cascade can act. Detected on startup and every 5 min; repaired to 'auto'.
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
      // The one model writer: the row, the role's setting, the change note, and another look at a parked turn.
      void setAgentModel(agent.id, 'auto').catch((err: unknown) => logger.warn('A repaired agent\'s model change did not finish', {
        agentId: agent.id, error: err instanceof Error ? err.message : String(err),
      }));
      logger.warn('Repaired orphaned model_id pointer, set to auto-router', {
        agentId: agent.id,
        agentName: agent.name,
        deadModelId: agent.model_id,
      });
      // chat:error card, severity warning: visible in the dashboard, never iMessages the owner.
      try {
        broadcast({
          type: 'chat:error', cardClass: 'informational',
          agentId: agent.id,
          // The Dojo speaks, never "I"; the agent is told what went out and why.
          error: orphanedModelRepairText(agent.name),
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: false,
        });
        tellAgentWhatDojoSent({ agentId: agent.id, recipient: 'the owner (a dashboard card)', text: orphanedModelRepairText(agent.name), why: 'because your model no longer existed and the Dojo switched you to auto-routing' });
      } catch { /* best effort */ }
    }
  } catch (err) {
    logger.error('repairOrphanedModelPointers failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// BOTH SWEEPS UNREF'D: a ref'd module-scope handle holds the importing process's event loop
// open forever; production never notices (the listening socket holds it) but a test worker
// importing this stalls the suite; pinned by __tests__/the-runtime-arms-no-refd-timer-at-import.test.ts.
const stuckAgentSweep = setInterval(() => handBackOrphansOf(recoverStuckAgents(), (id) => getAgentRuntime().handleMessage(id, '')), STUCK_AGENT_CHECK_MS);
stuckAgentSweep.unref?.();
const orphanedModelSweep = setInterval(repairOrphanedModelPointers, STUCK_AGENT_CHECK_MS);
orphanedModelSweep.unref?.();

// Runs once at startup after the port bind and migrations (main() calls it there).
// Never module-scope: it would run before the bind and flip a serving box's live agents to idle.
export function runStartupRecoverySweep(): void {
  recoverStuckAgents();
  repairOrphanedModelPointers();
  // A held-call card for the main agent has no consumer (its calls are never held): close it, never re-wake it.
  getDb().prepare(`UPDATE healer_proposals SET status = 'auto_resolved', resolved_at = datetime('now'), result_summary = ?
    WHERE agent_id = ? AND approval_token IS NOT NULL AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL))`,
  ).run('Nothing waits on this request any more, so it was closed. Nothing was changed.', getPrimaryAgentId());
}

let runtimeInstance: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime();
  }
  return runtimeInstance;
}

export { AgentRuntime };
