// Per-agent turn state shared between the runtime and context assembler.
// Lives in its own module to avoid circular imports (runtime ↔ assembler).

// Timestamp of when each agent's current turn started, context assembly
// uses this to exclude user messages that arrived mid-turn so they get
// a fresh run via the wakeup mechanism.
export const turnBoundary = new Map<string, string>();

// Kind of the current turn per agent ('user' | 'a2a'), set once the turn's
// counterparty is resolved. Threaded onto agent:status='working' broadcasts so
// the dashboard composer can stay quiet (no thinking dots / stop button) on
// pure agent-to-agent turns unless wordy mode is on. Cleared when idle.
export const currentTurnKind = new Map<string, 'user' | 'a2a'>();

// E-C1: the conv_key of the conversation the current turn is serving. Set when the
// turn picks its trigger; read by recall_recent_thread so it scopes to the CURRENT
// conversation instead of re-deriving "the most recently stamped conv_key", which
// on an engine/A2A turn (no human conv stamped this turn) wrongly latched the last
// HUMAN conversation and bled it into the recall. The map having an entry means a
// turn is in progress: a non-null value = that human conversation; an explicit null
// = engine/A2A turn (no human conv) → recall stays on untagged/current-turn rows.
// No entry = called outside a turn → recall falls back to the legacy heuristic.
export const currentTurnConvKey = new Map<string, string | null>();

// T-4: the iMessage address this turn is conversing with (the turn counterparty's
// senderId, when it's a human iMessage turn). getInboundSenderFor prefers this over
// the racy per-agent pendingIMResponseMap (a single last-inbound value), so an
// explicit imessage_send with no recipient, and an image_create reply, go to THIS
// turn's person, not whoever messaged most recently during a multi-conversation
// drain (the "reply to a contact sent to the owner" class of bug). Cleared on idle.
export const currentTurnImRecipient = new Map<string, string>();

// C26: per-turn register of engine-written tool_receipts ids. writeToolReceipt
// (receipts/store.ts) appends the receipt id here the moment it persists the
// row; the tracker complete gate reads getTurnReceipts(agentId) to demand a
// verified receipt for a turn that ran a send-class tool. Same-process,
// deterministic, LLM-free, the same pattern as currentTurnKind above. Cleared
// at the turn boundary (turn entry + idle) so receipts only ever count for the
// turn that produced them; a later poked turn keeps the prose-evidence path.
export const currentTurnReceipts = new Map<string, string[]>();

// RC-12: the outer turn number of the current turn per agent. Set by the loop
// right after it derives turnNumber (mirrors currentTurnConvKey above); read by
// writeToolReceipt (receipts/store.ts) so an engine-written receipt can be stamped
// with the turn that produced it WITHOUT threading turnNumber through every send
// executor. Cleared at the turn boundary (idle). A missing entry means "outside a
// turn" and the receipt's turn_number stays NULL.
export const currentTurnNumber = new Map<string, number>();

// RC-3 item 2: per-turn recall budget. recall_recent_thread / history_search
// dumps are the doom-loop fuel (a wordy recall returns 12-16k chars, and nothing
// caps N of them per turn). This map tracks cumulative EMITTED recall/history
// output tokens for the current turn so the tool dispatcher (agent/tools.ts) can
// return a short engine notice instead of another dump once the budget is spent.
// The AgentTurnState (agent/v2/state.ts) is not reachable from the tool executor,
// so the enforcement counter lives here alongside currentTurnReceipts, the
// established home for per-turn state the executor must see. Cleared at the turn
// boundary (turn entry + idle).
export const currentTurnRecallTokens = new Map<string, number>();

/** Recall/history output tokens accumulated this turn for the agent (0 if none). */
export function getRecallBudgetUsed(agentId: string): number {
  return currentTurnRecallTokens.get(agentId) ?? 0;
}

/** Add `tokens` to the agent's recall budget for this turn; returns the new total. */
export function addRecallBudgetUsed(agentId: string, tokens: number): number {
  const next = (currentTurnRecallTokens.get(agentId) ?? 0) + Math.max(0, tokens);
  currentTurnRecallTokens.set(agentId, next);
  return next;
}

/** Clear the current turn's recall budget (turn boundary). */
export function clearRecallBudget(agentId: string): void {
  currentTurnRecallTokens.delete(agentId);
}

/** Append a receipt id to the current turn's register for this agent. */
export function noteTurnReceipt(agentId: string, receiptId: string): void {
  const list = currentTurnReceipts.get(agentId);
  if (list) list.push(receiptId);
  else currentTurnReceipts.set(agentId, [receiptId]);
}

/** Receipt ids written this turn for this agent (empty array if none). */
export function getTurnReceipts(agentId: string): string[] {
  return currentTurnReceipts.get(agentId) ?? [];
}

/** Clear the current turn's receipt register (turn boundary). */
export function clearTurnReceipts(agentId: string): void {
  currentTurnReceipts.delete(agentId);
}

// C3: carries the "a human is still waiting on this task" signal across an ENGINE
// auto-continue (MAX_TOOL_LOOPS / time-budget / emergency-compaction). The continued
// turn fires with an EMPTY trigger, so it has no waiting human and no triggerRow, 
// without this it is classified pureBackgroundTurn, its final answer suppressed as
// inter-agent chatter, and the reply loses its channel (routes to dashboard). Stashed
// (the conversation's convKey + counterparty) right before the auto-continue; restored
// and CONSUMED (deleted) at the top of the next turn. Always deleted on read: a
// continuation is used at most once, and if a real human turn arrived in between it is
// stale and must be dropped so it can never falsely restore on a later background wake.
// (Import type only, erased at compile, so no runtime cycle with counterparty.ts.)
export const continuationContext = new Map<string, { convKey: string; counterparty: import('./v2/counterparty.js').TurnCounterparty }>();

// A2A turn isolation (v3.1.10).
//
// Inter-agent (A2A) traffic must never bleed into a user-facing reply: the
// user should not see A2A activity in the dashboard, in iMessage, or inside
// the agent's response unless wordy mode is on. To guarantee that
// structurally (not by trusting a weak model to behave), every turn is
// classified as EITHER an A2A-handling turn OR a normal/user turn, never
// both. On a normal turn A2A is stripped from context and the reply enforcer
// stays disarmed; on an A2A turn the A2A is handled and its output is
// suppressed from the user.
//
// When a user message supersedes a still-unreplied A2A (so the current turn
// is a user turn and the A2A gets stripped), the A2A is not dropped, the
// runtime sets `forceA2ATurn` and queues a follow-up wakeup so the A2A gets
// its OWN dedicated turn. `a2aTurnRetries` bounds how many times a single
// owed A2A can re-trigger, so a model that never manages a clean reply can't
// spin forever.
export const forceA2ATurn = new Set<string>();
export const a2aTurnRetries = new Map<string, number>();

// ── Counterparty serialization / turn continuity ──
//
// Turns run one at a time; concurrent messages queue a wakeup and the next turn
// re-resolves "who am I answering." The bug that motivated this: a turn that
// ended MID-TASK (hit a gate / limit / compaction before producing its reply)
// resumed under whoever's message was NEWEST, so the agent finished the old
// task but routed it to a new counterparty, e.g. a colleague's Teams answer
// delivered to a client's email thread.
//
// Fix: the turn's counterparty is the OLDEST conversation that still has an
// unanswered message ("waiting"). "Answered" is read from the DB, an own
// message stamped with the conversation's conv_key (migration 076), so the
// waiting set is DURABLE across a server restart (there is no in-memory served
// map to lose). A turn that ends WITHOUT delivering a reply tags nothing, so the
// conversation stays waiting and the NEXT turn resumes the SAME one (and routes
// to it). Conversations are thus served FIFO, each to completion, and routing
// always follows the conversation the turn is actually answering. See
// getWaitingHumanConversations (agent/v2/counterparty.ts).

/** Reset the per-agent turn-continuity scratch state on a new session. The
 *  "served" signal itself is DB-derived (conv_key), so there's nothing to clear
 *  there; this just resets the in-memory drain spin-guard. */
export function clearServedConversations(agentId: string): void {
  drainHead.delete(agentId);
  untrackedWorkAcrossTurns.delete(agentId);
}

// RC-19 item 3: cross-turn untracked-work counter.
//
// The per-turn `nonTrackerToolCalls` counter in AgentTurnState resets every turn,
// so an agent that breaks the turn with an A2A send (the "send_to_agent IS the
// response" exit) before the >=6 auto-scaffold floor engages can dodge the floor
// forever (work, send_to_agent, work, send_to_agent, ...). This map carries the
// untracked work-tool count across CONSECUTIVE turns of the SAME human conversation
// so a turn break can no longer reset the floor. Keyed by agentId; the stored
// convKey tags which conversation the count belongs to, so a turn on a different
// conversation resets instead of accumulating. Reset on any tracker write (the work
// is now tracked) or a new session. Only human turns (a non-null conv_key)
// participate; a2a/engine detours (conv_key null) leave it untouched so an
// interleaved A2A turn does not clobber the human conversation's running total. Same
// in-memory, deterministic, LLM-free pattern as the counters above.
export const untrackedWorkAcrossTurns = new Map<string, { convKey: string; count: number }>();

/** Add `delta` untracked work-tool calls to the agent's cross-turn total for the
 *  given human conversation, resetting first if the conversation changed. Returns
 *  the new running total. */
export function accumulateUntrackedWorkAcrossTurns(agentId: string, convKey: string, delta: number): number {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  const base = prev && prev.convKey === convKey ? prev.count : 0;
  const count = base + delta;
  untrackedWorkAcrossTurns.set(agentId, { convKey, count });
  return count;
}

/** Cross-turn untracked-work total for the agent on the given human conversation
 *  (0 if none recorded or the conversation changed). */
export function getUntrackedWorkAcrossTurns(agentId: string, convKey: string): number {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  return prev && prev.convKey === convKey ? prev.count : 0;
}

/** Clear the agent's cross-turn untracked-work total (any tracker write). */
export function clearUntrackedWorkAcrossTurns(agentId: string): void {
  untrackedWorkAcrossTurns.delete(agentId);
}

// Drain progress: the head (oldest-waiting) rowid the runtime last re-triggered
// on, and how many consecutive times it stayed stuck. Bounds the
// "keep working through the queue" re-trigger so a conversation the agent cannot
// serve (it never produces a terminal reply for it) doesn't spin the loop
// forever, after the cap we stop self-re-triggering and idle; a new inbound
// will wake it again.
export const drainHead = new Map<string, { rowid: number; stuck: number }>();
export const MAX_DRAIN_STUCK = 4;
/** Set by the loop when the turn it just ran was classified as an A2A turn, read by the runtime re-trigger so only genuinely-failed A2A turns count against the retry cap. */
export const lastTurnWasA2A = new Set<string>();
/** Max dedicated A2A turns spent on one owed reply before the engine gives up. */
export const MAX_A2A_TURN_RETRIES = 2;

// ── Lanes & lineage spine (P1, 2026-07-21) ──
// The ROOT of the current turn per agent: the one origin this turn is serving.
// Set at trigger claim (human pickup / engine-event claim / A2A wake), cleared
// at idle with the other per-turn maps. Writers of work records (tracker
// creates, scaffolds) read this to stamp the origin quad, so a task born from
// an ask carries the ask's identity instead of a prose copy of its text.
// kind vocabulary matches migration 112: ask / occurrence / a2a / engine.
export interface TurnRoot {
  kind: 'ask' | 'occurrence' | 'a2a' | 'engine';
  id: string;
  // The message row id of the inbound human ask, when kind === 'ask'.
  sourceMessageId: string | null;
  // P6a: the conversation the root belongs to (from the trigger row).
  conversationId?: string | null;
}
export const currentTurnRoot = new Map<string, TurnRoot | null>();

// The origin quad a work-record writer should stamp for work created by this
// agent right now. kind is the CREATION PATH (who decided to create the record),
// not the root kind; the source/turn/conv triple ties it to the live turn.
export interface WorkOrigin {
  kind: 'user_ask' | 'engine_scaffold' | 'a2a_assign' | 'model' | 'reminder' | 'user_direct' | 'system' | null;
  sourceMessageId: string | null;
  turn: number | null;
  convKey: string | null;
}
export function getWorkOriginForAgent(agentId: string, kind: WorkOrigin['kind']): WorkOrigin {
  const root = currentTurnRoot.get(agentId) ?? null;
  return {
    kind,
    sourceMessageId: root?.sourceMessageId ?? null,
    turn: currentTurnNumber.get(agentId) ?? null,
    convKey: currentTurnConvKey.get(agentId) ?? null,
  };
}

// The WORK the current engine turn is serving (P1 spine consumer #1): set at
// the engine-event claim from the trigger row's task/run referent columns,
// cleared at idle. The reminder-delivery lane reads taskKind to know this
// turn's output belongs to the owner.
export interface ServedWork {
  taskId: string | null;
  runId: string | null;
  taskKind: string | null;
  originConvKey: string | null;
}
export const currentTurnServedWork = new Map<string, ServedWork | null>();

// P6a: the tool_use call id currently executing for this agent. Set by the
// loop's executor immediately before dispatch; read by auditLog and
// writeToolReceipt so every execution record carries its exact call identity.
// Parallel-safe by construction: only serial-category tools (sends, gen,
// mutations) write records that read this; the parallel safe-read batch never
// does.
export const currentToolCallId = new Map<string, string>();
