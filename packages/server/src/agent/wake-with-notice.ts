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
import { getDb } from '../db/connection.js';
import { turnContext } from './turn-context.js';
import { postAgentNotice } from './agent-notice.js';

const logger = createLogger('wake-with-notice');

/** Persist the notice as a deliverable engine event for `agentId` and start (or queue) its turn. Never throws. */
export async function tellAgentAndWake(opts: { agentId: string; from: string; brief: string; inFailureTurn?: boolean }): Promise<void> {
  try {
    // NO WAKE LOOP (real signal, no counter or timer): a failure that happens inside a turn which a failure notice
    // itself woke is told to the agent as a rider; it is already on this request and will see it.
    if (opts.inFailureTurn ?? isFailureWokenTurn(opts.agentId)) {
      postAgentNotice({ toAgentId: opts.agentId, fromName: opts.from, brief: opts.brief, selfIntro: false });
      return;
    }
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

/**
 * R4: the woken turn is an ENGINE turn, so its written reply does not reach an iMessage requester. Name who to tell
 * (name, relation, channel, address) and say plainly how to reach them. Never throws.
 */
export async function requesterReachSentence(address: string): Promise<string> {
  let name = address; let relation = 'a contact';
  try {
    const { resolveRecipientDisplay } = await import('../contacts/resolve-recipient.js');
    name = resolveRecipientDisplay('imessage', address) || address;
    const { getSafeSenders, findSafeSenderByAddress } = await import('../services/imessage-bridge.js');
    if (findSafeSenderByAddress(getSafeSenders(), address)?.is_primary) relation = 'the owner';
  } catch { /* the address alone is still enough to act on */ }
  return `The person is ${name} (${relation}, on iMessage, address ${address}). Your written reply on this turn does NOT reach them; ` +
    `to tell them, call imessage_send with recipient="${address}".`;
}

/** Is the turn running for `agentId` right now the one a failure notice woke? Read off the row that woke it. */
export function isFailureWokenTurn(agentId: string): boolean {
  try {
    const id = turnContext(agentId)?.triggerMessageId;
    if (!id) return false;
    const row = getDb().prepare('SELECT origin_intent FROM messages WHERE id = ?').get(id) as { origin_intent: string | null } | undefined;
    return row?.origin_intent === 'delivery_failure_owed';
  } catch { return false; }
}

/** Background jobs (audio, music, video) started inside a turn a failure notice itself woke: their failure is told as a rider, never a second wake. */
const startedInFailureTurn = new Set<string>();
export function noteJobStartedIn(agentId: string, jobId: string): void { if (isFailureWokenTurn(agentId)) startedInFailureTurn.add(jobId); }
export function takeJobStartedInFailureTurn(jobId: string): boolean { return startedInFailureTurn.delete(jobId); }
