// The engine's own channel door: no tool name here, so the routing decision asks its own gate.

import type { AccessChannel, Channel } from '@dojo/shared';
import { mayUseChannel } from './read.js';

// The routing union says 'phone' where ACCESS_CHANNELS says 'voice': a name-matched gate would miss voice.

// 'dashboard'/'a2a'/'engine' reach no human: they answer null, so no gate is asked.
export function channelForDestination(destination: Channel): AccessChannel | null {
  switch (destination) {
    case 'imessage': return 'imessage';
    case 'sms': return 'sms';
    case 'teams': return 'teams';
    case 'email': return 'email';
    case 'phone': return 'voice';
    case 'voice': return 'voice';
    case 'dashboard': return null;
    case 'a2a': return null;
    case 'engine': return null;
  }
}

/** One predicate for every arm: the same mayUseChannel every other door asks, master switch inside. */
export function engineMayRouteTo(agentId: string, destination: Channel): boolean {
  const channel = channelForDestination(destination);
  return channel === null || mayUseChannel(agentId, channel);
}

export function engineRouteRefusalReason(destination: Channel): string {
  const channel = channelForDestination(destination);
  return `withheld: this agent holds no ${channel ?? destination} channel grant, so the engine did not auto-route its reply (the reply is in the dashboard chat)`;
}
