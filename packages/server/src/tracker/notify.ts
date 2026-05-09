// ════════════════════════════════════════
// Task assignment notification (v2.3.6)
//
// Single helper used by every path that creates a task assigned to an
// agent — agent-driven (tracker_create_task / tracker_create_project /
// send_to_agent ASSIGN) and engine-driven (multistep auto-create).
//
// Persists a synthetic [SOURCE: TRACKER TASK ASSIGNMENT] user message
// into the assignee's conversation, broadcasts the WS chat event so the
// dashboard sees it, and wakes the agent via runtime.handleMessage so
// they process it immediately. Identical wording across all paths so
// agents have a single, recognizable signal that they've been assigned
// work and how to close it.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';

const logger = createLogger('tracker:notify');

export interface AssignmentNotificationParams {
  assignedAgentId: string;
  /** The agent that initiated the assignment, or 'dojo-system' for engine-created. */
  creatorAgentId: string;
  taskId: string;
  title: string;
  description?: string | null;
  projectId?: string | null;
  priority?: string | null;
  /**
   * Skip the runtime.handleMessage call. Set true when the assignee is
   * the agent currently processing — calling handleMessage there just
   * queues a redundant wake-up. Default false.
   */
  skipWake?: boolean;
}

export interface AssignmentNotificationResult {
  ok: boolean;
  /** The full message content that was persisted (caller may want to push into in-flight context). */
  content: string | null;
}

/**
 * Inject a task-assignment notification into the assignee's conversation.
 * Skips work and returns ok:false if the assignee is the same as the
 * creator (the agent already knows about the task it just created itself).
 * 'dojo-system' is treated as a distinct creator so engine-created tasks
 * still notify the receiving agent.
 */
export function injectTaskAssignmentNotification(
  params: AssignmentNotificationParams,
): AssignmentNotificationResult {
  const { assignedAgentId, creatorAgentId, taskId, title, description, projectId, priority, skipWake } = params;
  if (!assignedAgentId) return { ok: false, content: null };
  if (assignedAgentId === creatorAgentId) return { ok: false, content: null };

  const db = getDb();
  let creatorName: string;
  if (creatorAgentId === 'dojo-system') {
    creatorName = 'DOJO';
  } else {
    const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(creatorAgentId) as { name: string } | undefined;
    creatorName = row?.name ?? creatorAgentId;
  }

  const lines = [
    `[SOURCE: TRACKER TASK ASSIGNMENT — you have been assigned a new task]`,
    ``,
    `Task: ${title}`,
    `ID: ${taskId}`,
    `Priority: ${priority ?? 'normal'}`,
    description ? `\nInstructions:\n${description}` : '',
    projectId ? `Project: ${projectId}` : '',
    `Assigned by: ${creatorName}`,
    ``,
    `Begin working on this task. When finished, call tracker_update_status(task_id="${taskId}", status="complete", notes="what you did").`,
    `If you get stuck, call tracker_update_status(task_id="${taskId}", status="blocked", notes="why you're blocked").`,
  ].filter(Boolean);
  const content = lines.join('\n');

  const messageId = uuidv4();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, created_at)
       VALUES (?, ?, 'user', ?, ?, datetime('now'))`,
    ).run(messageId, assignedAgentId, content, creatorAgentId === 'dojo-system' ? null : creatorAgentId);

    broadcast({
      type: 'chat:message',
      agentId: assignedAgentId,
      message: {
        id: messageId,
        agentId: assignedAgentId,
        role: 'user' as const,
        content,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    if (!skipWake) {
      const runtime = getAgentRuntime();
      runtime.handleMessage(assignedAgentId, content).catch((err) => {
        logger.error('Task assignment notification — handleMessage failed', {
          taskId, assignedAgentId,
          error: err instanceof Error ? err.message : String(err),
        }, creatorAgentId);
      });
    }

    return { ok: true, content };
  } catch (err) {
    logger.warn('Task assignment notification failed (non-fatal)', {
      taskId, assignedAgentId,
      error: err instanceof Error ? err.message : String(err),
    }, creatorAgentId);
    return { ok: false, content: null };
  }
}
