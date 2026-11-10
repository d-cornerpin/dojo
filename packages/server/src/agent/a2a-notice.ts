// Best-effort notices only: a refused A2A delivery is a RETURN (`{ delivered: false, reason }`),
// not a throw; each site must check `delivered` and warn, or it logs a send that never happened.

import { deliverA2AMessage, type A2ADeliveryOptions, type A2ADeliveryResult } from './a2a-transport.js';
import { createLogger } from '../logger.js';

const logger = createLogger('a2a-notice');

// Census: no-a2a-caller-throws-its-delivery-away.test.ts; a branching caller uses `deliverA2AMessage`.
export async function deliverA2ANotice(
  envelope: A2ADeliveryOptions,
  what: string,
  facts: Record<string, unknown> = {},
  agentId?: string,
): Promise<A2ADeliveryResult> {
  const res = await deliverA2AMessage(envelope);
  if (!res.delivered) {
    logger.warn(`${what} was NOT delivered`, {
      ...facts,
      threadId: res.threadId,
      reason: res.reason ?? 'unknown',
    }, agentId);
  }
  return res;
}
