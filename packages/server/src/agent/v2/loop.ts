// ════════════════════════════════════════
// v2 control shell, runV2Turn
//
// The entire agent runtime. ~400 line target. Replaces v1's 2055-line
// runAgentLoop. Phase 2 implementation: real behavior wired throughout.
//
// Per Part XIX (preservation contract), every v1-visible behavior must
// work identically, see agent/v2/PRESERVATION_CHECKLIST.md.
//
// Phase 2 covers:
//   ✓ All 7 phases as real functions
//   ✓ All 14 Phase-1 classifiers wired
//   ✓ TRUE streaming (chunks broadcast immediately, not buffered)
//   ✓ complete_task / image_create loop exit
//   ✓ Status heartbeat preserved
//   ✓ Stop / preempt preserved (via shared-state)
//   ✓ Cost recording + embedding queueing preserved
//   ✓ chat:tool_call / chat:tool_result / chat:message broadcasts preserved
//   ✓ Synthetic Cancelled tool results when stopped mid-batch
//   ✓ Engine-injected ack (via ackInjector)
//   ✓ Tool partitioning (safe → parallel, others → serial)
//   ✓ Loop break detection (via loopDetector)
//   ✓ Permission denial nudging (via permissionAlternativeFinder)
//   ✓ Tracker enforcement (engine-side, no tool_use in context)
//   ✓ Spinning detection with model nudge (via progressClassifier)
//
// Landed since (via the remediation work):
//   ✓ Phase 3.5, large-files.ts removed; file_read has offset/limit
//   ✓ Phase 4, compaction + scaffolding reworked (memory remediation)
//   ✓ Phase 5, system-prompt diet (names-only tool index, trimmed SOUL)
// Still deferred (no inline markers; tracked here):
//   • Phase 6, full unified error cascade (Dreamer special case, etc.)
//   • Phase 7, squad shared memory namespaces
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { ownOutputBroadcast } from '../interagent-broadcast.js';
import type { AgentStatus } from '@dojo/shared';
// classifyTool is the canonical effectful/retrieval/bookkeeping classifier
// (test-covered against the full tool registry); the closeout machinery
// derives "did this turn do real work" from it instead of a hand list that
// drifted (missed every _ms variant and user_ twin, see countsAsTaskWork).
import { classifyTool } from '@dojo/shared';
// PHASE-1 T8 — every engine marker this file writes or matches comes from the ONE taxonomy.
// Nothing below is spelled out locally any more; `src/__tests__/marker-ownership.test.ts`
// refuses a second copy of any of these strings anywhere in the tree.
import {
  NO_REPLY_CLOSED_MARKER, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX,
  NO_REPLY_TAIL_RE, isBareNoReplySentinel, stripMoodMarker, formatRoutingMarker,
} from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';

import { getContextWindow } from '../model.js';
import { resolveRecipientDisplay } from '../../contacts/resolve-recipient.js';
import { redactHandedCredentials, redactAssistantBlocksForPersist } from '../../credentials/secret-fields.js';
// recordError intentionally NOT imported, handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
import { AgentError } from '../errors.js';
import { resolveInbound } from './inbound-channel.js';
import path from 'node:path';
import { turnBoundary, forceA2ATurn, lastTurnWasA2A, continuationContext } from '../turn-state.js';
// PHASE-6 T1: the turn's own facts (`turnCtx`, threaded; `turnContext(agentId)` for the
// module-level helpers below, which run whether or not that agent is in a turn).
import { openTurnContext, turnContext, endTurnContext, type TurnContext } from '../turn-context.js';
import { persistEngineSteer } from './engine-steer.js';
import { clearSteerQueue, enqueueSteer, steerFireCount, steerFired } from './steer-queue.js';
import { findRecentDeliveries, findRecentDeliveriesKeyed, relativeTimeAgo, channelLabel } from './outbound-ledger.js';
// PHASE-2 T8V: the six work verbs made tool NAMES insufficient to identify an
// operation, so every gate below matches `toolOpKey(name, args)` — the operation
// id for a work verb, the plain name for everything else. One matcher, one marker.
import { toolOpKey, CLOSING_WORK_OPS, PROGRESS_WORK_OPS } from '../../tools/work-verbs.js';
import { taskScope, msToText, tsToMs, STATE_TO_STATUS_SQL, stampColumns } from '../../work/tracker-view.js';
import { splitDanglers, resolveServedWork } from './stale-work-ids.js';

import { statusHeartbeats, turnContinuationCounts } from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import { type AgentTurnState, initState, advance } from './state.js';
import { canonicalToolSignature, isNearDuplicateText } from './classifiers/loop.js';
// ackInjector intentionally NOT imported, engine ack disabled per invariant
// review (see "Engine-injected ack, DISABLED" comment below).
import { isForwardPromiseReply } from './ack-copy.js';
import {
  insertMessageIfAbsent, insertEngineEventIfAbsent, stampConversationIdByRowid, tagTurnOutputConversationId,
  claimEngineEventByRowid, releaseEngineEventByRowid, isRowUnserved,
  markServedByRowid,
} from '../../memory/message-store.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { a2aReplyEnforcer, parseA2ATrigger } from './classifiers/a2a.js';
import { resolveTurnCounterparty, getWaitingHumanConversations, getPendingEngineEvent, recordEngineEventDeliveryFailure, getOwedMidTurnArrivals, type TurnCounterparty } from './counterparty.js';
// PHASE-2 T6 — THE ANSWERED EDGE. One module answers "has the person heard from us" for
// every gate in this file that used to answer it for itself (research 07 rows 1a/1b/1c/1e/
// 1g/2d). Nothing below reads the model's prose to decide it any more.
import { closedWithoutDelivery, hasOpenHumanWork, owesAnswer, recordedAnswerInConversation, resumeWorkOnOwnerAsk, turnDeliveredToPerson } from './answered-edge.js';
import { resolveOwnerAffinityChannel, affinityPromotionAllowed } from './owner-affinity.js';
import { getProactiveSendStreak, bumpProactiveSendStreak, resetProactiveSendStreak, PROACTIVE_SEND_DEMOTE_THRESHOLD } from './proactive-budget.js';
import { findUnrepliedAssignForAgent, hasPriorReplyOnThread } from '../a2a-replies.js';
import { outputTruncationClassifier, outputPersistenceClassifier, sanitizeAssistantText, stripLeadingTimeStamp } from './classifiers/output.js';
import { type RepeatCallState } from './identical-call-brake.js';
import { startTurn } from './turn-record.js';
import { withOutboundAsync } from './outbound.js';
// PHASE-2 T3: the ask's lifecycle. `transition()` is the only writer of `work.state`; these
// are its named callers for the pickup / re-arm / turn-link steps of one owner ask.
import { askIdForMessage, claimAsk, stampClaimingTurn, revertAskClaimOnAbort, isStateConflict, noteUnsettled } from '../../work/store.js';
import { detectDeliveryDenial } from './classifiers/grounding.js';
import { decideClaimedDelivery, claimedDeliverySteer } from './claimed-delivery.js';
import { recordFloorGhost, MAX_FLOOR_STEER_ATTEMPTS } from './floor-ghost.js';
// PHASE-6 T8: the first step cut out of this driver. `steps/step-outcome.ts`
// carries the contract every step package shares, including the exit-request
// channel this call site honours.
import { runPostExecution } from './steps/post-execution/index.js';
import { runExecute } from './steps/execute/index.js';
// PHASE-6 T9b: the ninth step — the turn's exit path. Two arms because a module
// cannot express catch/finally on its caller's behalf; the driver keeps the
// construct and the step owns both bodies.
import {
  TEARDOWN_PHASE, runTurnRecovery, runTurnTeardown, type TeardownContext,
} from './steps/teardown/index.js';
// PHASE-6 T3: the loop's FIRST step — everything asked before a model call is spent.
// Seven of the `while` body's exits live in it, which is why its outcome is honoured
// at the call site rather than through a field a later step could overwrite.
import { runPreCallGates, type PreCallGatesContext } from './steps/pre-call-gates/index.js';
import { runAssemble } from './steps/assemble/index.js';
// PHASE-6 T9 (CUT 4): the eighth step — everything the turn does after the loop ends
// and before the exit path. It is the last statement of the main `try`, so it can
// never ask to exit; the reply-destination resolver and the two safety nets live there.
import { runFinalize, type FinalizeContext } from './steps/finalize/index.js';
import { runCallLLM, type CallLLMContext } from './steps/call-llm/index.js';

const logger = createLogger('v2-loop');

/** Standard tail appended to false-positive-prone engine refusals: makes the
 *  agent the tripwire for a wrong block. The engine can't always tell a genuine
 *  action from a pathological one, so when it refuses, the agent, which DOES
 *  have the context, is told to surface a wrong-looking block to the user
 *  instead of silently giving up. Strictly additive: it never blocks anything,
 *  it only adds a chance the user hears about a block that shouldn't have
 *  happened. (Model-dependent, so not a guarantee, a safety net, not a gate.) */
const ENGINE_BLOCK_ESCAPE_HATCH =
  'If you believe this block is a mistake and it is stopping something the user genuinely needs, ' +
  'do NOT silently give up, tell the user what you were trying to do and that the engine blocked it, ' +
  'so they can decide.';

/** The redundant-closeout floor's only narrowing, carried VERBATIM from the deleted
 *  `isGenericCloseout` (PHASE-2 T6, C1). A LENGTH, not a reading of the text: anything
 *  longer is substantive and is never dropped, whatever the delivery ledger says. */
const REDUNDANT_CLOSEOUT_MAX_CHARS = 30;

/**
 * A tool RESULT carries no arguments, but the operation a work verb performed is
 * IN its arguments — so every result-side match resolves the args from the tool
 * CALL that produced it. Without this a `work_update` result would be
 * indistinguishable from any other and the four result-side gates below
 * (transitioned-this-turn, counts-as-task-work, the promise floor, the
 * bookkeeping nudge) would each have to guess. Returns undefined for a result
 * with no matching call, which `workOperation` then resolves by shape.
 */
function argsForResult(
  toolCalls: ReadonlyArray<{ id: string; name: string; arguments: Record<string, unknown> }>,
  tr: { toolCallId?: string; name?: string },
): Record<string, unknown> | undefined {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i].id === tr.toolCallId) return toolCalls[i].arguments;
  }
  return undefined;
}

const STATUS_HEARTBEAT_INTERVAL_MS = 30_000;
// v3.1.11 (FN-9): "recently tended" window shared by the turn-start multistep
// guard and the runtime tracker floor. An assigned in_progress/on_deck task
// suppresses auto-scaffolding ONLY when it was touched within this window; a
// task that has gone quiet for longer is treated as stale and no longer
// disarms enforcement, so genuinely new untracked multi-step work can't ride
// in under an abandoned open task forever. Any tracker mutation bumps
// updated_at, so active cross-turn work naturally stays inside the window.
const STALE_TASK_WINDOW_MINUTES = 30;
const MAX_TOOL_LOOPS = 75;                     // matches v1
// PHASE-6 T3: TURN_TIME_BUDGET_MS (15 min) and MAX_TURN_AUTO_CONTINUATIONS (3) went
// with the budget checkpoint to `steps/pre-call-gates/turn-budget.ts`, unchanged.
const ACK_DEFAULT_TEXT = 'Working on it…';
// Elapsed-based start-ack floor (F10). The classifier and scaffold acks key off
// call accounting (project-worthy classification / 6 work calls), which can land
// long after the person started waiting or, on a quiet-phrased ask, never. This
// floor keys off the USER'S WAIT instead: quick lookups that finish in ~12s stay
// ceremony-free (the battery praised that), anything longer acks before the user
// starts wondering whether the agent heard them.
// Owner directive 2026-07-17: the ack is for work that takes LONGER than a
// person would normally wait for a reply, not for every turn that crosses a
// short threshold ("it fires for almost everything, even the smallest tasks").
// 12s acked nearly every tool-using turn on the floor model; 30s is roughly
// where a texting human starts wondering if they were heard.
const ENGINE_START_ACK_AFTER_MS = 30000;
// Owner ruling 2026-07-22 (engine detects, agent speaks): the start ack is no
// longer engine-composed; the steer hands the mic to the model instead.
// PHASE-6 T4 (CUT 6): START_ACK_STEER_TEXT MOVED to `steps/assemble/steer-checkpoint.ts`
// with the two sites that bind it — both were inside this tranche's span.
// RC-4.4: streaming-race grace. When the start-ack timer / first-tool hook is about to
// fire but a model call is still streaming, wait up to this long for the real reply to
// land (startAckRepliedNow suppresses the ack then). Kills the F-11 double-ack (ack at
// +12s, model reply at +13s) while keeping the guarantee: a stalled model still gets the
// ack after the grace expires.
// Cap on waiting out an in-flight model call before the ack may speak anyway.
// Generous on purpose (the wait usually ends in the reply landing, which
// silences the ack entirely); the stream-idle watchdog owns truly hung calls.
const ENGINE_START_ACK_STREAM_GRACE_MS = 60000;

// ── Task-thrash detector ──
// Catches the "agent re-runs the SAME canonical tool call over and over"
// pattern.
//
// Signature semantics matter: reading 20 unique messages each once is NOT
// thrashing (the task asks for it). Reading the SAME message 4 times is.
// We key on canonicalToolSignature so a model that varies one parameter
// (limit=1000 vs no limit) doesn't slip past, but distinct args = distinct
// signatures = no false positive on legitimate iteration.
//
// REACTION (rewritten): instead of pausing the task and walking away
// (which strands work and forces the user to manually intervene), we
// inject a specific steer message naming the exact gated signature and
// activate a per-signature refusal gate. The agent can still call the
// same tool with DIFFERENT args. Only the exact spinning signature is
// refused. Cleared on any work_update(action="status").
//
// LAST RESORT: if the gate has had to refuse THRASH_GATE_BREAKER_LIMIT+
// calls without the agent transitioning, the engine auto-blocks the task
// so it reaches a real terminal state instead of looping.
// P6b-2 REKEY: the window is TURN IDENTITY, not wall clock. The old 2-minute
// clock was load-dependent (a slow provider saw fewer calls in the window and
// missed thrash; a fast one over-counted); the current turn plus its
// predecessor (auto-continued spirals span the boundary) is the same
// semantic window keyed on execution identity.
const THRASH_TURN_WINDOW = 1; // current turn and this many before it
const DUPLICATE_SIG_LIMIT = 4;

function detectTaskThrashing(agentId: string): {
  thrashing: boolean;
  toolName?: string;
  signature?: string;
  count?: number;
} {
  try {
    const db = getDb();
    // Turn-keyed window (P6b-2). Rows with NULL turn_number (pre-113 or the
    // odd unstamped write) fall out of the window, which fails SAFE for a
    // detector (missing one row can only under-count).
    const minTurn = (turnContext(agentId)?.turnNumber ?? 0) - THRASH_TURN_WINDOW;
    const rows = db.prepare(`
      SELECT content FROM messages
      WHERE agent_id = ? AND role = 'assistant'
        AND turn_number >= ?
      ORDER BY created_at ASC, rowid ASC
    `).all(agentId, minTurn) as Array<{ content: string }>;

    // AUDIT-FIX (D5): mutating-tool progress must be SUCCESS-aware. tool_use blocks
    // carry no result, so a failing file_write counted as "progress" and disabled
    // this breaker for any window containing a mutating call (and the `continue`
    // also hid failing loops from the thrash counts). Build the set of FAILED
    // tool_use ids from the window's tool-result rows; a mutating call only counts
    // as progress when it did not fail, and a FAILED one is counted toward thrash.
    const failedToolUseIds = new Set<string>();
    try {
      const toolRows = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'tool'
          AND turn_number >= ?
      `).all(agentId, minTurn) as Array<{ content: string }>;
      for (const tr of toolRows) {
        let blocks: unknown;
        try { blocks = JSON.parse(tr.content); } catch { continue; }
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          const blk = b as { type?: string; tool_use_id?: string; is_error?: boolean };
          if (blk?.type === 'tool_result' && blk.is_error && blk.tool_use_id) {
            failedToolUseIds.add(blk.tool_use_id);
          }
        }
      }
    } catch { /* best effort, without result rows, fall back to name-based */ }

    const counts = new Map<string, { count: number; toolName: string }>();
    let madeProgress = false;
    for (const row of rows) {
      let blocks: unknown;
      try { blocks = JSON.parse(row.content); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        const block = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (block.type !== 'tool_use') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        const failed = block.id != null && failedToolUseIds.has(String(block.id));
        // A status flip / step completion / note, and complete_task, count as
        // forward progress: an agent that calls these is at least transitioning. Same for
        // send_to_user / chat-style replies (they finish the work).
        // D5 (2026-07-08 defect-class sweep): a SUCCESSFUL effectful-action tool
        // is ALSO forward progress. This used to be a hand list (isMutatingTool,
        // ~10 file/channel-send names) that missed every _ms / user_ / Google-
        // write / calendar / drive variant, so an MS-heavy or upload-heavy work
        // turn could look like non-progress and get thrash-flagged. classifyTool
        // is the canonical, verb-derived effect classifier: creating a calendar
        // event (calendar_create/_ms), uploading a file (drive_upload/onedrive_
        // upload), editing a doc, or sending on any channel all classify as
        // 'effectful-action' and correctly count as work. A FAILED call is NOT
        // progress and falls through into the thrash counts below. (A genuine
        // re-run of the IDENTICAL effectful call still trips loopDetector on its
        // canonical signature, so counting effectful success as progress here
        // does not open a thrash hole.)
        if (
          !failed && (
            PROGRESS_WORK_OPS.has(toolOpKey(name, block.input)) ||
            name === 'complete_task' ||
            classifyTool(name, block.input) === 'effectful-action'
          )
        ) {
          madeProgress = true;
          continue;
        }
        const sig = canonicalToolSignature(name, block.input);
        const cur = counts.get(sig) ?? { count: 0, toolName: name };
        counts.set(sig, { count: cur.count + 1, toolName: name });
      }
    }
    if (madeProgress) return { thrashing: false };
    let topSig = '';
    let topCount = 0;
    let topName = '';
    for (const [sig, v] of counts) {
      if (v.count > topCount) { topCount = v.count; topSig = sig; topName = v.toolName; }
    }
    if (topCount >= DUPLICATE_SIG_LIMIT) {
      return { thrashing: true, toolName: topName, signature: topSig, count: topCount };
    }
    return { thrashing: false };
  } catch {
    return { thrashing: false };
  }
}

// ── Heartbeat (mirrors v1 helpers, local copy so v2 can run standalone) ──

function startStatusHeartbeat(agentId: string): void {
  const existing = statusHeartbeats.get(agentId);
  if (existing) clearInterval(existing);
  const timer = setInterval(() => {
    try {
      // Carry the current turn kind on EVERY heartbeat. Without it, the client
      // (Chat.tsx) treats a missing turnKind as 'user' and re-shows the working
      // UI (thinking dots + stop button) on the next tick, clobbering the 'a2a'
      // turnKind that the turn-start broadcast set, so inter-agent turns flashed
      // the working UI back into the user's chat every heartbeat interval.
      broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: turnContext(agentId)?.kind ?? 'user', userFacing: typeof turnContext(agentId)?.convKey === 'string' });
    } catch {
      /* best effort */
    }
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

export function setAgentStatus(agentId: string, status: AgentStatus): void {
  try {
    const db = getDb();
    // The turn's human-conversation binding: non-null conv_key on a genuine human turn
    // (dashboard / iMessage / voice), null on a pure background a2a / engine turn,
    // undefined outside a turn. Threaded onto the broadcast as `userFacing` so the
    // composer can tell "idle after a user turn" from "idle after background noise": on
    // a busy box a queued dashboard send must keep its working-UI latch across a
    // background turn's idle (see AgentStatusEvent.userFacing).
    // PHASE-6 T1: was a capture taken BEFORE this function deleted ten turn-state maps.
    // That delete is gone; a status write no longer decides how long the turn's facts live.
    const turnConvKeyAtStatus = turnContext(agentId)?.convKey; // string | null | undefined
    const userFacingTurn = typeof turnConvKeyAtStatus === 'string' && turnConvKeyAtStatus.length > 0;
    // FA-A2: clear the diagnostic ONLY on a clean turn end ('idle'), not on the
    // 'working' transition. A turn that errors and retries goes working → error →
    // working; clearing last_error on 'working' wiped the diagnostic on every
    // retry and raced the Healer's grace-delayed notify. Clearing on 'idle' lets
    // it survive across retries and clears once the turn actually finishes clean.
    // Genuine recovery also clears it via onAgentRecovered (injury-recovery.ts).
    if (status === 'idle') {
      db.prepare(`
        UPDATE agents SET status = ?, last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    } else {
      db.prepare(`
        UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(status, agentId);
    }
    // On 'working', carry the turn kind so the composer can stay quiet on pure
    // A2A turns (unless wordy mode). Defaults to 'user' until the counterparty
    // is resolved early in the turn.
    const turnKind = status === 'working' ? (turnContext(agentId)?.kind ?? 'user') : undefined;
    // userFacing rides on EVERY status this seam emits (working AND idle/terminal),
    // captured above before the idle delete. `undefined` (no turn resolved yet, e.g.
    // the pre-classification 'working' at turn start) is omitted so the client keeps
    // its safe default there; the authoritative value lands on the post-resolution
    // working re-broadcast and on the terminal broadcast.
    broadcast({
      type: 'agent:status',
      agentId,
      status,
      ...(turnKind ? { turnKind } : {}),
      ...(turnConvKeyAtStatus !== undefined ? { userFacing: userFacingTurn } : {}),
    });
  } catch (err) {
    logger.warn('Failed to update agent status', {
      agentId,
      status,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

// Orb mood marker (`((mood: NAME))`) is an orb-only signal that away text channels
// (iMessage / SMS / Teams / email) were sending raw, breaking the prompt's promise that it is
// invisible to the user. Stripped from the channel-routed copy (lastAssistantTextForIM) at
// set-time.
//
// PHASE-1 T8: the regex used to live here as one of FOUR copies (this one, the TTS sanitizer,
// and two in the dashboard). It is now `stripMoodMarker` in @dojo/shared, and the PERSISTED
// row no longer carries the marker either — the writer module extracts it to `messages.mood`
// at insert (17 §C3), so this call is the channel copy's own safety net rather than the only
// place it is removed.

// ── Main entry ──

/**
 * Run a single user-message → agent-response cycle on the v2 runtime.
 * Mirrors v1's runAgentLoop semantics with the Control Shell pattern.
 *
 * PHASE-6 T1: this wrapper IS the turn's lifetime. Why the clear lives here and not in
 * the body's teardown `finally` is written at `endTurnContext` (`agent/turn-context.ts`).
 * ⚠ FOR T12: the tripwire's subject — "the driver's residual" — is `runV2TurnBody`.
 */
export async function runV2Turn(agentId: string): Promise<void> {
  const turnCtx = openTurnContext(agentId);
  try {
    await runV2TurnBody(agentId, turnCtx);
  } finally {
    endTurnContext(agentId);
  }
}

async function runV2TurnBody(agentId: string, turnCtx: TurnContext): Promise<void> {
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
    | Record<string, unknown>
    | undefined;
  if (!agent) {
    throw new AgentError('Agent not found', agentId, { code: 'AGENT_NOT_FOUND' });
  }
  const configuredModelId = agent.model_id as string | null;
  if (!configuredModelId) {
    throw new AgentError('Agent has no model configured', agentId, { code: 'NO_MODEL' });
  }

  const isAutoRouted = configuredModelId === 'auto';
  const contextModelId = isAutoRouted ? '__auto__' : configuredModelId;
  const contextWindow = getContextWindow(contextModelId);

  setAgentStatus(agentId, 'working');
  startStatusHeartbeat(agentId);

  // Trigger context, read once at preflight (Part XIX preservation).
  //
  // v2.9.15: filter out rows that share `role='user'` but are NOT
  // actual user-channel inbounds. Without this, an A2A reply from a
  // sub-agent or a synthetic rate-limit-recovery notice shows up as
  // "the most recent user message" and the engine misattributes the
  // current turn's inbound channel - the canonical failure shape is:
  // user iMessages primary, primary delegates to a sub-agent, the
  // sub-agent's A2A reply lands as `role='user'` with content starting
  // `[A2A:`, and the primary's next-turn reply auto-routes to
  // dashboard instead of back to the original iMessage thread.
  // Recent role='user' rows with full attribution, newest first. The turn
  // trigger / counterparty is classified by STRUCTURED origin (deriveOrigin =
  // the origin_kind column + the legacy-marker shim), NOT a prose NOT-LIKE list.
  // The old query only excluded [SOURCE: SYSTEM / [A2A: / [SOURCE: AGENT MESSAGE,
  // so engine events written as role='user' (tracker / scheduler / thrash gate /
  // healer / …) became the "trigger" and resolved to a malformed
  // "a contact / engine / dashboard" counterparty, which then misclassified A2A
  // turns and leaked their planning text to the dashboard. origin.kind tells
  // human (user) from engine from agent unambiguously.
  // ── Counterparty serialization (turn continuity) ──
  // Serve the human conversation that has been WAITING longest with an
  // unanswered message (FIFO). Its LATEST message is the trigger, so multi-part
  // messages from one sender answer together. Because a turn only marks a
  // conversation "served" when it actually delivers a reply (below), a turn that
  // ends mid-task leaves its conversation waiting → the next turn RESUMES the
  // SAME one and routes to it, instead of jumping to whoever is newest (which
  // sent a Teams answer to a client's email). Same helper the runtime uses to
  // decide whether to re-trigger and drain the rest. Engine events / A2A are not
  // human conversations here.
  const waitingConvs = getWaitingHumanConversations(agentId);
  // PHASE-2 T6 (C8, requirement 1e): ONE QUERY on the spine, taken HERE — at the same
  // instant as the waiting set and BEFORE the pickup claim below. The instant is
  // load-bearing: the claim moves this turn's own trigger to `claimed`, so a read taken
  // afterwards answers "is anybody ELSE waiting" and turns every ordinary user turn into a
  // settled-context wake.
  const openHumanWorkAtTurnStart = hasOpenHumanWork(agentId);
  // C3: restore a human-task continuation. When a long human task hit MAX_TOOL_LOOPS /
  // the time budget / emergency compaction, the engine auto-continued with an empty
  // trigger and stashed the conversation here. This continuation turn has no waiting
  // human (the ask was stamped served at the original pickup), so without restoring it
  // the turn would be pureBackgroundTurn → its final answer suppressed + routed to
  // dashboard. Always consume the entry on read: a continuation is used once, and if a
  // real human turn arrived in between (waitingConvs non-empty) the entry is stale and
  // must be dropped so it can't falsely restore later.
  const continuation = continuationContext.get(agentId);
  continuationContext.delete(agentId);
  const isHumanContinuation = waitingConvs.length === 0 && !!continuation;
  const chosenConvKey = isHumanContinuation ? continuation!.convKey : (waitingConvs[0]?.key ?? null);
  // PHASE-2 T10I: the same choice as the FK. `conversationId` is resolved at ingest by the
  // producer and read straight off the trigger row here; the `??` fallback below (at the
  // pickup stamp) is what covers a row no door ever resolved for. `chosenConvKey` SURVIVES
  // beside it because four other tables are still keyed by the string — see
  // `TurnContext.conversationId`'s note in turn-context.ts.
  let chosenConversationId: string | null = isHumanContinuation
    ? (continuation!.conversationId ?? null)
    : (waitingConvs[0]?.oldest?.conversation_id ?? null);
  // F9: timestamp of the turn's most recent context assembly; sibling user rows
  // of the same conversation created before this instant were IN the assembled
  // context and are claimed at teardown (see claimAssembledSiblings).
  // PHASE-6 T4 (CUT 6): MOVED to the turn's bag with its two siblings — the
  // `assemble` span writes it and the teardown closure reads it, so a by-value
  // hand-off would lose the stamp. Reason at the field (RULING P6-R3(1)).
  // FA-M1: the non-compressible overhead (assembled system prompt + tool-schema/
  // output reserve) the pre-call compaction gate subtracts from the window to get
  // the compressible budget. Refreshed from each assembly below; the pre-call gate
  // sits at the top of the iteration (before assembly), so it uses the prior
  // iteration's value (0 on the very first gate, i.e. old full-window behavior).
  // The stronger, exact anti-silent-loss signal is the eviction broadcast, which
  // fires whenever the assembler actually drops fresh-tail rows.
  // PHASE-6 T4 (CUT 6): both MOVED to the turn's bag — see `lastAssembledAtIso`
  // above. `freshTailDropWarned` is the once-per-TURN latch behind the CONTEXT_HIGH
  // banner, which is why it cannot ride by value into a step that runs per iteration.
  // E-C1: publish the conversation this turn serves so recall_recent_thread scopes
  // to it. null on engine/A2A turns (no waiting human) so recall doesn't latch the
  // last human conversation. Cleared when the agent goes idle.
  turnCtx.convKey = chosenConvKey;
  // The ID half of the same publication is written AFTER the pickup block below, where
  // `chosenConversationId` becomes final. See the note at that write.
  // OPEN-12: trigger on the OLDEST unanswered message in the chosen conversation,
  // so a conversation's pending messages are answered oldest-first, a later ping
  // ("are you there?") can never be answered before the request that came before it.
  const triggerRow = waitingConvs[0]?.oldest;
  const lastUserMessageContent = triggerRow?.content ?? null;
  // P1 lineage spine: the inbound ask's ROW ID, the origin key work records
  // born this turn will carry (the prose copy in lastUserMessageContent stays
  // for display; identity travels as this id).
  const lastUserMessageId: string | null = triggerRow?.id != null ? String(triggerRow.id) : null;
  turnCtx.root = lastUserMessageId ? { kind: 'ask', id: lastUserMessageId, sourceMessageId: lastUserMessageId, conversationId: (triggerRow as unknown as { conversation_id?: string | null })?.conversation_id ?? null } : null;
  // CLAIM this ask the moment the turn picks it up, so it reads as SERVED regardless of how
  // this turn ends. The old design only marked a conversation served when the turn
  // delivered a terminal reply (or [no-reply]), so a turn that did real, NON-IDEMPOTENT
  // work (created a project, wrote files, messaged the PM) but then ended via a suppressed
  // reply, a gate/limit, or an A2A hand-off tagged nothing, left the conversation
  // "waiting", and the runtime drain re-triggered the SAME message → the agent redid the
  // work → duplicate projects (the thrash spiral). A genuinely newer message in the same
  // conversation has its OWN ticket, so it still reads as waiting and is served on the next
  // turn; only the self-re-trigger of the message we are handling right now is killed.
  // Continuing a long task is the tracker/PM's job, never re-running the user's message.
  //
  // PHASE-2 T3: the claim is a STATE on the ask (`open → claimed`), not a NULL becoming a
  // string on `messages.conv_key`. The conv_key stamp stays as what it was always named
  // for — the conversation's IDENTITY, which conversation-scoped recall and the turn's own
  // output tagging read (07 §3g/3l) — and it no longer decides anything about the queue.
  // requirement preserved: restart-durable (still a DB fact, now on the ticket), one winner
  // across processes (the CAS is `expectedState: 'open'` inside `transition()`), and
  // identity untouched (a claim can no longer overwrite a channel).
  const triggerWorkId: string | null = waitingConvs[0]?.workId ?? null;
  // The conversation the trigger arrived on, read HERE at pickup and carried to the
  // delegation exit. PHASE-2 T4 copies it onto the join rather than re-resolving the channel
  // later from an `inbound_meta` blob, which is what the park machine had to do after it
  // overwrote the identity column.
  const triggerConversationId: string | null = waitingConvs[0]?.oldest?.conversation_id ?? null;
  if (chosenConvKey && triggerRow) {
    let claimed = true;
    if (triggerWorkId) {
      const res = claimAsk(triggerWorkId, agentId);
      claimed = res.kind === 'applied';
      if (!claimed && !isStateConflict(res)) {
        logger.warn('v2: pickup claim refused by the work spine', { agentId, workId: triggerWorkId, res }, agentId);
      }
      // PHASE-2 T6 (C3) — THE REOPEN EDGE. The owner has spoken, so work the engine parked
      // because it was waiting on them returns to the state it was paused from. Not
      // optional: a pause with no reopen is how a ticket rots quietly, which is what the P2
      // drive boundary was protecting against (T1 adjudication #2, rider b).
      if (claimed) {
        try { resumeWorkOnOwnerAsk(agentId); }
        catch (err) {
          logger.warn('v2: reopen-on-owner-ask failed (non-fatal)', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }
    }
    // Identity, always, and independent of the claim: this row belongs to this
    // conversation whether or not this turn won the race to serve it.
    //
    // PHASE-2 T10I: the identity is `conversations.id`. Two cases, and the second is the
    // reason this write still exists after the backfill:
    //   * the producer resolved it at ingest (the normal path) — nothing to do, the row
    //     already carries it, and re-writing it from the turn's coarser view could only make
    //     it worse (a door knows the mail thread; a turn knows the sender);
    //   * the producer could NOT (`resolveOrCreateConversation` is best-effort by contract and
    //     returns null rather than blocking an inbound) or the row never passed a door at all
    //     — resolve it here, once, through the same one writer, from the identity the waiting
    //     set derived from this row's own stamped origin.
    // This is a DOOR-TIME resolution, not a backfill guess: the turn is genuinely having this
    // conversation right now, which is what `resolveOrCreateConversation` exists to record.
    // It logs when it fires, because a live occurrence means a producer is not stamping and
    // that is a finding rather than routine.
    if (!chosenConversationId) {
      const identity = waitingConvs[0]?.identity;
      if (identity) {
        try {
          chosenConversationId = resolveOrCreateConversation(agentId, identity);
          logger.info('v2: trigger row carried no conversation_id; resolved at pickup', {
            agentId, rowid: triggerRow.rowid, convKey: chosenConvKey, conversationId: chosenConversationId,
          }, agentId);
        } catch { /* best effort; the turn proceeds unscoped exactly as it would have */ }
      }
    }
    if (chosenConversationId) {
      try {
        stampConversationIdByRowid({ rowid: triggerRow.rowid, agentId, conversationId: chosenConversationId });
      } catch { /* best effort, served-tagging also happens at turn end */ }
    }
    // C24: reset the turn-continuation counter at the start of a genuinely NEW
    // human-triggered turn (a fresh trigger claimed here). The counter bounds CONSECUTIVE
    // time-budget auto-continuations of ONE turn; without a reset it accumulated across the
    // whole process, so three unrelated long turns would prematurely hard-stop the fourth.
    // Continuation turns (empty trigger → no pickup) never reach here, so a single long
    // task's own continuations still accumulate and cap correctly.
    if (claimed) turnContinuationCounts.delete(agentId);
    if (!claimed) {
      // D-2 (comms-audit): the atomic claim affected 0 rows, ANOTHER process already
      // stamped this trigger between our read and our stamp (cross-process race on one
      // SQLite DB). Bail cleanly instead of running a DUPLICATE turn on the same
      // message. Single-process production never hits this (changes is always 1); this
      // only guards the multi-process case (e.g. stray dev `tsx watch` processes). The
      // turn's own `finally` clears its context; the other process serves the message.
      logger.warn('v2: pickup claim lost, another process already claimed this trigger; skipping to avoid a duplicate turn', { agentId, rowid: triggerRow.rowid, workId: triggerWorkId }, agentId);
      setAgentStatus(agentId, 'idle');
      return;
    }
  }

  // E-C1 / PHASE-2 T10I: publish the conversation this turn serves, as `conversations.id`.
  // PHASE-3 STRIP-3 MOVED IT HERE (it was beside its KEY sibling above) because THIS is where
  // `chosenConversationId` is final: the pickup repair just above resolves one for exactly the
  // trigger rows no producer stamped. Written early, the map said "no conversation" on a turn
  // that had one, `memory/assembler.ts` handed that null to `scopeToHumanConversation`, and
  // the own-output rule dropped every stamped answer — the model saw its asks with its replies
  // missing and answered again (dojo `8bc7d7a`'s re-answer ghost; 23.6% of user rows on the dev
  // body carry no `conversation_id`). MOVED, not doubled — a second `.set()` is two owners of
  // one fact. Pinned by integration.test.ts, "STRIP-3 … (b)".
  turnCtx.conversationId = chosenConversationId;

  // N-1 (comms-audit): re-arm a stranded human ask. The pickup claim above marks the ask
  // served so a concurrent turn can't double-serve it. If THIS turn then aborts BEFORE
  // producing any answer (model-call exhausted all retries, or no model available at all, a
  // transient rate-limit / provider outage), leaving the claim in place would drop the ask
  // from the waiting set FOREVER and the user would get permanent silence on a purely
  // transient infra failure, while the recovery toast promises "retrying automatically".
  // Handing the ticket back to `open` returns it to the waiting set so the runtime
  // finally-drain (runtime.ts) re-serves it once the provider recovers (bounded by
  // MAX_DRAIN_STUCK, so a persistent failure can't tight-loop). Call ONLY on no-answer
  // abort paths, never after any reply text has been produced, or it would resurrect an
  // answered ask and double-reply.
  //
  // PHASE-2 T3 — P6b NOW BINDS THE HUMAN RE-ARM TOO, AND THIS IS A DELIBERATE BEHAVIOUR
  // CHANGE. The engine-event half below has always been gated on
  // `nonIdempotentCallsThisTurn === 0`; the human half was gated only at the C4 CALLER
  // (`reArmIfStrandedNoAnswer`), so any of the five direct abort-path callers could re-arm
  // an ask whose turn had already sent an email. The rule is one rule now, enforced where
  // the revert happens rather than at each site that remembers to check: "a turn that
  // performed a side effect must never re-fire" (07 §2c, ledger P6b-1). The refusal is
  // recorded as a work event, so a held ask is a fact somebody can find.
  //
  // D8: set at the engine-event pickup below when THIS turn claims a pending engine
  // event (conv_key stamped 'engine'). Declared here, before the abort revert that
  // reads it, so the closure never touches a TDZ variable.
  let claimedEngineEvent: { rowid: number; turnNumber: number } | null = null;
  /** PHASE-2 T9: the event this turn INTENDS to claim, decided at engine-turn detection.
   *  It becomes `claimedEngineEvent` only when the CAS at turn-identity allocation wins. */
  let pendingEngineClaim: { rowid: number } | null = null;
  const revertTriggerStampOnAbort = () => {
    if (triggerWorkId) {
      try {
        noteUnsettled(revertAskClaimOnAbort(
          triggerWorkId, state.nonIdempotentCallsThisTurn,
          'turn aborted with no answer; handing the ask back to the waiting set (N-1)',
        ), 'v2: ask hand-back on abort', { workId: triggerWorkId });
      } catch { /* best effort, recovery, never block the abort */ }
    }
    // D8: symmetric revert for an ENGINE trigger claim. The engine pickup stamps the
    // serve edge the moment the event is picked up, so a model/provider abort
    // on the engine turn used to leave the event permanently "processed": the
    // reminder was never spoken and nothing ever retried it. Revert our own claim
    // (AND served_by_turn = OUR turn keeps it idempotent against a concurrent re-claim)
    // and record the failed delivery (attempt counter + backoff, migration 084) so
    // the retry timer / boot re-drain re-serves it, bounded by the 5-attempt /
    // 6-hour lifecycle. Guarded by the SAME no-non-idempotent-execution rule as
    // the C4 human re-arm below (P6b): a turn that performed a side effect
    // (sent the reminder via imessage_send, created a task) must not re-fire
    // the event, that would duplicate it; a read-only turn re-arms safely.
    if (claimedEngineEvent != null) {
      try {
        if (state.nonIdempotentCallsThisTurn === 0) {
          const reverted = releaseEngineEventByRowid({
            rowid: claimedEngineEvent.rowid, agentId, turnNumber: claimedEngineEvent.turnNumber,
          });
          if (reverted > 0) recordEngineEventDeliveryFailure(agentId, claimedEngineEvent.rowid);
        }
      } catch { /* best effort, recovery, never block the abort */ }
    }
  };
  // T-6 (comms-audit, RESOLVED per the owner): rapid bursts are handled by PER-MESSAGE
  // serving, every message in a burst keeps its conv_key NULL until its own turn
  // picks it up, so none is ever DROPPED (the priority). The cost the owner accepted is
  // that a later message's turn can repeat an earlier answer from the tail. We do NOT
  // combine the burst onto one turn / stamp siblings served, because on the weak model
  // that risks marking a message answered without answering it (a dropped reply).
  // Phase 3, bind the inbound source for the whole turn. Computed once
  // here and threaded into every assembleContext call below so the
  // voice-conduct block stays in scope across tool-call iterations of
  // a single voice turn.
  // T6: the voice fact is `channel='voice'` now (T3-0b §3). This selects the
  // voice-conduct addendum, so it is under the cache-prefix rider: the four
  // ?source=voice|text × tts=local|cloud matrix cells must stay byte-identical.
  const latestUserSource: 'voice' | 'text' | null =
    triggerRow?.channel === 'voice' ? 'voice' : triggerRow ? 'text' : null;
  // Hume cloud-TTS brief, extend turn context with the active TTS engine
  // so the assembler can swap between the flat-voice (Kokoro) addendum
  // and the expressive (Hume) addendum that teaches the ((deliver: ...))
  // cue. Resolved once here so it stays stable across tool iterations.
  let latestTtsEngine: 'local' | 'cloud' | null = null;
  if (latestUserSource === 'voice') {
    try {
      const ttsRow = db.prepare("SELECT value FROM config WHERE key = ?")
        .get('voice.tts_engine') as { value: string } | undefined;
      latestTtsEngine = ttsRow?.value === 'cloud' ? 'cloud' : 'local';
    } catch {
      latestTtsEngine = 'local';
    }
  }
  const triggeredByIMessage = lastUserMessageContent?.includes('[SOURCE: IMESSAGE FROM') ?? false;
  // v2.9.16: once-per-turn latch for the voice-mode filler phrase.
  // Flipped true the first time we push a filler into the active TTS
  // burst so subsequent tool-using iterations in the same turn don't
  // double-fire ("on it ... checking ... give me a sec ...").
  let voiceFillerFired = false;

  // v2.9.23, phone-call streaming TTS state. When this turn is
  // triggered by a live phone call, we keep a sentence-splitting
  // buffer attached to the model's onChunk callback. Each completed
  // sentence (or comma-separated clause for short replies) goes to
  // `CallSession.queueAgentSay` ASAP so audio starts playing on the
  // first sentence instead of waiting for the whole model output.
  // Cuts perceived latency by ~70 % on multi-sentence replies.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): the BUFFER and the FLUSHED latch are on the
  // turn's bag, because both are written from the model's `onChunk` CALLBACK below
  // and the `finalize` span both reads and WRITES the buffer — a module boundary
  // passes values, so a by-value copy would take a stale tail and drop the clear.
  // PHASE-6 T5 (CUT 5): `phoneStreamCallSid` MIGRATED to the bag with the rest of its
  // family, exactly where CUT 4's note said it would — it crosses `callLLM` (the
  // streaming callback) and `postCallClassify` (the voice filler), so this is the
  // tranche that owed it. See the field's own comment for what the migration is and
  // is not claiming.

  // v3.0.9, inbound channel + reply context resolved in ONE place
  // (inbound-channel.ts). Priority: structured metadata (messages.inbound_meta,
  // stamped by the producer) → voice (source='voice') → a behavior-preserving
  // parse of the [SOURCE: ...] prose. Routing no longer depends on the engine
  // re-parsing notification wording, which is the recurring failure this
  // closes. The reply-destination resolver reads these at end of turn to
  // auto-route the model's terminal text back to the source channel.
  const resolvedInbound = resolveInbound({
    agentId,
    content: lastUserMessageContent,
    channel: triggerRow?.channel ?? null,
    inboundMeta: triggerRow?.inbound_meta ?? null,
  });
  const inboundChannel = resolvedInbound.inboundChannel;
  const inboundContext = resolvedInbound.inboundContext;
  // v2.9.23, bind the streaming TTS sink for a live phone call so audio
  // starts playing while the model is still generating (the onChunk callback
  // on the model call flushes sentence-complete chunks to queueAgentSay).
  if (inboundChannel === 'phone' && inboundContext?.phoneCallSid) {
    turnCtx.phoneStreamCallSid = inboundContext.phoneCallSid;
  }
  // v2.5.31, A2A reply context now sources from the durable a2a_replies
  // table, not just "is the most recent user message an [A2A:...] tag."
  // findUnrepliedAssignForAgent returns null if the most recent ASSIGN/
  // QUESTION/BLOCK has already been replied to via send_to_agent (in any
  // prior handleMessage invocation), which prevents the enforcer from
  // firing again for an already-handled inbound message. Falls back to
  // the legacy parse path so any pre-fix in-flight ASSIGNs (no row in
  // a2a_replies yet) still trigger the enforcer at least once.
  const unrepliedAssign = findUnrepliedAssignForAgent(agentId);

  // ── A2A turn classification (v3.1.10) ──
  // A turn is a dedicated A2A-handling turn when EITHER the runtime forced one
  // (a still-unreplied A2A that a prior user turn deferred, forceA2ATurn) OR
  // the most-recent inbound is itself an unreplied wake-A2A and nothing newer
  // (a real user message) supersedes it. On any other turn A2A is stripped
  // from context (assembler) and the reply enforcer stays disarmed, so
  // inter-agent traffic cannot bleed into a user-facing reply. A deferred A2A
  // is not dropped: the runtime re-queues it as its own A2A turn (see
  // runtime.ts finally + turn-state.ts).
  const forcedA2ATurn = forceA2ATurn.has(agentId);
  forceA2ATurn.delete(agentId);
  // T6: ONE most-recent inbound, over every lane the agent owns. This was a two-arm
  // UNION with an anti-join dedup because peer A2A lived in a second physical table;
  // T4 folded it in, so a NEW peer ASSIGN is the most-recent trigger by insertion order
  // and mostRecentIsA2A → isA2ATurn → counterparty.kind='agent' without any merging.
  // requirement preserved: a peer ASSIGN that arrived last is the trigger the assembler
  // scopes the tail to. The `_src` tag is gone with the second table (one rowid space).
  const mostRecentInbound = db.prepare(`
    SELECT seq AS rowid, content, lane, origin_intent, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, inbound_meta, served_by_turn
      FROM messages
     WHERE agent_id = @agentId AND role = 'user'
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1
  `).get({ agentId }) as {
    rowid: number; content: string; lane: string; origin_intent: string | null;
    source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null;
    a2a_requires_response: number | null; inbound_meta: string | null; served_by_turn: number | null;
  } | undefined;
  // A reply-needed peer A2A (QUESTION/ASSIGN/BLOCK) is most-recent. Engine-origin
  // rows (fromAgent='system') are NOT peer A2A, they drive an engine turn instead,
  // so they never count here (else they'd mis-frame the receiver toward send_to_agent).
  const mostRecentIsA2A =
    mostRecentInbound?.lane !== 'events' &&
    parseA2ATrigger(mostRecentInbound?.content ?? null) !== null;
  // ── Terminal-wake A2A detection (interagent-separation) ──
  // Terminal intents (DELIVERABLE/ANSWER/COMPLETE/FAIL) ALSO wake the receiver by
  // design (a sub-agent handing back the thing that was asked for), but they are
  // NOT reply-needed, so findUnrepliedAssignForAgent returns null and the old
  // isA2ATurn was false. With no human waiting the turn then fell to owner/engine
  // classification and scopeToHumanConversation->stripA2AFromTail REMOVED the very
  // deliverable that woke the agent: it woke blind to what it was woken for, and
  // could run a stale owner directive. Detect the wake structurally: the most-recent
  // inbound is a PEER (not engine) terminal A2A intent that actually woke this agent
  // (a2a_requires_response=1) and has not yet been claimed by a turn.
  //
  // PHASE-2 T10I: "not yet claimed" is `served_by_turn IS NULL`. It was `conv_key IS NULL`,
  // which is the LAST survivor of the claim job T4 already moved off this column: T4
  // re-pointed `findUnservedTerminalWake` onto `served_by_turn` and deleted the
  // `conv_key='a2a'` sentinel that fed it, but this second reader of the same fact was
  // missed, and it kept working only because nothing wrote the sentinel any more — i.e. it
  // was reading "unclaimed" off a column that no longer records claims. Now both readers of
  // that edge ask the same column the same question.
  // Gated with !hasUnansweredUser below so a waiting human always wins (no hijack).
  const TERMINAL_WAKE_INTENTS = new Set(['DELIVERABLE', 'ANSWER', 'COMPLETE', 'FAIL']);
  let terminalWakeA2A: { intent: string; threadShort: string; threadId: string; fromName: string; rowid: number } | null = null;
  if (
    mostRecentInbound &&
    mostRecentInbound.lane !== 'events' &&
    mostRecentInbound.a2a_thread_id &&
    mostRecentInbound.a2a_intent &&
    TERMINAL_WAKE_INTENTS.has(mostRecentInbound.a2a_intent) &&
    mostRecentInbound.a2a_requires_response === 1 &&
    mostRecentInbound.served_by_turn === null
  ) {
    const senderRow = mostRecentInbound.source_agent_id
      ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(mostRecentInbound.source_agent_id) as { name?: string } | undefined)
      : undefined;
    terminalWakeA2A = {
      intent: mostRecentInbound.a2a_intent,
      threadShort: mostRecentInbound.a2a_thread_id.slice(0, 8),
      threadId: mostRecentInbound.a2a_thread_id,
      fromName: senderRow?.name ?? mostRecentInbound.source_agent_id ?? 'another agent',
      rowid: mostRecentInbound.rowid,
    };
  }
  // Buried-wake fallback (2026-07-23): the check above only sees a wake when
  // it is the absolute most-recent inbound. A peer message landing after a
  // deliverable buried it, so the wake run served the peer and the
  // deliverable sat unserved until a slow periodic. Pick the newest UNSERVED
  // terminal wake instead; the human-wins gate below is unchanged.
  if (!terminalWakeA2A) {
    try {
      const { findUnservedTerminalWake } = await import('./counterparty.js');
      const buried = findUnservedTerminalWake(agentId);
      if (buried) {
        const b = db.prepare('SELECT a2a_intent, a2a_thread_id, source_agent_id FROM messages WHERE rowid = ?')
          .get(buried.rowid) as { a2a_intent: string; a2a_thread_id: string; source_agent_id: string | null } | undefined;
        if (b) {
          const senderRow2 = b.source_agent_id
            ? (db.prepare('SELECT name FROM agents WHERE id = ?').get(b.source_agent_id) as { name?: string } | undefined)
            : undefined;
          terminalWakeA2A = {
            intent: b.a2a_intent,
            threadShort: b.a2a_thread_id.slice(0, 8),
            threadId: b.a2a_thread_id,
            fromName: senderRow2?.name ?? b.source_agent_id ?? 'another agent',
            rowid: buried.rowid,
          };
          logger.info('v2: buried terminal wake selected (newer non-wake inbound had hidden it)', {
            agentId, intent: b.a2a_intent, thread: b.a2a_thread_id.slice(0, 8),
          }, agentId);
        }
      }
    } catch { /* best effort; the turn falls back to normal classification */ }
  }
  // The user always wins: if a real user-channel message is still unanswered
  // (newer than our last user-facing text reply), this is a user turn even if
  // an A2A is forced/pending, answer the user now, the A2A re-defers to its
  // own turn. Without this, a forced A2A turn hijacks a fresh user message and
  // the user's question is silently dropped. (Assistant text replies persist
  // as plain strings; tool-call/content-block messages persist as '[{...}]'.)
  // Is there a GENUINE human conversation still WAITING (an unanswered message,
  // per the per-conversation served tracking above)? This is the "user wins"
  // signal: a waiting human means this is a user turn and any pending A2A defers
  // to its own turn. Engine events and A2A are not human conversations, so they
  // never make this true (the bug that forced isA2ATurn=false and leaked A2A
  // chatter to the dashboard).
  const hasUnansweredUser = waitingConvs.length > 0;
  // An A2A turn is either the reply-needed case (an unreplied QUESTION/ASSIGN/BLOCK,
  // forced or most-recent) OR a terminal-wake (a peer handed back a DELIVERABLE/
  // ANSWER/COMPLETE/FAIL that woke us). Both need the live tail scoped to the A2A
  // thread (scopeToA2AThread) so the agent SEES the message instead of having it
  // stripped. The waiting-human guard is shared: a real user always wins the turn.
  const isA2ATurn =
    !hasUnansweredUser &&
    ((unrepliedAssign !== null && (mostRecentIsA2A || forcedA2ATurn)) || terminalWakeA2A !== null);
  if (isA2ATurn) lastTurnWasA2A.add(agentId); else lastTurnWasA2A.delete(agentId);
  // The terminal wake DRIVES this turn only when there is no competing reply-needed
  // obligation (an unreplied QUESTION/ASSIGN/BLOCK wins the counterparty + enforcer,
  // and its own thread is scoped instead). Only then is the terminal message the one
  // this turn scopes to and should claim.
  const terminalWakeDrivesTurn = isA2ATurn && terminalWakeA2A !== null && unrepliedAssign === null;
  // PHASE-2 T4: the terminal-wake claim is the SERVE edge, not a fake conversation.
  //
  // It used to stamp `conv_key='a2a'` — a sentinel that is not a conversation, on the column
  // that carries conversation IDENTITY, purely so `findUnservedTerminalWake` (whose predicate
  // was `conv_key IS NULL`) would stop returning the row. That is the same overloading the
  // owner-ask queue was rekeyed off at T3, and it is the last one in the A2A lane (3l).
  // `messages.served_by_turn` already means exactly "a turn took this", it is already stamped
  // on this row a few lines below, and the finder now reads it.
  // requirement preserved: the driving wake drives exactly ONE turn — without a stamp it stays
  // most-recent and unserved, and a later spurious wake would re-detect it and (worst case)
  // re-relay the deliverable to the owner.
  if (terminalWakeDrivesTurn && terminalWakeA2A) {
    // P1 lineage spine: an A2A wake turn's root is its thread.
    const twThread = (terminalWakeA2A as unknown as { a2a_thread_id?: string | null }).a2a_thread_id;
    if (twThread) turnCtx.root = { kind: 'a2a', id: String(twThread), sourceMessageId: null };
  }

  // ── Engine turn classification (OPEN-11) ──
  // A turn triggered by an engine event, a scheduler task or reminder firing
  // (a role='user' row with origin_kind='engine'). The owner always wins: only
  // when no human conversation is waiting and this isn't an A2A turn does the
  // engine event drive the turn. On an engine turn the assembler scopes the live
  // tail to the engine event (scopeToEngineTurn) instead of the owner's human
  // chat, so an hour-old already-answered request can't be run in place of the
  // scheduled task (the gastro-digest-ran-a-stale-RAM-rundown hijack). The
  // scheduler payload itself is the ACTIVE USER DIRECTIVE this turn.
  // E-A2: detect the engine turn from a PENDING (unprocessed) engine event, not
  // just "the most-recent inbound is engine." A human message that arrives in the
  // same window as a scheduler/reminder event makes mostRecentInbound non-engine;
  // the human wins this turn, and without this the engine event would never again
  // be most-recent and would be silently starved (task stuck in_progress). The
  // pending-event check + the runtime drain (which re-triggers while one is pending)
  // give it its own turn after the human is served.
  const pendingEngineEvent = (!isA2ATurn && !hasUnansweredUser) ? getPendingEngineEvent(agentId) : null;
  const isEngineTurn = !isA2ATurn && !hasUnansweredUser && pendingEngineEvent != null;
  // Settled-context wake (owner report 2026-07-09 9:39 PM, third re-chase
  // specimen): when NO human is waiting at turn start, every user conversation
  // this turn can see is, by definition, already answered (a fresh human ask
  // would be in waitingConvs). The engine's claim bookkeeping knows this; the
  // model cannot see that bookkeeping, so on background wakes it sometimes
  // re-answers the last visible question as if it were new. On these turns an
  // [Engine hint] is injected at the context tail (see the assembly site) and a
  // turn-end tripwire logs any user-facing outbound for calibration.
  // PHASE-2 T6 (C8, requirement 1e): ONE QUERY on the spine, taken at turn start (see
  // `openHumanWorkAtTurnStart` above), not the length of an array the loop had to build.
  // `hasUnansweredUser` still routes the TURN — it needs the conversations themselves —
  // but the settled consumers only ever needed the boolean, and building fifty rows with a
  // per-row origin re-derivation to learn it is the shape requirement 1e exists to remove.
  const settledContextWakeTurn = !openHumanWorkAtTurnStart;
  // Two readings of ONE fact, so a disagreement is a finding rather than a mystery. The
  // ticket gate and the waiting set apply the same `deriveOrigin` verdict to the same rows,
  // so they can only diverge on a ticket whose root message is gone, or on a producer that
  // opened one for something that is not a person asking — both defects, and both worth a
  // line in the log the day they appear. (They are the unauthorized-ticket family C7
  // disposes of, and this line is how a new producer of them announces itself.)
  if (openHumanWorkAtTurnStart !== hasUnansweredUser) {
    logger.warn('v2: the settled read and the waiting set DISAGREE about whether a person is waiting', {
      agentId, openHumanWorkAtTurnStart, waitingConversations: waitingConvs.length,
    }, agentId);
  }
  // RC-5.2: a NOTIFICATION turn, a wake with no trigger row, not A2A, not an engine
  // event, whose newest inbound row is an UNAUTHORIZED human notice (a mailbox event
  // about the owner's inbox, an unknown sender). resolveTurnCounterparty on a null
  // trigger falls through to the owner-on-dashboard header, which the awareness lane
  // contradicts; on the weak model the header won and every notification read as an
  // open channel to the owner. isNotificationTurn drives a dedicated header variant
  // (renderCounterpartyHeader) that tells the model NOT to greet/message the user
  // unless the item genuinely matters, and to end with [no-reply] otherwise. Distinct
  // from isEngineTurn (a scheduler/reminder the agent must act on) and from a settled
  // wake whose newest inbound was an already-answered authorized ask.
  const isNotificationTurn =
    !triggerRow &&
    !isA2ATurn &&
    !isEngineTurn &&
    mostRecentInbound != null &&
    mostRecentInbound.lane !== 'events' &&
    !mostRecentInbound.a2a_thread_id &&
    deriveOrigin({
      role: 'user',
      content: mostRecentInbound.content,
      ...legacyOriginInputs(mostRecentInbound.lane, null),
      sourceAgentId: mostRecentInbound.source_agent_id,
      a2aThreadId: mostRecentInbound.a2a_thread_id,
      a2aIntent: mostRecentInbound.a2a_intent,
      a2aRequiresResponse: mostRecentInbound.a2a_requires_response,
      inboundMeta: mostRecentInbound.inbound_meta,
      originIntent: mostRecentInbound.origin_intent,
    }).authorized === false;
  // Mark the engine event PROCESSED at pickup (mirrors the human pickup-stamp) so it
  // can't re-fire and so getPendingEngineEvent stops returning it.
  //
  // PHASE-2 T9: the sentinel `conv_key='engine'` is gone. "Processed" is `served_by_turn`,
  // the real serve edge, which this turn already stamps on this very row below — so the
  // ATOMIC claim moved down there (`claimEngineEventByRowid`), where the turn number it
  // records exists. What is left here is the cheap READ of the same edge, which still bails
  // the common stray-process case before the turn does any work.
  if (isEngineTurn && pendingEngineEvent) {
    let engineClaimed = true;
    try {
      engineClaimed = isRowUnserved(pendingEngineEvent.rowid, agentId);
    } catch { /* best effort: the CAS below is the authoritative answer */ }
    // D8: remember OUR intent to claim; `claimedEngineEvent` is only SET once the CAS wins,
    // so a no-answer abort can revert exactly what it took (see revertTriggerStampOnAbort).
    if (engineClaimed) pendingEngineClaim = { rowid: pendingEngineEvent.rowid };
    // P1 lineage spine: this turn serves the engine event; if the row carries a
    // run/task referent (migration 112 columns), the root is that occurrence,
    // and the served task's kind/origin are published to turn-state so lanes
    // (reminder delivery) can read what this turn's output belongs to.
    if (engineClaimed) {
      turnCtx.root = pendingEngineEvent.runId
        ? { kind: 'occurrence', id: pendingEngineEvent.runId, sourceMessageId: null }
        : { kind: 'engine', id: pendingEngineEvent.id, sourceMessageId: null };
      if (pendingEngineEvent.taskId) {
        try {
          // PHASE-6 T0D: the map used to be set even when this read came back
          // EMPTY, publishing a dead task id to five readers — `stale-work-ids.ts`.
          const served = resolveServedWork(pendingEngineEvent.taskId, pendingEngineEvent.runId);
          if (served) turnCtx.servedWork = served;
          else {
            logger.warn('v2: the engine event names a task row that is not there; serving no work this turn', {
              agentId, taskId: pendingEngineEvent.taskId,
            }, agentId);
          }
        } catch { /* best effort; the lane simply stays inactive */ }
      }
    }
    if (!engineClaimed) {
      // C24: symmetry with the human pickup-claim above — the event is already served, so
      // ANOTHER process picked it up. Bail cleanly instead of running a DUPLICATE engine
      // turn. Single-process production never hits this; it guards stray dev `tsx watch`
      // processes on the one SQLite DB.
      logger.warn('v2: engine event already served, another process claimed it; skipping to avoid a duplicate engine turn', { agentId, rowid: pendingEngineEvent.rowid }, agentId);
      setAgentStatus(agentId, 'idle');
      return;
    }
  }

  // Now that the turn kind is known, record it and re-broadcast the working
  // status with it so the composer can stay quiet on pure A2A turns (unless
  // wordy mode is on). The DB status was already set to 'working' at turn start;
  // this is a broadcast-only update and the 30s heartbeat reads the same map.
  turnCtx.kind = isA2ATurn ? 'a2a' : 'user';
  // PHASE-6 T1: the two turn-entry clears here (`clearTurnReceipts`, `clearRecallBudget`)
  // are gone with their functions — C26's receipt register and RC-3's recall brake start
  // clean because the bag is new, not because two calls were remembered.
  broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: isA2ATurn ? 'a2a' : 'user', userFacing: !!chosenConvKey });

  // Enforcer arms ONLY on A2A turns AND only for reply-needed intents. On a user
  // turn a pending/lingering A2A must not force a send_to_agent into the user-facing
  // reply. A terminal-wake turn is an A2A turn but is NOT reply-needed (the sender
  // handed back a deliverable and closed the thread), so a2aReplyContext stays null
  // and the missed-reply enforcer is not armed, exactly right: there is nothing to
  // reply to, only a deliverable to act on.
  const a2aReplyContext = isA2ATurn
    ? (unrepliedAssign
        ? { intent: unrepliedAssign.intent, threadShort: unrepliedAssign.threadShort, fromName: unrepliedAssign.fromName }
        : parseA2ATrigger(lastUserMessageContent))
    : null;
  const a2aReplyAssignMessageId = isA2ATurn ? (unrepliedAssign?.messageId ?? null) : null;
  // The A2A thread IDENTITY used to render the counterparty header and scope the
  // live tail (scopeToA2AThread). For a terminal wake there is no reply context, so
  // fall back to the terminal message's own thread/sender, without that, the
  // counterparty carries a null thread and scopeToA2AThread would drop the very
  // deliverable that woke the agent (the bug this fixes). Distinct from
  // a2aReplyContext, which stays null so the enforcer does not arm.
  const a2aCounterpartyIdentity = a2aReplyContext
    ?? (terminalWakeA2A
        ? { intent: terminalWakeA2A.intent, threadShort: terminalWakeA2A.threadShort, fromName: terminalWakeA2A.fromName }
        : null);

  // ── Turn counterparty (attribution redesign, Phase 3) ──
  // The single entity this turn is addressing, resolved from structured origin.
  // Drives the explicit "who you're talking to" header (Phase 3) and the
  // fresh-tail scoping (Phase 4). Derived from the same signals computed above.
  // C3: on a human-task continuation, restore the ORIGINAL counterparty so the final
  // answer routes to the conversation's real channel/person (the empty-trigger
  // continuation has no inbound to resolve from). Otherwise resolve normally.
  const counterparty: TurnCounterparty = isHumanContinuation
    ? continuation!.counterparty
    : resolveTurnCounterparty({
        isA2ATurn,
        a2aFromName: a2aCounterpartyIdentity?.fromName ?? null,
        a2aThreadShort: a2aCounterpartyIdentity?.threadShort ?? null,
        triggerContent: lastUserMessageContent,
        triggerLane: triggerRow?.lane ?? null,
        triggerChannel: triggerRow?.channel ?? null,
        triggerInboundMeta: triggerRow?.inbound_meta ?? null,
        inboundChannel,
      });

  // T-4: publish this turn's iMessage recipient (the human counterparty) so an
  // explicit no-recipient imessage_send / image_create reply goes to THIS person.
  if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
    turnCtx.imRecipient = counterparty.senderId;
  } else {
    turnCtx.imRecipient = undefined;
  }

  // RC-10: owner-channel affinity, resolved ONCE here so the SAME value drives both the
  // counterparty header (so the model is never told "dashboard" on a turn the engine
  // will text) and the end-of-turn reply routing. Applies only when: the counterparty
  // is the owner (never a contact), the natural destination would be the dashboard (not
  // a bound routed channel, and never voice/phone), the owner's most recent contact was
  // iMessage within 48h, the bridge is configured, and the per-conversation rate limit
  // allows a promotion. The presence-away override at end-of-turn remains stronger.
  // RC-5.3: an authorized owner inbound (the owner is present and engaging) resets the
  // proactive-send backoff. A settled-context wake has no trigger row, so only a genuine
  // owner message clears the streak; every unanswered proactive ping keeps it climbing.
  if (triggerRow && counterparty.kind === 'user' && counterparty.relation === 'owner') {
    resetProactiveSendStreak(agentId);
  }

  // P5c: the affinity cooldown is keyed by the CONVERSATION ROW. Owner-addressed
  // dashboard-default turns (the only promotion case) all belong to the owner's
  // one dashboard conversation per agent, the same identity the chat route
  // stamps, so resolve that row lazily inside the promotion guard.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): both live on the turn's bag — the pair is one
  // mechanism (the destination is meaningless without the conversation its cooldown is
  // keyed to) and both cross into the `finalize` span, which decides the reply's
  // destination and records the promotion. Written once each, here, in straight-line code.
  {
    const destinationWouldBeDashboard =
      counterparty.channel !== 'imessage' && counterparty.channel !== 'teams' &&
      counterparty.channel !== 'email' && counterparty.channel !== 'sms' &&
      counterparty.channel !== 'phone' && counterparty.channel !== 'voice';
    if (counterparty.kind === 'user' && counterparty.relation === 'owner' && destinationWouldBeDashboard) {
      try {
        const { isImessageConfigured } = await import('../../services/presence.js');
        const bridgeConfigured = isImessageConfigured();
        const affinity = resolveOwnerAffinityChannel(agentId, { imessageBridgeConfigured: bridgeConfigured });
        if (affinity === 'imessage') {
          const { resolveOrCreateConversation } = await import('../../memory/conversations.js');
          turnCtx.ownerAffinityConversationId = resolveOrCreateConversation(agentId, {
            channel: 'dashboard', provider: null, counterpartyId: 'owner', threadRoot: null,
          });
          if (affinityPromotionAllowed(agentId, turnCtx.ownerAffinityConversationId)) {
            turnCtx.ownerAffinityDestination = 'imessage';
          }
        }
      } catch { /* best effort; a resolution failure just leaves the reply on the dashboard */ }
    }
  }

  // ── P4 turn record: allocate this turn's IDENTITY and record what it SERVES ──
  //
  // PHASE-2 T2: the turn number is allocated by the `turns` table itself, in-transaction
  // (`INSERT … SELECT COALESCE(MAX(turn_number),0)+1 … RETURNING`), and NOT derived here from
  // `MAX(messages.turn_number)`. The old derivation was wrong in two live situations — a turn
  // that writes no messages, and an agent whose history was cleared — because `messages`
  // restarts while `turns` keeps climbing, so the derived number collided with an already
  // recorded turn and the old `ON CONFLICT DO UPDATE` overwrote it in silence. Both facts now
  // come from one place. Per Part XVIII §E turn_number stays per-agent and monotonic; it no
  // longer resets when history is cleared, which is the honest reading of "turn 41 of this
  // agent's life".
  const turnNumber: number = (() => {
    const root = turnCtx.root ?? null;
    const kind: 'user' | 'a2a' | 'engine' | null =
      isEngineTurn ? 'engine' : ((isA2ATurn || terminalWakeA2A) ? 'a2a' : (chosenConvKey ? 'user' : null));
    const subjectKind = isEngineTurn ? 'engine_event' as const
      : (isA2ATurn || terminalWakeA2A) ? 'a2a_thread' as const
      : chosenConvKey ? 'conv' as const
      : isHumanContinuation ? 'continuation' as const
      : 'none' as const;
    const subjectId = isEngineTurn ? (pendingEngineEvent?.id ?? null)
      : terminalWakeA2A ? terminalWakeA2A.threadId
      : isA2ATurn ? ((terminalWakeA2A as unknown as { a2a_thread_id?: string | null } | null)?.a2a_thread_id ?? null)
      : chosenConvKey;
    turnCtx.modelRequestId = `req_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    return startTurn({
      agentId, kind, subjectKind, subjectId,
      // P8: typed spoken-stream lane on the record.
      lane: latestUserSource === 'voice' ? 'voice' : inboundChannel === 'phone' ? 'phone' : null,
      rootKind: root?.kind ?? null, rootId: root?.id ?? null,
      sourceMessageId: root?.sourceMessageId ?? null, convKey: chosenConvKey,
    });
  })();
  // RC-12: publish the turn number so writeToolReceipt can stamp turn_number on
  // engine receipts without threading it through every send executor. Cleared at
  // the turn's `finally`, like every other fact in the bag.
  turnCtx.turnNumber = turnNumber;
  // S3 (PHASE-3 T3): restart rehydration, at the TURN, once per agent per process.
  // `memory/assembler.ts:1262-1281` (pre-repin) did this from inside the assembly read path
  // on EVERY assembly — a mutation on a read, and one that re-broke the cached tools prefix
  // for every agent on the first assembly after any restart. The requirement it encoded (an
  // agent should not have to re-call load_tool_docs for a tool it was already using before
  // the server restarted) is preserved exactly, at the boundary where a restart is visible.
  try {
    const { rehydrateSessionToolsFromHistory } = await import('../../tools/tool-docs.js');
    rehydrateSessionToolsFromHistory(agentId);
  } catch { /* best effort — never break a turn over a cache warm-up */ }
  // Per-ask forward link: the claimed trigger records WHICH turn serves it (the claim
  // above only made it invisible to the waiting set). Two rows, one fact: the ticket's
  // `claimed_by_turn` is what the delivery close and the boot reconciliation read; the
  // message's `served_by_turn` is the message-side lineage the answer stamp joins on.
  // The ticket is stamped HERE and not at the claim because the turn number is allocated
  // from the subject the claim itself decides — and the D-2 race has to be settled before
  // any of that runs.
  try {
    if (triggerWorkId) {
      stampClaimingTurn(triggerWorkId, turnNumber);
    }
    if (triggerRow) {
      markServedByRowid(triggerRow.rowid, turnNumber);
    }
    // PHASE-2 T9 — THE ENGINE EVENT'S ATOMIC CLAIM, and it is this stamp.
    // It used to be an unconditional re-stamp of a row already claimed by the
    // `conv_key='engine'` sentinel 155 lines above. With the sentinel gone, the stamp IS the
    // claim: a CAS on `served_by_turn IS NULL`. A loss means another process took the event,
    // and the turn continues WITHOUT owning it — so no revert and no delivery-failure
    // bookkeeping is recorded against a claim it never held.
    if (pendingEngineClaim) {
      const won = claimEngineEventByRowid({ rowid: pendingEngineClaim.rowid, agentId, turnNumber }) > 0;
      if (won) {
        claimedEngineEvent = { rowid: pendingEngineClaim.rowid, turnNumber };
      } else {
        logger.warn('v2: engine-event claim lost at the serve edge; this turn does not own the event', {
          agentId, rowid: pendingEngineClaim.rowid, turnNumber,
        }, agentId);
      }
    }
    // GATED on driving the turn, and that gate is load-bearing since T4. A terminal wake that
    // exists but LOST the turn (an unreplied QUESTION/ASSIGN/BLOCK wins the counterparty, or a
    // human is waiting) must stay UNSERVED so it gets its own turn later — that is the whole
    // point of "the A2A re-defers to its own turn". Before T4 the wake's un-served-ness was
    // tracked by a second column (`conv_key`), so stamping `served_by_turn` unconditionally
    // here was inert; now it is the finder's own predicate, so an ungated stamp would
    // SWALLOW the wake. The two stamps disagreed; they agree now.
    if (terminalWakeA2A && terminalWakeDrivesTurn) {
      markServedByRowid(terminalWakeA2A.rowid, turnNumber);
    }
  } catch { /* best effort */ }

  // Snapshot turn boundary so context assembly excludes mid-run user messages
  const turnStartedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  turnBoundary.set(agentId, turnStartedAt);

  // Remediation Phase 5 (5a): if a technique gets injected this turn, the
  // turn's outcome (completed vs errored) is written back to its usage row.
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): on the turn's bag — it crosses into the
  // `finalize` span (the success write-back) and the teardown package already takes it
  // as a context field, which the driver closure below now feeds from the bag.

  // D6: the technique-acknowledgement gate no longer blocks (the hard gate was
  // removed, see the tool loop) and is per-turn only. Do NOT hydrate it from
  // agents.config across turns: a pending ack left over from a prior turn used
  // to resurrect a global tool lock on an unrelated later turn with no expiry.
  const initialPendingTechniqueAck: import('./state.js').AgentTurnState['pendingTechniqueAck'] = null;

  // Initial state
  let state = initState({
    agentId,
    contextWindow,
    isAutoRouted,
    configuredModelId,
    turnNumber,
    triggeredByIMessage,
    triggeredByA2AReplyIntent: a2aReplyContext,
    lastUserMessageContent,
    lastUserMessageId,
    inboundChannel,
    inboundContext,
    pendingTechniqueAck: initialPendingTechniqueAck,
  });

  // C4: re-arm a stranded human ask on a CLEAN-RETRY no-answer break. A deliberate
  // `break` that ends a turn with the trigger still stamped-served (at pickup) strands a
  // human ask that got no answer, it is never re-served (inv 2). This reverts the pickup
  // stamp so the runtime drain re-serves it, but ONLY when the turn is a clean retry:
  //   - no user-facing text (lastAssistantTextForIM), and
  //   - no surfaced reply, and
  //   - no delivery-tool send (explicitSendThisTurn), and
  //   - no NON-IDEMPOTENT execution (nonIdempotentCallsThisTurn === 0; P6b
  //     refinement of the old any-tools-at-all clause, which stranded asks on
  //     purely read-only turns).
  // The last clause is the correctness-critical one: a break after a real side
  // effect (created a task, wrote a file, sent a message) must never re-serve,
  // that would DUPLICATE the effect. Reads/lookups load context and nothing
  // else, so re-serving after them is a safe transient-empty retry. The
  // "did work but didn't reply" cases are owned by the note-then-stopped /
  // going-idle nudges, not by re-serving. Bounded by MAX_DRAIN_STUCK.
  // D8: on an ENGINE turn the same call also reverts the engine-event claim and
  // records the failed delivery (attempt counter + backoff), so an empty give-up
  // turn can't strand a reminder as "processed"; bounded by the 5-attempt lifecycle.
  const reArmIfStrandedNoAnswer = () => {
    if (
      !state.lastAssistantTextForIM &&
      !state.surfacedReplyThisTurn &&
      !Object.values(state.explicitSendThisTurn).some(Boolean) &&
      state.nonIdempotentCallsThisTurn === 0
    ) {
      revertTriggerStampOnAbort();
    }
  };

  // C3: before an engine auto-continue (MAX_TOOL_LOOPS / time-budget / emergency-compact /
  // block), stash the human conversation this turn is serving so the continuation turn, 
  // which fires with an EMPTY trigger and thus has no waiting human, restores it and
  // delivers the final answer to the right person/channel instead of suppressing it as
  // background chatter (see continuationContext). No-op on a non-human turn (chosenConvKey
  // null). On a continuation-of-a-continuation, chosenConvKey is the restored value, so it
  // re-stashes and the chain holds.
  const stashContinuationIfHuman = () => {
    if (chosenConvKey) continuationContext.set(agentId, { convKey: chosenConvKey, conversationId: chosenConversationId, counterparty });
  };

  // Persist + broadcast an outbound routing marker (a role='system'
  // `[Reply routed via <label>]` row). The dashboard hides the raw row and turns
  // it into a "to <recipient> via <channel>" badge on the preceding assistant
  // bubble (parseOutboundRouting + outboundBadge). ONE writer, shared by the
  // engine-ack channel pushes (deliverEngineUserAck, below) and the end-of-turn
  // reply-destination resolver, so every outbound delivery is labeled
  // identically and an engine-sent line is never an unlabeled bubble in the
  // owner's stream (the observed defect). The <label> always carries the
  // recipient the sender actually resolved (e.g. `iMessage to <name>`), never a
  // bare channel word.
  // P6b-2: the marker is the user-visible VIEW; the deliveries ROW is the RECORD everything
  // load-bearing reads.
  //
  // PHASE-2 T5: THIS FUNCTION NO LONGER WRITES THAT ROW. It used to take the delivery facts
  // as a parameter and insert them itself — which is how the ledger came to hold 44 rows of
  // one tool, every one of them written by a caller that had already decided the send worked.
  // A caller cannot know that; only the transport can. The row is now written by the door the
  // send passes through, inside the outbound scope each site below declares, and what is left
  // here is exactly what it should always have been: the badge the owner sees.
  const persistRoutingMarker = (label: string): void => {
    const tagId = uuidv4();
    const tagContent = formatRoutingMarker(label);
    insertMessageIfAbsent({ id: tagId, agentId, role: 'system', content: tagContent, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: tagId, agentId, role: 'system' as const,
        content: tagContent,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  };

  // T9 (research 17 D4 — "reload-only rows"): the mirror image of the empty-bubble hack.
  // Three engine steers below each INSERTED a role='system' row and told nobody, so wordy
  // mode showed them after a refresh and never live. This helper is the pairing, in one
  // place, so it cannot come apart again. It adds NO new text: regular mode hides every
  // role='system' row (the client short-circuits before classification), so the only view
  // that changes is wordy — which now matches its own reload.
  const persistAndBroadcastSystemRow = (content: string): string => {
    const rowId = uuidv4();
    insertMessageIfAbsent({ id: rowId, agentId, role: 'system', content, turnNumber });
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: rowId, agentId, role: 'system' as const, content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
    return rowId;
  };

  // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01) — `persistCrossConvSendEcho` and its three call
  // sites are DELETED. RC-1 dual-homed a cross-recipient send by PERSISTING A SECOND ROW: when
  // the agent asked Sam a question while replying to Maya, the sent text lived only in Maya's
  // tool rows, `scopeToHumanConversation` correctly kept it out of Sam's next turn, and Sam
  // then answered a question with no visible trace of ever being asked. The repair duplicated
  // the message into Sam's conversation. It worked, and it was a duplicate mechanism: history
  // the platform had already recorded, written a second time in a different shape, then re-read
  // as history and re-billed inside the fresh tail on every turn until it aged out — and it
  // could never be truncated, because it was indistinguishable from a real message.
  //
  // requirement preserved: (1) THE RECIPIENT'S NEXT TURN SEES THE QUESTION IT WAS ASKED —
  // `memory/deliveries-lane.ts` (T7 Step 1), which reads the `deliveries` rows natively for
  // the conversation being served, carries up to three of them newest-first against a declared
  // 316-token reserve, and renders the one-row case as RC-1's header byte for byte. Its
  // no-bleed half — a question asked in another conversation never surfaces here — is pinned by
  // `deliveries-lane.test.ts` "a send into ANOTHER conversation never surfaces on this turn",
  // written BEFORE this deletion. (2) THE SEND STAYS VISIBLE IN THE DASHBOARD FEED —
  // `persistRoutingMarker` (below), persisted and broadcast for exactly the three send families
  // this echo covered.
  //
  // Measured on this body at the strip: `SELECT COUNT(*) FROM messages WHERE
  // origin_intent='cross_conv_send_echo'` -> 0. That is an ABSENCE, not evidence of death
  // (#15): the writer was alive and this dev box simply never made a cross-recipient channel
  // send. The positive evidence is the named replacement above, not the row count.

  // ── Engine-enforced human acknowledgment (NEXT-WAVE item 1) ──
  // When the multistep classifier deems a user request tracker-project-worthy,
  // the person who asked MUST hear "on it" when the work starts and "done" when
  // it finishes, EVERY time, regardless of what the floor model chooses to emit
  // (architecture rule 1: the engine enforces correctness, it never relies on
  // the model obeying a prompt). The nudge-only path (BOOKKEEPING_NUDGE) failed
  // in production: the floor model ignored it and ended the turn on a
  // send_to_agent A2A, so the owner heard nothing on a real backup+reset job.
  //
  // This helper delivers ONE plain, user-voiced ack immediately to the person's
  // ACTUAL channel: the dashboard broadcast is universal, and for a live
  // iMessage / phone / SMS counterparty we also push it straight to that channel
  // so an away user hears it now, not only when they open the dashboard. It is
  // an assistant-role message (a real thing the agent said), NOT engine
  // suppression of the model's own reply. Fires only for user counterparties;
  // A2A / engine turns never reach the classifier that calls it.
  // PHASE-6 T6 (CUT 8): the delivery latch and its partner `deferredDeliveredByAck` MOVED to
  // the turn's bag — `postCallClassify` WRITES both and the wall-clock timer READS the first
  // at fire time, which by value would double-ack. Reasons at the fields (RULING P6-R3(1)).
  // Start-ack steer lifecycle (owner ruling 2026-07-22): requested (async-safe
  // intent set by the timer/first-tool hook) -> armed (steer injected at a loop
  // boundary, state write is loop-synchronous) -> delivered (the model's own
  // line surfaced via the capture site). The engine never composes the line.
  // PHASE-4 T3: `nudgedForGoingIdleWithInProgressThisTurn` carried TWO jobs — the steer's
  // one-shot latch (now the queue entry) and "the detector ran", read by the recurring-
  // dangler hardcap on the branch that deliberately does not steer. Only the first latched.
  let goingIdleDetectorRanThisTurn = false;
  // PHASE-6 T4 (CUT 6): the four F10 start-ack steer locals MOVED to the turn's bag —
  // one mechanism, split across four spans, and the request flag is written from the
  // wall-clock TIMER below, which is the by-value test's own disqualifier. The cap
  // (2: first steer, one reminder) and the loop index the first steer rode are bounded
  // state, not a snapshot. Reasons at the fields (RULING P6-R3(1)).
  // originIntent stamps a machine-readable marker on the ack row so consumers
  // (the completion-ack cross-turn dedup, the PM poke chain, the F10 replied-
  // check) recognize an engine ack STRUCTURALLY instead of by copy prefix,
  // which is what lets the wording vary freely. origin_kind is deliberately
  // left NULL: an assistant row with only origin_intent still classifies as
  // normal user-visible agent speech (deriveOrigin keys engine-origin off
  // origin_kind, and the display classifier ignores origin_intent on assistant
  // rows), so the ack still shows in chat exactly as before.
  // originIntent defaults to null so a non-ack caller (e.g. the thrash-block
  // user notice) keeps origin_intent NULL and stays a substantive reply. The
  // start-ack sites pass 'engine_start_ack' explicitly.
  // Captured text-with-tools that MIGHT be the user's genuine answer (set by the
  // demotion block, consumed by G-SUP-2 / the start-ack / the [no-reply]
  // promotion). Declared HERE, above the ack closures, so the start-ack timer
  // can capture it (2026-07-16, the trivial-save sequence).
  // PHASE-6 T9 (CUT 4), RULING P6-R3(1): on the turn's bag — it crosses into the
  // `finalize` span, where G-SUP-2 recovers it. The declaration comment above kept a
  // reason that had stopped being true (the start-ack timer no longer reads it; that
  // branch was retired 2026-07-23); the measurement is recorded at the field.
  // Ghosted-work-ask floor (2026-07-22): the multistep classifier's verdict on
  // THIS turn's inbound, so the [no-reply] handling can tell a work ask (silence is
  // never valid) from chatter (silence is fine). 'user_creating_explicitly' counts as
  // work: multistep=false there only means the ENGINE defers scaffolding to the model,
  // not that no work was asked.
  // PHASE-6 T4 (CUT 6): MOVED to the turn's bag — `assemble` writes it and
  // `postCallClassify` reads the write. Reason at the field (RULING P6-R3(1)).
  // The TRUTHFUL answer key (2026-07-22 silent-completion root fix): set ONLY
  // at the persists that genuinely deliver a user-facing reply (the terminal
  // persist, the G-SUP-2 recovery, the attachment surfacing nets), NEVER at
  // acks, working notes, or chip echoes. Turn finalize keys outcome='answered'
  // and answer_message_id on THIS, replacing the old any-text-row SELECT that
  // counted mid-turn captions as answers (which stamped asks answered, muted
  // the completion ack, and inflated ticket stamps).
  let terminalAnswerRowId: string | null = null;
  /**
   * PHASE-2 T6 (C4, requirement 1g) — the truthful-answer key has ONE setter.
   *
   * Four bare assignments were four writers of one fact, which is how the fact drifts
   * (research 07: any non-JSON assistant text once counted, and silent-ending turns were
   * stamped answered). The four SURFACES stay; the rule is stated once and is greppable.
   * requirement preserved: this key and nothing else decides `turns.answered`, the outcome
   * ladder's `answered` rung, and the ticket stamps' answer/delivery columns.
   */
  const noteTerminalAnswer = (rowId: string, surface: string): void => {
    terminalAnswerRowId = rowId;
    logger.debug('v2: truthful-answer key set', { agentId, rowId, surface }, agentId);
  };
  // True when the start-ack already delivered the deferred text as the turn's
  // user-visible answer; gates the terminal promotion and the redundant-closeout
  // floor so the answer can never double-send.
  // PHASE-6 T6 (CUT 8): on the turn's bag with its partner — see the field.
  // Identical-call brake state (2026-07-17): consecutive identical failing
  // tool calls this turn, keyed by exact call signature. See identical-call-brake.ts.
  const identicalCallState: RepeatCallState = new Map();
  // Terminal spin-brake state (owner ruling 2026-07-19): once ANY signature
  // goes terminal, the whole tool phase is over for this turn; every further
  // tool call returns a short note without executing, and after a small grace
  // of model iterations the loop concludes. The model's TEXT is never touched.
  // PHASE-6 T5 (CUT 5): both MIGRATED to the turn's bag under RULING P6-R3(1). This is
  // the one carrier family in this tranche whose by-value alternative is measurably
  // wrong in BOTH directions — the flag is latched in `execute` and read in `callLLM`,
  // the grace is written in `callLLM` and must survive into the next iteration. The
  // grace's initial value (2) moved with it, to the field's own initialiser.
  // `loopBlockFiredThisTurn` — DELETED, PHASE-2 T6 (C9; T1 adjudication #3). verdict: STRIP.
  // One assignment, zero reads (re-derived at this HEAD across packages/server,
  // packages/dashboard, watchdog and the tests), plus a docblock still describing its
  // deleted consumer — the going-idle `deliverable_shown` stamp — in the present tense.
  // requirement preserved: "a reply the engine FORCED with a STOP order is a status update,
  // not a delivery" is the TURN OUTCOME's job now (`exit_reason` computes `brake` ahead of
  // `answered`; task-stamps gates on `outcome === 'answered'`), locked by
  // `tracker/__tests__/coerced-reply-not-a-delivery.test.ts` including its ternary-order
  // conformance. That test is what makes this deletion safe rather than merely tidy.
  // Reminder-delivery lane refuse-once memory (turn-local): first non-owner
  // send on a reminder turn is refused with guidance; an identical repeat is
  // a deliberate confirmation and proceeds.
  const reminderLaneRefusedSigs = new Set<string>();

  const deliverEngineUserAck = async (text: string, originIntent: string | null = null, reuseId: string | null = null): Promise<void> => {
    // reuseId (2026-07-23, owner .19 report: doubled bubble): when the text
    // being delivered ALREADY streamed live under a bubble id, persist and
    // broadcast under THAT id so the streamed bubble becomes the delivered
    // message instead of a duplicate appearing next to a demoted note.
    const ackId = reuseId ?? uuidv4();
    try {
      insertMessageIfAbsent({ id: ackId, agentId, role: 'assistant', content: text, turnNumber, originIntent });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: ackId, agentId, role: 'assistant' as const,
          content: text,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.warn('v2: engine user-ack persist/broadcast failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
    // Immediate delivery to a non-dashboard counterparty's own channel. The
    // dashboard already has it via the broadcast above; this reaches an away
    // user on the channel they wrote in on. Best-effort: a channel failure still
    // leaves the ack in chat + the store.
    // Stamp the SAME routing marker the reply resolver writes whenever this ack
    // is pushed to a non-dashboard channel, so an engine-sent line reaching an
    // away user's phone renders with a "to <recipient> via <channel>" badge in
    // the dashboard, identical to the model's own channel sends. Without this an
    // engine-pushed ack was an unlabeled bubble in the owner's interleaved
    // stream (the observed defect).
    try {
      // ⚠ OR2-PROVISIONAL: CLOSED, PHASE-4 T4 (2026-08-02), and the disposition is a
      // CORRECTION rather than a removal. The marker predicted this lane would be converted
      // to "steer + verify + system voice", because the lane was carrying engine-composed
      // prose. It no longer is: after T4 deleted E1-E5, `deliverEngineUserAck` has exactly
      // ONE production caller (`:4582`), and what it delivers there is `startLine` — THE
      // MODEL'S OWN WORDS, the start-ack steer working as designed (§T0-PINS E names it as
      // the shape OR2 WANTS and forbids removing it).
      //
      // So the `engine-ack` tool value survives, and it means something narrower and true:
      // this is the model's opening line pushed EARLY, ahead of its answer. That is why the
      // two `NON_ANSWERING_*` sets still exclude it (`answered-edge.ts`, `work/store.ts`) —
      // not because the engine spoke, but because a start-ack is not an ANSWER, and closing
      // an ask on one would mark a question answered before anybody looked at it.
      if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        const { sendResponseViaIMessage } = await import('../../services/imessage-bridge.js');
        const delivered = await withOutboundAsync(
          {
            agentId, tool: 'engine-ack', channel: 'imessage',
            recipientId: counterparty.senderId,
            conversationId: turnCtx.root?.conversationId ?? null,
          },
          async () => sendResponseViaIMessage(text, agentId, counterparty.senderId!, false),
        );
        if (delivered) persistRoutingMarker(`iMessage to ${delivered.name}`);
      } else if (counterparty.kind === 'user' && counterparty.channel === 'phone' && state.inboundContext?.phoneCallSid) {
        const { getCallSession } = await import('../../twilio/call-session.js');
        const session = getCallSession(state.inboundContext.phoneCallSid);
        if (session && !session.isEnded()) {
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'phone',
              recipientId: state.inboundContext.phoneFromNumber ?? counterparty.senderId ?? null,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => session.queueAgentSay(text),
          );
          persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', state.inboundContext.phoneFromNumber ?? counterparty.senderId ?? '(unknown)')}`);
        }
      } else if (counterparty.kind === 'user' && counterparty.channel === 'sms' && state.inboundContext?.smsFromNumber) {
        const { sendSms } = await import('../../twilio/client.js');
        const { getDefaultFromNumber } = await import('../../twilio/auth.js');
        const fromNumber = state.inboundContext?.smsToNumber ?? getDefaultFromNumber();
        if (fromNumber) {
          const smsTo = state.inboundContext.smsFromNumber;
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'sms', recipientId: smsTo,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => sendSms(smsTo, text, fromNumber),
          );
          persistRoutingMarker(`SMS to ${resolveRecipientDisplay('sms', smsTo)}`);
        }
      }
    } catch (err) {
      logger.warn('v2: engine user-ack channel delivery failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };

  // ── F10: wall-clock start-ack timer ──
  // The person who sent a fresh ask hears "on it" at ENGINE_START_ACK_AFTER_MS
  // if no user-visible reply has landed by then. A TIMER, not a loop-boundary
  // check: the first model round can alone take 25s+, so a boundary check
  // cannot fire until moments before the reply (observed: ack 3s before
  // completion, exactly the noise pattern this exists to kill). Armed ONLY
  // when this turn serves a waiting human NOW (triggerRow set, the same
  // "human is waiting" signal the close-out gate trusts): a queued-wakeup /
  // drain / continuation turn has a user counterparty too, and an ack fired
  // there reads as a stray "On it." attached to nothing (observed live).
  // Cancelled in the teardown finally; a fire after the reply is prevented by
  // the DB check (any user-visible assistant text already stamped with this
  // turn_number) plus the shared once-per-turn flag.
  // WORK-GATED (owner report 2026-07-10, slow-local-model screenshot): the ack
  // exists for WORK, not conversation. On a slow model every reply crosses the
  // wall-clock, so a purely time-based ack answered "Hey dude!" with "Starting
  // on this, back with you soon." The gate: the timer only speaks when the turn
  // has STARTED USING TOOLS by the time it fires; a slow chat reply just
  // streams (the working dots cover the wait). Work that begins later than the
  // threshold is covered by the first-tool-call hook at the execution site,
  // which fires this same routine the moment real work starts.
  // PHASE-6 T9b (RULING P6-R3(1)): the handle lives on the turn's bag, not in a
  // driver `let`. It is the ONE mutable local the teardown span both reads and
  // WRITES, and the teardown span is about to become a module — where a by-value
  // parameter would carry the handle in and let the `= null` die at the boundary.
  // `turnCtx.startAckTimer` is a live binding on both sides. Same lifetime: the
  // timer is armed below, after every exit that returns before the main `try`
  // opens, so nothing can arm it and skip the teardown that cancels it.
  // PHASE-6 T7 (RULING P6-R3(1)): the FIRST-TOOL LATCH lives on the bag too, and it
  // is the ONE mutable crossing the `execute` span WRITES. It is written at the first
  // tool dispatch and read HERE, inside the timer callback, at fire time — so by value
  // the timer would read `false` forever and a long working turn would take the
  // "chat-shaped, stay quiet" branch while the person heard nothing. The hazard, and
  // why it completes the F10 family CUT 6 started, are written at the field.
  //   → `turnCtx.anyToolStartedThisTurn`
  // RC-4.4: true while a model call is streaming for this turn, set around the
  // `callModel` await below. PHASE-6 T5 (CUT 5): MIGRATED to the turn's bag under
  // RULING P6-R3(1) — the span writes it and the declaration is the driver's. The
  // comment that stood here claimed the start-ack timer consults it; it does not, and
  // nothing else does either. The measurement, and what is and is not being claimed
  // by moving a flag with no reader, are written at the field.
  // RC-4.2: the turn counterparty is another Dojo agent texting over a human channel
  // (an iMessage safe-sender flagged is_agent). Channel-delivered engine acks (start /
  // completion / A2A-handoff) are gated OFF for such a counterparty: another agent does
  // not need "on it" reassurance, and each ack is a fresh inbound that wakes the peer
  // box, the ack ping-pong (H-5) that produced the duplicate texts to the owner. The
  // human owner's OWN engine acks about her agent's work are unaffected, those go to
  // her dashboard/owner conversation, not to an agent-flagged counterparty.
  const counterpartyIsAgentSender = counterparty.kind === 'user' && !!counterparty.senderIsAgent;
  const startAckArmed = counterparty.kind === 'user' && !!triggerRow && !counterpartyIsAgentSender;
  const startAckArmedAtMs = Date.now();
  // The person has heard something the moment EITHER a user-visible
  // assistant text row landed this turn (the DB check) OR the agent
  // delivered through a channel send TOOL (explicitSendThisTurn). The
  // tool-send case leaves NO assistant text row, so the DB check alone
  // was blind to it and fired a duplicate ack seconds after the model's
  // own send (the observed double-ack, and the stray "On it" after a
  // relay was already sent). `state` is read at fire time, so this sees
  // the flag set during the loop. When the agent truly did nothing on
  // any channel, both are false and the engine still speaks.
  const startAckRepliedNow = (): boolean =>
    Object.values(state.explicitSendThisTurn).some(Boolean) ||
    !!db.prepare(`
    SELECT 1 FROM messages
    WHERE agent_id = ? AND role = 'assistant' AND turn_number = ?
      AND content NOT LIKE '[{%'
      AND origin_intent IS NULL
      AND length(trim(content)) > 0
    LIMIT 1
  `).get(agentId, turnNumber);
  const fireStartAckIfOwed = async (via: 'timer' | 'first-tool'): Promise<void> => {
    try {
      if (turnCtx.engineStartAckDeliveredThisTurn || turnCtx.startAckSteerRequested || turnCtx.startAckSteerArmedThisTurn || startAckRepliedNow()) return;
      // The captured-narration branch (F10, 2026-07-16) that lived here is
      // GONE (owner production report 2026-07-23: "not a single ack"). It
      // delivered whatever mid-work narration was captured ("Let me look at
      // the structure more closely...") AS the ack, short-circuiting the
      // steer, so the model was never actually asked to address the user.
      // Narration is a working note, not an acknowledgment. The trivial-save
      // contract (captured ANSWER must reach the user) lives at the finalize
      // recovery, not here.
      // Owner ruling 2026-07-22 (engine detects, agent speaks): no canned
      // engine line, no compose call. Request the steer; the loop injects it
      // at the next iteration boundary (loop-synchronous state write, so this
      // async timer can never race the loop) and the MODEL speaks the start
      // line in its own voice. The old in-flight-call wait is gone for the
      // same reason: the request is inert until the checkpoint, which
      // re-checks startAckRepliedNow at a safe boundary.
      turnCtx.startAckSteerRequested = true;
      logger.info('v2 F10: start-ack threshold passed with nothing heard; steer requested so the model says it (engine detects, agent speaks)', {
        agentId, turnNumber, via, thresholdMs: ENGINE_START_ACK_AFTER_MS,
      }, agentId);
    } catch (err) {
      logger.warn('v2 F10: start-ack fire failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  };
  if (startAckArmed) {
    turnCtx.startAckTimer = setTimeout(() => {
      if (!turnCtx.anyToolStartedThisTurn) {
        // Chat-shaped so far: the model is composing a reply with no tools.
        // Stay silent (dots cover the wait); if tools DO start later, the
        // first-tool-call hook delivers the ack then. Delivered-flag stays
        // unset on purpose so that hook can still speak.
        logger.info('v2 F10: start-ack threshold passed with no tool activity; staying quiet (chat-shaped turn)', {
          agentId, turnNumber,
        }, agentId);
        return;
      }
      void fireStartAckIfOwed('timer');
    }, ENGINE_START_ACK_AFTER_MS);
  }

  // ── v2.5.46: pre-turn close-out gate detection ──
  // Look up in_progress tasks the agent appears to have abandoned. Pre-
  // v2.7.17 this used `updated_at < turnStartedAt` (any task not touched
  // THIS turn), which made the gate fire every time the user interrupted
  // mid-conversation - even though the agent was actively working the task
  // a minute ago. Now uses a wall-clock threshold so genuinely abandoned
  // tasks are still caught but active mid-conversation work isn't.
  //
  // Per user spec ("if we default to agents creating tasks, they MUST
  // also close them out"): tracker hygiene is still a hard precondition,
  // just with a sane idle window before it kicks in.
  try {
    // (1) Tasks the agent is in_progress on but hasn't touched in the
    // last CLOSE_OUT_IDLE_MINUTES. Any tracker tool call (status update,
    // notes add/edit, complete_step) bumps updated_at, so an actively-
    // worked task naturally stays inside the window.
    const CLOSE_OUT_IDLE_MINUTES = 10;
    const inProgressDanglers = db.prepare(`
      SELECT w.id AS id, w.title AS title, 'in_progress' AS kind FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0
        AND w.updated_at < ?
      ORDER BY w.updated_at ASC
      LIMIT 10
    `).all(agentId, Date.now() - CLOSE_OUT_IDLE_MINUTES * 60_000) as Array<{ id: string; title: string; kind: string }>;

    // (2) Stranded on_deck tasks. Catches the Presenton-shaped failure:
    // agent created a project, did some of it, then abandoned it (often
    // because compaction made them forget the project existed and they
    // spun up a duplicate). The orphans sit in on_deck forever because
    // the existing in_progress-only gate never sees them and the PM's
    // STALE check only chats, doesn't auto-resolve.
    //
    // Criteria: on_deck task assigned to this agent, in a project this
    // agent created, the project has zero in_progress tasks, and the
    // task hasn't been touched in 30+ minutes. The 30-minute floor
    // prevents this from firing inside the same conversation as the
    // creation, only catches genuinely abandoned work between sessions.
    const strandedRows = db.prepare(`
      SELECT t.id AS id, t.title AS title, 'stranded' AS kind FROM work t
      INNER JOIN work p ON p.id = t.parent_id
      WHERE ${taskScope('t')} AND t.agent_id = ?
        AND t.state = 'on_deck'
        AND t.is_paused = 0
        AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
        AND t.schedule_status != 'waiting'
        AND p.requester_id = ?
        AND p.state = 'open'
        AND t.updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM work sib
          WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
        )
      ORDER BY t.updated_at ASC
      LIMIT 10
    `).all(agentId, Date.now(), agentId, Date.now() - 30 * 60_000) as Array<{ id: string; title: string; kind: string }>;

    // BUG-2 (comms-audit convergence pass): NEVER arm the close-out gate on a turn a
    // human is waiting on (`triggerRow` set ⇒ this turn serves a waiting human, by the
    // user-always-wins rule). Task-closeout is Lane 2/3 machinery; per the lane-separation
    // law (see the nudge guard at "counterparty.kind !== 'user'" later in this file) it has
    // no business running in the middle of a Lane-1 conversation about something unrelated, 
    // the danglers are almost always pre-existing background leftovers, not this turn's work.
    // When armed on a conversation turn the gate (a) DELETED the agent's just-streamed reply
    // and (b) REFUSED the tool calls the agent needed to answer, both silent-drop / blocked-
    // turn failures (inv 2, inv 6) on the weak-model floor, where the model routinely answers
    // a fresh ask in plain text without first touching the tracker. Abandoned danglers are
    // still enforced off the conversation path: by this same gate on the next non-conversation
    // turn, and by the PM poke chain (where closeout enforcement belongs).
    const danglingRows = triggerRow ? [] : [...inProgressDanglers, ...strandedRows];
    if (danglingRows.length > 0) {
      state = advance(state, {
        danglingTaskIds: danglingRows.map((r) => r.id),
        nudgedForCloseOutThisTurn: true,
      });
      const inProgressList = inProgressDanglers
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');
      const strandedList = strandedRows
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');

      const sections: string[] = [];
      if (inProgressDanglers.length > 0) {
        sections.push(
          `${inProgressDanglers.length} in_progress task${inProgressDanglers.length === 1 ? '' : 's'} from a previous turn you never closed:\n${inProgressList}`
        );
      }
      // 2026-07-22 production incident: the neutral menu let the floor model
      // pause a DELIVERED task (a new zombie) and redo finished work. When the
      // engine's own records show the work was answered/delivered, the gate
      // says so and names the right disposition instead of offering a menu.
      try {
        const { findDeliveryEvidenceForTask, renderDeliveryEvidence } = await import('../../tracker/delivery-evidence.js');
        const { renderTaskStamps } = await import('../../tracker/task-stamps.js');
        const evidenced: string[] = [];
        for (const r of inProgressDanglers) {
          // Stamps first (mig 124), live join as backfill for pre-stamp rows.
          const st = db.prepare(
            `SELECT w.id AS id, ${stampColumns('w')} FROM work w WHERE w.id = ?`,
          ).get(r.id) as import('../../tracker/task-stamps.js').TaskStampFields | undefined;
          // Tangibility rule (battery catch 2026-07-22): only a recorded
          // HANDOVER (file or channel delivery) earns the close-this text; a
          // bare answered reply is often an ack on a task legitimately
          // waiting (delegation synthesis), and pushing CLOSE on it forged a
          // wrong close. Same standard as the strike-2 engine close.
          if (st && st.last_answered_turn !== null && st.last_delivery_summary) {
            evidenced.push(`  - "${r.title}" (${r.id.slice(0, 8)}): ${renderTaskStamps(st)}`);
            continue;
          }
          const ev = findDeliveryEvidenceForTask(r.id);
          if (ev && (ev.artifacts.length > 0 || ev.deliveredVia.length > 0)) {
            evidenced.push(`  - "${r.title}" (${r.id.slice(0, 8)}): ${renderDeliveryEvidence(ev)}`);
          }
        }
        if (evidenced.length > 0) {
          sections.push(
            `ENGINE RECORDS show these were already ANSWERED/DELIVERED on their own conversations:\n${evidenced.join('\n')}\n` +
            `For each of these, the correct call is work_update(action="status", status="complete") with the result (or work_update(action="complete_step")). ` +
            `Do NOT pause them, do NOT add a "still working" note, and do NOT redo or re-deliver the work.`
          );
        }
      } catch { /* evidence consult is best-effort; the gate still fires */ }
      if (strandedRows.length > 0) {
        sections.push(
          `${strandedRows.length} stranded on_deck task${strandedRows.length === 1 ? '' : 's'} (queued steps on a project you created but stopped working on more than 30 minutes ago, with no in_progress sibling):\n${strandedList}`
        );
      }

      const gateMsg = (
        `[System: REQUIRED close-out, you have abandoned work on the tracker.\n\n` +
        `${sections.join('\n\n')}\n\n` +
        `**This turn must start with a tracker tool call, not a user-facing reply.** ` +
        `Resolve at least one item before doing anything else - call work_update(action="complete_step") (multi-step projects), ` +
        `work_update(action="status") (status="complete" | "blocked" | "paused" with resume_at), ` +
        `work_note (if you are STILL actively working it - then KEEP GOING on this same turn, do not stop after writing the note), ` +
        `or - if the whole project was abandoned/duplicated/superseded - work_update(action="close_project", project_id, status="cancelled", reason="..."). ` +
        `The engine will REFUSE every non-tracker tool call until one of those lands; after that the gate releases for the rest of the turn so you can keep resolving the others alongside other work. ` +
        `Do NOT generate a user-facing response on this turn until the gate is satisfied - the user does not expect a reply yet; they expect the tracker to come back in sync. ` +
        `Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.]`
      );
      // F2.4: dedupe the gate message per wakeup batch. Queued wakeups re-arm this
      // gate on every attempt (three duplicate inserts were observed in 20s). The
      // enforcement state is already armed above (danglingTaskIds), so if the
      // dashboard already carries a close-out gate message from the last 5 minutes,
      // skip the redundant INSERT + broadcast while STILL arming enforcement.
      const recentGateMsg = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'system'
          AND content LIKE '[System: REQUIRED close-out%'
          AND created_at >= (unixepoch('now', '-5 minutes') * 1000)
        LIMIT 1
      `).get(agentId);
      const gateMsgId = uuidv4();
      if (!recentGateMsg) {
        try {
          // engine-steer-exempt (RC-19): the pre-turn close-out gate is ENFORCED at
          // the tool-execution layer (the engine REFUSES non-tracker tool calls until
          // a tracker call lands), so its behavior does not depend on the model seeing
          // this row. It also runs in the pre-turn setup, outside the loop's per-turn
          // steer-queue scope. Guidance-only text; not dashboard-only theater.
          insertMessageIfAbsent({ id: gateMsgId, agentId, role: 'system', content: gateMsg });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: gateMsgId, agentId, role: 'system' as const,
              content: gateMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (msgErr) {
          logger.warn('v2: close-out gate system message insert failed', {
            agentId, error: msgErr instanceof Error ? msgErr.message : String(msgErr),
          }, agentId);
        }
      }
      logger.info('v2: pre-turn close-out gate armed', {
        agentId, danglingCount: danglingRows.length,
        sample: danglingRows.slice(0, 3).map((r) => `${r.id.slice(0, 8)}:${r.title}`),
      }, agentId);
    }
  } catch (err) {
    logger.warn('v2: dangling-task lookup failed; close-out gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // ── Post-compaction recall flag (auto-injected via intercept, v2.7.2) ──
  // If compaction fired an unacknowledged recall nudge (no
  // recall_recent_thread call since), arm the one-shot auto-recall that
  // fires on the agent's first significant tool call this turn.
  //
  // v2.7.2, bounded by session_started_at. Previously this query swept
  // ALL of an agent's history for "Memory was just compacted", which
  // meant stale compaction nudges from prior sessions kept arming the
  // flag after a session_reset. Symptom: agent post-reset gets the
  // auto-recall on its very first tool call, recall replays a transcript
  // from before the reset, and the agent gets confused into duplicate
  // calls. The boundary makes the check session-local.
  try {
    const sessionRow = db.prepare(
      'SELECT session_started_at FROM agents WHERE id = ?',
    ).get(agentId) as { session_started_at: string | null } | undefined;
    const sessionBoundary = sessionRow?.session_started_at ?? null;
    const nudgeQuery = sessionBoundary
      ? `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
           AND created_at >= (unixepoch(?) * 1000)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      : `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
         WHERE agent_id = ? AND role = 'system'
           AND content LIKE '[System: Memory was just compacted%'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    const nudgeParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
    const lastNudge = db.prepare(nudgeQuery).get(...nudgeParams) as { created_at: string } | undefined;
    if (lastNudge) {
      const recallQuery = sessionBoundary
        ? `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
             AND created_at >= (unixepoch(?) * 1000)
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        : `SELECT datetime(created_at/1000,'unixepoch') AS created_at FROM messages
           WHERE agent_id = ? AND role = 'assistant'
             AND content LIKE '%"name":"recall_recent_thread"%'
           ORDER BY created_at DESC, rowid DESC LIMIT 1`;
      const recallParams = sessionBoundary ? [agentId, sessionBoundary] : [agentId];
      const lastRecall = db.prepare(recallQuery).get(...recallParams) as { created_at: string } | undefined;
      const nudgeTs = new Date((lastNudge.created_at.includes('Z') ? lastNudge.created_at : lastNudge.created_at + 'Z')).getTime();
      const recallTs = lastRecall
        ? new Date((lastRecall.created_at.includes('Z') ? lastRecall.created_at : lastRecall.created_at + 'Z')).getTime()
        : 0;
      if (nudgeTs > recallTs) {
        state = advance(state, { awaitingPostCompactRecall: true });
        logger.info('v2: post-compaction recall flag armed', { agentId }, agentId);
      }
    }
  } catch (err) {
    logger.warn('v2: post-compaction recall check failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // G-SUP-2 (comms-audit): turn-scoped stash for user-facing text that rode with
  // tool calls and was deferred (suppressed as possible narration). Recovered at
  // turn-end ONLY if the turn delivered no proper tool-less reply, so a genuine
  // answer the weak model paired with a closing tool is never silently lost.

  // P4b: the F3 runway tripwire (a log-only guard on the guard) was DELETED
  // with the near-dup swallow; the turns record now audits the round.

  // PHASE-6 T9b: what the teardown step reads from this driver, gathered at the
  // moment it is called. It is a CLOSURE and not an object built here on purpose —
  // seven of these are mutable and are still being written right up to the last
  // statement of the turn, so a value snapshotted before the `try` would hand the
  // teardown a picture of the turn as it began. Reading them at call time is what
  // the lexical block did, and this is the smallest construct that keeps it.
  // PHASE-6 T9 (CUT 4): what the finalize step reads from this driver. A CLOSURE for
  // the same reason `teardownContext` is one — several of these are still being
  // written right up to the last statement of the loop, and a snapshot taken before
  // the `try` would hand finalize a picture of the turn as it began.
  const finalizeContext = (): FinalizeContext => ({
    agentId, turnCtx, turnNumber, db,
    counterparty, counterpartyIsAgentSender, chosenConvKey, turnStartedAt,
    settledContextWakeTurn, isA2ATurn, isEngineTurn, broadcast,
    noteTerminalAnswer, persistRoutingMarker, stopStatusHeartbeat, setAgentStatus,
  });

  const teardownContext = (): TeardownContext => ({
    agentId, turnCtx, turnNumber, db,
    chosenConvKey, chosenConversationId, lastAssembledAtIso: turnCtx.lastAssembledAtIso,
    terminalAnswerRowId, triggerWorkId,
    toolPhaseEndedBySpinBrake: turnCtx.toolPhaseEndedBySpinBrake,
    turnInjectedTechniqueId: turnCtx.turnInjectedTechniqueId,
    counterparty, isA2ATurn, isEngineTurn, turnStartedAt,
    inboundChannel, inboundContext,
    reArmIfStrandedNoAnswer, stopStatusHeartbeat,
  });

  // PHASE-6 T3: what the preCallGates step reads from this driver. A CLOSURE for the
  // same reason as the one above, and here it is load-bearing on three specific
  // fields: `assemblerOverheadTokens` is rewritten by every assemble,
  // `engineStartAckDeliveredThisTurn` and `deferredDeliveredByAck` by the post-call
  // classifier, and this step runs once per ITERATION — so a snapshot taken before
  // the `try` would hand iteration nine the picture iteration one had.
  // PHASE-6 T6 (CUT 8): the latter two now live on the turn's bag, so the closure reads
  // THEM off the bag. The per-iteration property this note is about is unchanged — the
  // read still happens at the call site — and the bag is what makes it true now that the
  // step that WRITES them is a module of its own.
  // `setAgentStatus` and `detectTaskThrashing` are passed rather than imported so a
  // step never points back at the driver (CUT 2's `stopStatusHeartbeat` precedent).
  const preCallGatesContext = (): PreCallGatesContext => ({
    agentId, turnNumber, contextWindow, contextModelId, configuredModelId, isAutoRouted,
    counterparty, assemblerOverheadTokens: turnCtx.assemblerOverheadTokens,
    engineStartAckDeliveredThisTurn: turnCtx.engineStartAckDeliveredThisTurn,
    deferredDeliveredByAck: turnCtx.deferredDeliveredByAck,
    engineBlockEscapeHatch: ENGINE_BLOCK_ESCAPE_HATCH,
    broadcast, setAgentStatus, stashContinuationIfHuman, detectTaskThrashing,
  });

  try {
    // ── Main loop ──
    //
    // v2.7.2, `taskClosedWithTextThisTurn` is checked here at the
    // boundary because internal phase transitions during the body
    // (preCallGates → assemble → callLLM → postCallClassify → execute →
    // postExecution) keep overwriting `phase`, so setting `phase: 'done'`
    // mid-body never survives to the next boundary check. The flag, on
    // the other hand, only gets set (never cleared) once the
    // text-plus-close-out pattern is detected, so the next loop turn
    // sees it and exits, after the current iteration's close-out tool
    // has already run.
    while (
      state.phase !== 'done' &&
      state.loopCount < MAX_TOOL_LOOPS &&
      !state.taskClosedWithTextThisTurn
    ) {
      state = advance(state, { loopCount: state.loopCount + 1, phase: 'preCallGates' });

      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here, where nothing downstream can
      // overwrite the request — which is the whole defect the comment at this
      // loop's head describes about mid-body `phase` writes.
      const preCallGates = await runPreCallGates(state, preCallGatesContext());
      state = preCallGates.state;
      if (preCallGates.directive === 'exit') break;
      if (preCallGates.directive === 'continue') continue;
      // ── Phase: assemble context ──
      state = advance(state, { phase: 'assemble' });
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here. This step's ONE exit is the
      // empty-assembled-context clean exit, preserved from v1.
      // What this step reads from the driver. Built HERE, inside the iteration,
      // because it runs once per ITERATION and three of its inputs are rewritten
      // between rounds — a snapshot taken before the `try` would hand iteration
      // nine the picture iteration one had.
      const assembled = await runAssemble(state, {
        agentId, turnCtx, turnNumber, db, contextModelId, contextWindow,
        counterparty, counterpartyIsAgentSender, chosenConvKey, hasUnansweredUser,
        isA2ATurn, isEngineTurn, isNotificationTurn, lastUserMessageContent,
        latestTtsEngine, latestUserSource, mostRecentIsA2A, pendingEngineEvent,
        waitingConvs, engineStartAckDeliveredThisTurn: turnCtx.engineStartAckDeliveredThisTurn,
        // Declared at module level in this file on purpose: a guard pins it there BY
        // PATH (`work-reaper.test.ts`, the narrower and therefore stronger corpus)
        // and `execute` reads it too. Handed across, never copied.
        staleTaskWindowMinutes: STALE_TASK_WINDOW_MINUTES,
        startAckRepliedNow, setAgentStatus,
      });
      state = assembled.state;
      if (assembled.directive === 'exit') break;
      const { assembled: ctx, messages, systemPrompt, volatileFrom, modelContext: mctx, steerAwaitingConfirm } = assembled;
      // ── Phase: model call ──
      // (Auto-routing + capability gate + retry-fallback + TRUE streaming.)
      state = advance(state, { phase: 'callLLM' });
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`), and this step
      // is the one that can ask to leave the TURN rather than the loop: `abandon`
      // is honoured by RETURNING, so finalize does not run and only the `finally`
      // does. That is what the two mid-call `return`s did, preserved exactly.
      // What this step reads from the driver. Built HERE rather than beside the other
      // step contexts because five of its inputs — the assembled call, its system
      // prompt, the assembly context, the volatile boundary and the steer awaiting
      // confirmation — are produced by `assemble`, inside this same iteration.
      const callLLMContext: CallLLMContext = {
        agentId, turnCtx, turnNumber, db,
        counterparty, isA2ATurn, isAutoRouted, configuredModelId, lastUserMessageContent,
        messages, systemPrompt, assembled: ctx, modelContext: mctx, volatileFrom,
        steerAwaitingConfirm,
        revertTriggerStampOnAbort, setAgentStatus,
      };
      const callLLM = await runCallLLM(state, callLLMContext);
      state = callLLM.state;
      if (callLLM.directive === 'abandon') return;
      if (callLLM.directive === 'exit') break;
      if (callLLM.directive === 'continue') continue;
      const { messageId, result } = callLLM;

      // Spin-brake grace (owner ruling 2026-07-19): once the tool phase has
      // been ended by the terminal brake, every further tool call returns an
      // instant note without executing; allow a small grace of model
      // iterations to converge to text, then conclude the turn. The model's
      // text is never suppressed, whatever it has said stands.
      if (turnCtx.toolPhaseEndedBySpinBrake && result.toolCalls.length > 0) {
        turnCtx.spinBrakeGraceCalls -= 1;
        if (turnCtx.spinBrakeGraceCalls < 0) {
          logger.warn('v2: spin brake grace exhausted, concluding the turn', { agentId, turnNumber }, agentId);
          state = advance(state, { phase: 'done' });
        }
      }

      // ── Phase: post-call classification ──
      state = advance(state, { phase: 'postCallClassify' });

      // Empty response handling, v1 has 3-phase retry. Phase 2 baseline:
      // single output-truncation check; if not truncated and no text/tools,
      // surface as toast and break.
      if (result.toolCalls.length === 0 && (!result.content || result.content.trim().length === 0)) {
        const trunc = outputTruncationClassifier({
          stopReason: result.stopReason,
          contentLength: 0,
          currentBudget: state.outputTokensEscalated,
        });
        if (trunc.truncated && trunc.escalateTo !== null) {
          // Output was truncated, escalate budget and retry.
          state = advance(state, { outputTokensEscalated: trunc.escalateTo });
          continue;
        }
        // Clean end-of-turn after tools, legitimate exit, no error.
        if (state.toolCallsExecutedThisTurn > 0) {
          // v1 line 1167-1171: agent did work and has nothing more to say.
          break;
        }
        // No tools called and no text, empty response. v1 runtime.ts:1166-1199
        // does a 3-phase fallback before giving up. Many empties are transient
        // (streaming hiccup, model hesitation) and resolve on a silent retry.
        // Phase 1: silent retry (no nudge, just re-run the model).
        if (!state.retriedEmptyResponse) {
          logger.warn('v2: model returned empty response, retrying silently', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, { retriedEmptyResponse: true });
          continue;
        }
        // Phase 2: explicit nudge, enqueue a [System: ...] note
        // so the assemble phase wraps it as a synthetic user message next turn.
        if (!steerFired(state.steerQueue, 'empty-response')) {
          logger.warn('v2: model returned empty after silent retry, nudging', {
            loopCount: state.loopCount, stopReason: result.stopReason,
          }, agentId);
          state = advance(state, {
            steerQueue: enqueueSteer(state.steerQueue, {
              floor: 'empty-response', atLoop: state.loopCount,
              content: "[System: You returned an empty response. Please respond to the user's last message or call a tool to continue your task. If you are finished, say so clearly.]",
            }),
          });
          continue;
        }
        // Phase 3: give up, toast the user, no DB changes.
        logger.warn('v2: model returned empty after nudge, breaking', {
          loopCount: state.loopCount, stopReason: result.stopReason,
        }, agentId);
        // The turn is giving up: nothing still waiting can be delivered, so drop the
        // queue. The entries are recorded as abandoned, never silently forgotten.
        state = advance(state, { steerQueue: clearSteerQueue(state.steerQueue) });
        broadcast({
          type: 'chat:error',
          agentId,
          error: 'Agent gave an empty reply. Send your message again to retry.',
          code: 'MODEL_FAILED',
          severity: 'warning',
          retryable: true,
        });
        // C4: this give-up break is the clean-retry case, reached only when NO tools
        // executed this turn (the empty-after-tools break above catches the tools case)
        // and the model produced empty text 3x. Re-arm the human ask so the drain re-serves
        // it (the toast still tells the user they can also resend). Guarded so it never
        // re-arms a turn that produced any answer/side effect.
        reArmIfStrandedNoAnswer();
        break;
      }

      // Sanitize text before persistence (#39, v1 runtime.ts:1208-1219).
      // Weak models emit literal `\n` and over-pad blank lines.
      result.content = sanitizeAssistantText(result.content ?? null) ?? '';

      // Deliberate engine surface (scheduler digest / reminder / completion
      // report): text meant to REACH THE USER, exempt from both dedup guards
      // below (2026-07-03, see the G-SUP-3 note). E-A2: read from the PENDING
      // engine event too, in the race case mostRecentInbound is the human that
      // out-raced the event, so checking only mostRecentInbound would wrongly
      // suppress a reminder's text on the engine turn. (Declared here, above
      // the dedup guards, all inputs are turn-invariant.)
      const deliberateSurfaceTurn =
        mostRecentInbound?.origin_intent === 'scheduler' || mostRecentInbound?.origin_intent === 'completion_report' ||
        (isEngineTurn && (pendingEngineEvent?.originIntent === 'scheduler' || pendingEngineEvent?.originIntent === 'completion_report'));

      // Dedup check (#40, v1 runtime.ts:1221-1232). If the model produced
      // the exact same text as the most recent assistant message AND there
      // are no tool calls, break the loop without persisting. Catches the
      // "model regenerated identical text" failure mode (multiple triggers,
      // model stalls). Tool-bearing turns are exempt, even with identical
      // text, the tool calls themselves carry new state.
      // GOVERNING RULE (comms-audit G-SUP-3, sibling of G-SUP-1): never suppress on
      // a turn a human is waiting on. This dedup compares against the most recent
      // assistant message ACROSS turns, so when a user RE-ASKS the same thing the
      // correct answer is necessarily near-identical to the prior turn's answer
      // ("capital of France?" → "Paris" twice) and was being silently eaten, the
      // re-ask got no reply at all. Restrict the dedup to non-user turns (a genuine
      // mid-stall regeneration with no one waiting); a fresh user ask is always
      // answered. A tool-less reply ends the turn, so this cannot loop.
      //
      // 2026-07-03: same rule extends to DELIBERATE ENGINE SURFACES (scheduler /
      // reminder / completion-report turns). Their user-facing text is repeated
      // near-identical BY DESIGN ("Time to stretch!" every day), and the surface
      // IS the point of the turn. The behavioral harness caught both dedup
      // guards eating a reminder delivery entirely (run bmr5637ptnc: two model
      // attempts suppressed as cross-turn near-duplicates, turn ended silent,
      // the user never got the reminder). deliberateSurfaceTurn is computed
      // above from structured origin (origin_intent / pending engine event),
      // exactly the signal E-A2 already anticipated for this failure shape.
      if (result.content && result.toolCalls.length === 0 && !triggerRow && !deliberateSurfaceTurn) {
        const lastAssistant = db
          .prepare(
            "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1",
          )
          .get(agentId) as { content: string } | undefined;
        if (lastAssistant && isNearDuplicateText(lastAssistant.content, result.content)) {
          logger.warn('v2: skipping duplicate assistant response (identical or near-identical to last message)', {
            loopCount: state.loopCount,
          }, agentId);
          break;
        }
      }

      // Broadcast streaming complete + persist assistant message.
      // v3.1.10 (attribution redesign §5, Phase 4): drive suppression off the
      // STRUCTURED counterparty, never prose. counterparty.kind === 'agent' exactly
      // when isA2ATurn (resolveTurnCounterparty), so this is the same authoritative
      // signal with the legacy [SOURCE: GROUP BROADCAST / PM AGENT POKE] includes()
      // tails deleted (per the prime directive: decide by origin, not string-match).
      // Companion rule (channel-awareness): a turn that is NOT a conversation with a
      // present user must not emit user-visible text. The leak this closes: on an
      // autonomous/background turn (owner asleep, no user waiting) the agent
      // SPONTANEOUSLY messages another agent, send_to_agent / broadcast, and its
      // trailing reasoning ("It's 1 AM, the owner's asleep, let me reply to the PM agent about
      // the homepage copy…") persisted into the owner's chat. That is the agent
      // talking out loud about what it will tell the PM. Such text is coordination,
      // never a message to the owner, so suppress it. A genuine user turn
      // (hasUnansweredUser) still persists even if it also pings an agent; deliberate
      // surfaces (scheduler digest, completion report) don't do A2A, so they persist.
      const spontaneousA2ATurn =
        !hasUnansweredUser &&
        (state.sentToAgentThisTurn ||
          result.toolCalls.some(tc => tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group'));
      // Also: a turn whose most-recent trigger is an A2A poke, with NO fresh user
      // waiting, is a background/inter-agent turn even if isA2ATurn is false (the
      // poke was already replied to, so unrepliedAssign is null). Without this, a
      // PM poke with nothing new to do flips to a "user turn" and the agent
      // RE-EMITS a user-facing summary ("a few things before you log off…") on
      // every poke. Fresh user always wins (hasUnansweredUser guard).
      const a2aBackgroundTurn = mostRecentIsA2A && !hasUnansweredUser;
      // The agent is mid A2A exchange: it was poked by an agent (mostRecentIsA2A)
      // AND it messaged an agent back this turn (sentToAgent). Its terminal text is
      // coordination addressed to that agent, so suppress it.
      // T-5 (comms-audit / PHANTOM-FLIP): but ONLY when no human is waiting. When a
      // user message is waiting, "user wins" makes THIS a user turn (trigger = the
      // waiting human), so its text is the USER's reply, suppressing it here dropped
      // the user's answer. The other A2A classifiers already carry this guard; this
      // one was missing it (the old comment's "suppress even if a user is waiting"
      // wrongly assumed the user gets a separate turn, this turn already IS it).
      const a2aExchangeTurn = mostRecentIsA2A && state.sentToAgentThisTurn && !hasUnansweredUser;
      // Pure background/wakeup turn: no user waiting, no fresh trigger, not A2A, not a
      // deliberate engine surface (scheduler digest / completion report). The agent's
      // text here ("3 AM, you're asleep, let me make progress…") is internal, suppress.
      // (deliberateSurfaceTurn is declared above the dedup guards, 2026-07-03.)
      // C3: a human-task continuation (auto-continued after MAX_TOOL_LOOPS / budget /
      // compaction) has no waiting human but IS finishing a human's ask, its final
      // answer must be delivered + routed to the restored counterparty, never suppressed
      // as background chatter.
      const pureBackgroundTurn = !hasUnansweredUser && !triggerRow && !mostRecentIsA2A && !deliberateSurfaceTurn && !isHumanContinuation;
      // USER TURNS ARE NEVER RECLASSIFIED (owner law 2026-07-09, same guard as the
      // pre-model stamp): with a human counterparty this union is forced false, so
      // neither the live turnKind stamp nor the persisted source:'a2a' visibility
      // can hide a user-facing turn after it delegates mid-turn.
      const interAgentTurn = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || spontaneousA2ATurn || a2aBackgroundTurn || a2aExchangeTurn || pureBackgroundTurn);
      // LIVE = RELOAD (incident 2026-07-06): the dashboard's live suppression keys
      // on the turnKind stamp, but the PERSISTED visibility keys on
      // `source: interAgentTurn ? 'a2a' : null` below, and interAgentTurn is a
      // SIX-way union of which the turn-start stamp knew only isA2ATurn. Any turn
      // that became inter-agent via the other five terms (agent counterparty,
      // spontaneous/background/exchange/pure-background) streamed into regular-mode
      // chat live and then vanished on refresh. Re-stamp the turn kind HERE, from
      // the SAME predicate the persistence uses, before any chunk is emitted (this
      // point precedes the model call); the heartbeat re-broadcasts the same map.
      if (interAgentTurn && turnCtx.kind !== 'a2a') {
        turnCtx.kind = 'a2a';
        broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
      }
      // [DIAGNOSTIC] phantom-waiting-user: an A2A poke that should be a background turn
      // is being flipped to a user turn by a stale waiting conversation. Log which
      // conversation is keeping hasUnansweredUser true so the served-tracking edge can
      // be pinned. (Remove once fixed.)
      if (mostRecentIsA2A && hasUnansweredUser) {
        logger.warn('v2 PHANTOM-FLIP: A2A turn flipped to user by waiting conversation', {
          agentId, turnNumber,
          waiting: waitingConvs.map(w => ({ key: w.key, oldest: w.oldestWaitingRowid, latest: String(w.latest.content).slice(0, 45) })),
        }, agentId);
      }
      const persistenceDecision = outputPersistenceClassifier({
        responseText: result.content ?? null,
        toolCallsThisTurn: result.toolCalls,
        isInterAgentTrigger: interAgentTurn,
        sentToAgentThisTurn: state.sentToAgentThisTurn,
      });

      let persistedContent: string | null = result.content;
      // v2.5.7, strip system routing tags the LLM may have copied from
      // prior conversation history (e.g. "[SENT VIA IMESSAGE to the owner]")
      // before persisting OR routing to iMessage. This cleans both the
      // dashboard render path and the iMessage outbound path at the source,
      // and keeps the next turn's LLM context free of the hallucinated tags
      // (so we don't reinforce the pattern).
      if (persistedContent) {
        const { stripSystemTags } = await import('../../services/imessage-bridge.js');
        const cleaned = stripSystemTags(persistedContent);
        persistedContent = cleaned || null;
      }
      // Same class of copied-markup strip for the per-message time stamps
      // (2026-07-16): the floor model prefixes its own replies with the
      // bracket-time it sees on every historical message. Strip at the source
      // so persist, demotion capture, deferred delivery, and channel routing
      // all see clean text (see stripLeadingTimeStamp for the observed case).
      if (persistedContent) {
        const destamped = stripLeadingTimeStamp(persistedContent).trim();
        persistedContent = destamped.length > 0 ? destamped : null;
      }
      // On an inter-agent turn, suppress the text even when it accompanies tool
      // calls (intermediate planning text leaks otherwise). On normal turns keep
      // the long-standing "only suppress standalone trailing text" behavior.
      if (persistenceDecision.decision === 'suppress' && (result.toolCalls.length === 0 || interAgentTurn)) {
        logger.debug('v2: suppressed trailing text', {
          agentId,
          reason: persistenceDecision.reason,
          interAgentTurn,
        }, agentId);
        persistedContent = null;
      }
      // Channel-awareness (attribution redesign §5): assistant text that rides in
      // the SAME model response as one or more tool calls is the agent thinking-
      // before-acting, Lane-2 process narration ("Let me check the calendar",
      // "Close-out gate is released now, let me handle the other task", "Now I have a
      // clear picture, let me reply to the PM agent"), never a message to the user. The user
      // reply is ALWAYS the terminal message: a separate, tool-less response emitted
      // after the work completes (verified empirically, every legitimate reply is
      // tool-less; every preamble / machinery-narration / A2A-coordination leak rides
      // with a tool call). outputPersistenceClassifier already applies exactly this on
      // inter-agent turns; generalize it to ALL turns so preambles stop leaking into
      // the conversation on normal user turns too. Subsumes the prior
      // send_to_agent/broadcast-only suppression. Deterministic engine enforcement,
      // not prompt-hope (the weak-model correctness floor).
      let deliveredAsStartLine = false;
      if (persistedContent && result.toolCalls.length > 0) {
        // GOVERNING RULE (comms-audit G-SUP-2): on a turn a HUMAN is waiting on,
        // this text MIGHT be the genuine answer the weak model paired with a
        // closing tool (work_update(action="status"), etc.), the v2.7.24 capture below
        // exists for exactly that, but this blanket null defeated it (two patches
        // in conflict). Don't show it as a mid-turn bubble (avoid preamble leak),
        // but REMEMBER it: if the turn ends with no proper tool-less reply, the
        // finalize block recovers it so the ask is never silently dropped. On an
        // inter-agent / background turn it is coordination narration, hard-
        // suppress with no recovery (keeps A2A chatter off human channels).
        if (hasUnansweredUser && !interAgentTurn) {
          turnCtx.deferredUserReplyWithTools = persistedContent;
          // Steered start line (owner ruling 2026-07-22): the start-ack steer
          // asked the model to speak and this is its next text riding with
          // tool calls. Surface it NOW as the user-visible start line, the
          // model's own words at the moment they were said. Consumed so
          // nothing double-sends; the terminal reply still lands separately
          // when the work completes.
          if (
            turnCtx.startAckSteerArmedThisTurn &&
            !turnCtx.engineStartAckDeliveredThisTurn &&
            turnCtx.deferredUserReplyWithTools &&
            !startAckRepliedNow()
          ) {
            turnCtx.engineStartAckDeliveredThisTurn = true;
            deliveredAsStartLine = true;
            const startLine = turnCtx.deferredUserReplyWithTools.trim();
            turnCtx.deferredUserReplyWithTools = null;
            turnCtx.deferredDeliveredByAck = true;
            // Fresh id on purpose: messageId already holds this iteration's
            // persisted tool_use row, so reusing it makes the INSERT no-op and
            // the ack line never reaches the DB (caught by the ack scenario).
            // The doubled display the owner saw on .19 was ack row + demoted
            // NOTE of the same text; skipping the demotion below (the text was
            // promoted whole, nothing to demote) leaves exactly one copy.
            await deliverEngineUserAck(startLine, null);
            logger.info('v2 start-ack steer: model spoke its start line mid-work; delivered as the visible ack (streamed bubble promoted in place)', {
              agentId, turnNumber, preview: startLine.slice(0, 60),
            }, agentId);
          }
        }
        // Demote, don't discard (owner request 2026-07-10). This narration
        // already STREAMED into the user's chat live; classifying it out of the
        // conversation made the bubble visibly vanish, which reads as the engine
        // killing the agent mid-thought. Persist it as a [working-note] system
        // row (role='system' never enters model context, so this cannot feed the
        // re-answer class) and tell the dashboard to convert the streamed bubble
        // in place into a dimmed note. Live view and reload agree. Inter-agent
        // turns keep the hard suppression: their narration never streamed to the
        // user (chat:chunk is suppressed on those turns), so there is nothing on
        // screen to demote.
        if (!interAgentTurn && !deliveredAsStartLine) {
          try {
            const noteId = uuidv4();
            // RC-9: channel-aware demotion. On a ROUTED-channel human turn (iMessage /
            // SMS / Teams / email) exactly ONE routing pass delivers exactly ONE string
            // to the channel, while the dashboard live-mirrors EVERY iteration. A demoted
            // narration line here was NOT delivered to that channel, so a visible working
            // note reads as a second, contradictory reply (F-22: the dashboard showing
            // "Not yet, sending now" that never reached iMessage). Mark such notes
            // INTERNAL: prefix them [working-note:internal] and flag the broadcast so the
            // dashboard hides them by default (shown only in wordy/verbose mode). Owner
            // dashboard/voice turns are unchanged (there is one lane, nothing to confuse).
            const routedHumanChannel =
              counterparty.kind === 'user' &&
              (counterparty.relation === 'owner' || counterparty.relation === 'known_contact') &&
              (counterparty.channel === 'imessage' || counterparty.channel === 'sms' ||
               counterparty.channel === 'teams' || counterparty.channel === 'email');
            const notePrefix = routedHumanChannel ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX;
            // Chat-native system note: prefix-marked, NO origin stamp, same
            // convention as routing markers and dividers. An origin_kind of
            // 'engine' here would make the row inter-agent-shaped, and those
            // belong in the store, not messages (the NO_INTERAGENT_LEAK
            // invariant caught exactly that on the first draft of this).
            insertMessageIfAbsent({
              id: noteId, agentId, role: 'system',
              content: `${notePrefix}${persistedContent}`, turnNumber,
            });
            broadcast({
              type: 'chat:workingnote',
              agentId,
              messageId,
              noteId,
              content: persistedContent,
              ...(routedHumanChannel ? { internal: true } : {}),
            });
          } catch { /* cosmetic; never block the turn */ }
        }
        persistedContent = null;
      }

      // ── Claimed-delivery floor (OPEN-14, REKEYED PHASE-4 T4) ── Catch a fabricated
      // completion BEFORE it is persisted: a terminal, user-facing reply that claims it
      // already delivered something to a NAMED THIRD PARTY when the LEDGER says otherwise.
      //
      // ⚠ THE TRIGGER IS NO LONGER THE PROSE, and the owner is why. On 2026-08-01 this floor
      // fired three times on the words "told Michael" quoted out of a wedding transcript he
      // had asked about, each fire ordering "do it NOW" — double answers, a re-done delivery,
      // and a false accusation made by a regex. `agent/v2/claimed-delivery.ts` is the rekey:
      // the prose only NARROWS (which party does the reply name), and the FIRING is a row —
      // an owed obligation with no delivery against it, or a delivery this turn whose own
      // recorded outcome contradicts the claim. Receipt-keyed, never prose-keyed (research 21).
      //
      // This is not suppression: nothing is hidden, the steer re-enters so the agent either
      // ACTUALLY sends or says so plainly. One steer per ROW (the queue entry's latch key is
      // the obligation / delivery id), so the same claim cannot be hammered.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn
      ) {
        const claim = decideClaimedDelivery({
          agentId,
          turnNumber,
          responseText: persistedContent,
          // C5: the CUMULATIVE tool activity across all iterations, not state.toolCalls
          // (overwritten each iteration → always [] on this tool-less terminal iteration, so
          // a real send made earlier in the turn was invisible and the guard false-fired into
          // a DUPLICATE send). Errored calls are excluded here on purpose — a send the tool
          // itself refused is not a delivery, and ARM B's ledger read is what judges the ones
          // that ran and failed at the door.
          toolCallsThisTurn: state.toolResults
            .filter((r) => !r.isError)
            .map((r) => ({ name: r.name })),
          counterpartyName: counterparty.name,
          // RC-12's durable suppressor, unchanged in meaning: a REAL send to the claimed
          // recipient (this turn or within 24h) grounds the claim, so the floor never fires
          // into a duplicate send. P6b-2 keyed consult first, receipts-alias as the legacy
          // prong while pre-121 history ages out.
          hasDeliveryReceipt: (recipient) =>
            findRecentDeliveriesKeyed(agentId, recipient, 24).length > 0 ||
            findRecentDeliveries(agentId, recipient, 24).length > 0,
        });
        if (!claim.fires && claim.recipient) {
          logger.info('v2 claimed-delivery floor stood down; the ledger answered', {
            agentId, recipient: claim.recipient, reason: claim.reason,
          }, agentId);
        }
        if (claim.fires && !steerFired(state.steerQueue, 'ungrounded-claim', claim.latchKey)) {
          // RC-19: deliver the correction via persistEngineSteer so it reaches the
          // model (the steer queue) AND keeps the dashboard row. A bare role='system'
          // row is stripped by the assembler, so pre-fix the agent re-entered without
          // ever seeing the correction and re-posted the same false claim.
          state = persistEngineSteer(
            state,
            {
              agentId, content: claimedDeliverySteer(claim), turnNumber,
              floor: 'ungrounded-claim', atLoop: state.loopCount, key: claim.latchKey,
            },
            { broadcast },
          );
          logger.info('v2 claimed-delivery floor fired on a LEDGER row, re-entering', {
            agentId, recipient: claim.recipient, basis: claim.basis,
            obligationId: claim.obligation?.id ?? null, failedDeliveryId: claim.failedDeliveryId,
          }, agentId);
          continue; // re-enter so the agent actually sends or corrects the claim
        }
      }

      // ── Boundary wrap-up (2026-07-22, consolidated) ── The duplicate
      // wrap-up steer that briefly lived here is GONE: the going-idle nudge
      // below is the one boundary mechanism (4-option menu on SILENT task-work
      // stops; never a re-prompt when a reply exists, the v3.1.10 double-reply
      // rule). For answered turns, the ticket STAMPS land at finalize and the
      // tangible-gated ladder close-steer / strike-2 close the loop within one
      // poke cycle; stacking a second steer here chained re-entries and ate
      // final replies (battery catch).
      // ── RC-12 DENIAL direction ── The inverse of the positive guard: the terminal
      // reply DENIES a delivery ("Not yet", "sending now", "haven't sent it") that the
      // engine receipt ledger proves already happened (F-5, F-22). The denial text
      // detection is deliberately generous; the durable receipt is the true gate, so a
      // steer only fires when a real send is on record. Steer with the receipt fact and
      // re-enter once so the agent answers truthfully AND does not re-send.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn &&
        !steerFired(state.steerQueue, 'delivery-denial')
      ) {
        const denial = detectDeliveryDenial({ responseText: persistedContent });
        if (denial.denied) {
          // Named recipient → 24h window (a specific past send); bare "not yet" → a
          // short 1h window so an unrelated older send cannot spuriously ground it.
          // P6b-2: keyed consult first, legacy alias prong second.
          const keyedMatches = denial.recipient
            ? findRecentDeliveriesKeyed(agentId, denial.recipient, 24)
            : findRecentDeliveriesKeyed(agentId, null, 1);
          const matches = keyedMatches.length > 0
            ? keyedMatches
            : denial.recipient
              ? findRecentDeliveries(agentId, denial.recipient, 24)
              : findRecentDeliveries(agentId, null, 1);
          const receipt = matches[0];
          if (receipt) {
            const who = receipt.recipient ?? denial.recipient ?? 'them';
            const nudgeText =
              `[Engine receipt: you DID send ${channelLabel(receipt.channel)} to ${who} ${relativeTimeAgo(receipt.createdAt)}. ` +
              `Answer truthfully; do not re-send.]`;
            state = persistEngineSteer(
              state,
              { agentId, content: nudgeText, turnNumber, floor: 'delivery-denial', atLoop: state.loopCount },
              { broadcast },
            );
            logger.info('v2 delivery-denial guard fired, receipt contradicts denial, re-entering', {
              agentId, recipient: who, channel: receipt.channel,
            }, agentId);
            continue; // re-enter so the agent corrects the denial instead of re-sending
          }
        }
      }

      // ── RC-13.2 failed-save-claim floor ── The reply claims something was saved /
      // stored / remembered, but every vault_remember THIS turn was REJECTED (isError,
      // the RC-13 bounce fix) and nothing was stored. On the floor model, F-6's false
      // "Saved." was the INSTRUCTED behavior (the bookkeeping nudge stapled "reply
      // 'Saved.'" onto a rejection). Steer truthfully once so a rejected save can never
      // masquerade as done.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        !interAgentTurn &&
        !steerFired(state.steerQueue, 'failed-save-claim') &&
        /\b(saved|stored|remembered|noted it|added (it|that) to (memory|the vault)|put it in (memory|the vault))\b/i.test(persistedContent)
      ) {
        const vaultRemembers = state.toolResults.filter((r) => r.name === 'vault_remember');
        const rejected = vaultRemembers.filter((r) => r.isError).length;
        const succeeded = vaultRemembers.filter((r) => !r.isError).length;
        if (succeeded === 0 && rejected >= 1) {
          const nudgeText =
            `You told the user you saved that, but all ${rejected} vault_remember call${rejected === 1 ? '' : 's'} this turn ` +
            `${rejected === 1 ? 'was' : 'were'} REJECTED and nothing was stored. Either retry with the correction the tool ` +
            `gave you, or tell the counterpart truthfully that it is not saved yet. Do not claim it was saved.`;
          state = persistEngineSteer(
            state,
            { agentId, content: nudgeText, turnNumber, floor: 'failed-save-claim', atLoop: state.loopCount },
            { broadcast },
          );
          logger.info('v2 RC-13.2 save-claim floor fired, all vault saves rejected this turn, re-entering', {
            agentId, rejected,
          }, agentId);
          continue; // re-enter so the agent retries the save or tells the truth
        }
      }

      // ── Deliverable-claim floor: REMOVED same day it landed (2026-07-19) ──
      // The first full battery with it live proved the design law it violated:
      // prose classification must never gain authority. The floor steered a
      // TRUTHFUL completion (a checklist task whose work WAS its technique_read
      // calls, reads are not in any artifact-receipt list) and the floor model
      // answered the steer by spiraling re-reads until turns blew their windows
      // (run bmrrg3lk3db: use-technique loop, simple-reply timeout). Claims
      // honesty is enforced where it can be DETERMINISTIC instead: delivery
      // outcomes are handed to the model at the source (image completion, fan-
      // out steer payloads, attachment give-up notes), and the behavioral
      // harness keeps the SURFACE-ONLY claims:completion_without_receipts
      // invariant, which observes and reports but never acts on prose.

      // Cross-turn respond-once (attribution redesign §4.5). The within-turn dedup
      // above only compares against the single most-recent assistant message and is
      // exempt on tool-bearing turns, so it misses the real leak: the agent
      // RE-ENGAGES the same conversation a few turns later and re-posts a
      // near-identical reply ("Dry cleaning set for 6pm, dentist not found" twice).
      // Close the loop by comparing against the last few persisted assistant replies
      // (suppressed turns were never persisted, so the DB holds only shown text).
      //
      // GOVERNING RULE (comms-audit G-SUP-1): suppression NEVER applies on a turn a
      // human is waiting on. If a user asked (hasUnansweredUser), including asking
      // the SAME thing again, where the correct answer is necessarily near-identical
      // ("what's on my calendar?" twice), the reply is a genuine answer and must be
      // delivered, never eaten as a "duplicate." Cross-turn dedup is ONLY for the
      // agent spontaneously RE-POSTING with no new user ask driving the turn.
      // 2026-07-03: a DELIBERATE ENGINE SURFACE (scheduler/reminder/completion
      // report) is likewise a new external event driving the turn, and its text is
      // repeated near-identical BY DESIGN, so it is exempt too (run bmr5637ptnc:
      // this guard ate a reminder delivery twice and the turn ended silent).
      if (persistedContent && persistedContent.trim().length > 0 && !triggerRow && !deliberateSurfaceTurn) {
        try {
          const recentReplies = db
            .prepare(
              "SELECT content FROM messages WHERE agent_id = ? AND role = 'assistant' AND content NOT LIKE '[{%' ORDER BY rowid DESC LIMIT 5",
            )
            .all(agentId) as Array<{ content: string }>;
          if (recentReplies.some(r => isNearDuplicateText(r.content, persistedContent!))) {
            logger.info('v2: suppressed cross-turn near-duplicate reply (respond-once)', {
              turnNumber,
            }, agentId);
            persistedContent = null;
          }
        } catch {
          // best-effort; never block a reply on a dedup read failure
        }
      }

      // ── Duplicate-final-answer prevention (v2.7.2, scoped down v2.7.3) ──
      //
      // The v2.7.2 fix exited the loop whenever the agent paired wrap-up
      // text with ANY task-closing tool call (work_update(action="close_project"),
      // work_update(action="complete_step"), work_update(action="status") with terminal
      // status, complete_task). The intent was good (skip the duplicate
      // "All set." follow-up turn) but the trigger was way too broad:
      //
      //   • Multi-step user asks where step 1 is a close-out got cut
      //     off after step 1 and never reached step 2.
      //   • Agents naturally mark intermediate task transitions with
      //     "Step done, moving on to X", that paired text+close-out
      //     killed the loop mid-flow.
      //   • The v2.7.3 DB-based "any remaining queued work?" check
      //     helped for tracker-tracked workflows but still cut off
      //     conversational multi-step asks where the next step lives
      //     only in the user's prompt, not in the tracker.
      //
      // Narrowed in v2.7.3 to fire ONLY for `complete_task`, the
      // sub-agent self-termination tool. Its semantics are unambiguous:
      // "I am a sub-agent, my work is over, terminate me and report
      // back to parent." Letting the loop run one more iteration after
      // complete_task would only produce a wasted "all done" follow-up
      // before the agent gets terminated anyway.
      //
      // Every tracker close-out path is now allowed to flow into the
      // next loop iteration. The worst case is one extra model call
      // that emits a brief duplicate "all set" line, minor polish
      // issue. The previous trigger broke real multi-step work, which
      // is a far worse failure mode.
      const isSubAgentExit = (tc: { name: string }): boolean => tc.name === 'complete_task';
      const hasSubAgentExit = result.toolCalls.some(isSubAgentExit);
      const hasWrapUpText = !!(result.content && result.content.trim().length >= 10);

      if (
        !state.taskClosedWithTextThisTurn &&
        hasSubAgentExit &&
        hasWrapUpText
      ) {
        state = advance(state, {
          taskClosedWithTextThisTurn: true,
          // Force loop exit AFTER this iteration's tool execution. The
          // complete_task tool still runs (it's already in result.toolCalls
          // and processed below this block). The next while-loop check
          // sees phase==='done' and exits without calling the model again.
          phase: 'done',
        });
        logger.info('v2: sub-agent complete_task + wrap-up text, phase set to done, no second model call', {
          agentId,
        }, agentId);
      }

      // No-reply sentinel: the agent emits `[no-reply]` (case-insensitive,
      // possibly with surrounding whitespace) when the incoming message
      // closes the conversation (goodnight, that's all, etc.) and there's
      // nothing actionable to respond to. We swallow the literal sentinel
      // (so it doesn't get echoed via iMessage or rendered in chat) and
      // persist a system marker instead, so the agent's next turn sees
      // that the prior turn ended silently. Skipping persistedContent here
      // means lastAssistantTextForIM stays unset, which suppresses the
      // iMessage routing at end-of-turn. Critical for preventing endless
      // back-and-forth chatter on iMessage.
      //
      // Two forms: (a) the entire message IS the sentinel, swallow the
      // bubble entirely, persist a [conversation closed] system marker.
      // (b) the message ENDS with the sentinel (optionally wrapped in
      // backticks/asterisks), strip just the sentinel so the user sees
      // the actual reply text. This handles the common model mistake of
      // appending the sentinel after a real reply (2026-06-02 bug fix:
      // the primary agent was tail-appending `[no-reply]` to user-facing
      // messages and the literal text was rendering in chat).
      // PHASE-1 T8: both shapes come from @dojo/shared now. They were spelled out here and
      // again in the dashboard's marker lib, which is the same drift that made the closed
      // marker unreadable to its own matcher.
      if (
        persistedContent &&
        result.toolCalls.length === 0 &&
        NO_REPLY_TAIL_RE.test(persistedContent) &&
        !isBareNoReplySentinel(persistedContent)
      ) {
        const cleaned = persistedContent.replace(NO_REPLY_TAIL_RE, '').trimEnd();
        if (cleaned.length > 0) {
          logger.info('v2: stripped trailing [no-reply] sentinel from user-facing message', {
            agentId, originalLength: persistedContent.length, cleanedLength: cleaned.length,
          }, agentId);
          persistedContent = cleaned;
        }
      }
      const isBareNoReply =
        persistedContent !== null &&
        result.toolCalls.length === 0 &&
        isBareNoReplySentinel(persistedContent);

      // Decline-as-prose: the weak model sometimes states "I'm not going to reply to
      // this" in prose ("No reply needed here, I can't address X…") instead of the
      // [no-reply] sentinel. Treated as a normal reply, that deliberation gets ROUTED
      // to the counterparty, it was literally sent to Ben as the Globex renewal email
      // reply (thread "Renewal") AND shown in the owner's chat. Honor the agent's
      // stated intent: a message that OPENS with an unambiguous self-decline is a
      // no-reply, not a message to anyone, suppress + don't route, same as the
      // sentinel. Conservative: leading phrase only, no tool calls, so it never
      // swallows a substantive reply that merely mentions "no reply" mid-sentence.
      const DECLINE_OPENER_RE = /^\s*[`*_>]*\s*(?:no\s+(?:reply|response)\s+(?:needed|necessary|required|warranted)\b|no\s+need\s+to\s+(?:reply|respond)\b|nothing\s+(?:to\s+)?(?:reply|respond|to\s+say)\b|i(?:'|’)?ll\s+hold\s+off\s+(?:on\s+)?repl|i\s+(?:won(?:'|’)?t|will\s+not|am\s+not\s+going\s+to)\s+(?:reply|respond)\b)/i;
      const isDeclineNonReply =
        persistedContent !== null &&
        result.toolCalls.length === 0 &&
        !isBareNoReply &&
        // N-2 (comms-audit): NEVER treat a prose "decline" as no-reply on a turn a
        // human is WAITING on. The DECLINE_OPENER_RE false-positives on a genuine
        // answer that merely opens with such a phrase ("No response needed on the
        // receipt, your June total is $432."), which was nulled and dropped on every
        // channel. The governing rule: suppression never fires when serving a waiting
        // ask. A bare [no-reply] (the agent's explicit, whole-message choice) is still
        // honored for chatter-prevention; only the FUZZY prose-decline is guarded.
        !triggerRow &&
        DECLINE_OPENER_RE.test(persistedContent);

      // REG-3 refinement (2026-07-16, the trivial-save sequence): intentional
      // silence stands on turns nobody is waiting on (the narration-resurrection
      // case REG-3 protects). But a bare [no-reply] on a turn SERVING A HUMAN
      // TRIGGER, with NO surfaced reply and a captured text-with-tools answer,
      // means "I already answered" while the answer only exists as a demoted
      // note. Contract #1 (every authorized human message gets exactly one
      // substantive answer) outranks the sentinel: promote the model's own
      // captured words as the terminal reply. isDeclineNonReply already
      // requires !triggerRow (N-2), so only the bare sentinel can reach here.
      let noReplyOverridden = false;
      if (
        isBareNoReply &&
        triggerRow &&
        !state.surfacedReplyThisTurn &&
        !turnCtx.deferredDeliveredByAck &&
        turnCtx.deferredUserReplyWithTools &&
        turnCtx.deferredUserReplyWithTools.trim().length > 0
      ) {
        persistedContent = turnCtx.deferredUserReplyWithTools.trim();
        turnCtx.deferredUserReplyWithTools = null;
        noReplyOverridden = true;
        logger.info('v2: [no-reply] on a served human turn with an undelivered captured answer; promoting it as the reply', {
          agentId, turnNumber, preview: persistedContent.slice(0, 60),
        }, agentId);
      }
      if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply) && (latestUserSource === 'voice' || state.inboundChannel === 'phone')) {
        // Voice AND phone are LIVE conversations, so going silent reads as a dropped
        // call. (comms-audit B-1/phone: phone utterances persist with NO `source`, so
        // they read as 'text' and were EXCLUDED from this guard, a bare [no-reply] on
        // a live call left the caller in dead air. Phone is distinguished by
        // inboundChannel==='phone'.) The voice-conduct prompt block tells the agent not
        // to use [no-reply] here, but the weakest model (the correctness floor) still
        // emits it sometimes, so the engine enforces the floor: swap the bare sentinel
        // for a short spoken acknowledgment and let it flow through the normal persist +
        // TTS path instead of swallowing into dead air.
        const voiceAcks = [
          'Okay, just say the word.',
          "Sounds good, I'm here when you need me.",
          "Got it. Holler when you're ready.",
        ];
        persistedContent = voiceAcks[Math.floor(Math.random() * voiceAcks.length)];
        logger.info('v2: [no-reply] on a voice turn, substituted a brief spoken acknowledgment to avoid dead air', {
          agentId, loopCount: state.loopCount,
        }, agentId);
      } else if (!noReplyOverridden && (isBareNoReply || isDeclineNonReply)) {
        // ── Ghosted-work-ask floor (2026-07-22, battery catch) ── Contract #1
        // (every authorized human message gets exactly one substantive answer)
        // reaches its last unguarded gap here: a bare [no-reply] on a turn
        // serving a human ask the classifier read as WORK, with nothing
        // surfaced and nothing captured to promote. Observed: a repeat of an
        // already-delivered job made the model go silent in one model call
        // (the settled-work record taught it not to re-answer; it over-read
        // that as "don't reply at all"). Silence on chatter stays honored
        // (REG-3); a work ask gets a steer first: reply with a pointer to the
        // settled delivery, or do the work. If the model ghosts the steer too
        // and this conversation HAS an engine-recorded settled answer, a second
        // steer hands the model its own recorded words to restate (the engine
        // never speaks as the agent, owner ruling 2026-07-22); double-ghosted
        // silence stands, loudly logged, and the ladder owns the follow-up.
        const ghostedWorkAsk =
          isBareNoReply && !!triggerRow && turnCtx.inboundClassifiedAsWork &&
          !state.surfacedReplyThisTurn && !turnCtx.deferredDeliveredByAck;
        if (ghostedWorkAsk && !steerFired(state.steerQueue, 'ghosted-ask')) {
          broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
          // T9: was an EMPTY chat:message meaning "drop this bubble" — an event named
          // "here is a message" carrying its own opposite, and the one shape that made
          // "every broadcast has a row" unstateable. It is a named event now.
          broadcast({ type: 'chat:retract', agentId, messageId });
          const steerText =
            '[Engine hint: you ended with [no-reply], but this message is a direct request from the user. ' +
            'A direct ask never ends in silence. If this exact work was already delivered (check the RECENTLY ANSWERED engine record and your tracker), ' +
            'reply with ONE brief line pointing to the existing answer or delivery. Otherwise, do the work now, including creating the tracker task first if the user asked for one.]';
          try {
            persistAndBroadcastSystemRow(steerText);
          } catch { /* dashboard row is best effort */ }
          state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'ghosted-ask', content: steerText, atLoop: state.loopCount }) });
          logger.info('v2 ghosted-work-ask floor: bare [no-reply] on a work-classified human ask with nothing surfaced; steering once (answer-or-point, never silence)', {
            agentId, turnNumber, classifierKeyed: true,
          }, agentId);
          continue;
        }
        if (ghostedWorkAsk && steerFired(state.steerQueue, 'ghosted-ask') && !steerFired(state.steerQueue, 'ghosted-ask-answer') && chosenConversationId) {
          // Second (last) steer, owner ruling 2026-07-22: the engine never
          // speaks as the agent, so instead of re-serving the recorded answer
          // itself, hand the model its own recorded words to restate. If this
          // is ghosted too, silence stands (marker row + loud log below); the
          // ladder and stamps own the follow-up.
          //
          // PHASE-3 STRIP-3: gate and lookup both read `chosenConvKey` before.
          // `recordedAnswerInConversation` filters `m1.conversation_id = ?` — a UUID column —
          // and a conv key matches 0 of the dev body's 6,975 stamped rows where real ids match
          // 954, so this rung had never once fired since the T10I rekey. Both values are
          // `string` and the key crossed a function boundary: no type and no bind-site grep
          // could see it. Pinned by integration.test.ts, "STRIP-3 … (a)".
          try {
            const excerpt = (recordedAnswerInConversation(agentId, chosenConversationId) ?? '')
              .replace(/\s+/g, ' ').trim().slice(0, 220);
            if (excerpt.length > 0) {
              const steer2 =
                `[Engine record: you again ended with [no-reply] on the user's direct ask, but you already answered this in this conversation. Your recorded answer: "${excerpt}". Reply now with one brief line in your own words pointing back to that. Do not re-do the work and do not stay silent.]`;
              try {
                persistAndBroadcastSystemRow(steer2);
              } catch { /* dashboard row is best effort */ }
              broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
              state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'ghosted-ask-answer', content: steer2, atLoop: state.loopCount }) });
              logger.info('v2 ghosted-work-ask floor: model ghosted the first steer; second steer hands it its own recorded answer to restate', {
                agentId, turnNumber,
              }, agentId);
              continue;
            }
          } catch { /* best effort; silence falls through to the marker below */ }
        }
        if (ghostedWorkAsk && steerFired(state.steerQueue, 'ghosted-ask')) {
          logger.warn('v2 ghosted-work-ask floor: model ghosted the steer(s) on a work-classified human ask; engine does not speak for the agent, silence stands with the marker row', {
            agentId, turnNumber, secondSteerFired: steerFired(state.steerQueue, 'ghosted-ask-answer'),
          }, agentId);
        }
        {
          if (isDeclineNonReply) {
            logger.info('v2: agent declined in prose ("no reply needed…"), honoring intent as no-reply (not routing it)', {
              agentId, turnNumber, preview: (persistedContent ?? '').slice(0, 60),
            }, agentId);
          }
          persistedContent = null;
          // REG-3 (comms-audit): the agent INTENTIONALLY went silent ([no-reply] /
          // prose decline). Discard any deferred text-with-tools narration so the
          // G-SUP-2 finalize recovery can't resurrect it and override the decision.
          turnCtx.deferredUserReplyWithTools = null;

          // Silent turn that still opened a canvas (or queued attachments via
          // show_to_user): surface the pending "Open in canvas" chip / thumbnails
          // onto this otherwise-empty assistant bubble instead of dropping it. The
          // user asked the agent to open a canvas; even on [no-reply] they need the
          // affordance back to it (an explicit canvas_render + [no-reply] otherwise
          // left NO chip). Draining here also pre-empts the end-of-turn safety net,
          // so the chip is surfaced exactly once.
          let surfacedNoReplyAttachments = false;
          try {
            const { drainPendingAttachments } = await import('../pending-attachments.js');
            const noReplyAttachments = drainPendingAttachments(agentId);
            if (noReplyAttachments.length > 0) {
              // A short factual line so the bubble renders cleanly (and tells the
              // user WHAT opened); the "Open in canvas" chip rides on it.
              const canvasDoc = noReplyAttachments.find((a) => a.openInCanvas);
              const noReplyCaption = canvasDoc
                ? `Opened ${canvasDoc.filename ? `"${canvasDoc.filename.replace(/\.[a-z0-9]+$/i, '')}"` : 'a document'} in the canvas.`
                : 'Here you go.';
              insertMessageIfAbsent({
                id: messageId, agentId, role: 'assistant', content: noReplyCaption,
                attachments: JSON.stringify(noReplyAttachments), turnNumber,
              });
              noteTerminalAnswer(messageId, 'canvas chip surfaced as the reply');
              broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: messageId, agentId, role: 'assistant' as const,
                  content: noReplyCaption,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                  attachments: noReplyAttachments,
                },
              });
              surfacedNoReplyAttachments = true;

              // N-3 (comms-audit): same gap as A-1, on the [no-reply] path. The drain
              // above surfaces the files onto the DASHBOARD bubble only. If the requester
              // is on iMessage, the deliverable they asked for never reaches their channel
              // (the end-of-turn channel router is skipped on a no-reply turn, and the
              // stranded safety net can't re-find these, they're already drained). Deliver
              // to the iMessage counterparty here. iMessage user only (a dashboard turn
              // already rendered them in the bubble).
              if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
                try {
                  const { sendIMessageWithAttachment } = await import('../../services/imessage-bridge.js');
                  for (const att of noReplyAttachments as Array<{ path?: string }>) {
                    if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
                  }
                } catch (err) {
                  logger.warn('N-3: no-reply attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
                }
              }
            }
          } catch (err) {
            logger.warn('v2: failed to surface no-reply canvas chip', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }

          if (!surfacedNoReplyAttachments) {
            // Clear the streaming bubble in the dashboard. We need BOTH events:
            //  - chat:chunk done:true ends the bubble's streaming state (without
            //    this the thinking dots stay forever, since the normal done:true
            //    at line ~923 only fires when persistedContent or tools exist).
            //  - chat:retract drops the bubble entirely so the chat doesn't show an
            //    empty assistant row. T9: this was an EMPTY chat:message, and the
            //    overload had a visible failure mode — when NO bubble existed for the
            //    id the client APPENDED the empty message instead of dropping it, and
            //    it rendered as a bare timestamp (research 17 §4 item 1). A retract on
            //    a bubble that is not there is a no-op.
            broadcast({
              type: 'chat:chunk',
              agentId,
              messageId,
              content: '',
              done: true,
            });
            broadcast({ type: 'chat:retract', agentId, messageId });
            const sysId = uuidv4();
            // THE COMMA IS GONE (PHASE-1 T8). This literal was written with a comma while
            // both matchers — @dojo/shared's constant and the dashboard's inline copy —
            // expected an em-dash, so the row this line writes was invisible to its own
            // reader and rendered raw in the owner's chat. Taking the constant is what makes
            // that class impossible rather than merely fixed.
            const sysContent = NO_REPLY_CLOSED_MARKER;
            try {
              insertMessageIfAbsent({ id: sysId, agentId, role: 'system', content: sysContent, turnNumber });
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: sysId, agentId, role: 'system' as const,
                  content: sysContent,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
            } catch (err) {
              logger.warn('v2: failed to persist no-reply marker', {
                agentId, error: err instanceof Error ? err.message : String(err),
              }, agentId);
            }
          }
          // Turn continuity: declining ([no-reply]) IS addressing the counterparty.
          // Tag this turn's own messages with the conversation, that conv_key is
          // the durable "served" signal (the conversation won't be re-picked) AND
          // the content-isolation tag (its work won't bleed into another turn).
          if (chosenConvKey) {
            try { if (chosenConversationId) tagTurnOutputConversationId({ agentId, turnNumber, conversationId: chosenConversationId }); } catch { /* best effort */ }
          }
          logger.info('v2: agent ended turn silently via [no-reply] sentinel', {
            agentId, loopCount: state.loopCount,
          }, agentId);
        }
      }

      // ── Redundant-closeout floor (engine-enforced "respond once") ──
      //
      // PHASE-2 T6 (C1, requirement 1a): the AUTHORITY here is now a RECEIPT.
      //
      // It used to be two guesses stacked: a turn-local boolean for "a reply already
      // surfaced", and a twenty-phrase regex for "this line is only a closeout". Both are
      // gone. The question the floor actually needs answered is "has this turn already put
      // the result in front of this person", and since PHASE-2 T5 that is a row —
      // `deliveries`, written by the transport door that performed the send, for every
      // channel including the dashboard bubble that recorded nothing at all before T5.
      //
      // The ≤30-character bound is carried over VERBATIM from the deleted
      // `isGenericCloseout` (it had the same cap) and is the only narrowing left: it is a
      // length, not a reading of the text, and it is what keeps this from ever dropping a
      // substantive second answer. Nothing was tuned and no threshold was invented (#14).
      //
      // requirement preserved: the person gets ONE answer per turn, and the engine drops a
      // duplicate only when it can point at the answer they already have.
      if (
        persistedContent &&
        persistedContent.trim().length <= REDUNDANT_CLOSEOUT_MAX_CHARS &&
        result.toolCalls.length === 0 &&
        turnDeliveredToPerson(agentId, turnNumber, turnCtx.root?.conversationId ?? null)
      ) {
        persistedContent = null;
        broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
        // T9: the third and last empty-chat:message "drop" hack; no row is written here
        // by design ("No system marker, the agent already replied"), so a retraction is
        // exactly what this is.
        broadcast({ type: 'chat:retract', agentId, messageId });
        logger.info('v2: suppressed a redundant closeout — the engine holds a delivery receipt for this turn, so the person already has the answer', {
          agentId, turnNumber, loopCount: state.loopCount,
        }, agentId);
      }

      // P4b (owner status-truth family): the owed-interrupt near-duplicate
      // swallow that lived here was DELETED. It nulled the granted round's
      // reply on a wording-similarity verdict, prose-as-authority in the
      // suppression direction, and its known worst case silently ate a
      // genuinely different short answer. The round's contract is now audited
      // by identity instead: the owed rows carry served_by_turn +
      // answer_message_id stamps (migration 113), and the worst case of the
      // swallow's absence is a visible duplicate paragraph, never a silent
      // drop. The re-prompt itself (below) is unchanged.

      // ── RC-5.3: proactive-send budget (backoff on unanswered background chatter) ──
      // A settled-context wake (no human waiting, not a deliberate surface) that produces
      // a terminal user-facing reply is an UNPROMPTED ping. Production fired ~10 of these
      // at a silent owner in 24h with no backoff (F-10). Track consecutive such pings in a
      // persistent per-agent streak (reset on any authorized owner inbound); once the
      // agent has already sent PROACTIVE_SEND_DEMOTE_THRESHOLD in a row, DEMOTE the next
      // one to a quiet dashboard working-note row instead of sending, still visible, no
      // ping. Deliberate surfaces (scheduler digests, reminders, completion reports) are
      // exempt (deliberateSurfaceTurn) and never counted. This is lane-attribution, not
      // suppression: the commentary lands in the notices lane, just not as a ping.
      if (
        settledContextWakeTurn &&
        !deliberateSurfaceTurn &&
        !interAgentTurn &&
        result.toolCalls.length === 0 &&
        persistedContent && persistedContent.trim().length > 0
      ) {
        const streak = getProactiveSendStreak(agentId);
        if (streak >= PROACTIVE_SEND_DEMOTE_THRESHOLD) {
          logger.info('v2 RC-5.3: proactive-send budget reached; demoting unsolicited settled-wake outbound to a quiet notices-lane row instead of sending', {
            agentId, turnNumber, streak, threshold: PROACTIVE_SEND_DEMOTE_THRESHOLD,
            preview: persistedContent.slice(0, 80),
          }, agentId);
          try {
            const noteId = uuidv4();
            insertMessageIfAbsent({
              id: noteId, agentId, role: 'system',
              content: `${WORKING_NOTE_PREFIX}${persistedContent}`, turnNumber,
            });
            // Convert the already-streamed dashboard bubble in place into the dimmed note
            // (same demote mechanism as the RC-9 text-with-tools path).
            broadcast({ type: 'chat:workingnote', agentId, messageId, noteId, content: persistedContent });
          } catch { /* cosmetic; never block the turn */ }
          persistedContent = null;
        } else {
          // Allowed proactive delivery: count it toward the streak. It flows through to
          // the persist + routing below and pings as normal.
          bumpProactiveSendStreak(agentId);
        }
      }

      // Arm the floor: once any user-facing reply surfaces this turn, later
      // generic closeouts get suppressed (above). Set AFTER the suppression
      // checks so a just-swallowed closeout (now null) doesn't arm it.
      if (persistedContent && persistedContent.trim().length > 0 && !state.surfacedReplyThisTurn) {
        state = advance(state, { surfacedReplyThisTurn: true });
      }

      // ── XML-fallback detection (matches v1 runtime.ts:1240) ──
      // Weak/local models that don't support structured tool calling emit
      // tool calls via the XML text-fallback parser. Their tool IDs are
      // synthetic (`text_tool_*`). Persisting them as structured tool_use
      // blocks would corrupt the next turn, the provider can't reference
      // IDs it didn't generate. Instead we persist text-only, then broadcast
      // a collapsed view with calls + results inline so the user sees them.
      const hasXmlFallbackTools = result.toolCalls.some((tc) =>
        tc.id.startsWith('text_tool_'),
      );

      // Drain attachments queued by show_to_user during prior tool calls
      // in this turn. The runtime owns assistant-message persistence, so
      // we attach here rather than letting the tool insert a synthetic
      // message (which would break tool_use/tool_result alternation).
      //
      // v2.9.20: ONLY drain on text-bearing iterations. Tool-only
      // iterations (no text + tool_use blocks) render as compact tool
      // pills in non-wordy mode and have no slot to display
      // attachments - draining onto them silently swallowed the files.
      // The 2026-06-06 JJ-report incident lost the deliverable this
      // way: show_to_user → work_update(action="complete_step") → end. Attachments
      // drained onto the work_update(action="complete_step") pill and vanished. Now
      // the queue persists across tool iterations and only drains
      // when text accompanies the persist - and an end-of-turn safety
      // net catches anything still queued so files can't be lost.
      const { drainPendingAttachments } = await import('../pending-attachments.js');
      const hasTerminalTextThisIter = !!(persistedContent && persistedContent.trim().length > 0);
      const queuedAttachments = hasTerminalTextThisIter ? drainPendingAttachments(agentId) : [];
      const queuedAttachmentsJson =
        queuedAttachments.length > 0 ? JSON.stringify(queuedAttachments) : null;

      // Build content for persistence (text + tool_use blocks if any)
      const effectiveModelIdForPersist =
        state.modelId === '__auto__' ? configuredModelId : state.modelId;

      if (result.toolCalls.length > 0 && !hasXmlFallbackTools) {
        // v2.9.16: voice-mode filler. When a voice-triggered turn is
        // about to run tools AND the model produced no pre-tool text
        // of its own ("let me check that"), push a short random
        // acknowledgment into the active TTS burst so the user doesn't
        // sit in silence while tools execute. Once per turn, works
        // with both local (Kokoro) and cloud (Hume) TTS engines via
        // the engine-agnostic push handle on the voice session.
        if (
          !voiceFillerFired &&
          latestUserSource === 'voice' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { pushVoiceFiller } = await import('../../voice/voice-ws.js');
            const phrase = pickFillerPhrase();
            const pushed = pushVoiceFiller(agentId, phrase);
            if (pushed) {
              voiceFillerFired = true;
              logger.info('Voice filler pushed before tool execution', {
                agentId, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Voice filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }

        // v2.9.23, same filler logic for live phone calls. Tool calls
        // are the only path that produces noticeable latency on phone
        // (a plain text reply now streams sentence-by-sentence via the
        // onChunk pipe above). When the model jumps straight to tools
        // with no opener text, push a short filler to the CallSession
        // so the caller hears something instead of dead air. Caller
        // hears "On it" / "One sec" / "Let me check" within ~150 ms
        // of finishing their utterance.
        if (
          !voiceFillerFired &&
          turnCtx.phoneStreamCallSid &&
          inboundChannel === 'phone' &&
          (persistedContent ?? '').trim().length === 0
        ) {
          try {
            const { pickFillerPhrase } = await import('../../voice/filler-phrases.js');
            const { getCallSession } = await import('../../twilio/call-session.js');
            const phrase = pickFillerPhrase();
            const session = getCallSession(turnCtx.phoneStreamCallSid);
            if (session && !session.isEnded()) {
              await session.queueAgentSay(phrase);
              voiceFillerFired = true;
              logger.info('Phone filler pushed before tool execution', {
                agentId, callSid: turnCtx.phoneStreamCallSid, phrase, toolCount: result.toolCalls.length,
              }, agentId);
            }
          } catch (err) {
            logger.warn('Phone filler push failed (non-fatal)', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          }
        }
        const assistantContent: Anthropic.ContentBlockParam[] = [];
        if (persistedContent) {
          assistantContent.push({ type: 'text', text: persistedContent });
        }
        for (const tc of result.toolCalls) {
          assistantContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        // THE PERSIST SEAM (rule 6: secrets never in message content). Two
        // redactions, one owner (credentials/secret-fields.ts): a DECLARED secret
        // field never enters a stored tool_use argument (PHASE-4 T5b / P4-R2 — the
        // owner's key was at rest in `credential_add`'s own arguments, in a row
        // replayed to the provider every later turn), and any secret this agent has
        // handled is scrubbed from the rest of the row (NEXT-WAVE item 5's classic
        // `sshpass -p '<pw>'`). result.toolCalls is untouched, so the live call still
        // runs with the real value; only the stored/broadcast copy is redacted.
        const assistantContentForStore = redactAssistantBlocksForPersist(agentId, assistantContent);
        const reasoningForStore = result.reasoningContent
          ? redactHandedCredentials(agentId, result.reasoningContent) : null;
        const assistantContentJson = JSON.stringify(assistantContentForStore);
        if (interAgentTurn) {
          // D-A step 8: the agent's OWN inter-agent-turn output goes to the physical
          // inter-agent store, never the `messages` chat table. Persisting it here
          // (stamped source='a2a') is what let a coordination burst bury the owner's
          // conversation 10k rows deep and blank the chat, and the 'a2a' stamp was a
          // leak-prone downstream overlay. The merged tail loaders UNION this row back
          // into the model context byte-identically (role/content/order/attachments/
          // turn_number preserved; the display/accounting columns NULL-pad exactly as
          // for peer-A2A rows), so model continuity holds. Regular-mode chat (messages-
          // only) never sees it; wordy mode serves it from the merged set. The row id
          // stays STABLE (other tables reference message ids) and content byte-identical.
          insertMessageIfAbsent({
            id: messageId,
            agentId,
            role: 'assistant',
            lane: 'a2a',
            content: assistantContentJson,
            attachments: queuedAttachmentsJson,
            turnNumber,
          });
        } else {
          // The old statement's trailing `NULL` was the `source` column — the else arm of
          // the a2a split, and T3-0b §3 measured it as the reason NO live writer stamps
          // source='a2a' into `messages`. Owner-lane is the writer module's default, so
          // that NULL position simply disappears.
          insertMessageIfAbsent({
            id: messageId, agentId, role: 'assistant', content: assistantContentJson,
            attachments: queuedAttachmentsJson,
            modelId: effectiveModelIdForPersist, cost: null, turnNumber,
            reasoningContent: reasoningForStore,
          });
        }
        // T9: the event family follows the SAME `interAgentTurn` flag that just picked the
        // writer, decided in one place (agent/interagent-broadcast.ts). Before this, the
        // broadcast sat outside the if/else and a coordination turn's tool_use row went out
        // on the owner's chat feed (research 17 D2). `convKey` rides the owner arm only —
        // conv_key is stamped on the row at turn TEARDOWN, so a mid-turn broadcast is the
        // only place the live view can learn it (research 17 §C2 / bug (a), not T9's).
        broadcast(ownOutputBroadcast({
          interAgentTurn,
          agentId,
          agentName: (agent.name as string | null) ?? null,
          id: messageId,
          role: 'assistant',
          content: JSON.stringify(assistantContentForStore),
          createdAt: new Date().toISOString(),
          modelId: effectiveModelIdForPersist,
          attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
          reasoningContent: reasoningForStore ?? undefined,
          conversationId: chosenConversationId,
        }));
        // v2.7.24, also track text-with-tools iterations as deliverable
        // assistant text. Previously this branch ran (because there are
        // tool calls) without updating lastAssistantTextForIM, which meant
        // a turn shaped "text + tool call → tool result → [no-reply]" would
        // leave the channel-routing block with nothing to deliver. The
        // user's substantive answer (the text in iter 1) never reached
        // iMessage / Teams / email. Capturing the LAST iteration's text
        // regardless of whether tools rode with it gives the routing
        // block the right value to deliver at end-of-turn.
        if (persistedContent && persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: stripMoodMarker(persistedContent) });
        }
      } else if (persistedContent) {
        if (interAgentTurn) {
          // D-A step 8: own-output on an inter-agent iteration NEVER touches
          // `messages`. In practice outputPersistenceClassifier always suppresses
          // trailing text on an inter-agent turn (so persistedContent is null and
          // this branch does not run), but keeping the relocation here makes the
          // "no own inter-agent output in messages" invariant total and future-proof.
          insertMessageIfAbsent({
            id: messageId,
            agentId,
            role: 'assistant',
            lane: 'a2a',
            content: persistedContent,
            attachments: queuedAttachmentsJson,
            turnNumber,
          });
        } else {
          insertMessageIfAbsent({
            id: messageId, agentId, role: 'assistant', content: persistedContent,
            attachments: queuedAttachmentsJson,
            modelId: effectiveModelIdForPersist, cost: null, turnNumber,
            // T5b: the REPLY stands (the phase's second binding caution — the
            // platform never edits what it said). The model's private reasoning
            // is not the reply, and it restates the key it was just handed.
            reasoningContent: result.reasoningContent
              ? redactHandedCredentials(agentId, result.reasoningContent) : null,
          });
        }
        if (persistedContent.trim().length > 0) {
          state = advance(state, { lastAssistantTextForIM: stripMoodMarker(persistedContent) });
          noteTerminalAnswer(messageId, 'a genuine terminal reply');
        }
        // T9 — THE TEXT-ONLY REPLY NOW GETS ITS CORRECTING chat:message, AND THAT IS
        // THIS TASK'S SHARPEST SINGLE FIX (research 17 D3).
        //
        // This used to fire only when attachments were queued. The reason given was "the
        // streaming chunks already delivered the text live, so we'd dupe-render if we
        // unconditionally fired chat:message", citing v1 runtime.ts:1303-1318. That reason
        // has been FALSE since 2026-04-30: the dashboard's handler REPLACES a bubble's
        // content in place on an id match (it says so in its own comment — "Pre-2026-04-30
        // this skipped on id match"), and appends only when no bubble exists, which is the
        // correct outcome for a client that missed the stream.
        //
        // What the omission actually cost: the chunks carry the model's RAW output, the row
        // carries what the writer stored — sanitized, timestamp-stripped, `[no-reply]`-free,
        // and since T8 with the orb mood marker moved out to its own column. With no
        // chat:message there was nothing to correct the bubble with, so on a plain text
        // reply the browser kept the raw string forever while the database held the clean
        // one. That is research 17 D3 ("streamed text != persisted text") and the live half
        // of the mood gap recorded at the T8 boundary.
        //
        // Found by BROADCAST_EQUALS_ROW on its first real run (bms4dtng747), which is what
        // a new invariant is for.
        broadcast(ownOutputBroadcast({
          interAgentTurn,
          agentId,
          agentName: (agent.name as string | null) ?? null,
          id: messageId,
          role: 'assistant',
          content: persistedContent,
          createdAt: new Date().toISOString(),
          modelId: effectiveModelIdForPersist,
          attachments: queuedAttachments.length > 0 ? queuedAttachments : undefined,
        }));
      }

      // A-1 (comms-audit): the end-of-turn channel router routes TEXT only, so a
      // deliverable file attached to the reply reached only the dashboard. If the
      // requester is on iMessage, deliver the files to them too. iMessage counterparty
      // only (a dashboard turn already renders the files in its bubble above).
      if (queuedAttachments.length > 0 && counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        try {
          const { sendIMessageWithAttachment } = await import('../../services/imessage-bridge.js');
          for (const att of queuedAttachments as Array<{ path?: string }>) {
            if (att.path) sendIMessageWithAttachment(counterparty.senderId, att.path, '');
          }
        } catch (err) {
          logger.warn('A-1: reply-attachment iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
        }
      }

      // Broadcast streaming complete (only if we actually streamed something)
      if ((persistedContent && persistedContent.trim().length > 0) || result.toolCalls.length > 0) {
        broadcast({
          type: 'chat:chunk',
          agentId,
          messageId,
          content: '',
          done: true,
          modelId: state.modelId === '__auto__' ? configuredModelId : state.modelId,
        });
      }

      // No tools? Loop is done.
      if (result.toolCalls.length === 0) {
        // ── Silent-closeout steer (owner ruling 2026-07-22) ── The user speaks
        // with the AGENT; the engine never speaks for it. So the always-acked
        // completion guarantee (v3.1.14 hard rule) is enforced as a CHECK plus
        // a handed-back mic, not as engine-composed text: when this ending turn
        // completed task(s) and nothing user-facing surfaced, steer once and
        // let the model say it in its own words. The engine-record facts ride
        // in the steer so the weakest model only has to phrase, not remember.
        if (
          !steerFired(state.steerQueue, 'silent-closeout') &&
          !isA2ATurn &&
          counterparty.kind === 'user' &&
          !counterpartyIsAgentSender &&
          (!persistedContent || persistedContent.trim().length === 0) &&
          !state.surfacedReplyThisTurn &&
          !state.lastAssistantTextForIM &&
          !turnCtx.deferredUserReplyWithTools &&
          !Object.values(state.explicitSendThisTurn).some(Boolean)
        ) {
          try {
            // PHASE-2 T6 (C2, requirement 1b): "did work close WITHOUT a delivery" is a JOIN
            // now. The SPINE half asks it directly (`closedWithoutDelivery()`; the DDL's own
            // CHECK makes that set exact, since a row cannot be `done` without pointing at a
            // delivery); the TRACKER half — task rows on the same spine, kept as a separate
            // read because it carries the closed row's own prose — filters through the same
            // ONE reader, `owesAnswer()`.
            const turnStartedAtMs = Date.parse(`${turnStartedAt.replace(' ', 'T')}Z`);
            const closedWorkThisTurn = closedWithoutDelivery(agentId, Number.isFinite(turnStartedAtMs) ? turnStartedAtMs : Date.now() - 60_000);
            const closedThisTurn = db.prepare(`
              SELECT w.title AS title, w.result AS result, ${msToText('w.opened_at')} AS created_at,
                     w.source_message_id AS source_message_id FROM work w
               WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'done'
                 AND w.repeat_interval IS NULL AND w.closed_at >= ?
               ORDER BY w.closed_at ASC LIMIT 3
            `).all(agentId, tsToMs(turnStartedAt) ?? 0) as Array<{ title: string; result: string | null; created_at: string; source_message_id: string | null }>;
            if (closedWorkThisTurn.length > 0) {
              logger.info('v2 silent-closeout: work settled this turn with NO delivery to point at', {
                agentId, turnNumber,
                work: closedWorkThisTurn.map((w) => ({ id: w.workId, kind: w.kind, state: w.state })),
              }, agentId);
            }
            if (closedThisTurn.length > 0) {
              // Receipt-keyed owe, PER TASK (2026-07-23, owner production
              // transcript: duplicate status reply after the real answer). The
              // old time-window dedup ("any substantive reply since the
              // earliest task was created") failed exactly when a bookkeeping
              // task was born AFTER the real answer went out: the window was
              // empty, the steer fired on a settled conversation, and the
              // model re-announced work the user already had, on a WAKE turn
              // nobody was waiting on. The receipts say who is owed what:
              //   - a task WITH an origin ask owes a closeout only while that
              //     ask records no answer (mig 113 answer_message_id);
              //   - a task WITHOUT an origin ask (self/bookkeeping) owes one
              //     only when this turn is serving a live human ask; on a
              //     wake/bookkeeping turn its close is incidental, exactly
              //     what the tracker engine-note tells the model to [no-reply].
              const owedTasks = closedThisTurn.filter((t) => (
                t.source_message_id ? owesAnswer(t.source_message_id) : hasUnansweredUser
              ));
              if (owedTasks.length > 0) {
                const first = owedTasks[0];
                const whichTask = owedTasks.length === 1
                  ? `the task "${first.title.slice(0, 80)}"`
                  : `${owedTasks.length} tasks (first: "${first.title.slice(0, 80)}")`;
                // Receipts, never the model's own result prose (owner .19
                // transcript: a task closed with a FALSE "opened in the canvas"
                // claim and this steer quoted it back as "result on file",
                // lending engine framing to a lie; prose-never-authority
                // applies to the engine's own steers too). The engine states
                // only what it RECORDED; with no recorded delivery it demands
                // honesty instead of a victory lap.
                let receipts = '';
                try {
                  const { composeTurnDeliverySummary } = await import('../../tracker/task-stamps.js');
                  receipts = composeTurnDeliverySummary(agentId, turnNumber);
                } catch { /* fall through to the no-receipts wording */ }
                const steerText =
                  `[Engine record: this turn marked ${whichTask} complete. ` +
                  (receipts.length > 0
                    ? `The engine recorded this delivery: ${receipts.slice(0, 220)}. The user has not heard anything about it. `
                    : 'The engine has NO recorded delivery for it (no file artifact, no channel send). ') +
                  'WRITE one short reply in this conversation now, in your own words: ' +
                  (receipts.length > 0
                    ? 'tell the user it is done and include the deliverable or link. '
                    : 'if the work truly reached the user, say where; if it did NOT, say honestly what remains instead of claiming it is done. ') +
                  'Do NOT call imessage_send or any other send tool; the engine routes your written reply automatically. Do not re-open or re-do the task.]';
                try {
                  persistAndBroadcastSystemRow(steerText);
                } catch { /* dashboard row is best effort */ }
                broadcast({ type: 'chat:chunk', agentId, messageId, content: '', done: true });
                state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'silent-closeout', content: steerText, atLoop: state.loopCount }) });
                logger.info('v2 silent-closeout steer: turn completed task(s) whose origin ask is unanswered; handing the mic to the model for the completion message', {
                  agentId, turnNumber, taskCount: owedTasks.length, firstTask: first.title.slice(0, 60),
                }, agentId);
                continue;
              }
            }
          } catch { /* best effort; the teardown detector still logs the miss */ }
        }
        // ── v2.7.17: "added a note then stopped" detector ──
        // Common failure: agent is mid-project, calls work_note as
        // a status checkpoint, then ends the turn silently because the
        // model treats the note as a stopping point. The user is left
        // wondering why the agent went idle. Detect that pattern and
        // fire a one-shot nudge before the turn ends.
        //
        // Conditions:
        //   - had any tool calls this turn
        //   - LAST tool call was work_note
        //   - the target task is still in_progress
        //   - not already nudged this turn (one-shot, no loop)
        if (
          !steerFired(state.steerQueue, 'add-notes-stop') &&
          state.toolResults.length > 0
        ) {
          const lastTool = state.toolResults[state.toolResults.length - 1];
          if (lastTool && lastTool.name === 'work_note') {
            // Pull the task_id from the original tool call args. The args
            // live on the matching toolCall record by id; search both lists.
            let nudgedTaskId: string | null = null;
            for (let i = state.toolCalls.length - 1; i >= 0; i--) {
              const tc = state.toolCalls[i];
              if (tc.id === lastTool.toolCallId && tc.name === 'work_note') {
                const tid = (tc.arguments as { task_id?: unknown })?.task_id;
                if (typeof tid === 'string') nudgedTaskId = tid;
                break;
              }
            }
            if (nudgedTaskId) {
              const row = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('state')} AS status, title FROM work WHERE id = ?`).get(nudgedTaskId) as { status?: string; title?: string } | undefined;
              if (row?.status === 'in_progress') {
                const titleShort = (row.title ?? '').slice(0, 60);
                const nudgeText = (
                  `[System: you just added a note to "${titleShort}" (${nudgedTaskId.slice(0, 8)}) but did not say what comes next. ` +
                  `That task is STILL in_progress. If you have more work to do on it, KEEP GOING - call your next tool now, do not end the turn. ` +
                  `If you are genuinely waiting on something (user input, an external response, a scheduled time), say so explicitly: ` +
                  `update the task status to "blocked" or "paused" with a clear reason, OR write one sentence in your reply telling the user what you are waiting for. ` +
                  `Silently going idle after a work_note leaves the user with no idea what is happening.]`
                );
                // RC-19: via persistEngineSteer so the nudge reaches the model
                // (the steer queue) AND keeps its dashboard row. The prior bare
                // role='system' row was stripped by the assembler, so the re-entered
                // model never saw "keep going / say what you are waiting for".
                state = persistEngineSteer(
                  state,
                  { agentId, content: nudgeText, turnNumber, floor: 'add-notes-stop', atLoop: state.loopCount },
                  { broadcast },
                );
                logger.info('v2 add-notes-stop nudge fired', { agentId, taskId: nudgedTaskId }, agentId);
                continue; // re-enter the loop so the model sees the nudge
              }
            }
          }
        }

        // ── v2.7.17: "going idle with in_progress task" detector ──
        // Broader sibling of the add-notes-stop nudge. Catches every case
        // where the agent ends a turn while a task assigned to them is
        // still in_progress AND they did not transition it this turn.
        // Walks them through the decision matrix - keep going, mark
        // complete, mark paused (waiting on user), or mark blocked
        // (needs escalation). One-shot so a model that insists on
        // stopping doesn't trigger a loop.
        //
        // Skip if the close-out gate is already armed for this turn
        // (the gate's own message + dispatcher already covers the case)
        // or the add-notes-stop nudge just fired (we just told them).
        if (
          !goingIdleDetectorRanThisTurn &&
          !steerFired(state.steerQueue, 'add-notes-stop') &&
          !state.nudgedForCloseOutThisTurn
        ) {
          // Find in_progress tasks assigned to this agent. Use the same
          // criterion the close-out gate uses but at end-of-turn instead
          // of start: any in_progress task at all (even one touched this
          // turn) qualifies, because the issue isn't staleness - it's
          // that the agent went idle without resolving its state.
          const openTasks = db.prepare(`
            SELECT w.id AS id, w.title AS title FROM work w
            WHERE ${taskScope('w')} AND w.agent_id = ?
              AND w.state = 'claimed'
              AND w.is_paused = 0
            ORDER BY w.updated_at DESC
            LIMIT 5
          `).all(agentId) as Array<{ id: string; title: string }>;

          // Skip if no in_progress tasks - then the agent is fine to idle.
          // Also skip if the agent ALREADY transitioned a task this turn (any
          // status flip / step completion / project close), since that signals
          // they DID make a deliberate state choice and just happened to leave
          // another task in_progress for legitimate reasons.
          const transitionedThisTurn = state.toolResults.some(
            tr => CLOSING_WORK_OPS.has(toolOpKey(tr.name, argsForResult(state.toolCalls, tr))),
          );

          // ── Channel-awareness: enforce task bookkeeping only on a TASK-EXECUTION
          // turn, never on a CONVERSATION turn (attribution redesign §4.5). ──
          // The closeout/auto-pause/PM-escalation machinery exists to catch "the
          // agent WORKED a task and forgot to record it." A pure conversational
          // reply, answering "what's on my plate?", searching the vault and telling
          // the user "I couldn't find the key", greeting a contact, is NOT task
          // execution; the standing backlog is not this turn's responsibility.
          // Firing on it is exactly what turned a simple question into a closeout-miss
          // + PM sweep storm. A turn "worked a task" only if it was task-triggered
          // (scheduler / A2A task coordination) OR it produced a real side effect
          // (sent a message, ran exec, created a doc/file). Reading the tracker or
          // just talking does not count. Decide by what the turn actually did.
          //
          // MEMBERSHIP IS DERIVED, NOT HAND-LISTED. The original hand list here
          // froze a snapshot of google-flavored canonical names, so every _ms
          // variant, every user_ twin, and every office/onedrive tool read as
          // "just conversation": a 31-event calendar_create_ms turn skipped this
          // whole machinery, its task sat open for 100 minutes, and an unrelated
          // email wake re-announced the finished work to the owner (observed on
          // the production box 2026-07-08). classifyTool is the canonical,
          // test-covered classifier (every tool in categories.ts must classify,
          // per the shared V5 test), so new tools can never silently fall out.
          // work_note / work_open:task classify as bookkeeping but counted in the
          // old list on purpose (tending the tracker IS task work); keep them
          // explicitly.
          const countsAsTaskWork = (name: string, args?: Record<string, unknown>): boolean => {
            const key = toolOpKey(name, args);
            return classifyTool(name, args) === 'effectful-action' ||
              key === 'work_note' || key === 'work_open:task';
          };
          const schedulerTurn = mostRecentInbound?.origin_intent === 'scheduler' || (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
          const workedATaskThisTurn = schedulerTurn || isA2ATurn ||
            state.toolResults.some(tr => !tr.isError && !!tr.name && countsAsTaskWork(tr.name, argsForResult(state.toolCalls, tr)));

          if (openTasks.length > 0 && !transitionedThisTurn && workedATaskThisTurn) {
            // v2.10.2, detect scheduler-triggered turns AND scan this
            // turn's tool_results for side-effecting calls that
            // returned success. Pre-fix, the agent had to read a
            // 4-option menu and construct result+evidence themselves,
            // and frequently just emitted "08 done" as text. When
            // we can see "you just ran gmail_send and got [SENT]",
            // surfacing that inline makes the close-out mechanical.
            //
            // Signal source is `state.toolResults` (in-memory, this
            // turn) rather than task_log, most tools don't write
            // per-task log entries when called, so a task_log scan
            // would almost always come up empty.
            // v3.1.10 (attribution redesign §5, Phase 5): decide by structured
            // origin first. The scheduler stamps origin_intent='scheduler'; reading
            // it fixes the case where lastUserMessageContent (now sourced from the
            // authorized-human waiting set) is null on a pure scheduler turn and the
            // prose marker could never match. Prose kept only as the legacy fallback.
            const isSchedulerTriggered =
              mostRecentInbound?.origin_intent === 'scheduler' ||
              (lastUserMessageContent ?? '').includes('[SOURCE: SCHEDULER');
            // Same derived membership as countsAsTaskWork above (minus the
            // tracker tools: this hint warns about re-running EXTERNAL side
            // effects, and re-adding a tracker note is harmless). The old hand
            // list had the same google-only drift as SIDE_EFFECTING did.
            const recentSideEffects: Array<{ name: string; preview: string }> = [];
            for (let i = state.toolResults.length - 1; i >= 0 && recentSideEffects.length < 4; i--) {
              const tr = state.toolResults[i];
              if (!tr.name || classifyTool(tr.name) !== 'effectful-action') continue;
              if (tr.isError) continue;
              const preview = (tr.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
              recentSideEffects.push({ name: tr.name, preview });
            }
            const taskList = openTasks
              .map(t => `  - "${t.title.slice(0, 60)}" (${t.id.slice(0, 8)})`)
              .join('\n');
            const schedulerHint = isSchedulerTriggered
              ? `\n**This turn was scheduler-triggered.** Scheduler-fired tasks rarely need option (1) KEEP GOING, the scheduler does the repetition, not you. The right answer here is almost always option (2) DONE.\n`
              : '';
            const auditHint = recentSideEffects.length > 0
              ? `\nYou successfully called ${recentSideEffects.length === 1 ? 'a side-effecting tool' : 'side-effecting tools'} this turn:\n` +
                recentSideEffects.map(s => `  - \`${s.name}\` returned: ${s.preview}`).join('\n') + `\n\n` +
                `These are NON-IDEMPOTENT actions that already executed. Re-running them would duplicate the side effect (double email, double text, double charge). The work is done. Close the task NOW:\n` +
                `\`work_update(action="status", task_id="${openTasks[0].id}", status="complete", result="<one-line summary of what landed>", evidence=[{kind: "tool_call_ref", claim: "${recentSideEffects[0].name} succeeded"}])\`\n`
              : '';
            const nudgeText = (
              `[System: you are about to end this turn with ${openTasks.length} task${openTasks.length === 1 ? '' : 's'} still in_progress and assigned to you:\n` +
              `${taskList}\n` +
              schedulerHint +
              auditHint +
              `\nPick exactly one of these before ending the turn:\n\n` +
              `  1. KEEP GOING - call your next tool NOW to continue from EXACTLY where you stopped. Long file reads, batch operations, multi-step processes, don't restart, don't re-read content you already processed, just advance to the next line / next item / next step.\n` +
              `  2. DONE - work_update(action="status", task_id, status="complete", result="...", evidence=[...]) (or work_update(action="complete_step") for multi-step projects).\n` +
              `  3. WAITING ON USER (already asked them) - work_update(action="status", task_id, status="paused", notes="waiting for X"). PM will ignore this task entirely; no pokes.\n` +
              `  4. BLOCKED (needs escalation - user does not know yet) - work_update(action="status", task_id, status="blocked", notes="why"). PM will surface this to the primary user.\n\n` +
              `If you go idle with a task still in_progress, the engine will auto-pause it and escalate to PM. Pre-fix for non-idempotent tasks (gmail_send, sms_send, voice_call, exec hitting live APIs), PM was then forced into a re-run remediation that duplicated the side effect. Save everyone the work: close the task now.]`
            );
            // v3.1.10: if the agent ALREADY produced a user-facing reply this
            // turn, do NOT re-prompt it. The weaker model treats the re-prompt
            // as "answer again" and emits a second, slightly-reworded reply, 
            // the double-response the user reported (e.g. the Anthropic-OAuth
            // recall question answered twice), and on a setup turn the same
            // re-prompt makes it redo the work (the duplicate project). Set the
            // flag and fall through to the close-out hardcap below, which
            // reconciles the dangling task deterministically (pause one-shot /
            // reset recurring) while the one reply already shown stands. Only
            // re-prompt when there is NO reply yet (a silent stop), where it can
            // safely get the agent to continue or formally close the task. Build
            // to the weak-model floor: never rely on a re-prompt doing the right
            // thing.
            goingIdleDetectorRanThisTurn = true;
            const alreadyRepliedThisTurn = !!(persistedContent && persistedContent.trim().length > 0);
            if (alreadyRepliedThisTurn) {
              logger.info('v2 going-idle-with-in_progress: agent already replied this turn, skipping re-prompt, engine reconciles the dangling task', {
                agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
              }, agentId);
              // No nudge message, no continue: fall through to the hardcap below,
              // which pauses/resets the dangling task and keeps the single reply.
            } else {
              const nudgeId = uuidv4();
              insertMessageIfAbsent({ id: nudgeId, agentId, role: 'system', content: nudgeText, turnNumber });
              broadcast({
                type: 'chat:message',
                agentId,
                message: {
                  id: nudgeId, agentId, role: 'system' as const,
                  content: nudgeText,
                  tokenCount: null, modelId: null, cost: null, latencyMs: null,
                  createdAt: new Date().toISOString(),
                },
              });
              // F2.6: the persisted row above is a role='system' message, which the
              // assembler strips, so the re-entered round would carry NO new info and
              // burn a model call for nothing. Deliver the menu via the steer queue (a
              // synthetic user message injected next iteration) so the extra round
              // actually shows the model the 4-option decision. Row kept for the
              // dashboard. Gating is unchanged.
              state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'going-idle-in-progress', content: nudgeText, atLoop: state.loopCount }) });
              logger.info('v2 going-idle-with-in_progress nudge fired', {
                agentId, openTaskCount: openTasks.length, taskIds: openTasks.map(t => t.id),
              }, agentId);
              continue; // re-enter the loop so the model sees the nudge
            }
          }
        }

        // Going-idle reconciliation (demolition Phase 1.3): the going-idle nudge
        // already fired this turn and the model STILL ended with a user-facing
        // closeout ("Done" / "All set") without calling a tracker close verb.
        // P2 drive boundary (owner status-truth invariant, 2026-07-21): the
        // going-idle deliverable_shown stamp that lived here was DELETED. It
        // guessed "the reply the user saw IS the delivery" from the mere fact
        // that a non-empty reply and open tasks coexisted, then marked EVERY
        // in_progress task delivered, and that hidden flag stood the poke
        // ladder down (the yacht-research silent hour). Statuses are promises:
        // an in_progress task stays visibly in_progress and the ladder DRIVES
        // it (check-in poke: continue, or close with evidence, or self-mark
        // paused/blocked). Real delivery evidence files Key-1 through the
        // sanctioned paths; prose never silences the drive.
        //
        // RECURRING CARVE-OUT (kept, janitorial not forgery): a recurring
        // schedule is never terminally completed by a missed close-out; fail
        // THIS run and keep the schedule alive.
        if (
          goingIdleDetectorRanThisTurn &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          const recurringDanglers = db.prepare(`
            SELECT w.id AS id FROM work w
            WHERE ${taskScope('w')} AND w.agent_id = ?
              AND w.state = 'claimed'
              AND w.is_paused = 0
              AND w.repeat_interval IS NOT NULL
            ORDER BY w.updated_at DESC
            LIMIT 10
          `).all(agentId) as Array<{ id: string }>;
          if (recurringDanglers.length > 0) {
            const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
            for (const r of recurringDanglers) {
              try { forceResetStuckRecurringTask(r.id); } catch { /* best effort */ }
            }
            logger.info('v2 idle-with-in_progress: recurring dangler(s) failed THIS run and rejoined their schedule; one-shot danglers stay visibly in_progress for the drive boundary', {
              agentId, recurringResetCount: recurringDanglers.length,
            }, agentId);
          }
        }

        // ── THE SAME-TURN SCAFFOLD CLOSE IS GONE (PHASE-2 T8c item 3) ──
        // `closeEngineScaffoldSameTurn` and this call site both die with the empty-project
        // machine, exactly as the plan's Step 4 says. The turn-start classifier no longer
        // opens a project+task before the model has done anything, so there is no pre-emptive
        // scaffold to dangle `in_progress` on a read-only turn and become a ghost-done
        // re-delivery. The >=6 floor's row describes work that DEMONSTRABLY happened (six
        // real tool calls), so closing it on the strength of a reply would be the engine
        // adjudicating success — the thing the two-key contract exists to refuse.
        // requirement preserved: an engine-opened row cannot dangle. Three surviving
        // mechanisms see it — the going-idle close-out gate, the PM ladder's
        // delivery-evidence consult (strike 1 steers the close, strike 2 closes on the
        // receipt), and the reaper. What is gone is the one path that bypassed all three.

        // ── F3: owed mid-turn interrupt re-prompt ──
        // A quick question that lands WHILE a turn is running is NOT an interrupt:
        // its wakeup row sits conv_key NULL and rides into the running turn's
        // per-iteration reassembled tail (runtime.ts). At teardown,
        // claimAssembledSiblings claims every same-conversation user row that was in
        // the answered context (conv_key NULL, created_at <= the final assembly) so a
        // burst can't earn a duplicate answer, a requirement we KEEP intact. The gap
        // it leaves: "in context when we answered" is treated as "was answered", so a
        // DISTINCT factual question that arrived mid-task is claimed as served and
        // never answered anywhere (the weak model absorbs the interruption silently).
        //
        // Fix the CAUSE, don't suppress the claim: on a user turn that produced a
        // reply, give the model exactly ONE more round to address any owed mid-turn
        // arrival BEFORE the same teardown claim marks it served. The [no-reply]
        // escape is what keeps this from creating a NEW duplicate-answer problem when
        // the main reply already covered it. getOwedMidTurnArrivals scopes to the
        // EXACT set the claim will take (same conv-scoping + window) narrowed to
        // mid-turn arrivals (created_at > turnStartedAt), so the trigger and any
        // pre-turn burst siblings (answered as the turn's subject) are excluded.
        //
        // Placed AFTER the F2.1 scaffold close so that close still runs on THIS
        // iteration's reply (it must not be deferred into a possible [no-reply] extra
        // round), and it yields to the going-idle hardcap above (which breaks first on
        // a worked-task-with-danglers turn) so this never fights that reconciliation.
        // One-shot (the queue's own latch for `owed-interrupt`) and skipped at the loop cap, so it
        // can neither spin the loop nor push past MAX_TOOL_LOOPS.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          !steerFired(state.steerQueue, 'owed-interrupt') &&
          persistedContent && persistedContent.trim().length > 0 &&
          state.loopCount < MAX_TOOL_LOOPS &&
          turnCtx.lastAssembledAtIso &&
          chosenConvKey &&
          chosenConvKey !== 'engine'
        ) {
          let owed = getOwedMidTurnArrivals(agentId, chosenConvKey, turnStartedAt, turnCtx.lastAssembledAtIso);
          if (owed.length > 0) {
            // Belt-and-suspenders on top of the query's origin_kind='engine' filter:
            // never quote human text that merely opens with an engine tag ([System:,
            // [A2A:, [SOURCE: ...) back into a model-visible re-prompt.
            const { looksLikeEngineMessage } = await import('./classifiers/multistep.js');
            owed = owed.filter((m) => !looksLikeEngineMessage(m.content));
          }
          if (owed.length > 0) {
            const quoted = owed
              .slice(0, 3)
              .map((m) => `"${m.content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`)
              .join('; ');
            const itThem = owed.length === 1 ? 'it' : 'them';
            const rePrompt = (
              `[System] While you were working, the user also sent: ${quoted}. ` +
              `Reply ONLY to ${itThem}, in one or two sentences. ` +
              `Answer from what you already know, with at most one quick lookup if truly needed. ` +
              `Do not re-run the tools you used for the main task; that work is done and delivered. ` +
              `Do NOT repeat, summarize, or re-deliver ANY part of your earlier reply; the user already has it. ` +
              `If your earlier reply already answered ${itThem}, reply exactly [no-reply].`
            );
            const rePromptId = uuidv4();
            try {
              // Model-visible engine channel, same pattern as the thrash steer and the
              // auto-scaffold note: an origin_kind='engine' row (EVENTS lane surfaces
              // it) with the 'engine-steer' conv_key sentinel so it can never be picked
              // as a pending engine event, PLUS a queue entry so the steer reaches the
              // model on the very next iteration. Label form ([System] body) so the
              // events-lane leading-bracket strip keeps the body.
              insertEngineEventIfAbsent({
                work: null,
                id: rePromptId,
                agentId,
                content: rePrompt,
                sourceAgentId: null,
                originIntent: 'owed_interrupt',
                turnNumber,
              });
            } catch { /* best effort */ }
            state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'owed-interrupt', content: rePrompt, atLoop: state.loopCount }) });
            logger.info('v2 owed-interrupt re-prompt: a mid-turn user message was assembled but may be unanswered; giving the model one more round before the teardown claim marks it served', {
              agentId, turnNumber, owedCount: owed.length, convKey: chosenConvKey,
            }, agentId);
            continue; // exactly one more round for the model to answer the owed ask
          }
        }

        // ── Promise floor: a turn whose entire deliverable is a promise to start ──
        // The last member of the fall-asleep family. Observed live 2026-07-08: the
        // owner asked for a calendars-to-markdown job, the ack fired, one
        // load_tool_docs round ran, then the model emitted TEXT ("On it. Let me pull
        // up all your calendars.") with NO tool calls, and the loop took that promise
        // as the turn's reply and ended clean. Every existing floor (task closeout,
        // going-idle, completion ack) keys on tasks or deliveries; NONE catches a
        // reply whose whole content is a promise to begin.
        //
        // Sequenced AFTER the F3 owed-interrupt block so that answering an owed
        // mid-turn ask takes priority (F3 continues before we reach here). Guards
        // mirror F3 (real user turn, non-empty reply, a human conv_key, and the same
        // MAX_TOOL_LOOPS proximity skip so it can neither spin nor push past the cap)
        // plus two more, deliberately conservative because the action is a re-prompt:
        // (2) the reply must LOOK like a forward promise at its END
        // (isForwardPromiseReply, unit-tested), and (3) the turn must have done
        // NEGLIGIBLE work, no successful effectful-action tool result AND no task
        // transitioned/closed this turn (same classifyTool === 'effectful-action'
        // derivation the closeout machinery uses at countsAsTaskWork; retrieval /
        // bookkeeping reads like load_tool_docs do NOT count, so the live case still
        // qualifies). One-shot: if the model ends AGAIN with a promise after the
        // steer, log the tripwire and let the turn end rather than spin.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          persistedContent && persistedContent.trim().length > 0 &&
          state.loopCount < MAX_TOOL_LOOPS &&
          chosenConvKey &&
          chosenConvKey !== 'engine' &&
          isForwardPromiseReply(persistedContent)
        ) {
          const didEffectfulWorkThisTurn = state.toolResults.some(
            (tr) => !tr.isError && !!tr.name && classifyTool(tr.name, argsForResult(state.toolCalls, tr)) === 'effectful-action',
          );
          const transitionedATaskThisTurn = state.toolResults.some(
            (tr) => !tr.isError && CLOSING_WORK_OPS.has(toolOpKey(tr.name, argsForResult(state.toolCalls, tr))),
          );
          if (!didEffectfulWorkThisTurn && !transitionedATaskThisTurn) {
            const quoted = persistedContent.replace(/\s+/g, ' ').trim().slice(0, 200);
            if (steerFired(state.steerQueue, 'promise-floor')) {
              // Steered once already this turn and the model STILL ended on a promise.
              // Don't spin, let the turn end. This warn is the tripwire that a harder
              // floor is needed if the weak model can't be talked past it.
              logger.warn('promise floor: second promise ending, letting the turn end', {
                agentId, turnNumber, convKey: chosenConvKey,
              }, agentId);
            } else {
              const steer = (
                `[System] Your reply to the user was a promise to start ('${quoted}') but the turn ` +
                `was about to end with no work done. Do the work NOW with tool calls and deliver the ` +
                `result. Do not narrate what you are about to do again.`
              );
              const steerId = uuidv4();
              try {
                // Model-visible engine channel, same pattern as the owed-interrupt
                // re-prompt: an origin_kind='engine' row on the 'engine-steer' conv_key
                // sentinel (never pickable as a pending event), PLUS a queue entry so the
                // steer reaches the model on the next iteration. The promise text row the
                // user already saw is KEPT visible (never delete a user-visible row); the
                // follow-through lands after it.
                insertEngineEventIfAbsent({
                  work: null,
                  id: steerId,
                  agentId,
                  content: steer,
                  sourceAgentId: null,
                  originIntent: 'promise_floor',
                  turnNumber,
                });
              } catch { /* best effort */ }
              state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'promise-floor', content: steer, atLoop: state.loopCount }) });
              logger.info('v2 promise floor: reply was a forward promise with negligible work this turn; steering the model to do the work now', {
                agentId, turnNumber, convKey: chosenConvKey,
              }, agentId);
              continue; // one more round to actually do the work and deliver
            }
          }
        }

        // A2A-handoff floor (owner law 2026-07-09: a turn the user triggered may
        // never end in silence because work was delegated). The async handoff
        // contract tells the model to end its turn after send_to_agent; on a weak
        // model that instruction wins over "tell the user first," so a user-facing
        // turn can end with results in hand and nothing delivered (production
        // transcript 2026-07-09: live device list fetched, then a handoff, then
        // silence). Mutually exclusive with the promise floor above, which
        // requires a non-empty final reply; this one requires an EMPTY one.
        // PHASE-4 T4 (OR2): the engine used to deliver a handoff notice ITSELF here,
        // picked from `A2A_HANDOFF_ACK_POOL` and persisted on the owner's lane as an
        // assistant bubble — the engine wearing the agent's face, which is exactly what
        // OR2 removes. The ladder is now: steer, re-enter, steer ONCE MORE, re-enter, and
        // if the agent still says nothing, VERIFY against the delivery ledger and record a
        // SYSTEM fault in the platform's own voice (`recordFloorGhost`). Silence still stops
        // being a silent outcome; it stops being a sentence the engine puts in the agent's
        // mouth.
        // A successful explicit channel send this turn (explicitSendThisTurn)
        // means the user already heard something delivered on purpose; stand down.
        if (
          counterparty.kind === 'user' &&
          !isEngineTurn &&
          // 2026-07-23 (owner production transcript, duplicate status reply):
          // the floor's own law is "a turn the USER TRIGGERED may never end
          // in silence because work was delegated". A wake/bookkeeping turn
          // that happens to send an A2A serves nobody who is waiting; firing
          // there steered the model into re-announcing settled work. The
          // trigger row is the receipt that a human is actually waiting.
          !!triggerRow &&
          (!persistedContent || persistedContent.trim().length === 0) &&
          chosenConvKey &&
          chosenConvKey !== 'engine' &&
          !Object.values(state.explicitSendThisTurn).some(Boolean) &&
          state.toolResults.some((tr) => !tr.isError && tr.name === 'send_to_agent')
        ) {
          const handoffAttempts = steerFireCount(state.steerQueue, 'a2a-handoff-floor');
          if (handoffAttempts < MAX_FLOOR_STEER_ATTEMPTS && state.loopCount < MAX_TOOL_LOOPS) {
            const again = handoffAttempts === 1;
            const steer = again
              ? (
                `[System] Second time: this turn is STILL about to end with nothing said to the user, ` +
                `and they are waiting. Nothing else on this turn matters until they hear from you. ` +
                `WRITE one or two sentences to them now, directly in this conversation (do NOT call ` +
                `imessage_send or any send tool; the engine routes your reply): what you have, and ` +
                `that another agent is finishing the rest.`
              )
              : (
                `[System] You handed work to another agent and are ending this turn without telling ` +
                `the user anything. The user is waiting. WRITE the user a short reply NOW, directly in ` +
                `this conversation (do NOT call imessage_send or any send tool; the engine routes your ` +
                `reply): report any results you already have, and say you have asked another agent for ` +
                `the rest and will report back when they answer. Do not message the other agent again.`
              );
            const steerId = uuidv4();
            try {
              insertEngineEventIfAbsent({
                work: null,
                id: steerId,
                agentId,
                content: steer,
                sourceAgentId: null,
                originIntent: 'a2a_handoff_floor',
                turnNumber,
              });
            } catch { /* best effort */ }
            state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'a2a-handoff-floor', content: steer, key: again ? 'retry' : '', atLoop: state.loopCount }) });
            logger.info('v2 a2a-handoff floor: user-facing turn ending silently after a handoff; steering the model to report to the user first', {
              agentId, turnNumber, convKey: chosenConvKey, attempt: handoffAttempts + 1,
            }, agentId);
            continue; // one more round to report to the user
          }
          // OR2's honest end of the ladder. Both steers are spent. VERIFY against the
          // delivery ledger before calling it a ghost — the model may have answered on a
          // channel this loop-local check cannot see, and accusing it of silence on an
          // absence is the reasoning non-negotiable #15 forbids.
          // RC-4.2's carve-out is preserved and re-stated as its own condition: a peer box
          // handles a silent handoff on its own lane, so an agent-flagged counterparty was
          // never owed the old notice and is not owed a ghost record either.
          if (handoffAttempts >= MAX_FLOOR_STEER_ATTEMPTS && !counterpartyIsAgentSender
              && !turnDeliveredToPerson(agentId, turnNumber, chosenConversationId ?? null)) {
            const root = turnCtx.root;
            recordFloorGhost({
              agentId, turnNumber, floor: 'a2a-handoff-floor',
              workId: root?.kind === 'ask' ? askIdForMessage(root.id) : null,
              attempts: handoffAttempts,
              ownerLine:
                'your agent handed part of this to another agent and then went quiet without telling you. '
                + 'The engine asked it twice to report back and it did not, so nothing was delivered on this '
                + 'turn. The other agent is still working; ask your agent where things stand.',
              detail: { conv_key: chosenConvKey ?? null },
            }, { broadcast });
          }
        }

        // ── Reminder-delivery silence floor (P3 wave, 2026-07-21; CONVERTED PHASE-4 T4) ──
        // A turn serving a kind='reminder' occurrence exists to SAY one thing to the owner.
        // Observed silent-close: the model closed the run (correct bookkeeping) and ended
        // without replying, so the reminder never reached the owner at all.
        //
        // ⚠ WHAT CHANGED, AND WHY IT MATTERS MORE HERE THAN ANYWHERE ELSE. The old floor read
        // the work row's own `description` and delivered `Reminder: <it>` as an ASSISTANT
        // message on the owner's lane. It was described as "deterministic and model-free",
        // and that is true and is the problem: the owner saw their agent remind them, in
        // their agent's voice, about a thing their agent had said nothing about. The kit's
        // own reminder clause used to pick its delivery with a regex over the row text, which
        // that fallback satisfies perfectly — so the engine speaking as the agent scored
        // GREEN (T4S1 §4.2b measured it). OR2: the AGENT is told, the agent speaks.
        //
        // The reminder text is handed to the MODEL as a steer, twice, and the delivery is
        // verified on the answered edge. If it still says nothing, that is a system fault and
        // it is recorded as one, in the platform's own voice, against the occurrence row.
        {
          const servedRem = turnCtx.servedWork;
          if (
            servedRem?.taskKind === 'reminder' &&
            (!persistedContent || persistedContent.trim().length === 0) &&
            !Object.values(state.explicitSendThisTurn).some(Boolean)
          ) {
            try {
              const remRow = servedRem.taskId
                ? (db.prepare('SELECT title, description FROM work WHERE id = ?')
                    .get(servedRem.taskId) as { title: string | null; description: string | null } | undefined)
                : undefined;
              const remText = (remRow?.description || remRow?.title || '').replace(/^Reminder:?\s*/i, '').trim();
              const remAttempts = steerFireCount(state.steerQueue, 'reminder-silence');
              if (remText && remAttempts < MAX_FLOOR_STEER_ATTEMPTS && state.loopCount < MAX_TOOL_LOOPS) {
                const steer = remAttempts === 1
                  ? (
                    `[System] Second time: this reminder still has not reached the owner. It is the ` +
                    `only reason this turn exists. WRITE it to them now, in your own words, directly ` +
                    `in this conversation (do NOT call imessage_send or any send tool; the engine ` +
                    `routes your reply). The reminder is: ${remText}`
                  )
                  : (
                    `[System] This turn is delivering a reminder and is about to end with nothing said ` +
                    `to the owner. WRITE it to them now, in your own words, directly in this ` +
                    `conversation (do NOT call imessage_send or any send tool; the engine routes your ` +
                    `reply). The reminder is: ${remText}`
                  );
                const steerId = uuidv4();
                try {
                  insertEngineEventIfAbsent({
                    work: null, id: steerId, agentId, content: steer,
                    sourceAgentId: null, originIntent: 'reminder_silence_floor', turnNumber,
                  });
                } catch { /* best effort */ }
                state = advance(state, { steerQueue: enqueueSteer(state.steerQueue, { floor: 'reminder-silence', content: steer, key: remAttempts === 1 ? 'retry' : '', atLoop: state.loopCount }) });
                logger.info('v2 reminder silence floor: reminder turn about to end silently; steering the model to say it', {
                  agentId, turnNumber, taskId: servedRem.taskId, attempt: remAttempts + 1,
                }, agentId);
                continue; // one more round for the agent to deliver its own reminder
              }
              if (remText && remAttempts >= MAX_FLOOR_STEER_ATTEMPTS
                  && !turnDeliveredToPerson(agentId, turnNumber, chosenConversationId ?? null)) {
                recordFloorGhost({
                  agentId, turnNumber, floor: 'reminder-silence',
                  workId: servedRem.taskId ?? null,
                  attempts: remAttempts,
                  ownerLine:
                    'a reminder was due and your agent did not deliver it. The engine asked it twice and '
                    + `it stayed silent, so nothing reached you on this turn. The reminder was: ${remText}`,
                  detail: { task_id: servedRem.taskId ?? null },
                }, { broadcast });
              }
            } catch { /* best effort; never block turn end */ }
          }
        }

        // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01, RULING P3-R3) — the cross-conversation
        // re-answer DETECTOR is deleted, with `re-answer-guard.ts`, `re-answer-sink.ts` and
        // the eslint `node:fs` allowance booked against that sink. It was log-only telemetry:
        // a Jaccard similarity between this turn's reply and answers delivered in OTHER
        // conversations, recorded and never acted on. The plan's own design had it retiring
        // here — "keep as the migration's proof instrument, then delete" (scar-tissue ledger).
        //
        // IT IS DELETED AS AN ALARM THAT NEVER WORKED, NOT AS ONE THAT WENT QUIET. Its
        // exclusion argument was `chosenConvKey` — a conv KEY — against a `conversation_id !=
        // ?` filter on a UUID column, so `conversation_id != 'owner'` never excluded a single
        // row and the reply's OWN conversation was always in the comparison set. Measured:
        // 656 of 656 conversation ids are 36-char UUIDs; two of the three fires in the driven
        // FLIPSTRIP arm matched the reply's own conversation (`616f857b…` on both sides), on
        // two independent builds. Its whole quiet history was evidence in neither direction.
        // The third fire is the OTHER known class and is not a defect: the harness asks the
        // same scripted research question every run, which is verbatim the false positive that
        // demoted this floor to log-only on 2026-07-10 — and scripted repeats are the only
        // traffic a box nobody uses can have, so fixing it could not produce clean evidence
        // here either. Both are in `dojo/DOJO-ISSUES-LOG.md`.
        //
        // requirement preserved — DELIVERED HISTORY IS NEVER DELETED FROM THE WINDOW, which is
        // the CAUSE this heuristic was watching for downstream of:
        //   * `checks/check-reanswer-ghost.mjs` — 54 delivered messages seeded into an empty
        //     session, all 54 required back out of the real assembler, no model call. It is
        //     now on the kit's prompt-gate roster AND `deploy/checks/check-prompt-gate-record`'s
        //     REQUIRED list, green in-roster, and bite-proven (breaking the assembler's
        //     own-output rule makes the release reader refuse). It was WIRED AND REPAIRED
        //     BEFORE this deletion, in this same task, because RULING P3-R2 tried to delete
        //     against it while it was unwired and red and RULING P3-R3 corrected that order.
        //   * `settled-work-stays-settled` (kit battery) — the behavioural half: after a real
        //     delivery is closed, an unrelated wake produces no re-answer and no new artifact.
        // A deterministic gate on the cause replaces a similarity heuristic on the symptom.
        //
        // `~/.dojo/logs/re-answer-detector.jsonl` is LEFT ON DISK deliberately: it is the
        // historical record of what the instrument saw, and the ledger's disposition is that
        // it stays as evidence. Nothing reads it now; nothing writes it either.

        // Settled-context tripwire: MOVED to the end-of-turn route site (search
        // "Settled-context hold"). The tripwire fires when a wake turn whose visible
        // conversations were all answered produces user-facing outbound; its 2026-07-18
        // upgrade (phantom-outreach fix) HOLDS the auto-route channel push for the
        // narrow phantom shape, which can only be done where the destination is
        // resolved. Keeping it here (inside the model loop, log-only, on the
        // loop-local persistedContent) would leave two implementations that could
        // drift, so the single implementation now lives at the route decision.

        // v2.5.31, Hardcap: if the missed-reply nudge already fired once
        // for this assign id and the LLM STILL produced text-no-tool, end
        // the turn instead of nudging again. This is the loop-breaker for
        // models that genuinely can't be talked into a tool call by a
        // system message (they pattern-match "user wants summary" and
        // ignore the directive). Pre-fix this looped ~30 times before
        // the time/token budget killed it (loop.txt 2026-05-13).
        if (
          a2aReplyAssignMessageId &&
          steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId ?? '') &&
          !state.sentToAgentThisTurn &&
          persistedContent && persistedContent.trim().length > 0
        ) {
          // Hardcap engaged to prevent the pre-v2.5.31 nudge spiral (the enforcer
          // kept re-nudging a model that pattern-matched "user wants a summary" and
          // ignored the send_to_agent directive, ~30 loops until the budget killed it).
          const stopMsg = (
            `[System: Ending the turn. You wrote text instead of calling send_to_agent, so the message from the other agent is still unanswered. ` +
            `If it still needs a reply, call send_to_agent on your next turn; otherwise leave it.]`
          );
          const stopId = uuidv4();
          insertMessageIfAbsent({ id: stopId, agentId, role: 'system', content: stopMsg, turnNumber });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: stopId, agentId, role: 'system' as const,
              content: stopMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
          break;
        }

        // Missed-reply nudge (subsumes v1 runtime.ts:1344-1378)
        const replyDecision = a2aReplyEnforcer({
          triggeredByReplyNeededIntent: a2aReplyContext !== null,
          sentToAgentThisTurn: state.sentToAgentThisTurn,
          alreadyNudgedForMissedReply:
            !!a2aReplyAssignMessageId && steerFired(state.steerQueue, 'a2a-missed-reply', a2aReplyAssignMessageId),
          // Raw model text, NOT persistedContent, on an inter-agent turn the
          // text is display-suppressed (persistedContent nulled) but the enforcer
          // still needs to know the agent wrote a reply as chat instead of calling
          // send_to_agent, so it can nudge a retry.
          agentProducedText: !!(result.content && result.content.trim().length > 0),
          intent: a2aReplyContext?.intent,
          threadShort: a2aReplyContext?.threadShort,
          fromName: a2aReplyContext?.fromName,
          // v2.5.31, soften the nudge text when we know the agent already
          // replied earlier on this thread. Prevents the "system says
          // receiver got nothing but I sent the message" cognitive
          // dissonance that drove the loop.txt spiral.
          priorReplyOnSameThread:
            !!a2aReplyContext?.threadShort && hasPriorReplyOnThread(agentId, a2aReplyContext.threadShort, unrepliedAssign?.threadId ?? null),
        });
        if (replyDecision.decision === 'nudge') {
          // RC-19: via persistEngineSteer so the retry nudge reaches the model
          // (the steer queue) AND keeps its dashboard row. The bare role='system' row
          // was stripped by the assembler, so the "you wrote text instead of
          // send_to_agent, retry" steer never reached the model it addressed; only
          // the hardcap above actually bounded the loop. Mark the nudge fired for
          // this assign id (extra) so the next enforcer call returns no_action and
          // the hardcap engages if the agent doubles down on text.
          state = persistEngineSteer(
            state,
            {
              agentId,
              content: replyDecision.nudgeText,
              turnNumber,
              floor: 'a2a-missed-reply',
              atLoop: state.loopCount,
              // KEYED on the assign id; §T0-PINS F's no-latch branch latches on the empty key.
              key: a2aReplyAssignMessageId ?? '',
            },
            { broadcast },
          );
          // Continue loop so the agent reads the nudge and retries
          continue;
        }

        // ── End-of-turn tracker close-out check (v2.5.40) ──
        // Common failure: agent opens a project, marks task 1 in_progress,
        // does the work, never marks it complete (or any subsequent task).
        // The PM agent's poke chain eventually catches it but costs a 30-min
        // wait. Detect at the moment of failure: agent is ending the turn
        // with text, has at least one in_progress task assigned, AND made
        // no work_update(action="status") / work_update(action="complete_step") call this turn.
        //
        // Hardcap mirrors the A2A enforcer: if the agent already saw the
        // nudge once this turn and STILL produces text without updating
        // tracker status, end the turn cleanly. Don't loop forever.
        const agentProducedText = !!(persistedContent && persistedContent.trim().length > 0);
        if (agentProducedText) {
          // ── v2.5.46 / demolition Phase 1.4: pre-turn close-out gate ──
          // The pre-turn system message already gave the agent a chance to
          // engage with the tracker BEFORE generating any response. If they
          // produced text instead of calling a tracker tool, they forfeited the
          // chance. The gate USED TO auto-pause the danglers here and pre-bless
          // the pause (pause_validated=1) so the PM could never re-flag it, a
          // forgery of the PM's key. De-fanged: the danglers keep their TRUE
          // status (one-shots stay in_progress), the recurring janitorial reset
          // stays, and the miss is escalated to the PM (visible A2A) to decide
          // per task. The turn then ends.
          //
          // No "second chance" hard nudge: the prior implementation streamed a
          // second response to the user before the duplicate detector could
          // suppress it, the user saw two responses. One shot, then the turn ends.
          if (
            state.danglingTaskIds.length > 0 &&
            !state.closeOutGateSatisfied
          ) {
            // ── KEEP the agent's reply visible; reconcile the tracker silently ──
            // BUG-2 (comms-audit convergence pass): this gate used to DELETE the
            // just-streamed assistant reply and erase the bubble whenever an
            // UNRELATED idle/stranded tracker task existed, with no human-waiting
            // guard. On the weak-model floor the agent routinely answers a fresh,
            // unrelated human question in plain text (without first calling a
            // work verb); the gate then ate that answer and the user got
            // silence (inv 2). That is the same silent-drop class as the whole P0,
            // and it contradicts the sibling going-idle hardcap which was already
            // fixed (2026-06-25, ~line 3333) to KEEP the closeout visible. Apply the
            // identical trade here: protecting an internal tracker-consistency
            // invariant the user never sees (they read the chat, not the task table)
            // is NOT worth suppressing a real reply. The reply was already persisted
            // AND streamed earlier this turn, so we simply let it stand and STILL
            // reconcile the danglers below (one-shots stay in_progress + escalate to
            // PM / recurring reset / on_deck left in place). No duplicate risk: there
            // is no second-chance re-prompt here (only one reply was ever generated).
            logger.info('v2: pre-turn close-out gate, keeping the agent reply visible, reconciling danglers in the background', {
              agentId, danglingCount: state.danglingTaskIds.length,
            }, agentId);

            try {
              // Distinguish the KINDS of dangler. One-shot in_progress rows keep
              // their TRUE status (no pause, no stamp); on_deck stragglers stay
              // on_deck, the user can decide whether to reassign or close the
              // project. PHASE-6 T0D: there are THREE kinds and this asked for
              // two — see `stale-work-ids.ts`.
              const danglers = splitDanglers(state.danglingTaskIds);
              const inProgressIds = danglers.claimed;
              const onDeckIds = danglers.onDeck;
              if (danglers.gone.length > 0) {
                state = advance(state, { danglingTaskIds: [...danglers.claimed, ...danglers.onDeck] });
                logger.info('v2: dropped dangling task ids whose rows are gone', {
                  agentId, goneCount: danglers.gone.length, remaining: state.danglingTaskIds.length,
                }, agentId);
              }

              // Demolition Phase 1.4: the gate no longer PAUSES one-shot danglers
              // or pre-blesses a pause (pause_validated=1). That flag was an
              // engine-authored "PM-blessed" verdict the PM sweep could never
              // re-flag, a forgery of the PM's key. One-shot danglers now stay
              // in_progress and are escalated to the PM (which decides per task).
              // Recurring danglers keep the janitorial reset (a single missed
              // close-out fails THIS run via forceResetStuckRecurringTask, never
              // pausing/closing the whole schedule).
              const { forceResetStuckRecurringTask } = await import('../../scheduler/runner.js');
              const recurringResetIds: string[] = [];
              const oneShotDanglerIds: string[] = [];
              for (const tid of inProgressIds) {
                const isRecurring = db.prepare(`SELECT repeat_interval FROM work WHERE id = ?`).get(tid) as { repeat_interval: number | null } | undefined;
                if (isRecurring?.repeat_interval) {
                  try { forceResetStuckRecurringTask(tid); recurringResetIds.push(tid); } catch { /* best effort */ }
                  continue;
                }
                oneShotDanglerIds.push(tid);
              }

              if (oneShotDanglerIds.length > 0 || recurringResetIds.length > 0 || onDeckIds.length > 0) {
                // Repaint the board (recurring rows changed; one-shots are
                // unchanged but harmless to re-broadcast). No INVISIBLE
                // retrospective note: the old engine-steer-exempt "[System: ...
                // the engine reconciled the danglers ...]" row is deleted. The
                // going-idle menu steer already gave the model its (visible)
                // instruction this turn, and the PM escalation below is a visible
                // A2A; nothing model-facing is owed on this (ending) turn.
                try {
                  const { getTask } = await import('../../tracker/schema.js');
                  for (const tid of state.danglingTaskIds) {
                    const updatedTask = getTask(tid);
                    if (updatedTask) {
                      broadcast({ type: 'tracker:task_updated', data: updatedTask });
                    }
                  }
                } catch { /* best effort */ }
                logger.warn('v2: pre-turn close-out gate unsatisfied, reply kept visible, one-shot danglers left in_progress (no pause, no stamp), recurring reset on schedule', {
                  agentId, oneShotDanglerCount: oneShotDanglerIds.length, recurringResetCount: recurringResetIds.length, onDeckCount: onDeckIds.length, totalDangling: state.danglingTaskIds.length,
                }, agentId);
                // Escalate the one-shot danglers to the PM (visible A2A). They
                // keep their true in_progress status until the PM decides.
                if (oneShotDanglerIds.length > 0) {
                  try {
                    const { escalateCloseoutMissToPM } = await import('../../tracker/pm-agent.js');
                    await escalateCloseoutMissToPM({
                      agentId,
                      danglingTaskIds: oneShotDanglerIds,
                      agentText: persistedContent ?? '',
                      source: 'pre-turn-gate',
                    });
                  } catch (escErr) {
                    logger.warn('v2: pre-turn gate closeout-miss escalation failed (non-fatal)', {
                      agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
                    }, agentId);
                  }
                }
              }
            } catch (escErr) {
              logger.error('v2: close-out one-shot escalation failed', {
                agentId, error: escErr instanceof Error ? escErr.message : String(escErr),
              }, agentId);
            }
            break;
          }

          if (
            steerFired(state.steerQueue, 'tracker-closeout') &&
            !state.trackerStatusUpdatedThisTurn
          ) {
            // Hardcap: nudge fired once and was ignored. End the turn.
            // The PM agent will catch the dangling tasks on its next poke pass.
            logger.warn('v2: tracker close-out nudge ignored, ending turn anyway', {
              agentId,
            }, agentId);
            break;
          }

          // Lane separation (attribution redesign §4.5): this nudge re-prompts the
          // model ("close out your open tasks; write NO user-facing text"). On a live
          // conversation turn the model ignores the no-text instruction and re-answers
          // the present user, producing the near-duplicate reply (field-documented
          // below). The deeper problem is the bleed itself: task-closeout is machinery
          // (Lane 2/3), and it has no business re-running the model in the middle of a
          // Lane-1 conversation about something unrelated (the open tasks are usually
          // pre-existing background danglers, not this turn's work). So on a user turn
          // we do NOT re-prompt, the agent answered the user, the turn ends here, and
          // the danglers are caught off the conversation path by the deterministic
          // pre-turn close-out gate next turn and by the PM poke chain (which is where
          // closeout enforcement belongs). The re-prompt remains for non-conversation
          // turns (autonomous / A2A), where any resulting text is already routed to the
          // agent-internal lane and never surfaces to the user.
          if (
            counterparty.kind !== 'user' &&
            !steerFired(state.steerQueue, 'tracker-closeout') &&
            !state.trackerStatusUpdatedThisTurn &&
            state.nonTrackerToolCalls > 0
          ) {
            let openTasks: Array<{ id: string; title: string }> = [];
            try {
              const { listTasks } = await import('../../tracker/schema.js');
              const inProgress = listTasks({ status: 'in_progress', assignedTo: agentId });
              openTasks = inProgress.map((t) => ({ id: t.id, title: t.title }));
            } catch (err) {
              logger.warn('Tracker close-out nudge: listTasks failed', {
                agentId, err: err instanceof Error ? err.message : String(err),
              }, agentId);
            }
            if (openTasks.length > 0) {
              const taskList = openTasks
                .map((t) => `  - "${t.title}" (${t.id.slice(0, 8)})`)
                .join('\n');
              // v2.5.42, rewritten to a direct, action-only command.
              // Prior wording was a paragraph with an "or end your turn
              // silently" escape hatch. Field test showed DeepSeek V4 Pro
              // ignoring the escape and re-running the whole response,
              // producing a duplicate reply to the user. The user noticed
              // immediately ("notice that something triggered him to do
              // it twice now"). New wording: tool call ONLY, no text,
              // explicit "do not repeat your prior message" guardrail.
              const nudgeText = (
                `[System: ${openTasks.length} in_progress task${openTasks.length === 1 ? '' : 's'} assigned to you was not closed out this turn:\n` +
                `${taskList}\n` +
                `REQUIRED ACTION: call work_update(action="complete_step") (for multi-step projects) or work_update(action="status") (complete | blocked | paused) on each task above. Make ONLY the tool call(s). Do NOT write any user-facing text, the user already received your previous response and a duplicate reply is worse than a stale tracker. ` +
                `If a task is genuinely still in progress, end your turn now with NO text output (no tool call, no message); the engine will continue you on the next user turn.]`
              );
              // RC-19: via persistEngineSteer so the close-out directive reaches the
              // model (the steer queue) AND keeps its dashboard row. This branch is
              // non-user turns only (any resulting text is routed to the agent-internal
              // lane, see the lane note above), so the bare role='system' row the
              // assembler strips meant the re-prompt never actually reached the model.
              state = persistEngineSteer(
                state,
                { agentId, content: nudgeText, turnNumber, floor: 'tracker-closeout', atLoop: state.loopCount },
                { broadcast },
              );
              logger.info('v2: tracker close-out nudge fired', {
                agentId, openTaskCount: openTasks.length,
              }, agentId);
              continue;
            }
          }
        }

        break;
      }

      // ── Engine-injected ack, DISABLED ──
      //
      // The v2 plan called for an engine-written ack ("Working on it…") to fire
      // when the agent goes straight to a tool call without text. In practice
      // this turned out to be both noise AND structurally broken: the ack was
      // persisted as a system message into the messages table BETWEEN the
      // assistant's tool_use and its matching tool_result, which violates the
      // conversation invariant (tool_use and tool_result must be in adjacent
      // messages). The assembler's defensive `sanitizeToolPairs` would then
      // drop both messages from context, and the model would re-issue the
      // tool call on the next turn because it lost memory of running it.
      //
      // The chat:tool_call broadcast (fired by executePhase below) already
      // serves the "agent is working" signal. The ack adds no information
      // and broke the conversation invariant. Removed 2026-05-04.
      //
      // INVARIANT (Part XIX, sharpened): never insert any persisted message
      // between an assistant tool_use and its matching tool_result. If we
      // ever want a transient "thinking" indicator, it must be broadcast-only,
      // never written to the messages table.
      //
      // The `ackInjector` classifier (agent/v2/classifiers/ack.ts) and its
      // tests are kept for potential future use as a broadcast-only path.

      // Engine-side tracker enforcement lives in the runtime nudge + engine
      // floor below (search "Runtime tracker nudge"); the v2.0.0-era classifier
      // (agent/v2/classifiers/tracker.ts) was never wired to side effects and
      // its intent is served there, so it was removed in v3.1.11 (FN-9).

      // ── Phase: execute tools (partitioned) ──
      state = advance(state, { phase: 'execute' });
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here. This step has the MOST ways out of
      // any tranche — FIVE exits and ONE continue — and every one of them was a
      // `break` or a `continue` of this loop before the cut, which is why its
      // contract test pins the count rather than trusting a reader to notice a
      // seventh appearing.
      // What this step reads from the driver. Built HERE, inside the iteration,
      // because four of its inputs (the model result, the persisted text, the
      // XML-fallback verdict and the model id the persist used) are produced by
      // `postCallClassify` in this same round.
      const executed = await runExecute(state, {
        agentId, turnCtx, turnNumber, db, agent, counterparty, counterpartyIsAgentSender,
        chosenConvKey, hasUnansweredUser, triggerRow, triggerWorkId, triggerConversationId,
        turnStartedAt, persistRoutingMarker,
        engineStartAckDeliveredThisTurn: turnCtx.engineStartAckDeliveredThisTurn,
        deferredDeliveredByAck: turnCtx.deferredDeliveredByAck,
        identicalCallState, reminderLaneRefusedSigs,
        startAckArmed, startAckArmedAtMs, fireStartAckIfOwed,
        result, messageId, persistedContent, interAgentTurn, hasXmlFallbackTools,
        effectiveModelIdForPersist,
        // Declared at module level in this file and read OUTSIDE this span too, so
        // one declaration is handed across rather than moved or copied — CUT 6's
        // shape for `STALE_TASK_WINDOW_MINUTES`, which additionally has a guard
        // pinning it here BY PATH on purpose.
        staleTaskWindowMinutes: STALE_TASK_WINDOW_MINUTES,
        maxToolLoops: MAX_TOOL_LOOPS,
        engineBlockEscapeHatch: ENGINE_BLOCK_ESCAPE_HATCH,
        engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
        setAgentStatus,
      });
      state = executed.state;
      if (executed.directive === 'exit') break;
      if (executed.directive === 'continue') continue;
      const { turnToolResults } = executed;

      // ── Phase: post-execution gates ──
      state = advance(state, { phase: 'postExecution' });
      const postExecution = runPostExecution(state, {
        agentId, turnNumber, result, turnToolResults, broadcast,
      });
      state = postExecution.state;
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here, where nothing downstream can
      // overwrite the request — which is the whole defect the comment at this
      // loop's head describes about mid-body `phase` writes.
      if (postExecution.directive === 'exit') break;
      if (postExecution.directive === 'continue') continue;

      // Loop continues, model will see tool results and respond
    }

    if (state.loopCount >= MAX_TOOL_LOOPS) {
      // Matches v1 runtime.ts:1683-1707. Hit the soft tool-loop cap but
      // (presumably) still making progress, auto-continue with a fresh
      // turn instead of dead-stopping. The continuity brief + tracker
      // tasks let the agent pick up where they left off.
      logger.warn('v2 hit MAX_TOOL_LOOPS, auto-continuing with fresh turn', {
        agentId, maxLoops: MAX_TOOL_LOOPS,
      }, agentId);
      const sysMsg = (
        `[System: This turn reached ${MAX_TOOL_LOOPS} tool calls. Starting a fresh turn ` +
        `to continue your work. Pick up where you left off.]`
      );
      const sysMsgId = uuidv4();
      insertMessageIfAbsent({ id: sysMsgId, agentId, role: 'system', content: sysMsg, turnNumber });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: sysMsgId, agentId, role: 'system' as const,
          content: sysMsg,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      // Schedule a self-continuation. Reassembles context fresh, the agent
      // sees its full history including the work it just did and continues
      // naturally. 1s delay lets DB writes settle.
      stashContinuationIfHuman(); // C3: carry the human conversation into the continuation
      setTimeout(() => {
        try {
          getAgentRuntime().handleMessage(agentId, '').catch((err) => {
            logger.error('v2 auto-continuation after tool limit failed', {
              agentId, error: err instanceof Error ? err.message : String(err),
            }, agentId);
          });
        } catch (err) {
          logger.error('v2 auto-continuation failed to schedule', {
            agentId, error: err instanceof Error ? err.message : String(err),
          }, agentId);
        }
      }, 1000);
    }

    // The engine-composed silent-close "Done:" line that briefly lived here is
    // GONE (owner ruling 2026-07-22: the engine never speaks as the agent). The
    // in-loop silent-closeout steer is the enforcement now: same check, but the
    // MODEL says the completion in its own words.

    // ── Phase: finalize ──
    state = advance(state, { phase: 'finalize' });
    state = (await runFinalize(state, finalizeContext())).state;
    // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). `finalize` is the
    // last statement of the turn's main `try`: there is no iteration to continue and
    // no loop left to break, so it always `proceed`s and the driver has nothing to
    // honour. The directive is still read by the contract test, on every arm.
  } catch (err) {
    // PHASE-6 T9b: the recovery arm of the exit path. The driver keeps the
    // language construct — a module cannot express catch/finally on its
    // caller's behalf — and the step owns the body.
    state = (await runTurnRecovery(state, teardownContext(), err)).state;
  } finally {
    // PHASE-6 T9b: the arm that runs on EVERY exit path, and the transition
    // INTO the ninth phase. The advance is HERE, at the call site and ahead
    // of the step, so validate() runs on it and the step never writes phase.
    state = advance(state, { phase: TEARDOWN_PHASE });
    state = (await runTurnTeardown(state, teardownContext())).state;
  }
}
