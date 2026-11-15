// The agent-to-agent notification bus: an agent sends another a typed notification, stored
// as a `messages` row scoped by `origin_intent='agent_bus'` to keep it apart from peer traffic.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { insertMessage, AGENT_BUS_INTENT } from '../memory/message-store.js';

const logger = createLogger('agent-bus');

export function sendAgentMessage(
  fromId: string,
  toId: string,
  messageType: string,
  content: string,
  metadata?: Record<string, unknown>,
): string {
  const id = uuidv4();
  const metadataJson = JSON.stringify(metadata ?? {});

  insertMessage({
    id,
    agentId: toId,
    role: 'user',
    lane: 'a2a',
    content,
    sourceAgentId: fromId,
    a2aIntent: messageType,
    originIntent: AGENT_BUS_INTENT,
    inboundMeta: metadataJson,
  });

  logger.info('Agent message sent', {
    messageId: id,
    from: fromId,
    to: toId,
    messageType,
    contentLength: content.length,
  }, fromId);

  return id;
}
