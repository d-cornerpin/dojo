// The turn's address with its channel re-read live: presence can change mid-turn, the person cannot.
// Notes and delivery both use `resolveDeliveryChannel`, so the channel the agent is told is the one used.

import { turnContext } from '../turn-context.js';
import { getPresence, isImessageConfigured } from '../../services/presence.js';
import { resolveDeliveryChannel, withDelivery, type TurnAddress } from './turn-address.js';

export function liveAddress(addr: TurnAddress | undefined): TurnAddress | undefined {
  if (!addr) return undefined;
  if (addr.heldWake) return addr.deliveryChannel === 'dashboard' ? addr : withDelivery(addr, 'dashboard');
  const channel = resolveDeliveryChannel(addr, {
    presence: getPresence(), imessageBridgeConfigured: isImessageConfigured(), ownerAffinityChannel: addr.ownerAffinity,
  });
  return channel === addr.deliveryChannel ? addr : withDelivery(addr, channel);
}

export function currentLiveAddress(agentId: string): TurnAddress | undefined {
  return liveAddress(turnContext(agentId)?.address);
}
