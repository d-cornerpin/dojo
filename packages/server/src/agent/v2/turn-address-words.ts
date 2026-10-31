// Words about the turn's address: labels, the reply sentence, the tail line, and the readers the
// engine texts use. Re-exported from turn-address.ts, so importers keep one module name.

import type { Relation } from '@dojo/shared';
import { turnContext } from '../turn-context.js';
import type { ReplyDestination } from './reply-destination.js';
import type { TurnAddress } from './turn-address.js';

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

