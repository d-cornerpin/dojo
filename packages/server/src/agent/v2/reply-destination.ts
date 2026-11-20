

import type { AgentTurnState } from './state.js';

export type ReplyDestination = 'imessage' | 'teams' | 'email' | 'sms' | 'phone' | 'voice' | 'dashboard';

export interface ResolveReplyDestinationParams {
  state: Pick<AgentTurnState, 'inboundChannel'>;
  imessageBridgeConfigured: boolean;
  // Owner affinity: owner only, never a contact; the channel arrives past the caller's rate limit,
  // null = no promotion. `personAskedHere`: the turn address is a person, not an engine or proactive turn.
  counterpartyIsOwner?: boolean;
  ownerAffinityChannel?: 'imessage' | null;
  personAskedHere?: boolean;
}

export function resolveReplyDestination(params: ResolveReplyDestinationParams): ReplyDestination {
  const { state, imessageBridgeConfigured, counterpartyIsOwner, ownerAffinityChannel, personAskedHere } = params;

  // Layer 1: a routed inbound is answered on the channel it arrived on, whatever presence says.
  if (state.inboundChannel === 'imessage') return 'imessage';
  if (state.inboundChannel === 'teams') return 'teams';
  if (state.inboundChannel === 'email') return 'email';
  if (state.inboundChannel === 'sms') return 'sms';
  if (state.inboundChannel === 'phone') return 'phone';
  // Voice is in-person speech: it is spoken back, so it must never fall through to a text.
  if (state.inboundChannel === 'voice') return 'voice';
  // A person's own dashboard ask is bound like every other inbound, not a dashboard-default turn.
  if (state.inboundChannel === 'dashboard' && personAskedHere === true) return 'dashboard';

  // Layer 2: only the owner's affinity promotes, and only to iMessage; "away" alone moves nothing.
  if (counterpartyIsOwner && ownerAffinityChannel === 'imessage' && imessageBridgeConfigured) return 'imessage';
  return 'dashboard';
}
