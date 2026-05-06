// ════════════════════════════════════════
// agent/v2/hooks/task-complete.ts — Phase 7 / Part X
//
// When a sub-agent completes a task, the parent agent needs to know what
// was asked, what was delivered, and decide whether the result is acceptable.
// v1 already sends a parent-facing system message at completion time, but
// it only includes the COMPLETION SUMMARY — not the original ask. The model
// loses the context of what was originally requested if the sub-agent's
// description got edited mid-task or the parent's chat has churned.
//
// onTaskComplete preserves Claude Code's contract: parent reads + judges.
// No automated drift scoring (Part X "Drift detection: parent agent's job,
// not the engine's"). The engine's only job is to surface the original ask
// alongside the summary.
//
// Fired from agent/spawner.ts:completeAgent AFTER the existing parent
// notification. Both messages are persisted; the existing one stays for
// continuity with v1, the new structured one carries the original ask.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../logger.js';
import { broadcast } from '../../../gateway/ws.js';
import { getDb } from '../../../db/connection.js';

const logger = createLogger('v2-task-complete-hook');

interface TaskRow {
  id: string;
  title: string | null;
  description: string | null;
  original_description: string | null;
  completion_summary: string | null;
  assigned_to: string | null;
}

interface AgentRow {
  id: string;
  name: string | null;
  parent_agent: string | null;
}

/**
 * Fires after a sub-agent reports task completion. Persists a structured
 * `[System: ...]` message into the parent's conversation surfacing the
 * original ask + completion summary. Non-fatal — any thrown error is
 * logged and swallowed so completion isn't blocked by a hook failure.
 *
 * @param taskId — the task that was just completed (may be null/undefined
 *   when the sub-agent didn't have a task assigned, in which case this
 *   hook no-ops).
 * @param completingAgentId — the sub-agent that called complete_task.
 */
export async function onTaskComplete(
  taskId: string | null | undefined,
  completingAgentId: string,
): Promise<void> {
  if (!taskId) return;

  const db = getDb();

  let task: TaskRow | undefined;
  let completingAgent: AgentRow | undefined;
  try {
    task = db
      .prepare(
        'SELECT id, title, description, original_description, completion_summary, assigned_to FROM tasks WHERE id = ?',
      )
      .get(taskId) as TaskRow | undefined;
    completingAgent = db
      .prepare('SELECT id, name, parent_agent FROM agents WHERE id = ?')
      .get(completingAgentId) as AgentRow | undefined;
  } catch (err) {
    logger.warn('onTaskComplete: DB lookup failed', {
      taskId,
      completingAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!task) {
    logger.debug('onTaskComplete: task not found, skipping', { taskId });
    return;
  }
  if (!completingAgent) {
    logger.debug('onTaskComplete: completing agent not found, skipping', { completingAgentId });
    return;
  }

  // Resolve the parent: spec uses "task.parent_agent" but the actual model
  // is that sub-agents have a parent_agent on the agents table. If the
  // completing agent has no parent (e.g. it's the primary agent finishing
  // its own work), the hook no-ops — there's no one to notify.
  const parentId = completingAgent.parent_agent;
  if (!parentId || parentId === completingAgentId) return;

  const parent = db
    .prepare('SELECT id, name FROM agents WHERE id = ?')
    .get(parentId) as { id: string; name: string | null } | undefined;
  if (!parent) {
    logger.debug('onTaskComplete: parent agent not found in DB, skipping', { parentId });
    return;
  }

  // Build the structured note. Spec wording from Part X §1156-1167:
  //   "[System: <agentId> completed task '<title>'.
  //    Original ask: <description>
  //    Completion summary: <summary>
  //    Review and decide whether to accept, redirect, or reassign.]"
  const subAgentDisplay = completingAgent.name ?? completingAgentId;
  const title = task.title ?? '(untitled)';
  const originalAsk = (task.original_description ?? task.description ?? '').slice(0, 400);
  const summary = (task.completion_summary ?? '').slice(0, 400);

  const lines = [
    `[System: ${subAgentDisplay} completed task "${title}".`,
    originalAsk ? `Original ask: ${originalAsk}` : 'Original ask: (none recorded)',
    summary ? `Completion summary: ${summary}` : 'Completion summary: (no summary provided)',
    'Review and decide whether to accept, redirect, or reassign.]',
  ];
  const content = lines.join('\n');

  try {
    const messageId = uuidv4();
    const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      `INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
       VALUES (?, ?, 'system', ?, ?)`,
    ).run(messageId, parentId, content, now);
    broadcast({
      type: 'chat:message',
      agentId: parentId,
      message: {
        id: messageId,
        agentId: parentId,
        role: 'system',
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: now,
      },
    });
    logger.info('onTaskComplete: structured note delivered to parent', {
      taskId,
      parentId,
      completingAgentId,
    });
  } catch (err) {
    logger.warn('onTaskComplete: failed to persist/broadcast note (non-fatal)', {
      taskId,
      parentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
