// The turn's address with the channel read LIVE. The person is fixed at preflight; only the
// channel can move (the owner going away or coming back changes where a dashboard-bound reply
// lands). Everything the agent is told and everything delivery does goes through
// `resolveDeliveryChannel`, so the channel the agent is told equals the channel used.

import { turnContext } from '../turn-context.js';
import { getPresence, isImessageConfigured } from '../../services/presence.js';
import { resolveDeliveryChannel, withDelivery, type TurnAddress } from './turn-address.js';

export function liveAddress(addr: TurnAddress | undefined): TurnAddress | undefined {
  if (!addr) return undefined;
  // A held wake (nothing is waiting, no inbound) keeps its text in the dashboard.
  if (addr.heldWake) return addr.deliveryChannel === 'dashboard' ? addr : withDelivery(addr, 'dashboard');
  const channel = resolveDeliveryChannel(addr, {
    presence: getPresence(), imessageBridgeConfigured: isImessageConfigured(), ownerAffinityChannel: addr.ownerAffinity,
  });
  return channel === addr.deliveryChannel ? addr : withDelivery(addr, channel);
}

export function currentLiveAddress(agentId: string): TurnAddress | undefined {
  return liveAddress(turnContext(agentId)?.address);
}
