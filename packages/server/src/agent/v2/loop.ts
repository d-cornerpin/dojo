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
import { createLogger } from '../../logger.js';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
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
  formatRoutingMarker,
} from '@dojo/shared';
import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';

import { getContextWindow } from '../model.js';
import { resolveRecipientDisplay } from '../../contacts/resolve-recipient.js';
// recordError intentionally NOT imported, handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
import { AgentError } from '../errors.js';
import { resolveInbound } from './inbound-channel.js';
import { turnBoundary, forceA2ATurn, lastTurnWasA2A, continuationContext } from '../turn-state.js';
// PHASE-6 T1: the turn's own facts (`turnCtx`, threaded; `turnContext(agentId)` for the
// module-level helpers below, which run whether or not that agent is in a turn).
import { openTurnContext, turnContext, endTurnContext, type TurnContext } from '../turn-context.js';
// PHASE-2 T8V: the six work verbs made tool NAMES insufficient to identify an
// operation, so every gate below matches `toolOpKey(name, args)` — the operation
// id for a work verb, the plain name for everything else. One matcher, one marker.
import { toolOpKey, PROGRESS_WORK_OPS } from '../../tools/work-verbs.js';
import { taskScope, stampColumns } from '../../work/tracker-view.js';
import { resolveServedWork } from './stale-work-ids.js';

import { statusHeartbeats, turnContinuationCounts } from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import { initState, advance } from './state.js';
import { canonicalToolSignature } from './classifiers/loop.js';
// ackInjector intentionally NOT imported, engine ack disabled per invariant
// review (see "Engine-injected ack, DISABLED" comment below).
import {
  insertMessageIfAbsent, stampConversationIdByRowid,
  claimEngineEventByRowid, releaseEngineEventByRowid, isRowUnserved,
  markServedByRowid,
} from '../../memory/message-store.js';
import { resolveOrCreateConversation } from '../../memory/conversations.js';
import { resolveTurnCounterparty, getWaitingHumanConversations, getPendingEngineEvent, recordEngineEventDeliveryFailure, type TurnCounterparty } from './counterparty.js';
import { parseA2ATrigger } from './classifiers/a2a.js';
import { resetProactiveSendStreak } from './proactive-budget.js';
// PHASE-2 T6 — THE ANSWERED EDGE. One module answers "has the person heard from us" for
// every gate in this file that used to answer it for itself (research 07 rows 1a/1b/1c/1e/
// 1g/2d). Nothing below reads the model's prose to decide it any more.
import { hasOpenHumanWork, resumeWorkOnOwnerAsk } from './answered-edge.js';
import { resolveOwnerAffinityChannel, affinityPromotionAllowed } from './owner-affinity.js';
import { findUnrepliedAssignForAgent } from '../a2a-replies.js';
import { type RepeatCallState } from './identical-call-brake.js';
import { startTurn } from './turn-record.js';
import { withOutboundAsync } from './outbound.js';
// PHASE-2 T3: the ask's lifecycle. `transition()` is the only writer of `work.state`; these
// are its named callers for the pickup / re-arm / turn-link steps of one owner ask.
import { claimAsk, stampClaimingTurn, revertAskClaimOnAbort, isStateConflict, noteUnsettled } from '../../work/store.js';
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
// PHASE-6 T6 (CUT 8): the fifth step — everything decided after the model spoke and
// before any tool runs. It has the MOST ways out of any tranche (seven exits, one
// per named reason), which is why its outcome is honoured at the call site.
import { runPostCallClassify } from './steps/post-call-classify/index.js';

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

// PHASE-6 T6 (CUT 8): `REDUNDANT_CLOSEOUT_MAX_CHARS` and `argsForResult` MOVED with the
// code that binds them — every one of their five uses was inside the `postCallClassify`
// span (measured `out=0` by binder census before the move), so one declaration travelled
// rather than a second being born. They live in
// `steps/post-call-classify/closeout-floors.ts` and `.../args-for-result.ts`.

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
          triggerWorkId, turnCtx.state!.nonIdempotentCallsThisTurn,
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
        if (turnCtx.state!.nonIdempotentCallsThisTurn === 0) {
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
  // PHASE-6 T6 (CUT 8): on the turn's bag — the latch is read and written inside the
  // `postCallClassify` span and must survive the ITERATION. See the field.

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
  turnCtx.state = initState({
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
      !turnCtx.state!.lastAssistantTextForIM &&
      !turnCtx.state!.surfacedReplyThisTurn &&
      !Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) &&
      turnCtx.state!.nonIdempotentCallsThisTurn === 0
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
  // PHASE-6 T6 (CUT 8): on the turn's bag — read and written inside the `postCallClassify`
  // span, and it must survive the ITERATION. See the field.
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
      } else if (counterparty.kind === 'user' && counterparty.channel === 'phone' && turnCtx.state!.inboundContext?.phoneCallSid) {
        const { getCallSession } = await import('../../twilio/call-session.js');
        const session = getCallSession(turnCtx.state!.inboundContext.phoneCallSid);
        if (session && !session.isEnded()) {
          await withOutboundAsync(
            {
              agentId, tool: 'engine-ack', channel: 'phone',
              recipientId: turnCtx.state!.inboundContext.phoneFromNumber ?? counterparty.senderId ?? null,
              conversationId: turnCtx.root?.conversationId ?? null,
            },
            () => session.queueAgentSay(text),
          );
          persistRoutingMarker(`phone call to ${resolveRecipientDisplay('phone', turnCtx.state!.inboundContext.phoneFromNumber ?? counterparty.senderId ?? '(unknown)')}`);
        }
      } else if (counterparty.kind === 'user' && counterparty.channel === 'sms' && turnCtx.state!.inboundContext?.smsFromNumber) {
        const { sendSms } = await import('../../twilio/client.js');
        const { getDefaultFromNumber } = await import('../../twilio/auth.js');
        const fromNumber = turnCtx.state!.inboundContext?.smsToNumber ?? getDefaultFromNumber();
        if (fromNumber) {
          const smsTo = turnCtx.state!.inboundContext.smsFromNumber;
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
    Object.values(turnCtx.state!.explicitSendThisTurn).some(Boolean) ||
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
      turnCtx.state = advance(turnCtx.state!, {
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
        turnCtx.state = advance(turnCtx.state!, { awaitingPostCompactRecall: true });
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
      turnCtx.state!.phase !== 'done' &&
      turnCtx.state!.loopCount < MAX_TOOL_LOOPS &&
      !turnCtx.state!.taskClosedWithTextThisTurn
    ) {
      turnCtx.state = advance(turnCtx.state!, { loopCount: turnCtx.state!.loopCount + 1, phase: 'preCallGates' });

      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here, where nothing downstream can
      // overwrite the request — which is the whole defect the comment at this
      // loop's head describes about mid-body `phase` writes.
      const preCallGates = await runPreCallGates(turnCtx.state!, preCallGatesContext());
      turnCtx.state = preCallGates.state;
      if (preCallGates.directive === 'exit') break;
      if (preCallGates.directive === 'continue') continue;
      // ── Phase: assemble context ──
      turnCtx.state = advance(turnCtx.state!, { phase: 'assemble' });
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here. This step's ONE exit is the
      // empty-assembled-context clean exit, preserved from v1.
      // What this step reads from the driver. Built HERE, inside the iteration,
      // because it runs once per ITERATION and three of its inputs are rewritten
      // between rounds — a snapshot taken before the `try` would hand iteration
      // nine the picture iteration one had.
      const assembled = await runAssemble(turnCtx.state!, {
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
      turnCtx.state = assembled.state;
      if (assembled.directive === 'exit') break;
      const { assembled: ctx, messages, systemPrompt, volatileFrom, modelContext: mctx, steerAwaitingConfirm } = assembled;
      // ── Phase: model call ──
      // (Auto-routing + capability gate + retry-fallback + TRUE streaming.)
      turnCtx.state = advance(turnCtx.state!, { phase: 'callLLM' });
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
      const callLLM = await runCallLLM(turnCtx.state!, callLLMContext);
      turnCtx.state = callLLM.state;
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
          turnCtx.state = advance(turnCtx.state!, { phase: 'done' });
        }
      }

      // ── Phase: post-call classification ──
      turnCtx.state = advance(turnCtx.state!, { phase: 'postCallClassify' });
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS by
      // returning; the driver decides here. This step has the MOST conversions of any
      // tranche in the phase — SEVEN exits and SEVENTEEN continues, every one of them a
      // `break` or a `continue` of THIS loop before the cut — which is why its contract
      // test pins both counts rather than trusting a reader to notice a twenty-fifth.
      // Built HERE, inside the iteration, because two of its inputs (the model result
      // and the message id) are produced by `callLLM` in this same round.
      const classified = await runPostCallClassify(turnCtx.state!, {
        agentId, turnCtx, turnNumber, db, agent, counterparty, counterpartyIsAgentSender,
        chosenConvKey, hasUnansweredUser, triggerRow, isA2ATurn, isEngineTurn,
        isHumanContinuation, mostRecentIsA2A, mostRecentInbound, pendingEngineEvent,
        unrepliedAssign, a2aReplyContext, a2aReplyAssignMessageId, settledContextWakeTurn,
        waitingConvs, inboundChannel, latestUserSource, lastUserMessageContent,
        configuredModelId, turnStartedAt, messageId, result,
        // Declared at module level in this file and read OUTSIDE this span too, so one
        // declaration is handed across rather than moved or copied — CUT 6's shape.
        maxToolLoops: MAX_TOOL_LOOPS,
        // Closures over driver state, passed as VALUES so they keep the bindings they
        // closed over (CUT 2's `stopStatusHeartbeat` precedent).
        reArmIfStrandedNoAnswer, noteTerminalAnswer, deliverEngineUserAck,
        persistAndBroadcastSystemRow, startAckRepliedNow,
      });
      turnCtx.state = classified.state;
      if (classified.directive === 'exit') break;
      if (classified.directive === 'continue') continue;
      const {
        persistedContent, interAgentTurn, hasXmlFallbackTools, effectiveModelIdForPersist,
      } = classified;


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
      turnCtx.state = advance(turnCtx.state!, { phase: 'execute' });
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
      const executed = await runExecute(turnCtx.state!, {
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
      turnCtx.state = executed.state;
      if (executed.directive === 'exit') break;
      if (executed.directive === 'continue') continue;
      const { turnToolResults } = executed;

      // ── Phase: post-execution gates ──
      turnCtx.state = advance(turnCtx.state!, { phase: 'postExecution' });
      const postExecution = runPostExecution(turnCtx.state!, {
        agentId, turnNumber, result, turnToolResults, broadcast,
      });
      turnCtx.state = postExecution.state;
      // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). The step ASKS
      // by returning; the driver decides here, where nothing downstream can
      // overwrite the request — which is the whole defect the comment at this
      // loop's head describes about mid-body `phase` writes.
      if (postExecution.directive === 'exit') break;
      if (postExecution.directive === 'continue') continue;

      // Loop continues, model will see tool results and respond
    }

    if (turnCtx.state!.loopCount >= MAX_TOOL_LOOPS) {
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
    turnCtx.state = advance(turnCtx.state!, { phase: 'finalize' });
    turnCtx.state = (await runFinalize(turnCtx.state!, finalizeContext())).state;
    // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`). `finalize` is the
    // last statement of the turn's main `try`: there is no iteration to continue and
    // no loop left to break, so it always `proceed`s and the driver has nothing to
    // honour. The directive is still read by the contract test, on every arm.
  } catch (err) {
    // PHASE-6 T9b: the recovery arm of the exit path. The driver keeps the
    // language construct — a module cannot express catch/finally on its
    // caller's behalf — and the step owns the body.
    turnCtx.state = (await runTurnRecovery(turnCtx.state!, teardownContext(), err)).state;
  } finally {
    // PHASE-6 T9b: the arm that runs on EVERY exit path, and the transition
    // INTO the ninth phase. The advance is HERE, at the call site and ahead
    // of the step, so validate() runs on it and the step never writes phase.
    turnCtx.state = advance(turnCtx.state!, { phase: TEARDOWN_PHASE });
    turnCtx.state = (await runTurnTeardown(turnCtx.state!, teardownContext())).state;
  }
}
