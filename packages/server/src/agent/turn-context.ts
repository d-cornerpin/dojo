// ════════════════════════════════════════════════════════════════════════════════
// THE TURN'S OWN BAG — one context object, opened by the turn, cleared in its
// `finally`. PHASE-6 T1.
//
// WHAT THIS REPLACES, AND WHY IT IS ONE OBJECT AND NOT TEN MAPS.
// Ten module-level `Map`s in `turn-state.ts` held one fact each about the turn in
// flight, all keyed by agentId, all deleted by ONE statement — and that statement
// lived inside `setAgentStatus(agentId, 'idle')`, so the lifetime of the turn's
// facts was a SIDE EFFECT OF A STATUS WRITE. Three things followed from that, and
// all three were live defects at `8e8106f`:
//
//   1. THE ORDINARY TURN CLEARED ITS OWN FACTS BEFORE TEARDOWN READ THEM. The
//      end-of-turn idle write sits inside the main `try`; the `finally` that
//      finalizes the turn record opens after it. Four teardown reads therefore
//      degraded to `null` on EVERY turn, silently, through `?.`/`?? null` — one of
//      them inside a bare `catch`. Two of `stampTasksAtTurnFinalize`'s four tie
//      predicates (`source_message_id`, `w.id = servedTaskId`) were consequently
//      matched against the empty string on every turn the engine has ever run, and
//      the terminal-delivery lookup ran UNSCOPED where it was written to be scoped
//      to the turn's own conversation.
//   2. THE ERROR PATH DID THE OPPOSITE AND LEAKED. `setAgentStatus(…, 'error')`
//      does not clear, so a turn that threw left every fact standing for the next
//      turn to inherit.
//   3. NOTHING OWNED THE LIFETIME. Ten deletes in one line is not an owner; it is
//      a habit that the next map added to the file has to remember to join.
//
// The bag fixes all three by construction: `openTurnContext` at the top of the
// turn, `endTurnContext` in the turn's `finally` — one clear point, on every exit
// path including the ones that `return` before the loop's own `try` opens, and
// including a throw.
//
// THE "NO ENTRY" CONTRACT IS PRESERVED EXACTLY. Every one of the ten maps
// distinguished "no entry" (called outside a turn) from "entry whose value is
// null" (this turn has no such thing — an engine/A2A turn with no human
// conversation). `turnContext(agentId)` returning `undefined` IS "no entry", and a
// field left `undefined` inside an open bag is the same state the map expressed by
// having no key. A field explicitly set to `null` is the map's explicit null. Every
// reader's `?? null` / `?.` / three-state `.has()` test keeps meaning what it meant.
//
// WHAT DOES NOT LIVE HERE, AND MUST NOT. `turn-state.ts` keeps the facts that are
// DELIBERATELY WIDER THAN A TURN — `turnBoundary`, `continuationContext`,
// `forceA2ATurn`, `a2aTurnRetries`, `untrackedWorkAcrossTurns`, `lastTurnWasA2A` —
// and `shared-state.ts` keeps the twelve process-level ones. Sweeping any of those
// into a bag cleared in `finally` would DELETE state that is supposed to outlive the
// turn: `continuationContext` is stashed by one turn expressly so the NEXT turn can
// consume it, and `untrackedWorkAcrossTurns` exists because the per-turn counter
// resetting every turn was the defect. `drainHead`'s retirement into a row
// (migration `140_drain_state.sql`, "A Map dies with the process") is the shape the
// cross-turn ones follow; it is not this module's shape.
// ════════════════════════════════════════════════════════════════════════════════

// ── Lanes & lineage spine (P1, 2026-07-21) ──
// The ROOT of the current turn: the one origin this turn is serving. Set at trigger
// claim (human pickup / engine-event claim / A2A wake). Writers of work records
// (tracker creates, scaffolds) read this to stamp the origin quad, so a task born
// from an ask carries the ask's identity instead of a prose copy of its text.
// kind vocabulary matches migration 112: ask / occurrence / a2a / engine.
export interface TurnRoot {
  kind: 'ask' | 'occurrence' | 'a2a' | 'engine';
  id: string;
  /** The message row id of the inbound human ask, when kind === 'ask'. */
  sourceMessageId: string | null;
  /** P6a: the conversation the root belongs to (from the trigger row). */
  conversationId?: string | null;
}

// The WORK the current engine turn is serving (P1 spine consumer #1): set at the
// engine-event claim from the trigger row's task/run referent columns. The
// reminder-delivery lane reads taskKind to know this turn's output belongs to the
// owner. PHASE-6 T0D: `null` when the referent named a row that is not there — a
// different fact from "served work whose kind we could not read".
export interface ServedWork {
  taskId: string | null;
  runId: string | null;
  taskKind: string | null;
  originConvKey: string | null;
}

/**
 * Everything the turn in flight knows about itself that must outlive the statement
 * that produced it. Two populations live here, and the second joined at PHASE-6 T9b:
 *
 *   1. FACTS CODE OUTSIDE THE LOOP READS BY AGENT ID — the original ten (T1).
 *      (`AgentTurnState` is the loop's own reducer state and is not reachable from
 *      the tool executor, which is why this exists beside it.)
 *   2. MUTABLE DRIVER LOCALS THAT CROSS A STEP BOUNDARY — RULING P6-R3(1): "the
 *      carrier is the turn's bag … and no second mechanism." A step package is a
 *      module, and a module boundary passes VALUES, not BINDINGS; a field on this
 *      object preserves live-read AND live-WRITE semantics by construction, because
 *      a property read happens at the moment it is read. The alternative — hand a
 *      step the value and let its write die at the boundary — is only harmless while
 *      nobody looks afterwards, which is the reasoning this project bans.
 *
 * Both populations have the same lifetime, which is why they share one object rather
 * than growing a second: `openTurnContext` at the top of the turn, `endTurnContext`
 * in its `finally`.
 *
 * `undefined` on a field means the same thing the old map meant by having no key.
 */
export interface TurnContext {
  readonly agentId: string;

  /** Kind of the turn ('user' | 'a2a'), set once the counterparty is resolved.
   *  Threaded onto agent:status='working' broadcasts so the dashboard composer can
   *  stay quiet (no thinking dots / stop button) on pure agent-to-agent turns
   *  unless wordy mode is on. */
  kind: 'user' | 'a2a' | undefined;

  /** E-C1: the conv_key of the conversation this turn is serving, so
   *  recall_recent_thread scopes to the CURRENT conversation instead of
   *  re-deriving "the most recently stamped conv_key" — which on an engine/A2A turn
   *  wrongly latched the last HUMAN conversation and bled it into the recall.
   *  Non-null = that human conversation; explicit `null` = engine/A2A turn. */
  convKey: string | null | undefined;

  /** PHASE-2 T10I: the same fact as `convKey`, as `conversations.id`.
   *
   *  ⚠ BOTH FIELDS EXIST ON PURPOSE and this is not a duplicate mechanism. `conv_key`
   *  did not die at T10I — it died on `messages` only. It is still first-class on FOUR
   *  other tables (`work.origin_conv_key`, `turns.conv_key`, `tool_receipts.conv_key`,
   *  `summaries.conv_key`), two of which are JOINED to each other on it
   *  (`tracker/delivery-evidence.ts` matches a work's `origin_conv_key` against a turn's
   *  `conv_key`). So the string above is what those four columns are stamped with, and
   *  the id here is what the MESSAGE readers scope on. Deleting either would break the
   *  other's consumers; they are two records of one fact only until the four surviving
   *  columns are themselves rekeyed. Same three-state contract, exactly. */
  conversationId: string | null | undefined;

  /** T-4: the iMessage address this turn is conversing with (the turn counterparty's
   *  senderId, when it is a human iMessage turn). This is the ONLY iMessage recipient
   *  state (the racy per-agent last-inbound map was stripped, P5c), so an explicit
   *  imessage_send with no recipient, and an image_create reply, go to THIS turn's
   *  person, not whoever messaged most recently during a multi-conversation drain. */
  imRecipient: string | undefined;

  /** P6b: the per-turn model-request id, the JOIN between the router's decision
   *  (router_log.request_id) and the spend it produced (cost_records.request_id).
   *  Minted once at turn start; out-of-turn model calls (background summarizers and
   *  the like) find no context and record NULL rather than inheriting a stale id. */
  modelRequestId: string | undefined;

  /** RC-12: the outer turn number, so writeToolReceipt can stamp an engine-written
   *  receipt with the turn that produced it WITHOUT threading turnNumber through
   *  every send executor. Absent means "outside a turn" and turn_number stays NULL. */
  turnNumber: number | undefined;

  root: TurnRoot | null | undefined;
  servedWork: ServedWork | null | undefined;

  /** C26: the register of engine-written tool_receipts ids. writeToolReceipt appends
   *  the moment it persists the row; the tracker complete gate demands a verified
   *  receipt for a turn that ran a send-class tool. Same-process, deterministic,
   *  LLM-free. Per-turn by construction now: a fresh bag starts empty, so a later
   *  poked turn keeps the prose-evidence path without anyone remembering to clear. */
  receiptIds: string[];

  /** RC-3 item 2: cumulative EMITTED recall/history output tokens for this turn.
   *  recall_recent_thread / history_search dumps are the doom-loop fuel (a wordy
   *  recall returns 12-16k chars, and nothing caps N of them per turn), so the tool
   *  dispatcher returns a short engine notice instead of another dump once the
   *  budget is spent. */
  recallTokens: number;

  /** F10: the handle of the wall-clock start-ack timer armed at turn start, so the
   *  turn's teardown can cancel it. `null` = not armed, or already cancelled.
   *
   *  ⚠ POPULATION 2 (see this interface's own header). It is the FIRST field here
   *  that no code outside the loop reads — it is a driver local, and it lives on the
   *  bag because it is the one mutable local the teardown span both READS and WRITES,
   *  which under RULING P6-R3(1) migrates to the turn's context BEFORE that span is
   *  extracted. Its lifetime is unchanged and provably so: the timer is armed after
   *  every exit that returns before the turn's main `try` opens, so there is no path
   *  that arms it and skips the teardown that cancels it. */
  startAckTimer: ReturnType<typeof setTimeout> | null;

  /** v2.9.23 phone-call streaming TTS — the sentence-splitting buffer the model's
   *  `onChunk` callback fills, holding the CURRENT stream's unsent tail (the sent
   *  prefix is stripped as each sentence flushes to `CallSession.queueAgentSay`).
   *
   *  ⚠ POPULATION 2, and the ONE carrier in the `finalize` tranche whose by-value
   *  alternative was measured UNSAFE rather than merely against the rule. Two
   *  reasons, both by command:
   *    * IT IS WRITTEN FROM A CALLBACK, not from straight-line driver code
   *      (`loop.ts`'s `onChunk`: `+= chunk`, then the sent-prefix strip). CUT 3's
   *      by-value test is "exactly one write site, none inside a timer or
   *      callback"; this family fails that test in its own words.
   *    * THE FINALIZE SPAN WRITES IT — the tail flush clears the buffer once the
   *      remaining sentence has been queued. Handed by value, that clear would die
   *      at the module boundary, harmless only while nobody looks afterwards.
   *  `phoneStreamCallSid`, the third local of the same mechanism, deliberately did
   *  NOT migrate here: it does not cross the `finalize` boundary, and migrating a
   *  local this tranche does not need is the next tranche's work (`callLLM` owns
   *  it). */
  phoneStreamBuffer: string;

  /** v2.9.23 / B-2: latched SYNCHRONOUSLY the moment the streaming path decides to
   *  flush, so the turn-end phone route knows the body was already spoken and does
   *  not fall to the one-shot full-reply fallback (the caller hearing the reply
   *  TWICE was the incident). ⚠ POPULATION 2, same family and same callback-write
   *  hazard as `phoneStreamBuffer` above; the two are one mechanism's state and
   *  migrate together. */
  phoneStreamFlushedAny: boolean;

  /** RC-10 / P5c: the owner-affinity promotion, resolved ONCE at turn start and read
   *  at the turn's reply-destination decision. `ownerAffinityDestination` is
   *  `'imessage'` only when affinity resolved AND the per-conversation cooldown
   *  allowed the promotion; `ownerAffinityConversationId` is the conversation ROW the
   *  cooldown is keyed by, which the promotion record needs at turn end.
   *
   *  ⚠ POPULATION 2, and honestly labelled: unlike the phone-stream pair these are
   *  written ONCE each, in straight-line driver code before the loop opens
   *  (`loop.ts`'s affinity block), so a by-value copy would be correct TODAY. They
   *  migrate under RULING P6-R3(1)'s rule rather than under a measured hazard — the
   *  ruling's own words are "a mutable local that crosses a step boundary migrates",
   *  and the alternative is a per-tranche judgment call that nine tranches would take
   *  nine different ways. The pair moves together because it is one mechanism: the
   *  destination is meaningless without the conversation its cooldown is keyed to. */
  ownerAffinityConversationId: string | null;
  ownerAffinityDestination: 'imessage' | null;
}

/** The one registry. Keyed by agentId because a turn belongs to an agent and
 *  because peers read each other's (`send_to_agent`'s busy check, the PM's closing
 *  turn, the iMessage bridge's turn-scoped recipient). */
const openContexts = new Map<string, TurnContext>();

/**
 * Open the turn's bag. Called ONCE at the top of the turn, before any fact is
 * published. A previous bag for the same agent is REPLACED, not merged: a fresh bag
 * is what "start each turn clean" means, and it is why no turn-entry clear calls
 * survive this change.
 */
export function openTurnContext(agentId: string): TurnContext {
  const ctx: TurnContext = {
    agentId,
    kind: undefined,
    convKey: undefined,
    conversationId: undefined,
    imRecipient: undefined,
    modelRequestId: undefined,
    turnNumber: undefined,
    root: undefined,
    servedWork: undefined,
    receiptIds: [],
    recallTokens: 0,
    startAckTimer: null,
    phoneStreamBuffer: '',
    phoneStreamFlushedAny: false,
    ownerAffinityConversationId: null,
    ownerAffinityDestination: null,
  };
  openContexts.set(agentId, ctx);
  return ctx;
}

/**
 * The turn in flight for this agent, or `undefined` when the agent is not in a turn.
 * `undefined` is the old maps' "no entry" and every reader's fallback keeps meaning
 * what it meant.
 */
export function turnContext(agentId: string): TurnContext | undefined {
  return openContexts.get(agentId);
}

/**
 * Close the turn's bag. Called from `runV2Turn`'s own `finally` — the ONE clear point,
 * on every exit path (clean end, mid-loop break, early return, throw).
 *
 * WHY THAT `finally` AND NOT THE LOOP'S TEARDOWN BLOCK, which is the obvious place and
 * the wrong one:
 *   * TWO EXITS RETURN BEFORE THE BODY'S `try` EVEN OPENS (the pickup-claim-lost bails,
 *     one human and one engine). Clearing inside the teardown `finally` would leak the
 *     bag on both — worse than the mechanism being replaced, which at least cleared
 *     there because those two write `idle`.
 *   * THE TEARDOWN BLOCK IS A READER. Four of its reads take the turn's root and its
 *     served work. A clear placed inside it has to be ordered after them by hand,
 *     forever, by every future editor — which is precisely the fragility that produced
 *     the defect. In the wrapper it is ordered after them BY THE LANGUAGE.
 *   * IT COSTS THE BODY NOTHING. `runV2TurnBody` is the function `runV2Turn` was, one
 *     parameter wider: no re-indentation and no moved code, so the collapse stays
 *     provably faithful and the nine step extractions (T2–T9b) inherit the `ctx` half
 *     of their `(state, ctx)` signature already threaded through the driver.
 */
export function endTurnContext(agentId: string): void {
  openContexts.delete(agentId);
}

/**
 * The three-state conversation scope, kept in one place because the three states are
 * the contract and a reader that flattens them re-opens E-C1: `undefined` = called
 * outside a turn (fall back to the legacy heuristic), `null` = engine/A2A turn (stay
 * on untagged/current-turn rows), a string = scope to that conversation.
 */
export function turnConversationScope(agentId: string): string | null | undefined {
  const ctx = openContexts.get(agentId);
  if (!ctx || ctx.conversationId === undefined) return undefined;
  return ctx.conversationId;
}

// The origin quad a work-record writer should stamp for work created by this agent
// right now. kind is the CREATION PATH (who decided to create the record), not the
// root kind; the source/turn/conv triple ties it to the live turn.
export interface WorkOrigin {
  kind: 'user_ask' | 'engine_scaffold' | 'a2a_assign' | 'model' | 'reminder' | 'user_direct' | 'system' | null;
  sourceMessageId: string | null;
  turn: number | null;
  convKey: string | null;
}

export function getWorkOriginForAgent(agentId: string, kind: WorkOrigin['kind']): WorkOrigin {
  const ctx = openContexts.get(agentId);
  return {
    kind,
    sourceMessageId: ctx?.root?.sourceMessageId ?? null,
    turn: ctx?.turnNumber ?? null,
    convKey: ctx?.convKey ?? null,
  };
}

/** Append a receipt id to this turn's register. Outside a turn this records nothing
 *  — the same answer `turnNumber` already gives for the same call (a receipt written
 *  for an agent that is not in a turn belongs to no turn), instead of the stale entry
 *  the old map created and carried to whenever that agent next went idle. */
export function noteTurnReceipt(agentId: string, receiptId: string): void {
  openContexts.get(agentId)?.receiptIds.push(receiptId);
}

/** Receipt ids written this turn for this agent (empty array if none / outside a turn). */
export function getTurnReceipts(agentId: string): string[] {
  return openContexts.get(agentId)?.receiptIds ?? [];
}

/** Recall/history output tokens accumulated this turn for the agent (0 if none). */
export function getRecallBudgetUsed(agentId: string): number {
  return openContexts.get(agentId)?.recallTokens ?? 0;
}

/** Add `tokens` to the agent's recall budget for this turn; returns the new total. */
export function addRecallBudgetUsed(agentId: string, tokens: number): number {
  const ctx = openContexts.get(agentId);
  if (!ctx) return 0;
  ctx.recallTokens += Math.max(0, tokens);
  return ctx.recallTokens;
}

/** Test-only: the agent ids currently holding an open bag. Production reads a
 *  specific agent's context; this exists so a leak is assertable. */
export function openTurnContextAgents(): string[] {
  return [...openContexts.keys()];
}
