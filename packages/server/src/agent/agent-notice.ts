// The sanctioned way to make another agent (usually the primary) AWARE: one brief first-person line.
// Stored role='user' (a 'system' row is invisible to the model), origin_kind='engine', so it lands
// in the EVENTS lane: model-visible, out of the user's chat, never compacted. Detail stays on the bus.

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { createLogger } from '../logger.js';
import { insertEngineEventIfAbsent } from '../memory/message-store.js';

const logger = createLogger('agent-notice');

export interface AgentNoticeOpts {
  toAgentId: string;
  fromName: string;
  /** ONE short first-person sentence; a full report belongs on the bus, not here. */
  brief: string;
  intent?: string;
  selfIntro?: boolean;
}

/** Best-effort: a notice must never break the caller, so errors are swallowed; null on failure. */
export function postAgentNotice(opts: AgentNoticeOpts): string | null {
  const { toAgentId, fromName, brief } = opts;
  if (!toAgentId || !fromName || !brief) return null;
  const trimmed = brief.replace(/\s+/g, ' ').trim();
  const intro = opts.selfIntro === false ? '' : `Hey, this is the ${fromName} agent. `;
  // The `[SOURCE: AGENT NOTICE` prefix is what platform-noise matches to keep notices out of compaction.
  const content = `[SOURCE: AGENT NOTICE from ${fromName}] ${intro}${trimmed}`;
  const id = uuidv4();
  try {
    // An engine notice is inter-agent traffic: it lands on the EVENTS lane, outside the owner's
    // chat table, and ENGINE_RIDER_INTENTS keeps it from ever driving an engine turn of its own.
    insertEngineEventIfAbsent({
      work: null,
      id,
      agentId: toAgentId,
      content,
      sourceAgentId: null,             // a subsystem/service name, not a peer agent id
      originIntent: opts.intent ?? 'agent_notice',
    });
    // Inter-agent traffic broadcasts on `interagent:message`, never `chat:message`.
    broadcast({
      type: 'interagent:message',
      agentId: toAgentId,
      message: {
        id,
        agentId: toAgentId,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        sourceAgentId: null,
        senderName: fromName,
        recipientName: null,
        threadId: null,
        intent: opts.intent ?? 'agent_notice',
        requiresResponse: false,
        originKind: 'engine',
      },
    });
    return id;
  } catch (err) {
    logger.warn('postAgentNotice failed (non-fatal)', {
      toAgentId, fromName, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A re-drive that WAKES an agent and owes nobody a reply: as an A2A QUESTION the one reply bit
 *  would make it a request owed its own turns until a reply lands, then given up.
 *  It rides as an events-lane engine event plus the runtime wake. Best-effort, never throws. */
export async function redriveWithoutReply(opts: {
  toAgentId: string; fromAgentId: string | null; content: string; taskId: string | null;
}): Promise<boolean> {
  try {
    insertEngineEventIfAbsent({
      id: uuidv4(), agentId: opts.toAgentId, content: opts.content, sourceAgentId: opts.fromAgentId,
      originIntent: 'tracker',
      work: opts.taskId ? { taskId: opts.taskId, runId: null, rootKind: 'task', rootId: opts.taskId } : null,
    });
    const { getAgentRuntime } = await import('./runtime.js');
    getAgentRuntime().handleMessage(opts.toAgentId, opts.content).catch((err: unknown) => {
      logger.warn('re-drive wake failed; the notice row stands for the next drain', {
        toAgentId: opts.toAgentId, error: err instanceof Error ? err.message : String(err) });
    });
    return true;
  } catch (err) {
    logger.warn('re-drive could not be delivered', { toAgentId: opts.toAgentId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
