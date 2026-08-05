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
// PHASE-6 T2 (CUT 9): this driver's last uses of that taxonomy — `formatRoutingMarker`,
// `deriveOrigin`, `legacyOriginInputs` — went out with the code that bound them, into
// the `preflight` package, so the imports went with them rather than being left standing.
// recordError intentionally NOT imported, handleMessage's catch path calls
// it. Calling here would double-count errors and trip the loop-detector
// pause prematurely.
// PHASE-6 T1: the turn's own facts (`turnCtx`, threaded; `turnContext(agentId)` for the
// module-level helpers below, which run whether or not that agent is in a turn).
import { openTurnContext, turnContext, endTurnContext, type TurnContext } from '../turn-context.js';
// PHASE-6 T10: the ONE owner of the `agents.status` transition. It used to live here.
import { setAgentStatus } from '../agent-status.js';
// PHASE-2 T8V: the six work verbs made tool NAMES insufficient to identify an
// operation, so every gate below matches `toolOpKey(name, args)` — the operation
// id for a work verb, the plain name for everything else. One matcher, one marker.
import { toolOpKey, PROGRESS_WORK_OPS } from '../../tools/work-verbs.js';

import { statusHeartbeats } from '../shared-state.js';

// Force-import side-effect: also register the runtime singleton getter so v2
// can fire self-continuation handleMessage() calls (matches v1 behavior).
import { getAgentRuntime } from '../runtime.js';

import { advance } from './state.js';
import { canonicalToolSignature } from './classifiers/loop.js';
// ackInjector intentionally NOT imported, engine ack disabled per invariant
// review (see "Engine-injected ack, DISABLED" comment below).
import { insertMessageIfAbsent } from '../../memory/message-store.js';
// PHASE-6 T8: the first step cut out of this driver. `steps/step-outcome.ts`
// carries the contract every step package shares, including the exit-request
// channel this call site honours.
import { runPostExecution } from './steps/post-execution/index.js';
import { runExecute } from './steps/execute/index.js';
// PHASE-6 T9b: the ninth step — the turn's exit path. Two arms because a module
// cannot express catch/finally on its caller's behalf; the driver keeps the
// construct and the step owns both bodies.
import { TEARDOWN_PHASE, runTurnRecovery, runTurnTeardown } from './steps/teardown/index.js';
// PHASE-6 T3: the loop's FIRST step — everything asked before a model call is spent.
// Seven of the `while` body's exits live in it, which is why its outcome is honoured
// at the call site rather than through a field a later step could overwrite.
import { runPreCallGates } from './steps/pre-call-gates/index.js';
import { runAssemble } from './steps/assemble/index.js';
// PHASE-6 T9 (CUT 4): the eighth step — everything the turn does after the loop ends
// and before the exit path. It is the last statement of the main `try`, so it can
// never ask to exit; the reply-destination resolver and the two safety nets live there.
import { runFinalize } from './steps/finalize/index.js';
import { runCallLLM, type CallLLMContext } from './steps/call-llm/index.js';
// PHASE-6 T6 (CUT 8): the fifth step — everything decided after the model spoke and
// before any tool runs. It has the MOST ways out of any tranche (seven exits, one
// per named reason), which is why its outcome is honoured at the call site.
import { runPostCallClassify } from './steps/post-call-classify/index.js';
// PHASE-6 T2 (CUT 9): the LAST step cut out of this driver, and the only one called with
// the turn's bag rather than its state — it is the step that MAKES the state. Everything
// the turn decides before the main `try` opens lives there, including the three closures
// that build the finalize / teardown / preCallGates contexts.
import { runPreflight } from './steps/preflight/index.js';

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

// PHASE-6 T10: `setAgentStatus` MOVED, whole, to `agent/agent-status.ts` — the one owner of
// the `agents.status` transition. It is imported here like any other collaborator and passed
// into the step contexts unchanged. It is deliberately NOT re-exported from this module: a
// second import path for one writer is the shape T10 exists to delete, and the census in
// `agent/__tests__/status-writer-conformance.test.ts` is what keeps it at one.

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
  // ── Phase: preflight ──
  // THE EXIT-REQUEST CHANNEL (PHASE-6, `steps/step-outcome.ts`), and this step's
  // exit is `abandon`: there is no loop yet to break and the main `try` has not
  // opened, so the driver honours it by RETURNING and neither finalize nor the
  // teardown `finally` runs. That is exactly what the two bare `return`s inside this
  // span did before the cut, and the step's contract test pins the count on BOTH
  // sides so a third cannot appear on either.
  //
  // ⚠ THE ONE STEP CALLED WITH `(turnCtx, ctx)` AND NOT `(state, ctx)` — it MAKES the
  // state, publishes it to the bag, and hands back what the rest of the turn reads.
  // There is no `advance` ahead of this call because there is no transition to
  // validate: `initState` SEEDS `phase: 'preflight'`, so the shared rule holds here
  // by construction rather than at a call site.
  const preflight = await runPreflight(turnCtx, {
    agentId,
    // Declared at module level in this file and read OUTSIDE the moved span too, so one
    // declaration is handed across rather than moved or copied — CUT 6's shape. The
    // four status helpers measure zero readers outside and are passed anyway: they are
    // `setAgentStatus`'s own machinery, and it cannot move.
    setAgentStatus, startStatusHeartbeat, stopStatusHeartbeat, detectTaskThrashing,
    engineBlockEscapeHatch: ENGINE_BLOCK_ESCAPE_HATCH,
    engineStartAckAfterMs: ENGINE_START_ACK_AFTER_MS,
  });
  if (preflight.directive === 'abandon') return;
  const {
    db, agent, configuredModelId, isAutoRouted, contextModelId, contextWindow,
    waitingConvs, isHumanContinuation, chosenConvKey, triggerRow, lastUserMessageContent,
    triggerWorkId, triggerConversationId, revertTriggerStampOnAbort, latestUserSource,
    latestTtsEngine, inboundChannel, unrepliedAssign, mostRecentInbound, mostRecentIsA2A,
    hasUnansweredUser, isA2ATurn, pendingEngineEvent, isEngineTurn, settledContextWakeTurn,
    isNotificationTurn, a2aReplyContext, a2aReplyAssignMessageId, counterparty, turnNumber,
    turnStartedAt, reArmIfStrandedNoAnswer, stashContinuationIfHuman, persistRoutingMarker,
    persistAndBroadcastSystemRow, noteTerminalAnswer, identicalCallState,
    reminderLaneRefusedSigs, deliverEngineUserAck, counterpartyIsAgentSender, startAckArmed,
    startAckArmedAtMs, startAckRepliedNow, fireStartAckIfOwed, finalizeContext,
    teardownContext, preCallGatesContext,
  } = preflight.outputs;


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
