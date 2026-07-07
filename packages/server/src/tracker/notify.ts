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
import { insertInterAgentEngineRow } from '../memory/interagent.js';
import { isDreamerAgent, isPrimaryAgent } from '../config/platform.js';

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

  // D-A step 4, Dreamer rule (owner decision, repeated): the Dreamer's output is
  // the VAULT (recall/retrieval injection) and it must NEVER message or wake the
  // primary agent. A Dreamer-created tracker task assigned to the primary would
  // both hand the primary work AND wake it (the handleMessage below), which is
  // exactly the seam the rule forbids. Refuse to notify/wake for that pair; the
  // Dreamer's memory curation never assigns work to the primary. (The Dreamer has
  // no send_to_agent and self-assigns its own bookkeeping tasks, so this is a
  // defensive guard at the one choke point that would reach the primary.)
  if (isDreamerAgent(creatorAgentId) && isPrimaryAgent(assignedAgentId)) {
    logger.warn('Suppressed Dreamer-created task assignment to the primary agent (Dreamer must never message/wake the primary)', {
      taskId, assignedAgentId,
    }, creatorAgentId);
    return { ok: false, content: null };
  }

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
    // D-A step 4: a task-assignment notice is inter-agent traffic (origin_kind=
    // 'engine'), so it lands in the physical inter-agent store, not the assignee's
    // `messages` chat table. The merged tail + assembler surface it as a pending
    // engine event (conv_key NULL) exactly as the old `messages` row did.
    // origin_kind/origin_intent (mig 075): this is an ENGINE event (a task
    // assignment notice), not the user talking, stamped structurally so the
    // engine/dashboard never have to parse the [SOURCE: …] prose to know that.
    // FA-T6: plain INSERT (orIgnore:false), not INSERT OR IGNORE. `id` is a fresh
    // uuid, so OR IGNORE could never suppress a real duplicate, it could only
    // swallow a genuine constraint failure (which the catch below already surfaces
    // as a warning + ok:false). No double-fire path exists for this notification,
    // so the implied dedup was inert; a plain INSERT keeps a real failure honest.
    insertInterAgentEngineRow({
      id: messageId,
      agentId: assignedAgentId,
      content,
      sourceAgentId: creatorAgentId === 'dojo-system' ? null : creatorAgentId,
      originIntent: 'tracker',
      convKey: null,
      orIgnore: false,
    });

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
