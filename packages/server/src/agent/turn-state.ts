// Per-agent state that OUTLIVES a turn, shared between the runtime and the
// assembler. Lives in its own module to avoid circular imports (runtime ↔ assembler).
//
// PHASE-6 T1: the ten PER-TURN maps that used to sit here — `currentTurnKind`,
// `currentTurnConvKey`, `currentTurnConversationId`, `currentTurnImRecipient`,
// `currentModelRequestId`, `currentTurnReceipts`, `currentTurnNumber`,
// `currentTurnRecallTokens`, `currentTurnRoot`, `currentTurnServedWork` — are GONE.
// They are one object now, `agent/turn-context.ts`, opened by the turn and cleared in
// its `finally`. They all died in one statement inside `setAgentStatus(…, 'idle')`,
// which meant the lifetime of the turn's facts was a side effect of a status write:
// the ordinary end-of-turn idle write happens INSIDE the loop's main `try`, so
// teardown read them after they had been deleted, on every turn.
//
// WHAT IS LEFT HERE IS LEFT ON PURPOSE, and it is the reason this file did not simply
// become that one. Every carrier below is deliberately WIDER than a turn:
// `continuationContext` is stashed by one turn expressly so the NEXT turn can consume
// it; `untrackedWorkAcrossTurns` exists precisely because the per-turn counter
// resetting every turn was the defect; `forceA2ATurn` / `a2aTurnRetries` /
// `lastTurnWasA2A` bound how many FUTURE turns an owed A2A may claim. Sweeping any of
// them into a bag emptied in `finally` would delete state that is supposed to survive.
// `drainHead` is the precedent for the ones that should go further still: it was
// retired into a ROW (migration `140_drain_state.sql`, whose header says "A Map dies
// with the process") with its scope preserved verbatim — see MAX_DRAIN_STUCK below.

import { AsyncLocalStorage } from 'node:async_hooks';
import { clearDrainLadder } from './drain-state.js';

// Timestamp of when each agent's current turn started, context assembly
// uses this to exclude user messages that arrived mid-turn so they get
// a fresh run via the wakeup mechanism.
//
// CROSS-TURN ON PURPOSE, and it is the one that looks per-turn and is not: the
// runtime clears it AFTER the next wakeup is queued (`runtime.ts:847`, `:879`) so the
// new run sees every message the old turn excluded. Clearing it with the turn would
// re-open the mid-turn arrival it exists to defer.
export const turnBoundary = new Map<string, string>();

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
//
// THE CLEAREST REASON THIS FILE STILL EXISTS: it is written by one turn FOR the next
// one. A per-turn bag cleared in `finally` would delete it between the two.
export const continuationContext = new Map<string, {
  convKey: string;
  /** PHASE-2 T10I: the conversation as the FK, so the restored turn scopes its recall and
   *  its assembler tail the same way the original turn did. Nullable because a turn can pick
   *  a conversation the producer never resolved a row for (non-door inserts). */
  conversationId: string | null;
  counterparty: import('./v2/counterparty.js').TurnCounterparty;
}>();

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
 *  "served" signal itself is DB-derived, so there's nothing to clear there; this resets the
 *  human-conversation drain spin-guard (durable since T10) and the cross-turn untracked-work
 *  counter.
 *
 *  SCOPE IS DELIBERATE AND IT IS THE OLD SCOPE. The Map this replaced was `drainHead` — the
 *  HUMAN drain only. Clearing both ladders here would hand the unserved-wake drain two extra
 *  passes on every session start, i.e. MORE self-wakes, on the one path a session reset
 *  touches. RULING 5 moved this counter's storage; it does not get to move its semantics, and
 *  the wider clear was caught by `fanout-serves-all-pieces` tripping the platform's own wake
 *  budget before it was caught by reading the diff. */
export function clearServedConversations(agentId: string): void {
  clearDrainLadder(agentId, 'human_conversation');
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
//
// ⚠ THE CLEAREST "DO NOT PUT THIS IN THE TURN'S BAG": a per-turn counter resetting
// every turn IS the defect this exists to fix.
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

/**
 * UX-REPAIR T1 — THE CLEAR THIS MAP WAS ALWAYS MISSING: a turn that ANSWERED ITS HUMAN.
 *
 * RC-19 above names its own scope precisely, and it is a turn BREAK: "an agent that breaks
 * the turn with an A2A send (the 'send_to_agent IS the response' exit) ... can dodge the
 * floor forever". The dodge is DEFINED by exiting WITHOUT answering the person. Carrying the
 * count across turns that COMPLETED AND DELIVERED was never the requirement, and it is what
 * made the >=6 floor fire on trivial turns: measured on the worn-in dev DB, 10 of 35 firings
 * in the current design era reported a per-turn count below 6, which is only reachable when
 * the accumulator was carrying finished work's debt.
 *
 * SCOPED, not blanket. The map holds ONE `{convKey, count}` per agent, so a turn answering
 * conversation B must leave conversation A's running total alone: if the stored convKey is
 * not the one that was answered, nothing is cleared. `clearUntrackedWorkAcrossTurns` above
 * (tracker write / floor firing / new session) keeps its blanket semantics unchanged.
 */
export function clearUntrackedWorkAcrossTurnsForConversation(agentId: string, convKey: string): void {
  const prev = untrackedWorkAcrossTurns.get(agentId);
  if (prev && prev.convKey === convKey) untrackedWorkAcrossTurns.delete(agentId);
}

// Drain progress: how many consecutive times the head (oldest-waiting) conversation
// stayed stuck. Bounds the "keep working through the queue" re-trigger so a conversation
// the agent cannot serve (it never produces a terminal reply for it) doesn't spin the loop
// forever, after the cap we stop self-re-triggering and idle; a new inbound will wake it
// again.
//
// PHASE-2 T10 (RULING 5): the `Map` that held this is GONE. It died with the process, so a
// crash loop reset the bound to zero on every boot — the storm hazard wearing a different
// hat. The ladder itself is unchanged and lives in `drain_state` (migration 140), read and
// written through `agent/drain-state.ts`. The BOUND stays here, beside the other turn
// constants, because it is a policy number and not state.
export const MAX_DRAIN_STUCK = 4;
/** Set by the loop when the turn it just ran was classified as an A2A turn, read by the runtime re-trigger so only genuinely-failed A2A turns count against the retry cap. */
export const lastTurnWasA2A = new Set<string>();
/** Max dedicated A2A turns spent on one owed reply before the engine gives up. */
export const MAX_A2A_TURN_RETRIES = 2;

// P6a: the tool_use call id currently executing. Read by auditLog (agent/tools/util.ts)
// and writeToolReceipt (receipts/store.ts) so every execution record carries the
// exact call that produced it.
//
// This used to be one slot per agent, with a comment claiming it was
// "parallel-safe by construction: only serial-category tools write records that
// read this". That was wrong. file_read, file_list and share_file are all
// 'safe' category, the loop runs a safe batch through Promise.all, and every one
// of them writes an audit row. Each execution overwrote the slot on the way in,
// so a batch of ten concurrent file_reads stamped ten audit rows with whichever
// call started last. Measured on the dev box at 8eb4c58: 705 call-id-bearing
// audit_log rows carrying 555 distinct ids — 150 rows (21.3%) provably belong to
// a call other than the one named on them, and every colliding group was
// file_read.
//
// AsyncLocalStorage gives each execution its own value: the store is captured
// when the async work is created and travels with it across every await, so two
// interleaved executions cannot see each other's id. The agent id is kept in the
// store, and getCurrentToolCallId only answers for a matching agent, so a record
// written FOR ANOTHER AGENT from inside this agent's tool call (a spawn, an A2A
// send) still gets NULL rather than borrowing an identity — the one honest
// property the per-agent map did have.
//
// NOT MOVED TO `turn-context.ts` BY PHASE-6 T1, and the reason is that it is already
// correctly scoped: its lifetime is one tool EXECUTION, which is narrower than a turn,
// and async-context is a stronger guarantee than any per-agent registry can give.
// Moving it for symmetry would trade a correct mechanism for a tidier import list.
//
// Outside any tool execution the answer is NULL. That is a change: the map kept
// the last call's id until the agent went idle, so engine-initiated writes (the
// loop's auto-delivery receipts) inherited a stale one. Nothing SELECTs call_id
// today; it is forensic evidence for later post-mortems, and a null is worth
// more than a confident wrong answer.
const toolCallContext = new AsyncLocalStorage<{ agentId: string; callId: string }>();

/** Run one tool execution with its call identity attached to its async context. */
export function runWithToolCallId<T>(agentId: string, callId: string, fn: () => Promise<T>): Promise<T> {
  return toolCallContext.run({ agentId, callId }, fn);
}

/** The call id of the execution the caller is inside, for this agent, or null. */
export function getCurrentToolCallId(agentId: string): string | null {
  const ctx = toolCallContext.getStore();
  return ctx?.agentId === agentId ? ctx.callId : null;
}
