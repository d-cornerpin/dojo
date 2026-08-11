// ════════════════════════════════════════
// PHASE-6 T6 (CUT 8) — THE `postCallClassify` STEP. RULING P6-R1: a step is a
// DIRECTORY with one entry point; this is it. CUT 8 in the ordinal order (P6-R3(3)).
//
// WHAT MOVED: `loop.ts`'s `postCallClassify` span — everything the engine decides
// AFTER the model has spoken and BEFORE any tool runs. The empty-response ladder, what
// kind of turn this was, what text gets persisted and whether it is a start line, the
// five floors that read the reply against the ledger, the `[no-reply]` sentinel and
// its ghosted-ask ladder, the "respond once" floors, the assistant row itself, and —
// when the model called no tools at all — the turn-ending floor family.
//
// WHAT THIS STEP IS ALONE IN OWING:
//   • THE HEAVIEST EXIT-REQUEST EXERCISE IN THE PHASE. Twenty-four control-flow
//     conversions — SEVEN `break`s and SEVENTEEN `continue`s — against `execute`'s six
//     and `teardown`'s zero. A module cannot break its caller's loop, so every one
//     became the shared exit-request channel with a reason, and the contract test pins
//     BOTH counts so a twenty-fifth cannot appear quietly.
//   • THE FLOOR FAMILY, AND IT IS AGENT-VOICED. The plan's tranche note: "the floor
//     family already runs agent-voiced (Phase 4); this tranche only RELOCATES with
//     tests riding along." OR2 holds by shape here — a floor's output is a STEER (a
//     model-visible `role='system'` row), never an assistant line the engine wrote for
//     the person to read as the agent.
//   • THE OWNER LAW OF 2026-07-09 — user turns are never reclassified mid-turn. The
//     post-model half of that law is `interAgentTurn`, computed in
//     `turn-classification.ts` behind a `counterparty.kind !== 'user'` floor.
//
// WHAT STAYED IN THE DRIVER, DELIBERATELY: the `advance` into this phase, so
// `validate()` runs on the transition and rule 2 of the shared contract (the phase
// belongs to the driver) holds.
//
// ── THE FOUR OUTPUTS, AND WHY THEY ARE OUTPUTS AND NOT BAG FIELDS ──
// The binder census finds exactly four declarations inside this span referenced after
// it, and all four are read at ONE place: the `execute` context, built in the same
// iteration, four statements later. A value produced and consumed inside one iteration
// is a return value; the turn's bag is for state that must outlive the statement that
// produced it, and putting these there would say something false about their lifetime.
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import type { DisplayKind } from '@dojo/shared';
import type { ModelCallResult } from '../../../model.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { UnrepliedAssign } from '../../../a2a-replies.js';
import { type AgentTurnState } from '../../state.js';
import { proceed } from '../step-outcome.js';
import { runEmptyResponse } from './empty-response.js';
import { runTurnClassification } from './turn-classification.js';
import { runTerminalText } from './terminal-text.js';
import { runReplyFloors } from './reply-floors.js';
import { runNoReply } from './no-reply.js';
import { runCloseoutFloors } from './closeout-floors.js';
import { runPersistAssistant } from './persist-assistant.js';
import { runNoToolCalls } from './no-tool-calls.js';
import { runOwedInterrupt } from './owed-interrupt.js';

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const POST_CALL_CLASSIFY_PHASE = 'postCallClassify' as const;

/** What the model call handed this step: the provider's own result shape, imported
 *  from the module that OWNS it rather than re-declared here — a second structural
 *  copy is how two shapes drift apart. */
export type PostCallModelResult = ModelCallResult;

/**
 * Everything the span read from the driver, measured rather than guessed: after this
 * tranche's three carrier commits the binder census finds 33 crossing declarations at
 * `runV2TurnBody`'s own top level, of which `state` rides the step contract and
 * `chosenConversationId` DISSOLVES into `turnCtx.conversationId` (CUT 4's precedent —
 * the driver assigns the bag from it before the loop and nothing writes either
 * afterwards). The rest are here, plus the two values `callLLM` produced this round
 * and one driver module-level constant that is PASSED because it has readers outside
 * this span.
 */
export interface PostCallClassifyContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: Database;
  readonly agent: { name?: string | null; [key: string]: unknown };
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly hasUnansweredUser: boolean;
  readonly triggerRow: { rowid: number; content: string; [key: string]: unknown } | null;
  readonly isA2ATurn: boolean;
  readonly isEngineTurn: boolean;
  readonly isHumanContinuation: boolean;
  readonly mostRecentIsA2A: boolean;
  readonly mostRecentInbound: { origin_intent?: string | null; [key: string]: unknown } | undefined;
  readonly pendingEngineEvent: { originIntent?: string | null; [key: string]: unknown } | null;
  readonly unrepliedAssign: UnrepliedAssign | null;
  readonly a2aReplyContext: { intent?: string; threadShort?: string; fromName?: string } | null;
  readonly a2aReplyAssignMessageId: string | null;
  readonly settledContextWakeTurn: boolean;
  readonly waitingConvs: ReadonlyArray<{ key: string; oldestWaitingRowid: number; latest: { content: unknown } }>;
  readonly inboundChannel: string | null;
  readonly latestUserSource: string | null;
  readonly lastUserMessageContent: string | null;
  readonly configuredModelId: string;
  readonly turnStartedAt: string;

  /** Produced by `callLLM` in THIS iteration. */
  readonly messageId: string;
  readonly result: PostCallModelResult;

  /** Declared at `loop.ts`'s module level and read OUTSIDE this span too, so one
   *  declaration is handed across rather than moved or copied — CUT 6's shape. */
  readonly maxToolLoops: number;

  /** Closures the driver owns, passed rather than imported so a step never points back
   *  at the driver (CUT 2's `stopStatusHeartbeat` precedent). A function VALUE keeps
   *  the bindings it closed over, so passing one preserves live-read semantics by
   *  construction. */
  readonly reArmIfStrandedNoAnswer: () => void;
  readonly noteTerminalAnswer: (rowId: string, surface: string) => void;
  readonly deliverEngineUserAck: (
    text: string, originIntent: string | null, reuseId?: string | null, displayKind?: DisplayKind | null,
  ) => Promise<void>;
  readonly persistAndBroadcastSystemRow: (content: string) => void;
  readonly startAckRepliedNow: () => boolean;
}

/**
 * The values that flow BETWEEN this step's sections. Not the turn's bag and not the
 * step's output: they are the span's own locals, and they are a mutable object for the
 * same reason `execute` has one — a section that both reads and writes `persistedContent`
 * cannot be handed a copy of it.
 */
export interface PostCallScratch {
  persistedContent: string | null;
  interAgentTurn: boolean;
  deliberateSurfaceTurn: boolean;
  deliveredAsStartLine: boolean;
  hasXmlFallbackTools: boolean;
  effectiveModelIdForPersist: string;
}

/** The step's outcome. On the `proceed` arm it carries the FOUR values the rest of the
 *  iteration reads; on every other arm the iteration is over and there is nothing to
 *  carry. */
export type PostCallClassifyOutcome =
  | {
      readonly directive: 'proceed';
      readonly state: AgentTurnState;
      readonly persistedContent: string | null;
      readonly interAgentTurn: boolean;
      readonly hasXmlFallbackTools: boolean;
      readonly effectiveModelIdForPersist: string;
    }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  // `abandon` is deliberately absent, and its absence is asserted by the contract
  // test's directive census: leaving the TURN rather than the loop is `callLLM`'s
  // alone (the user pressed stop, or a peer preempted, while the model call was in
  // flight), and CUT 4's finalize contract pins those at exactly two from the
  // driver's side.
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

/**
 * Everything the engine decides after the model has spoken and before any tool runs.
 *
 * The sequence below is the span's own order, and the order is load-bearing: the
 * suppression decisions come before the floors that read the surviving text, and the
 * assistant row is persisted before the turn-ending family gets to ask whether the
 * person heard anything.
 */
export async function runPostCallClassify(
  state: AgentTurnState,
  ctx: PostCallClassifyContext,
): Promise<PostCallClassifyOutcome> {
  const { result, configuredModelId } = ctx;

  const sc: PostCallScratch = {
    persistedContent: null,
    interAgentTurn: false,
    deliberateSurfaceTurn: false,
    deliveredAsStartLine: false,
    hasXmlFallbackTools: false,
    effectiveModelIdForPersist: configuredModelId,
  };

  const empty = runEmptyResponse(state, ctx);
  if (empty.directive !== 'proceed') return empty as PostCallClassifyOutcome;
  state = empty.state;

  const classified = runTurnClassification(state, ctx, sc);
  if (classified.directive !== 'proceed') return classified as PostCallClassifyOutcome;
  state = classified.state;

  const text = await runTerminalText(state, ctx, sc);
  if (text.directive !== 'proceed') return text as PostCallClassifyOutcome;
  state = text.state;

  const floors = runReplyFloors(state, ctx, sc);
  if (floors.directive !== 'proceed') return floors as PostCallClassifyOutcome;
  state = floors.state;

  const noReply = await runNoReply(state, ctx, sc);
  if (noReply.directive !== 'proceed') return noReply as PostCallClassifyOutcome;
  state = noReply.state;

  const closeout = runCloseoutFloors(state, ctx, sc);
  if (closeout.directive !== 'proceed') return closeout as PostCallClassifyOutcome;
  state = closeout.state;

  const persisted = await runPersistAssistant(state, ctx, sc);
  if (persisted.directive !== 'proceed') return persisted as PostCallClassifyOutcome;
  state = persisted.state;

  if (result.toolCalls.length === 0) {
    const ended = await runNoToolCalls(state, ctx, sc);
    if (ended.directive !== 'proceed') return ended as PostCallClassifyOutcome;
    state = ended.state;
  } else {
    // ── UX-REPAIR ROUND 7.5 T32 LEG B1 — THE SECOND CALL SITE, AND IT IS WHY B1 IS NOT INERT ──
    //
    // `runOwedInterrupt` lives in the turn-ending floor family, which runs only when the model
    // called NO tools. On a research turn that is the LAST pass — every pass before it rode
    // tool calls — so the one step that points at a mid-turn arrival could not see it until the
    // turn's own answer had already been written. W11 measured exactly that and recorded the
    // in-flight arm as never exercised; the round-7 S6 incident is its consequence, the full
    // earbuds comparison delivered seven seconds after "never mind, forget the earbuds".
    //
    // T30's own text asks for this in as many words — *"surface it to the in-flight model call
    // loop instead of holding it for the follow-up turn"*. The step is called, not copied, so
    // there is one detection, one steer text pair and one grant record.
    //
    // ⚠ IT MAY NOT TAKE THE LOOP HERE. The tool calls this pass produced have not run yet: the
    // `execute` step is four statements downstream, and a `continue` would drop them. The step
    // reads `ctx.result.toolCalls` and returns `proceed` on this path for that reason; the
    // steer rides into the next assembly out of the queue, which is how every other floor's
    // steer reaches the model anyway. Non-`proceed` is still forwarded, because a step that
    // asks to stop stops — it just cannot happen from this arm.
    const owedInFlight = await runOwedInterrupt(state, ctx, sc);
    if (owedInFlight.directive !== 'proceed') return owedInFlight as PostCallClassifyOutcome;
    state = owedInFlight.state;
  }

  return {
    ...proceed(state),
    persistedContent: sc.persistedContent,
    interAgentTurn: sc.interAgentTurn,
    hasXmlFallbackTools: sc.hasXmlFallbackTools,
    effectiveModelIdForPersist: sc.effectiveModelIdForPersist,
  } as PostCallClassifyOutcome;
}
