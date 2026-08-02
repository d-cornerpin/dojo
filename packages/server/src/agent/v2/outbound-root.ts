// ════════════════════════════════════════════════════════════════════════════════════════
// USER-FACING OUTBOUND NEEDS AN AFFIRMATIVE ROOT — PHASE-4 T4.
//
// ── THE PILE THIS DISSOLVES ─────────────────────────────────────────────────────────────
// `DOJO-SCAR-TISSUE-LEDGER.md:102` — *"Settled-context tripwire + channel-push HOLD + its
// carve-out flag pile"*, verdict **STRIP**, with its own two preconditions written into it:
// P2 removes the phantom-wake source, and **P4 provides the affirmative-basis read**. This is
// that read. Phase-3 T7 could not take the strip because the replacement did not exist and
// `no-outreach-without-inbound` (the 3:32 AM scenario) asserts on the pile today.
//
// What stood at `loop.ts` was SIX terms ANDed, five of them negations:
//
//   settledContextWakeTurn && inboundChannel === null && counterparty.kind !== 'agent'
//     && !isEngineTurn && !engineCompletionAckThisTurn && !steeredForSilentCloseout
//
// Six booleans that only mean something as a conjunction, where every carve-out is a NOT and
// the thing being carved out of is never named. Adding a seventh carve-out is one more `&&
// !x`, which is how a pile becomes a pile: nobody can say what the rule IS, only what it is
// not. The scar ledger's own requirement line names the fix — *"carve-outs become root kinds,
// not boolean flags"*.
//
// ── WHAT REPLACES IT ────────────────────────────────────────────────────────────────────
// The rule stated once, positively: **a user-facing CHANNEL PUSH requires an affirmative
// root — a reason, on the record, why the platform is reaching a person right now.** Each of
// the five old negations is one such reason, and each has a name a human can read in a log:
//
//   inbound_channel    they wrote in on a channel this turn; the reply goes back on it
//   waiting_human      a human conversation was already open when the turn began
//   peer_turn          the counterparty is an agent (the reply is forced to dashboard anyway)
//   engine_occurrence  an engine turn — a scheduler/reminder the agent must deliver
//   completion_ack     a real "done" for work that just finished (the always-ack law)
//   steered_closeout   the silent-closeout steer's reply IS that completion ack, in the
//                      agent's own voice (owner ruling 2026-07-22)
//
// NO ROOT -> the push is HELD. That is the 3:32 AM class: the platform woke itself, nobody
// wrote in, every visible conversation was answered, and affinity alone is not consent.
//
// ── WHAT DOES NOT CHANGE, AND IT IS THE DESIGN LAW ──────────────────────────────────────
// **Only the PUSH is withheld. The reply is persisted, broadcast and visible in the dashboard
// exactly as it already was.** Nothing here deletes or suppresses an agent's words (research
// 21, caution 2). A held push leaves a `deliveries` row with `outcome='held'`, which is why
// "did we withhold, or did we push and forget to say so" is answerable at all.
//
// The dissolution is EXACT: `held === (root === null)` is the same boolean the six-term
// conjunction produced, proven by exhausting all 64 combinations against the original
// expression rather than by reading it. `no-outreach-without-inbound` is green on both sides.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Why the platform is allowed to reach a person on a channel right now. One name per reason;
 *  a new carve-out is a new NAME here, never another `&& !flag` at the call site. */
export type OutboundRootKind =
  | 'inbound_channel'
  | 'waiting_human'
  | 'peer_turn'
  | 'engine_occurrence'
  | 'completion_ack'
  | 'steered_closeout';

export interface OutboundRootInput {
  /** The channel this turn's inbound arrived on, or null for a self-wake / drain turn. */
  inboundChannel: string | null;
  /** False when a human conversation was already open at turn start — i.e. NOT a settled wake. */
  settledContextWakeTurn: boolean;
  /** This turn's counterparty kind. An agent counterparty is forced to dashboard anyway. */
  counterpartyKind: 'user' | 'agent' | string;
  /** An engine-driven turn: a scheduler occurrence or reminder the agent must deliver. */
  isEngineTurn: boolean;
  /** A real completion ack for work that just finished (the always-ack law). */
  engineCompletionAckThisTurn: boolean;
  /** The silent-closeout floor steered this turn; its reply IS the completion ack. */
  steeredForSilentCloseout: boolean;
}

export interface OutboundRootDecision {
  /** The strongest root, or null when there is none — and null is the HOLD. */
  root: OutboundRootKind | null;
  /** EVERY root that applies, in precedence order. Recorded, so a push can say why it went. */
  roots: readonly OutboundRootKind[];
  /** `root === null`. Named, so call sites read the rule rather than a negation. */
  held: boolean;
}

/**
 * Precedence is REPORTING order, not a decision: any one root permits the push, so which one
 * is listed first only decides what the log line and the routing marker say. Strongest
 * evidence first — a person who just wrote in outranks an inference about what they are owed.
 */
const ORDER: readonly OutboundRootKind[] = [
  'inbound_channel', 'waiting_human', 'peer_turn',
  'engine_occurrence', 'completion_ack', 'steered_closeout',
];

export function outboundRoot(input: OutboundRootInput): OutboundRootDecision {
  const present: Record<OutboundRootKind, boolean> = {
    inbound_channel: input.inboundChannel !== null,
    waiting_human: !input.settledContextWakeTurn,
    peer_turn: input.counterpartyKind === 'agent',
    engine_occurrence: input.isEngineTurn,
    completion_ack: input.engineCompletionAckThisTurn,
    steered_closeout: input.steeredForSilentCloseout,
  };
  const roots = ORDER.filter((k) => present[k]);
  return { root: roots[0] ?? null, roots, held: roots.length === 0 };
}

/** One phrase for a log line, a `recordHeld` reason or the dashboard's routing pill. */
export function describeOutboundRoot(d: OutboundRootDecision): string {
  if (d.held) return 'no affirmative root: nobody wrote in and no human conversation was open';
  return `affirmative root: ${d.roots.join(', ')}`;
}
