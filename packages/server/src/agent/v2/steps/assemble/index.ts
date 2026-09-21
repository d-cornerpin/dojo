// ════════════════════════════════════════
// PHASE-6 T4 (CUT 6) — THE `assemble` STEP. RULING P6-R1: a step is a DIRECTORY
// with one entry point; this is it. CUT 6 in the ordinal order (P6-R3(3)), and
// the cut whose close is T12's SECOND ORDINAL CHECKPOINT.
//
// WHAT MOVED: `loop.ts`'s `assemble` span — build the one shared turn context,
// ask the allocator for the window, record the VOLATILE BOUNDARY, then append the
// loop's own tail entries (technique hints, the context-gap nudge, the multi-step
// scaffold and its notices, the delegation hint, the user's attachments) and drain
// one steer onto the tail.
//
// WHAT THIS STEP IS ALONE IN OWING, and both are in its contract test:
//   • SIX OUTPUTS — the most of any tranche, against CUT 5's two. They are the
//     whole of what the model call consumes: the assembled context, its message
//     array, its system prompt, the volatile boundary, the injection context and
//     the steer awaiting confirmation. `callLLM`'s own context comment already
//     said so before this cut existed ("five of its inputs … are produced by
//     `assemble`, inside this same iteration"), so the outputs are not a new
//     surface — they are the seam that was already written down.
//   • THE CACHE-PREFIX LAW'S OWN SPAN (OR7 / roadmap non-negotiable #10).
//     `volatileFrom` is recorded HERE, at the instant the allocator's work ends
//     and before the loop appends anything; every injection below lands at or
//     after it. A pure reorder with byte-identical content is INVISIBLE to the
//     release-gate prefix check (it reads only system prompt and tools), which is
//     why the contract test asserts the boundary itself rather than trusting the
//     golden gates alone — and why both goldens ran before every commit here.
//
// WHAT STAYED IN THE DRIVER, DELIBERATELY: the `advance` into this phase, so
// `validate()` runs on the transition and rule 2 of the shared contract (the phase
// belongs to the driver) holds; and `STALE_TASK_WINDOW_MINUTES`, which is passed
// on the context rather than moved or copied — it is declared at module level in
// `loop.ts`, a guard pins it there BY PATH on purpose (`work-reaper.test.ts`, the
// narrower and therefore stronger corpus), and `execute` reads it too. One
// declaration, handed across, is the only shape that keeps all three true.
// ════════════════════════════════════════

import { assembleContext, type AssembledContext } from '../../../../memory/assembler.js';
import { estimateTokens } from '../../../../memory/budget.js';
import { buildAssemblyContext } from '../../../../prompt/registry/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';
import { broadcast } from '../../../../gateway/ws.js';
import { clearConsumedOneShotFlags } from '../../../runtime.js';
import { complexityClassifier } from '../../classifiers/complexity.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { SteerEntry } from '../../steer-queue.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { AgentStatus } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { injectTechniqueAndGapHints } from './technique-hints.js';
import { detectMultistepAndScaffold } from './multistep-detection.js';
import { injectDelegationHintAndAttachments } from './delegation-and-attachments.js';
import { runSteerCheckpoint } from './steer-checkpoint.js';
import { proceed, requestExit } from '../step-outcome.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const ASSEMBLE_PHASE = 'assemble' as const;

/** The array the assembler hands over and the injections append to. */
type ModelMessage = AssembledContext['messages'][number];

/** Everything the span read from the driver, measured rather than guessed: the binder
 *  census after this tranche's three carrier commits found 22 crossing declarations,
 *  of which `state` rides the step contract and these are the rest. */
export interface AssembleContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: import('better-sqlite3').Database;
  readonly contextModelId: string;
  readonly contextWindow: number;
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly hasUnansweredUser: boolean;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly isNotificationTurn: boolean;
  readonly lastUserMessageContent: string | null;
  readonly latestTtsEngine: 'local' | 'cloud' | null;
  readonly latestUserSource: 'text' | 'voice' | null;
  readonly mostRecentIsA2A: boolean;
  readonly pendingEngineEvent: { rowid: number; originIntent?: string | null } | null;
  /**
   * T83 fix round 2: the newest inbound row, the SAME one `isNotificationTurn`
   * (`preflight/turn-classification.ts`) tested to classify this turn. Read ONLY to
   * resolve the notification trigger's own message id for `engineEventKeepFullId` —
   * never re-classified here, `isNotificationTurn` is the one decision.
   */
  readonly mostRecentInbound: { rowid: number } | null | undefined;
  readonly waitingConvs: ReadonlyArray<unknown>;
  /** Rides BY VALUE on positive evidence (#15), not on an absence: one write site,
   *  in `postCallClassify`, straight-line — nothing can write it while the driver is
   *  suspended awaiting this step. CUT 3's own by-value finding for this same local. */
  readonly engineStartAckDeliveredThisTurn: boolean;
  /** The stale-work window, PASSED rather than moved or copied — see the header. */
  readonly staleTaskWindowMinutes: number;
  /** Driver CLOSURES and helpers, passed as values so their bindings stay live across
   *  the boundary (CUT 2's precedent) and so a step never points back at the driver. */
  readonly startAckRepliedNow: () => boolean;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
}

/** The six values the span DECLARES and the rest of the turn reads. A module cannot
 *  leave a declaration behind for its caller, so they come back on the proceed arm,
 *  where the type puts them out of reach of every other arm. */
export type AssembleOutcome =
  | {
      readonly directive: 'proceed';
      readonly state: AgentTurnState;
      readonly assembled: AssembledContext;
      readonly messages: ModelMessage[];
      readonly systemPrompt: string;
      readonly volatileFrom: number;
      readonly modelContext: AssemblyContext;
      readonly steerAwaitingConfirm: SteerEntry | null;
      /**
       * T82a fix wave — THE EXACT TURN CONTEXT `assembleContext` WAS CALLED WITH.
       *
       * The router (auto-routing) picks the model AFTER this assembly ran, against the
       * `'__auto__'` sentinel (`getProviderCeilingTokens('__auto__')` is `null` by
       * construction — no such model row exists — so the provider-aware cap this task's
       * first commit taught `contextWindowPolicy` never engaged for an auto-routed turn).
       * `callLLM` re-runs `assembleContext` with the REAL model once the router names it,
       * and it must call it with the SAME turn context or the re-assembly would silently
       * diverge in content (a different counterparty header, a different othersWaiting
       * count) from the one this iteration actually decided. One object, handed across —
       * not rebuilt — for the same reason `staleTaskWindowMinutes` is passed rather than
       * recomputed (see this file's header).
       */
      readonly assemblyTurnContext: PromptTurnContext;
    }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

export async function runAssemble(stateIn: AgentTurnState, ctxIn: AssembleContext): Promise<AssembleOutcome> {
  const {
    agentId, turnCtx, turnNumber, db, contextModelId, contextWindow, counterparty,
    counterpartyIsAgentSender, chosenConvKey, hasUnansweredUser, isA2ATurn, isEngineTurn,
    isNotificationTurn, lastUserMessageContent, latestTtsEngine, latestUserSource,
    mostRecentIsA2A, pendingEngineEvent, mostRecentInbound, waitingConvs, engineStartAckDeliveredThisTurn,
    staleTaskWindowMinutes, startAckRepliedNow, setAgentStatus,
  } = ctxIn;
  let state = stateIn;

  // Intent companion to attribution: a quick conversational ask ("add a reminder",
  // "move my 10am") must not spin up a tracked, PM-validated task that then churns.
  // Classify the trigger, a 'simple' ask from a user is conversational, a 'complex'
  // one is project work, and pass it so the assembler injects guidance to handle
  // it directly. (Reuses the complexity classifier that was computed but unconsumed.)
  const conversationalTurn = counterparty.kind === 'user'
    && complexityClassifier(lastUserMessageContent ?? '').complexity === 'simple';
  // Content-preservation for THE ROW THAT IS THIS TURN'S OWN TRIGGER.
  //
  // T83 (behav-sig:a9ca4fea) — WAS scoped to origin_intent === 'a2a_request' only (Healer
  // QUESTION, PM escalation, destructive-gate approval — content the receiver must act on,
  // an approval token, the full escalation). But `isEngineTurn` is ALREADY the general
  // claim: it is true iff `pendingEngineEvent != null` (`preflight/turn-classification.ts`
  // `isEngineTurn = !isA2ATurn && !hasUnansweredUser && pendingEngineEvent != null`), and
  // OPEN-11's own comment on that line says it plainly for every engine turn, not one
  // intent: "The scheduler payload itself is the ACTIVE USER DIRECTIVE this turn."
  // `engine-riders.ts` draws the real line, structurally, upstream of this file: a
  // **deliverable event** (schedule fire, tracker assignment, reminder, healer action, "a
  // peer's completion report", an a2a request, a spawn kickoff, a PM review) IS the reason
  // for a turn, while a **rider** (thrash steer, delegation hint, the fan-out compile order,
  // …) merely rides one — and `getPendingEngineEvent`'s own query (`DELIVERABLE_ENGINE_EVENT_
  // WHERE`) excludes every `ENGINE_RIDER_INTENTS` value by construction, so `pendingEngineEvent`
  // can NEVER be a rider. Narrowing this exemption to one deliverable intent left every OTHER
  // one — 'completion_report' among them — subject to the EVENTS/awareness lane's truncation
  // exactly like an ambient notice, even though it is this turn's whole reason for existing.
  //
  // MEASURED (the incident this closes): a freshly spawned A2A worker sends its DELIVERABLE
  // and exits; `close-the-loop.ts` inserts a `completion_report` engine event and the runtime
  // drain wakes it for a follow-up turn. That turn's ENTIRE live tail is the agent's own
  // send_to_agent tool_use/tool_result pair (a fresh spawn has nothing else) plus this one
  // 'user'-role trigger row. The awareness sweep (this exemption's only gate) pulled the
  // trigger out into the gisted events lane, leaving `freshTail` = [assistant tool_use, an
  // all-tool_result "user" row] — no leading user message — which `applyIntegrityPass`'s
  // "must start with role=user" repair then shifts to EMPTY. Assembly's own zero-guard fired
  // (`memory-assembler: Context assembly produced 0 messages after filtering`) and recovered
  // via an unscoped "last user message in the DB" query that happened, by luck of recency
  // ordering, to land back on the very row that had just been filtered out.
  //
  // THE FIX IS THE RULE, NOT A SECOND INTENT LITERAL: keep THE PENDING ENGINE EVENT full
  // whenever it is driving this turn, full stop — `isEngineTurn && pendingEngineEvent` is
  // already exactly "this row is why this turn exists", by the definition one file over.
  // Every OTHER engine-origin row in the tail (an ambient notice that is NOT the row
  // driving this particular turn) is untouched: it is not `pendingEngineEvent` and stays
  // gisted, per T68b's charter ("every OTHER engine notice ... still gists at 400").
  //
  // T83 FIX ROUND 2 (review, behav-sig:a9ca4fea — structural code-read, no live repro) —
  // THE SAME CLASS HAS A SECOND MEMBER: THE NOTIFICATION TURN.
  //
  // `isNotificationTurn` (RC-5.2, `preflight/turn-classification.ts:266-293`) is a wake
  // whose own trigger is an UNAUTHORIZED human inbound row (a mailbox notice, an unknown
  // sender) — structurally the exact same shape as an engine turn: one specific row IS
  // the reason this turn exists, and `scopeToHumanConversation` (`memory/assembler.ts`,
  // "Unauthorized human inbound ... is NOT a conversation. Keep it so the caller can lift
  // it into the EVENTS/awareness lane") deliberately keeps it in the scoped tail so the
  // SAME awareness partition can gist it — the identical door `scopeToEngineTurn`'s kept
  // engine rows walk through. `isEngineTurn` excludes `isNotificationTurn` by construction
  // (`isNotificationTurn` requires `!isEngineTurn`), so the gate above never fires for it,
  // and a history-sparse agent whose whole tail is that one unauthorized row plus its own
  // prior self-output hits the identical leading-role strip this task already fixed once.
  //
  // THE ALTITUDE RULE STANDS: exempt THE TRIGGER ROW BY IDENTITY, never a category. On a
  // notification turn the trigger is `mostRecentInbound` — the SAME row
  // `isNotificationTurn`'s own condition just tested — never "every unauthorized row in
  // the tail" (an older, unrelated unauthorized notice sitting earlier in the session is
  // NOT this turn's reason for existing and must keep gisting, exactly like an ambient
  // engine notice that is not `pendingEngineEvent`).
  let engineEventKeepFullId: string | null = null;
  const turnTriggerRowid =
    isEngineTurn && pendingEngineEvent ? pendingEngineEvent.rowid
    : isNotificationTurn && mostRecentInbound ? mostRecentInbound.rowid
    : null;
  if (turnTriggerRowid != null) {
    try {
      const idRow = db.prepare('SELECT id FROM messages WHERE agent_id = ? AND rowid = ?')
        .get(agentId, turnTriggerRowid) as { id: string } | undefined;
      engineEventKeepFullId = idRow?.id ?? null;
    } catch { /* best effort, fall back to the truncated awareness gist */ }
  }
  // C28 Part 1: one shared turn context, threaded into BOTH assembleContext
  // (system) AND the message-injection mctx, so the msg.turn-context entry can
  // read counterparty / othersWaiting / conversationalTurn / isEngineTurn (they
  // are not recomputed).
  const sharedTurnContext = { latestUserSource, ttsEngine: latestTtsEngine, isA2ATurn, isEngineTurn, isNotificationTurn, counterparty, othersWaiting: Math.max(0, waitingConvs.length - 1), conversationalTurn, engineEventKeepFullId, resolvedReplyChannel: turnCtx.ownerAffinityDestination ?? undefined };
  // LIVE = RELOAD, pre-model half (incident 2026-07-06): the persisted-output
  // visibility keys on the six-way interAgentTurn union (computed post-model,
  // below), but the dashboard's live suppression needs the turn kind BEFORE the
  // first chunk/tool frame. Stamp here from the union's PRE-MODEL-knowable
  // terms: the A2A trigger, an agent counterparty, and the background-A2A
  // condition (mostRecentIsA2A with no unanswered user, which also subsumes the
  // exchange term). The spontaneous/pure-background terms depend on what the
  // model does, so the post-model re-stamp below remains as the catch-up for
  // later phases of the same turn.
  // USER TURNS ARE NEVER RECLASSIFIED (owner law 2026-07-09): a turn whose
  // counterparty is a human stays turnKind 'user' for its whole life, no
  // matter what it does along the way. Without this guard, the recency terms
  // below flip a user-facing turn to 'a2a' the moment it delegates via
  // send_to_agent, which hides the working dots + stop button in regular
  // (non-wordy) mode and buries the rest of the turn's output as inter-agent
  // traffic (production transcript 2026-07-09).
  const preModelInterAgent = counterparty.kind !== 'user' && (isA2ATurn || counterparty.kind === 'agent' || (mostRecentIsA2A && !hasUnansweredUser));
  if (preModelInterAgent && turnCtx.kind !== 'a2a') {
    turnCtx.kind = 'a2a';
    broadcast({ type: 'agent:status', agentId, status: 'working', turnKind: 'a2a', userFacing: !!chosenConvKey });
  }
  const ctx = await assembleContext(agentId, contextModelId, sharedTurnContext);
  // ── S3 (PHASE-3 T3): ASSEMBLY IS A READ; THE TURN OWNS THE WRITE. ──
  // `memory/assembler.ts` used to `UPDATE agents SET config` from inside its own read
  // path to clear the one-shot A2A-preempt and Stop markers it had just rendered. That
  // made any probe, retry or dry-run silently consume a marker the user had earned. The
  // assembler now REPORTS what it consumed and the turn clears it, once, here.
  clearConsumedOneShotFlags(agentId, ctx.consumedOneShotFlags);
  // T68b: the assembly's verdict on whether the fan-out compile order arrived WHOLE, carried
  // to the gate whose refusal text asserts that it did. Re-derived from THIS iteration's
  // array, never latched — the same discipline `compileOwedGateDecision` states for the owed
  // list itself. `null` (no compile order in the tail) and `false` (there is one and it was
  // cut) are the same answer to the only question the gate asks, so both land as `false`.
  state = advance(state, { compileOrderReachedModel: ctx.compileOrderIntact === true });
  // PHASE-3 T3: THE VOLATILE BOUNDARY, recorded for the prefix gate. Everything the
  // ALLOCATOR produced is the cacheable region; everything the LOOP appends below this
  // point is the tail-append (`lane.loop-tail`) — the technique hints, the context-gap
  // and delegation hints, the one-shot pending nudge, the tool note, turn-context,
  // peer-status and the clock. They are volatile BY DESIGN and re-emitted every
  // iteration, so a gate that judges them as prefix churn reports the prescribed shape
  // as a defect, which is why `check-message-prefix` could never go green.
  const volatileFrom = ctx.messages.length;
  turnCtx.lastAssembledAtIso = new Date().toISOString(); // F9: see assembledContextAsks
  let systemPrompt = ctx.systemPrompt;
  const messages = ctx.messages;
  // ── STRIP (PHASE-3 T7 Step 2, 2026-08-01) — the SETTLED_HINT is DELETED, both branches.
  // It was ~65 tokens of prose on every turn that actually fires (260 chars; 341 / 86
  // tokens on the rarer settled-wake wording) telling the model not to re-answer the OTHER
  // conversations visible above it. Scar-tissue ledger, verbatim: "STRIP. Requirement: a
  // turn acts only on its root; assembly scopes by id, so there is nothing to warn about."
  // That is the whole argument and it is now literally true rather than aspirational —
  // when the hint was written (`8bc7d7a`, 2026-07-10) the window really did carry other
  // conversations, so the prose was the only thing standing between the model and them.
  //
  // requirement preserved, three deep and every layer verified alive at this HEAD:
  //   1. STRUCTURAL — `memory/assembler.ts scopeToHumanConversation` keeps only THIS
  //      conversation's rows plus the agent's own output for it. There is no other
  //      conversation in the window to be warned about, so the warning has no referent.
  //   2. DETERMINISTIC, WIRED, RUNNING — `checks/check-reanswer-ghost.mjs` (54 delivered
  //      messages in, 54 out, no model call) is on the kit's prompt-gate roster AND the
  //      dojo REQUIRED list as of this same task, and it is green in-roster. Note what it
  //      guards and what it does not: it proves the window is never MISSING history, which
  //      is the cause the hint was compensating for. It was wired FIRST, on purpose —
  //      RULING P3-R3 exists because the earlier ruling deleted against a guard nobody had
  //      checked was running.
  //   3. BEHAVIOURAL — `settled-work-stays-settled` (kit battery) drives a real delivery,
  //      closes it, wakes the agent on something unrelated, and asserts zero re-answers
  //      and zero new artifacts. That is the user-facing property the prose asked for,
  //      asserted on a real model instead of requested from one.
  //
  // The `tagMessageLane('engine.settled-hint')` emission goes with it, and with it the
  // last `registry-exempt` marker in this file's assembly path: the hint needed the
  // in-flight array, which is why it could never move behind the registry.
  // Savings: -65 tokens on the fresh tail of every turn, measured (T7 sitting 1; T6's
  // 234-receipt distribution recorded `engine.settled-hint 65/65`).

  // FA-M1: record the non-compressible overhead the assembler just produced
  // (system prompt + the tool-schema/output reserve it also reserves) so the
  // NEXT iteration's pre-call gate measures the compressible total against the
  // real compressible budget instead of the full window.
  // PHASE-3 T4: this used to add the imported `TOOL_AND_OUTPUT_RESERVE` constant, which
  // is now measured per agent and no longer importable. `ctx.reserveTokens` is the
  // number the assembler ACTUALLY set aside on the assembly that just ran — the loop
  // reads the decision instead of re-deriving it, which is the same one-owner move.
  turnCtx.assemblerOverheadTokens = estimateTokens(systemPrompt) + (ctx.reserveTokens ?? 0);

  // FA-M1: surface the assembler's oldest-fresh-tail eviction. budgetFreshTail
  // silently dropped older fresh-tail groups to fit the window (live-view loss
  // where the weakest model needs it most). Emit the existing CONTEXT_HIGH
  // warning once per turn so the dashboard shows it instead of it being
  // log-only. The dropped rows are persisted and later summarized (not lost).
  if (!turnCtx.freshTailDropWarned && (ctx.freshTailDropped ?? 0) > 0) {
    turnCtx.freshTailDropWarned = true;
    const dropped = ctx.freshTailDropped ?? 0;
    logger.warn('assembler evicted oldest fresh-tail messages to fit the window (live-view loss)', {
      agentId, dropped, contextWindow,
    }, agentId);
    try {
      broadcast({
        type: 'chat:error',
        agentId,
        error: `Agent's memory is full, so it set aside its ${dropped} oldest recent message${dropped === 1 ? '' : 's'} to keep working. Older context is still saved.`,
        code: 'CONTEXT_HIGH',
        severity: 'warning',
        retryable: false,
      });
    } catch { /* best effort */ }
  }

  // One message-injection context for this iteration's §3c entries
  // (technique, context-gap, tracker-notif, nudge, tool-note, turn-context). The
  // loop sets mutable fields (the drained steer, technique payload) at each site and
  // calls injectRegistryMessage, so injection is registry-owned (R8). The
  // registry is the only assembler path (R7), so this is always built.
  const mctx: AssemblyContext = buildAssemblyContext(
    agentId,
    contextModelId,
    sharedTurnContext,
    // The steer starts null: which entry (if any) rides this iteration is the DRAIN's
    // decision, taken below against the declared precedence table.
    { loopCount: state.loopCount, turnNumber, lastUserMessageContent: lastUserMessageContent ?? '', pendingSteer: null },
  );


  await injectTechniqueAndGapHints(state, { agentId, turnCtx, lastUserMessageContent, mctx, messages });

  state = await detectMultistepAndScaffold(state, {
    agentId, turnNumber, turnCtx, db, counterparty, counterpartyIsAgentSender, lastUserMessageContent,
    engineStartAckDeliveredThisTurn, staleTaskWindowMinutes,
  });

  await injectDelegationHintAndAttachments(state, {
    agentId, turnNumber, counterparty, lastUserMessageContent, mctx, messages,
  });

  const steer = runSteerCheckpoint(state, {
    agentId, turnCtx, turnNumber, engineStartAckDeliveredThisTurn, startAckRepliedNow, mctx, messages,
  });
  state = steer.state;
  const steerAwaitingConfirm = steer.steerAwaitingConfirm;

  // Empty-messages guard (preserve v1 behavior at runtime.ts:1014-1020)
  if (messages.length === 0) {
    logger.info('v2: assembled context has zero messages, clean exit', {
      agentId,
      loopCount: state.loopCount,
    }, agentId);
    setAgentStatus(agentId, 'idle');
    return requestExit(state, 'empty-assembled-context') as Extract<AssembleOutcome, { directive: 'exit' }>;
  }

  return {
    ...proceed(state), directive: 'proceed', state,
    assembled: ctx, messages, systemPrompt, volatileFrom, modelContext: mctx, steerAwaitingConfirm,
    assemblyTurnContext: sharedTurnContext,
  } as AssembleOutcome;
}
