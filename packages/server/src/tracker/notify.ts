// Task assignment notification: the one helper the tracker tool doors (`tracker/tools.ts`) use when a task is
// assigned to another agent. It persists the [SOURCE: TRACKER TASK ASSIGNMENT] notice as an engine event,
// broadcasts it to the dashboard and wakes the assignee.

import { v4 as uuidv4 } from 'uuid';
import { findTaskOriginChain, renderTaskOriginChain } from './origin-chain.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { insertEngineEvent } from '../memory/message-store.js';
import { isDreamerAgent, isPrimaryAgent } from '../config/platform.js';
import { assignmentMeasureLine } from '../work/measure-view.js';
import { planStepLineOf } from '../work/plan-store.js';

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
}

// The assignee is always a different agent from the creator, so the wake in
// `injectTaskAssignmentNotification` is the delivery: no param may switch it off.

export interface AssignmentNotificationResult {
  ok: boolean;
  content: string | null;
}

/** Inject a task-assignment notice into the assignee's conversation. Returns ok:false when the assignee is
 *  the creator; 'dojo-system' counts as a distinct creator so engine-created tasks still notify. */
export function injectTaskAssignmentNotification(
  params: AssignmentNotificationParams,
): AssignmentNotificationResult {
  const { assignedAgentId, creatorAgentId, taskId, title, description, projectId, priority } = params;
  if (!assignedAgentId) return { ok: false, content: null };
  if (assignedAgentId === creatorAgentId) return { ok: false, content: null };

  // The Dreamer's output is the vault: it must never message or wake the primary agent. A Dreamer-created
  // task assigned to the primary would do both (the handleMessage below), so refuse at this choke point.
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
    planStepLineOf(taskId) ?? '',   // the step of its project's plan this task is
    projectId ? `Project: ${projectId}` : '',
    `Assigned by: ${creatorName}`,
    // The assignee starts with where this work came from, so the task is never a floating title.
    (() => { try { const o = findTaskOriginChain(taskId); return o ? `Origin: ${renderTaskOriginChain(o)}` : ''; } catch { return ''; } })(),
    ``,
    assignmentMeasureLine(taskId),
    // Facts only, never close-coaching: the assignee is not told how to close the task.
    `It is done when its work is done, and the PM validates its close. If you cannot proceed, status="blocked" with the reason.`,
  ].filter(Boolean);
  const content = lines.join('\n');

  const messageId = uuidv4();
  try {
    // An inter-agent notice: it lands on the EVENTS lane (outside the assignee's `messages` chat table),
    // stamped with `originIntent` so nothing parses the [SOURCE: ...] prose. The THROWING
    // `insertEngineEvent` is deliberate: the id is a fresh uuid, so an ignore-form could only swallow
    // a real failure, which the catch below reports.
    insertEngineEvent({
      id: messageId,
      agentId: assignedAgentId,
      content,
      sourceAgentId: creatorAgentId === 'dojo-system' ? null : creatorAgentId,
      originIntent: 'tracker',
      // The task this notice assigns, as a column, so a hand-in retires it by key.
      work: { taskId, runId: null, rootKind: 'task', rootId: taskId },
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

    // Unconditional: the wake IS the delivery.
    const runtime = getAgentRuntime();
    runtime.handleMessage(assignedAgentId, content).catch((err) => {
      logger.error('Task assignment notification — handleMessage failed', {
        taskId, assignedAgentId,
        error: err instanceof Error ? err.message : String(err),
      }, creatorAgentId);
    });

    return { ok: true, content };
  } catch (err) {
    logger.warn('Task assignment notification failed (non-fatal)', {
      taskId, assignedAgentId,
      error: err instanceof Error ? err.message : String(err),
    }, creatorAgentId);
    return { ok: false, content: null };
  }
}
