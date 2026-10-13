// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — A SEND THAT NAMES ITS TASK.
//
// Every person-reaching send tool (exactly the set the tool-dispatch door opens a delivery
// scope for: `agent/v2/outbound.ts:outboundChannelForTool`) carries this one OPTIONAL argument.
// When the agent passes it, the dispatch door records that the person was told about that task
// (`work/validation-drive.ts:recordPersonTold`, via `send_tool`), from the delivery the send
// itself wrote — so the owner-escalation ladder does not steer the agent to raise it again, and
// does not tell the owner a second time. Omitted means no record (the ladder's fail-safe stays).
// The task is never inferred from the words of the message or from what the turn was serving.
//
// Named `task_id` because every other agent tool that names a work row does (t142 fix round 1
// census: `spawn_agent`, `work_update`, `work_note`, `work_close_request`, `work_validate`,
// `work_schedule`), and resolved the way they resolve it (a full id, or a prefix of 8+).
//
// These bytes sit in every send tool's schema, i.e. in the cached tool array: changing them
// moves the prompt prefix once for every agent holding a send tool (G2).
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../../db/connection.js';
import { isPrimaryAgent } from '../../config/platform.js';

export const TOLD_ABOUT_TASK_ARG = 'task_id';

export const TOLD_ABOUT_TASK_PROPERTY = {
  type: 'string',
  description: 'Optional. The id of the task this message tells them about (e.g. raising a blocked task), so the platform knows they were told.',
};

/**
 * May `agentId` say a send was about work row `workId`? The agent that holds the row
 * (`agent_id`), its named assignee, the agent that opened it (a requester of kind agent), and the
 * primary — the one agent the escalation ladder steers to raise a blocked row with the owner, and
 * the only one that can text him. Any other agent naming a row it has no part in records nothing
 * (the send itself still goes out), so it cannot settle another agent's escalation episode.
 */
export function agentMayNameTask(agentId: string, workId: string): boolean {
  try {
    const row = getDb().prepare('SELECT agent_id, assignee_agent, requester, requester_id FROM work WHERE id = ?')
      .get(workId) as { agent_id: string; assignee_agent: string | null; requester: string; requester_id: string | null } | undefined;
    if (!row) return false;
    return row.agent_id === agentId || row.assignee_agent === agentId
      || (row.requester === 'agent' && row.requester_id === agentId)
      || isPrimaryAgent(agentId);
  } catch {
    return false;
  }
}
