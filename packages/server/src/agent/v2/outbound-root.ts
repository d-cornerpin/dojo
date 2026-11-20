// A user-facing channel push needs an affirmative root, a named reason the platform reaches a person now; with
// no root the push is held. Only the push is withheld: the reply is still persisted, broadcast and shown.

/** A new carve-out is a new name here, never another `&& !flag` at the call site. */
export type OutboundRootKind =
  | 'inbound_channel'
  | 'waiting_human'
  | 'peer_turn'
  | 'engine_occurrence'
  | 'forced_reply';

export interface OutboundRootInput {
  inboundChannel: string | null;
  settledContextWakeTurn: boolean;
  counterpartyKind: 'user' | 'agent' | string;
  isEngineTurn: boolean;
  forcedReply: boolean;
}

export interface OutboundRootDecision {
  root: OutboundRootKind | null;
  /** Every root that applies, in precedence order; recorded so a push can say why it went. */
  roots: readonly OutboundRootKind[];
  held: boolean;
}

/** Reporting order only (any one root permits the push): strongest evidence first. */
const ORDER: readonly OutboundRootKind[] = [
  'inbound_channel', 'waiting_human', 'peer_turn',
  'engine_occurrence', 'forced_reply',
];

export function outboundRoot(input: OutboundRootInput): OutboundRootDecision {
  const present: Record<OutboundRootKind, boolean> = {
    inbound_channel: input.inboundChannel !== null,
    waiting_human: !input.settledContextWakeTurn,
    peer_turn: input.counterpartyKind === 'agent',
    engine_occurrence: input.isEngineTurn,
    forced_reply: input.forcedReply,
  };
  const roots = ORDER.filter((k) => present[k]);
  return { root: roots[0] ?? null, roots, held: roots.length === 0 };
}

/** One phrase for a log line, a `recordHeld` reason or the dashboard's routing pill. */
export function describeOutboundRoot(d: OutboundRootDecision): string {
  if (d.held) return 'no affirmative root: nobody wrote in and no human conversation was open';
  return `affirmative root: ${d.roots.join(', ')}`;
}
