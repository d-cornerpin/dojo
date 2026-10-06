/**
 * THE CALLER SIDE OF "A DROP IS LOUD EVERYWHERE".
 *
 * `deliverA2AMessage` reports a refused delivery as a RETURN — `{ delivered: false, reason }` —
 * not as a throw. So a caller wrapped in `try { … } catch { /* best-effort *\/ }` never sees a
 * drop, and the `logger.info('…notified')` line below the call claims a send that did not
 * happen. The transport itself warns (t109 A), but a transport warn says "a delivery was
 * refused"; it cannot say WHICH notice the product therefore owes nobody.
 *
 * The twelve best-effort notice sites all want the identical branch — read `delivered`, warn
 * with `reason` — and twelve copies of it is twelve places for the next one to be forgotten.
 * So the branch lives here once, and a notice site reads as one call that cannot be silent.
 *
 * Use this ONLY where the caller has nothing to decide: the notice is best-effort either way
 * and the drop is a thing to SAY, not to handle. A caller that must branch on the outcome
 * (retry, un-record, refuse the tool call) calls `deliverA2AMessage` directly and reads the
 * result — `tracker/pm-agent.ts` and `healer/injury-recovery.ts`'s injury alert are both that
 * shape. The result is returned here too, so moving from one shape to the other is not a
 * rewrite.
 *
 * The census that keeps this honest is
 * `agent/__tests__/no-a2a-caller-throws-its-delivery-away.test.ts`: every
 * `deliverA2AMessage(` call site in the tree either binds the result or is a call to this
 * door, and a new discarding caller reds it.
 */

import { deliverA2AMessage, type A2ADeliveryOptions, type A2ADeliveryResult } from './a2a-transport.js';
import { createLogger } from '../logger.js';

const logger = createLogger('a2a-notice');

/**
 * Deliver a best-effort A2A notice and, if it was refused, say exactly which notice was lost
 * and why.
 *
 * @param envelope the delivery, unchanged — this door adds no policy to the send itself
 * @param what     the notice in the product's own words, e.g. "Retask directive to the agent".
 *                 The warn reads "<what> was NOT delivered".
 * @param facts    the identifiers a reader needs to find the thing that did not happen
 * @param agentId  the agent the line belongs to, for the per-agent log view
 */
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
