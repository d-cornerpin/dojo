// Wakes the agent on a failure it can act on, so it tells the person in its own words; the engine writes
// nothing to the person. A busy agent parks the wake until its run ends. The intent is the reason for the turn,
// so it must stay out of ENGINE_RIDER_INTENTS (agent/v2/engine-riders.ts).

import { v4 as uuidv4 } from 'uuid';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { turnContext } from './turn-context.js';
import { postAgentNotice } from './agent-notice.js';

const logger = createLogger('wake-with-notice');

/** Persist the notice as a deliverable engine event for `agentId` and start (or queue) its turn. Never throws. */
export async function tellAgentAndWake(opts: { agentId: string; from: string; brief: string; inFailureTurn?: boolean; intent?: 'delivery_failure_owed' | 'background_command_done' }): Promise<void> {
  try {
    // No wake loop: a failure inside a turn a failure notice itself woke goes to the agent as a rider instead.
    if (opts.inFailureTurn ?? isFailureWokenTurn(opts.agentId)) {
      postAgentNotice({ toAgentId: opts.agentId, fromName: opts.from, brief: opts.brief, selfIntro: false });
      return;
    }
    // A background command's result keeps its lines (a listing, a build log); every other brief is one line.
    const body = opts.intent === 'background_command_done' ? opts.brief.trim() : opts.brief.replace(/\s+/g, ' ').trim();
    const content = `[SOURCE: AGENT NOTICE from ${opts.from}] ${body}`;
    if (opts.intent === 'background_command_done') {
      insertEngineEventIfAbsent({ id: uuidv4(), agentId: opts.agentId, content, sourceAgentId: null, originIntent: 'background_command_done', work: null });
    } else {
      insertEngineEventIfAbsent({ id: uuidv4(), agentId: opts.agentId, content, sourceAgentId: null, originIntent: 'delivery_failure_owed', work: null });
    }
    const { getAgentRuntime } = await import('./runtime.js');
    getAgentRuntime().handleMessage(opts.agentId, '').catch((err) => {
      logger.warn('wake after a failure notice failed (the notice stays queued)', { error: err instanceof Error ? err.message : String(err) }, opts.agentId);
    });
  } catch (err) {
    logger.warn('failure notice could not be posted', { error: err instanceof Error ? err.message : String(err) }, opts.agentId);
  }
}

/** An engine turn's reply does not reach an iMessage requester: name them and how to reach them. */
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
