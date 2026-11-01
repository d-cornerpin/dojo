// Where the agent CAN act on a failure (a generated image that failed, a file that did not reach the person), the
// engine hands the failure to the agent and WAKES it, so the agent tells the person now in its own words (R1, R7,
// OWNER ANSWER 2). The engine writes nothing to the person.
//
// The wake is the engine's existing one for engine events: persist a deliverable event on the events lane
// (`insertEngineEventIfAbsent`, as spawner.ts' kickoff and the scheduler fire do) and call
// `getAgentRuntime().handleMessage` (it reads the persisted row; a busy agent parks the wake until its run ends).
// The intent ('delivery_failure_owed') is a DECLARED DELIVERABLE, not a rider (agent/v2/engine-riders.ts): it IS the reason for a turn.

import { v4 as uuidv4 } from 'uuid';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { createLogger } from '../logger.js';

const logger = createLogger('wake-with-notice');

/** Persist the notice as a deliverable engine event for `agentId` and start (or queue) its turn. Never throws. */
export async function tellAgentAndWake(opts: { agentId: string; from: string; brief: string }): Promise<void> {
  try {
    insertEngineEventIfAbsent({
      id: uuidv4(), agentId: opts.agentId,
      content: `[SOURCE: AGENT NOTICE from ${opts.from}] ${opts.brief.replace(/\s+/g, ' ').trim()}`,
      sourceAgentId: null, originIntent: 'delivery_failure_owed', work: null,
    });
    const { getAgentRuntime } = await import('./runtime.js');
    getAgentRuntime().handleMessage(opts.agentId, '').catch((err) => {
      logger.warn('wake after a failure notice failed (the notice stays queued)', { error: err instanceof Error ? err.message : String(err) }, opts.agentId);
    });
  } catch (err) {
    logger.warn('failure notice could not be posted', { error: err instanceof Error ? err.message : String(err) }, opts.agentId);
  }
}
