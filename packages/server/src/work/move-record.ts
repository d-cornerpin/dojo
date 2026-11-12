// THE record of a move of work between holders (`to` null = nobody now), filed by `moveAssignee` and by the engine
// subsystems that move work off a gone holder; it rides `recordReassignment`, which re-arms the patience ladder.
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
