// ════════════════════════════════════════
// Task assignment notification (v2.3.6)
//
// Single helper used by every path that creates a task assigned to an
// agent — agent-driven (work_open(kind="task") / work_open(kind="project") /
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
import { findTaskOriginChain, renderTaskOriginChain } from './delivery-evidence.js';
import { retireEngineEventsForTask } from '../agent/v2/counterparty.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { insertEngineEvent, claimTrackerNoticeForTask } from '../memory/message-store.js';
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
 * Neutralize a still-pending task-assignment engine event once its task has
 * reached a terminal state (C2). The scaffold that creates a task from the
 * current turn ALSO pushes the assignment notice inline into that same turn, so
 * the assignee acts on it immediately; the persisted notice row is a record for
 * compaction/display, not a second delivery. But it is stored conv_key=NULL, so
 * once the turn ends the runtime drain / engine-event pickup re-delivers it as a
 * fresh "begin working on this task" prompt on a NEW turn, and the floor model
 * redoes the work, overwriting the artifact the user was already shown. Marking
 * it claimed (conv_key='engine', the same sentinel the loop stamps when it
 * actually serves an engine event) excludes it from getPendingEngineEvent
 * without deleting it, so a task that is already done can never be re-driven.
 *
 * Only touches the pending (conv_key IS NULL) tracker assignment notice(s) for
 * THIS task (matched on the full task-id in the notice body, which is unique),
 * so unrelated engine events are never affected. Idempotent, best-effort;
 * genuinely-open tasks are untouched, so the dangling-recovery machinery for
 * unfinished work still fires as before.
 */
export function claimAssignmentNoticeForTerminalTask(assignedAgentId: string, taskId: string): void {
  if (!assignedAgentId || !taskId) return;
  // P2 serve boundary, KEYED retirement first (migration 112): every unserved
  // engine event carrying this task_id (assignment notices, triggers, pokes)
  // retires the moment the task goes terminal. The content-LIKE claim below is
  // kept ONLY as a legacy fallback for pre-112 rows whose task_id is NULL;
  // scar-ledger note: delete the LIKE arm once the fleet's pending rows have
  // aged past the 6-hour event horizon on a post-112 build.
  try {
    retireEngineEventsForTask(taskId, 'task_terminal');
  } catch { /* best effort; the LIKE fallback below still neutralizes */ }
  const like = `%ID: ${taskId}%`;
  try {
    // T6: one home, one call. This was two — the row could be in either physical
    // table, so the claim had to be attempted against both.
    claimTrackerNoticeForTask({ agentId: assignedAgentId, contentLike: like });
  } catch (err) {
    logger.warn('Failed to claim assignment notice for terminal task (non-fatal)', {
      taskId, assignedAgentId, error: err instanceof Error ? err.message : String(err),
    }, assignedAgentId);
  }
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
    // Ticket stamps (2026-07-22): the assignee starts with the CONNECTION,
    // where this work came from, so the ticket is never a floating title.
    (() => { try { const o = findTaskOriginChain(taskId); return o ? `Origin: ${renderTaskOriginChain(o)}` : ''; } catch { return ''; } })(),
    ``,
    `Begin working on this task. When finished, call work_update(action="status", task_id="${taskId}", status="complete", notes="what you did").`,
    `If you get stuck, call work_update(action="status", task_id="${taskId}", status="blocked", notes="why you're blocked").`,
  ].filter(Boolean);
  const content = lines.join('\n');

  const messageId = uuidv4();
  try {
    // D-A step 4: a task-assignment notice is inter-agent traffic (origin_kind=
    // lane='events'), so it lands on the EVENTS lane, structurally outside the assignee's
    // `messages` chat table. The merged tail + assembler surface it as a pending
    // engine event (conv_key NULL) exactly as the old `messages` row did.
    // origin_kind/origin_intent (mig 075): this is an ENGINE event (a task
    // assignment notice), not the user talking, stamped structurally so the
    // engine/dashboard never have to parse the [SOURCE: …] prose to know that.
    // FA-T6: `insertEngineEvent`, the THROWING form — not `insertEngineEventIfAbsent`.
    // `id` is a fresh uuid, so idempotence could never suppress a real duplicate; it
    // could only swallow a genuine constraint failure (which the catch below already
    // surfaces as a warning + ok:false). No double-fire path exists for this
    // notification, so the implied dedup was inert, and the throwing form keeps a real
    // failure honest. (T10: the shim's `orIgnore: false` said this by flag; the writer
    // module says it by which function is called.)
    insertEngineEvent({
      id: messageId,
      agentId: assignedAgentId,
      content,
      sourceAgentId: creatorAgentId === 'dojo-system' ? null : creatorAgentId,
      originIntent: 'tracker',
      convKey: null,
      // P1 lineage spine: the task this notice assigns, as a COLUMN. The
      // terminal-task retire (claimAssignmentNoticeForTerminalTask) becomes a
      // keyed UPDATE at P2 instead of a content LIKE scan.
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
