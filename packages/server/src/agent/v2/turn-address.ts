// ════════════════════════════════════════
// THE TURN'S ADDRESS (3.5, "who am I sending to")
//
// One value, computed ONCE at preflight, that says who this turn is talking to and where
// the written reply will really be delivered. Before it, five places each worked that out
// for themselves (delivery channel, delivery person, the reply tag's channel, the tag's
// name, the header) and they disagreed when two people were waiting, when a message
// arrived mid-turn, on a continuation, on an owner-affinity turn, and on A2A/engine turns.
//
// Delivery, the notes the agent reads, and every engine text that names a recipient or a
// reply route read THIS value. None of them recompute it.
//
// Pure on purpose: the caller hands in presence, bridge state and affinity, so every state
// is unit-testable without a database.
// ════════════════════════════════════════

import type { Channel, Relation } from '@dojo/shared';
import type { TurnCounterparty } from './counterparty.js';
import type { InboundChannel } from './inbound-channel.js';
import type { ChannelInboundContext } from './state.js';
import { resolveReplyDestination, type ReplyDestination } from './reply-destination.js';
import { affinityPromotionRefusedNoBasis } from './owner-affinity.js';

export interface TurnAddress {
  /** person = a human; agent = another agent over A2A; engine = a scheduler/tracker event;
   *  notification = a mailbox/channel notice (nobody is on the other end). */
  readonly kind: 'person' | 'agent' | 'engine' | 'notification';
  readonly name: string;
  readonly relation: Relation;
  readonly isOwner: boolean;
  /** The person's address on the channel (phone number, handle), when the channel has one. */
  readonly senderId: string | null;
  readonly threadId: string | null;
  /** How the message arrived. */
  readonly inboundChannel: Channel;
  /** The channel delivery is bound to by the inbound (what `resolveReplyDestination`
   *  Layer 1 reads). Restored on a continuation, which has no trigger row of its own. */
  readonly boundChannel: InboundChannel;
  /** The reply-routing context of that inbound (chat id, sms numbers ...), restored on a
   *  continuation for the same reason. */
  readonly inboundContext: ChannelInboundContext | null;
  /** Where the written reply is projected to land. `dashboard` for agent, engine and
   *  notification turns (nothing is auto-routed to a person on those); an engine turn's
   *  text is delivered like the owner's, so its channel is the real one. */
  readonly deliveryChannel: ReplyDestination;
  /** True when the written reply goes out on a routed channel (iMessage, SMS, email, Teams,
   *  phone) rather than staying in the dashboard. */
  readonly routed: boolean;
  /** Whether the engine auto-routes THIS agent's written reply to a channel at all. Only the
   *  primary agent's is; a sub-agent's reply stays in the dashboard whatever presence says. */
  readonly autoRoutes: boolean;
  /** The owner-affinity promotion resolved at preflight (null = none); kept so the live
   *  resolver can re-apply the same rule with current presence. */
  readonly ownerAffinity: 'imessage' | null;
  /** A settled-context wake with no inbound: the text is held in the dashboard, not pushed. */
  readonly heldWake: boolean;
}

export interface ComputeTurnAddressInput {
  counterparty: TurnCounterparty;
  isEngineTurn: boolean;
  isNotificationTurn: boolean;
  /** This turn's own inbound channel (null on a continuation or a wake with no trigger). */
  inboundChannel: InboundChannel;
  inboundContext: ChannelInboundContext | null;
  presence: 'in_dojo' | 'away';
  imessageBridgeConfigured: boolean;
  ownerAffinityChannel: 'imessage' | null;
  /** `isPrimaryAgent(agentId)`: only the primary agent's written reply is auto-routed to a channel. */
  autoRoutes: boolean;
  /** True when every visible conversation was already answered at turn start; nothing is
   *  pushed to a channel on such a wake (it is held), so the agent is not told it will be. */
  settledContextWakeTurn?: boolean;
  /** The address the stashed turn had, when this turn is the continuation of a human turn. */
  restoredFrom?: TurnAddress;
}

export interface LiveDeliveryInputs {
  presence: 'in_dojo' | 'away';
  imessageBridgeConfigured: boolean;
  ownerAffinityChannel: 'imessage' | null;
}

/**
 * Where the written reply goes, from the address plus the live facts that can still change
 * (presence, bridge state, the affinity cooldown). Preflight uses it to tell the agent;
 * finalize uses it to deliver; both read the same address, so they cannot disagree about
 * WHO or about which inbound the reply is bound to.
 */
export function resolveDeliveryChannel(
  addr: Pick<TurnAddress, 'kind' | 'isOwner' | 'boundChannel' | 'autoRoutes'>,
  live: LiveDeliveryInputs,
): ReplyDestination {
  // Agent and notification turns never auto-route to a person.
  if (addr.kind === 'agent' || addr.kind === 'notification' || !addr.autoRoutes) return 'dashboard';
  const affinityRefused = affinityPromotionRefusedNoBasis({
    ownerAffinityChannel: live.ownerAffinityChannel,
    inboundChannel: addr.boundChannel,
    presence: live.presence,
  });
  return resolveReplyDestination({
    state: { inboundChannel: addr.boundChannel },
    presence: live.presence,
    imessageBridgeConfigured: live.imessageBridgeConfigured,
    counterpartyIsOwner: addr.isOwner,
    ownerAffinityChannel: affinityRefused ? null : live.ownerAffinityChannel,
  });
}

const ROUTED: ReadonlySet<ReplyDestination> = new Set(['imessage', 'sms', 'email', 'teams', 'phone']);

export function computeTurnAddress(input: ComputeTurnAddressInput): TurnAddress {
  const { counterparty: cp } = input;
  const isOwner = cp.kind === 'user' && cp.relation === 'owner';
  const kind: TurnAddress['kind'] = input.isNotificationTurn ? 'notification'
    : input.isEngineTurn ? 'engine'
    : cp.kind === 'agent' ? 'agent'
    : 'person';

  // A continuation has no trigger row, so its own inbound is empty: take the original's.
  const restored = input.inboundChannel === null ? input.restoredFrom : undefined;
  const boundChannel: InboundChannel = input.inboundChannel ?? restored?.boundChannel ?? null;
  const inboundContext = input.inboundContext ?? restored?.inboundContext ?? null;

  let deliveryChannel: ReplyDestination = 'dashboard';
  // An engine turn's text is delivered like the owner's (a reminder reaches an away owner's phone),
  // so its delivery channel is the real one; the agent is simply not told to "reply" on it.
  if (kind === 'person' || kind === 'engine') {
    deliveryChannel = resolveDeliveryChannel(
      { kind, isOwner, boundChannel, autoRoutes: input.autoRoutes },
      { presence: input.presence, imessageBridgeConfigured: input.imessageBridgeConfigured, ownerAffinityChannel: input.ownerAffinityChannel },
    );
    // Held wake: the text stays in the dashboard, so do not promise a channel hop.
    if (input.settledContextWakeTurn && boundChannel === null) deliveryChannel = 'dashboard';
  }

  return {
    kind,
    name: cp.name,
    relation: cp.relation,
    isOwner,
    senderId: cp.senderId,
    threadId: cp.threadId,
    inboundChannel: cp.channel,
    boundChannel,
    inboundContext,
    deliveryChannel,
    routed: kind === 'person' && ROUTED.has(deliveryChannel),
    autoRoutes: input.autoRoutes,
    ownerAffinity: input.ownerAffinityChannel,
    heldWake: !!input.settledContextWakeTurn && boundChannel === null,
  };
}

/** Preflight's entry: reads presence and bridge state, then computes the address. A failed
 *  read leaves the dashboard default, the safe reading. */
export async function computeTurnAddressLive(
  input: Omit<ComputeTurnAddressInput, 'presence' | 'imessageBridgeConfigured'>,
): Promise<TurnAddress> {
  let presence: 'in_dojo' | 'away' = 'in_dojo';
  let imessageBridgeConfigured = false;
  try {
    const pres = await import('../../services/presence.js');
    presence = pres.getPresence();
    imessageBridgeConfigured = pres.isImessageConfigured();
  } catch { /* best effort */ }
  return computeTurnAddress({ ...input, presence, imessageBridgeConfigured });
}

/** The same address with its delivery channel replaced (and `routed` re-derived from it). */
export function withDelivery(addr: TurnAddress, deliveryChannel: ReplyDestination): TurnAddress {
  return { ...addr, deliveryChannel, routed: addr.kind === 'person' && ROUTED.has(deliveryChannel) };
}

export * from './turn-address-words.js';
