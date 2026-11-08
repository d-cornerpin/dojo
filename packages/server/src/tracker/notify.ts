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

// ── STRIP (PHASE-3 T9). `skipWake?: boolean` is DELETED from these params. ──
//
// It suppressed the `runtime.handleMessage` wake below when the assignee was the agent
// ALREADY running — which was only ever possible because the assembler could push a SECOND,
// same-turn copy of this notice straight into the in-flight array (`msg.tracker-notif`,
// slot 1500). T3 stripped that injection on positive evidence: its only consumer, the
// multistep classifier's auto-create block, was deleted whole by `d00f270`.
//
// T3 enumerated the flag for this task rather than deleting it inside its own re-bless
// window; RE-VERIFIED at this HEAD before removal (#15), not inherited:
// `git grep -n skipWake -- .` finds it in this file and in prose only — the two live
// callers (`tracker/tools.ts:891`, `:1214`) pass an object literal without the key, so
// there is no path on which it was ever true. (`runtime.ts`'s `__skipWakeDrain` is an
// unrelated throw sentinel and is untouched.)
//
// requirement preserved: "an agent that has just been ASSIGNED work learns it was assigned,
// and how to close it" — owned end to end by `injectTaskAssignmentNotification` below,
// which PERSISTS the `[SOURCE: TRACKER TASK ASSIGNMENT]` row, BROADCASTS it, and WAKES the
// assignee. In every surviving path the assignee is a different agent, so the wake is the
// delivery, and a flag that could switch it off is a way to lose one.

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
  const { assignedAgentId, creatorAgentId, taskId, title, description, projectId, priority } = params;
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
    planStepLineOf(taskId) ?? '',   // v3.5 plan before project: the step of its project's plan this task is
    projectId ? `Project: ${projectId}` : '',
    `Assigned by: ${creatorName}`,
    // Ticket stamps (2026-07-22): the assignee starts with the CONNECTION,
    // where this work came from, so the ticket is never a floating title.
    (() => { try { const o = findTaskOriginChain(taskId); return o ? `Origin: ${renderTaskOriginChain(o)}` : ''; } catch { return ''; } })(),
    ``,
    assignmentMeasureLine(taskId),
    // v3.5 field fix 3 (test-2 round): facts, never close-coaching (product law, "Finishing, not
    // closing"). This line told the assignee "Close it with work_update(... complete ...)".
    `It is done when its work is done, and the PM validates its close. If you cannot proceed, status="blocked" with the reason.`,
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

    // PHASE-3 T9: unconditional. The `skipWake` opt-out is stripped (see the header above);
    // the wake IS the delivery for an assignee that is, in every surviving path, a
    // different agent from the creator.
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
