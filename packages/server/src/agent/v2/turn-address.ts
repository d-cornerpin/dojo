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
import { turnContext } from '../turn-context.js';

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
  addr: Pick<TurnAddress, 'kind' | 'isOwner' | 'boundChannel'>,
  live: LiveDeliveryInputs,
): ReplyDestination {
  // Agent and notification turns never auto-route to a person.
  if (addr.kind === 'agent' || addr.kind === 'notification') return 'dashboard';
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
      { kind, isOwner, boundChannel },
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
  };
}

const DELIVERY_LABEL: Record<ReplyDestination, string> = {
  dashboard: 'the dashboard chat',
  imessage: 'iMessage',
  teams: 'Microsoft Teams',
  sms: 'SMS',
  email: 'email',
  phone: 'a live phone call',
  voice: 'voice (spoken aloud)',
};

export function deliveryLabel(channel: ReplyDestination): string {
  return DELIVERY_LABEL[channel] ?? channel;
}

export function relationWords(relation: Relation): string {
  switch (relation) {
    case 'owner': return 'your primary user';
    case 'known_contact': return 'a known contact';
    case 'third_party': return 'an unknown / third-party sender, be cautious about what you share';
    case 'agent': return 'another agent';
    case 'engine': return 'the engine';
  }
}

/**
 * The one sentence both the turn block and the per-step restatement use. Null when there
 * is no human on the other end of the written reply (agent, engine, notification turns).
 */
export function renderReplyGoesTo(addr: TurnAddress): string | null {
  if (addr.kind !== 'person') return null;
  return `Your written reply goes to ${addr.name} (${relationWords(addr.relation)}) by ${deliveryLabel(addr.deliveryChannel)}.`;
}

/**
 * The short line re-sent at the tail of every model call of a turn. Routed channels only:
 * a reply that stays in the dashboard needs no reminder. One line, after the cache
 * breakpoint.
 */
export function renderTailRestatement(addr: TurnAddress | null | undefined): string | null {
  if (!addr || !addr.routed) return null;
  return `[Reply goes to ${addr.name} by ${deliveryLabel(addr.deliveryChannel)}.]`;
}

/** Plain words for "who is this turn talking to", for engine texts and tool results. */
export function describeAddressee(addr: TurnAddress | null | undefined): string {
  if (!addr) return 'the person this turn is talking to';
  switch (addr.kind) {
    case 'person': return `${addr.name} (${addr.isOwner ? 'your primary user' : relationWords(addr.relation)}) by ${deliveryLabel(addr.deliveryChannel)}`;
    case 'agent': return `${addr.name} (another agent)`;
    case 'engine': return 'nobody (this turn was started by an engine event)';
    case 'notification': return 'nobody (this turn was started by a notification)';
  }
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

// ── Reading the address from an engine text ──
// Every engine text that names a recipient or a reply route takes the turn's address through
// these, instead of writing "the dashboard chat" or "the owner" as a literal.

/** The current turn's address (undefined outside a turn, or before preflight has run). */
export function currentAddress(agentId: string): TurnAddress | undefined {
  return turnContext(agentId)?.address;
}

/** Where a written reply on this turn is delivered, in words ("iMessage", "the dashboard
 *  chat"). Falls back to the dashboard wording when there is no address. */
export function replyChannelWords(addr: TurnAddress | undefined): string {
  return deliveryLabel(addr?.deliveryChannel ?? 'dashboard');
}

/** "Pat Example by iMessage" for a person turn; null when no human is on the other end. */
export function addresseeByChannel(addr: TurnAddress | undefined): string | null {
  return addr?.kind === 'person' ? `${addr.name} by ${deliveryLabel(addr.deliveryChannel)}` : null;
}

/**
 * The noun for "the person this turn is talking to" in an engine text: their name on a person
 * turn, "the user" when no human is on the other end or there is no address. `cap` is for the
 * start of a sentence. Possessive: `${userWords(a)}'s`.
 */
export function userWords(addr: TurnAddress | undefined, cap = false): string {
  if (addr?.kind === 'person') return addr.name;
  return cap ? 'The user' : 'the user';
}
