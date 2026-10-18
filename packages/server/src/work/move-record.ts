// THE record of a move of work between holders: cause, who, from, to (`to` null = nobody now).
// `moveAssignee` (work/row-authority.ts) files it for every model-driven and owner-asked move, and the
// engine subsystems that move work off a holder who is GONE file it too (the healer's orphan sweep,
// the scheduler's fire on a terminated assignee), so a move has ONE shape of record whoever made it.
// It rides `recordReassignment` (tracker/assignee-patience.ts), which also re-arms the patience ladder.
import { recordReassignment } from '../tracker/assignee-patience.js';

export function recordMove(p: {
  taskId: string; actor: string; from: string | null; to: { agentId: string } | { groupId: string } | null;
  cause: 'assignee_gone' | 'coordination' | 'user_requested'; door: string;
}): void {
  recordReassignment({
    taskId: p.taskId, actor: p.actor, fromAgentId: p.from, reason: `cause=${p.cause} via ${p.door}`,
    toAgentId: p.to && 'agentId' in p.to ? p.to.agentId : null,
    toGroupId: p.to && 'groupId' in p.to ? p.to.groupId : null,
  });
}
