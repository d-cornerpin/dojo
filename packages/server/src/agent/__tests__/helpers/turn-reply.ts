// A turn's reply for the relay tests: a delivered iMessage reply stamped with the turn and the request it serves.
import { asTurn } from '../../turn-context.js';
import { recordDelivery } from '../../v2/deliveries.js';
import { AGENT } from '../../v2/__tests__/helpers/reply-sender.js';
import { CONV } from './text-relay.js';

export function turnReplies(turn: number, rootMessageId: string): void {
  asTurn(AGENT, { turnNumber: turn, root: { kind: 'ask', id: rootMessageId, sourceMessageId: rootMessageId, conversationId: CONV }, convKey: null }, () => {
    recordDelivery({ agentId: AGENT, tool: 'imessage_send', channel: 'imessage', conversationId: CONV, outcome: 'delivered' });
  });
}
