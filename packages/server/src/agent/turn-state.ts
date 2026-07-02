// Per-agent turn state shared between the runtime and context assembler.
// Lives in its own module to avoid circular imports (runtime ↔ assembler).

// Timestamp of when each agent's current turn started — context assembly
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
// conversation instead of re-deriving "the most recently stamped conv_key" — which
// on an engine/A2A turn (no human conv stamped this turn) wrongly latched the last
// HUMAN conversation and bled it into the recall. The map having an entry means a
// turn is in progress: a non-null value = that human conversation; an explicit null
// = engine/A2A turn (no human conv) → recall stays on untagged/current-turn rows.
// No entry = called outside a turn → recall falls back to the legacy heuristic.
export const currentTurnConvKey = new Map<string, string | null>();

// T-4: the iMessage address this turn is conversing with (the turn counterparty's
// senderId, when it's a human iMessage turn). getInboundSenderFor prefers this over
// the racy per-agent pendingIMResponseMap (a single last-inbound value), so an
// explicit imessage_send with no recipient — and an image_create reply — go to THIS
// turn's person, not whoever messaged most recently during a multi-conversation
// drain (the "reply to a contact sent to the owner" class of bug). Cleared on idle.
export const currentTurnImRecipient = new Map<string, string>();

// C3: carries the "a human is still waiting on this task" signal across an ENGINE
// auto-continue (MAX_TOOL_LOOPS / time-budget / emergency-compaction). The continued
// turn fires with an EMPTY trigger, so it has no waiting human and no triggerRow —
// without this it is classified pureBackgroundTurn, its final answer suppressed as
// inter-agent chatter, and the reply loses its channel (routes to dashboard). Stashed
// (the conversation's convKey + counterparty) right before the auto-continue; restored
// and CONSUMED (deleted) at the top of the next turn. Always deleted on read: a
// continuation is used at most once, and if a real human turn arrived in between it is
// stale and must be dropped so it can never falsely restore on a later background wake.
// (Import type only — erased at compile, so no runtime cycle with counterparty.ts.)
export const continuationContext = new Map<string, { convKey: string; counterparty: import('./v2/counterparty.js').TurnCounterparty }>();

// A2A turn isolation (v3.1.10).
//
// Inter-agent (A2A) traffic must never bleed into a user-facing reply: the
// user should not see A2A activity in the dashboard, in iMessage, or inside
// the agent's response unless wordy mode is on. To guarantee that
// structurally (not by trusting a weak model to behave), every turn is
// classified as EITHER an A2A-handling turn OR a normal/user turn — never
// both. On a normal turn A2A is stripped from context and the reply enforcer
// stays disarmed; on an A2A turn the A2A is handled and its output is
// suppressed from the user.
//
// When a user message supersedes a still-unreplied A2A (so the current turn
// is a user turn and the A2A gets stripped), the A2A is not dropped — the
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
// task but routed it to a new counterparty — e.g. a colleague's Teams answer
// delivered to a client's email thread.
//
// Fix: the turn's counterparty is the OLDEST conversation that still has an
// unanswered message ("waiting"). "Answered" is read from the DB — an own
// message stamped with the conversation's conv_key (migration 076) — so the
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
}

// Drain progress: the head (oldest-waiting) rowid the runtime last re-triggered
// on, and how many consecutive times it stayed stuck. Bounds the
// "keep working through the queue" re-trigger so a conversation the agent cannot
// serve (it never produces a terminal reply for it) doesn't spin the loop
// forever — after the cap we stop self-re-triggering and idle; a new inbound
// will wake it again.
export const drainHead = new Map<string, { rowid: number; stuck: number }>();
export const MAX_DRAIN_STUCK = 4;
/** Set by the loop when the turn it just ran was classified as an A2A turn — read by the runtime re-trigger so only genuinely-failed A2A turns count against the retry cap. */
export const lastTurnWasA2A = new Set<string>();
/** Max dedicated A2A turns spent on one owed reply before the engine gives up. */
export const MAX_A2A_TURN_RETRIES = 2;
