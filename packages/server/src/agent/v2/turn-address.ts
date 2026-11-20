// The turn's address: who this turn talks to and where its written reply lands, computed once at preflight.
// Delivery, the agent's notes and every engine text naming a recipient read this value; none recompute it.

import type { Channel, Relation } from '@dojo/shared';
import type { TurnCounterparty } from './counterparty.js';
import type { InboundChannel } from './inbound-channel.js';
import type { ChannelInboundContext } from './state.js';
import { resolveReplyDestination, type ReplyDestination } from './reply-destination.js';
import { affinityPromotionRefusedNoBasis } from './owner-affinity.js';
import { turnContext } from '../turn-context.js';

export interface TurnAddress {
  /** person = a human; agent = an A2A peer; engine = a scheduler/tracker event; notification = nobody. */
  readonly kind: 'person' | 'agent' | 'engine' | 'notification';
  readonly name: string;
  readonly relation: Relation;
  readonly isOwner: boolean;
  readonly senderId: string | null;
  readonly threadId: string | null;
  readonly inboundChannel: Channel;
  /** The channel the inbound binds delivery to; restored from the original turn on a continuation. */
  readonly boundChannel: InboundChannel;
  /** The inbound's reply-routing context (chat id, sms numbers), restored the same way. */
  readonly inboundContext: ChannelInboundContext | null;
  /** Projected landing: `dashboard` on agent and notification turns; engine turns get the real channel. */
  readonly deliveryChannel: ReplyDestination;
  /** The reply leaves the dashboard on a routed channel (person turns only). */
  readonly routed: boolean;
  /** Only the primary agent's reply is auto-routed; a sub-agent's stays in the dashboard. */
  readonly autoRoutes: boolean;
  /** The owner-affinity promotion resolved at preflight, kept so the live resolver re-applies it. */
  readonly ownerAffinity: 'imessage' | null;
  /** A settled-context wake with no inbound: the text is held in the dashboard, not pushed. */
  readonly heldWake: boolean;
}

export interface ComputeTurnAddressInput {
  counterparty: TurnCounterparty;
  isEngineTurn: boolean;
  isNotificationTurn: boolean;
  /** Null on a wake with no trigger and no request row. */
  inboundChannel: InboundChannel;
  inboundContext: ChannelInboundContext | null;
  presence: 'in_dojo' | 'away';
  imessageBridgeConfigured: boolean;
  ownerAffinityChannel: 'imessage' | null;
  autoRoutes: boolean;
  /** Every visible conversation was answered at turn start: such a wake is held, not pushed. */
  settledContextWakeTurn?: boolean;
}

export interface LiveDeliveryInputs {
  presence: 'in_dojo' | 'away';
  imessageBridgeConfigured: boolean;
  ownerAffinityChannel: 'imessage' | null;
}

/** Where the written reply goes, from the address plus live facts that can still change. Preflight and
 * finalize read the same address, so they cannot disagree on who or which inbound the reply is bound to. */
export function resolveDeliveryChannel(
  addr: Pick<TurnAddress, 'kind' | 'isOwner' | 'boundChannel' | 'autoRoutes'>,
  live: LiveDeliveryInputs,
): ReplyDestination {
  if (addr.kind === 'agent' || addr.kind === 'notification' || !addr.autoRoutes) return 'dashboard';
  const affinityRefused = affinityPromotionRefusedNoBasis({
    ownerAffinityChannel: live.ownerAffinityChannel,
    inboundChannel: addr.boundChannel,
    presence: live.presence,
    personAskedHere: addr.kind === 'person',
  });
  return resolveReplyDestination({
    state: { inboundChannel: addr.boundChannel },
    imessageBridgeConfigured: live.imessageBridgeConfigured,
    counterpartyIsOwner: addr.isOwner,
    ownerAffinityChannel: affinityRefused ? null : live.ownerAffinityChannel,
    personAskedHere: addr.kind === 'person',
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

  const boundChannel: InboundChannel = input.inboundChannel ?? null;
  const inboundContext = input.inboundContext ?? null;

  let deliveryChannel: ReplyDestination = 'dashboard';
  // An engine turn's text is delivered like the owner's, so it gets the real channel.
  if (kind === 'person' || kind === 'engine') {
    deliveryChannel = resolveDeliveryChannel(
      { kind, isOwner, boundChannel, autoRoutes: input.autoRoutes },
      { presence: input.presence, imessageBridgeConfigured: input.imessageBridgeConfigured, ownerAffinityChannel: input.ownerAffinityChannel },
    );
    // A held wake keeps its text in the dashboard; engine turns are never held (outbound-root.ts).
    if (kind === 'person' && input.settledContextWakeTurn && boundChannel === null) deliveryChannel = 'dashboard';
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
    heldWake: kind === 'person' && !!input.settledContextWakeTurn && boundChannel === null,
  };
}

/** Preflight's entry: reads presence and bridge state; a failed read keeps the dashboard default. */
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

/** The line re-sent at the tail of every model call, after the cache breakpoint; routed replies only. */
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


// Engine texts take recipient and reply-route words from these readers, never as literals.

/** The current turn's address (undefined outside a turn, or before preflight has run). */
export function currentAddress(agentId: string): TurnAddress | undefined {
  return turnContext(agentId)?.address;
}

/** The delivery channel in words; the dashboard wording when there is no address. */
export function replyChannelWords(addr: TurnAddress | undefined): string {
  return deliveryLabel(addr?.deliveryChannel ?? 'dashboard');
}

/** The addressee's name on a person turn, else "the user"; `cap` starts a sentence. */
export function userWords(addr: TurnAddress | undefined, cap = false): string {
  if (addr?.kind === 'person') return addr.name;
  return cap ? 'The user' : 'the user';
}

