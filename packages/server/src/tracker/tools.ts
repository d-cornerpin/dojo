// ════════════════════════════════════════════════════════════════════════
// DEAD-CHANNEL DOCTRINE (RC-19 / demolition Phase 0): model-directed text from this
// subsystem rides NOTICE (postAgentNotice, role='user' origin_kind='engine', VISIBLE
// to the model), never role='system' (STRIPPED by the model-context builder). Bare
// role='system' rows here may carry only dashboard/owner-only informational notes or
// an agent's own system prompt, never an imperative the model is expected to ACT on.
// The RC-19 conformance test (agent/v2/__tests__/engine-steer.test.ts) source-scans
// this file for bare role='system' INSERTs carrying imperative model-directed text.
// ════════════════════════════════════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { findDeliveryEvidenceForTask, renderDeliveryEvidence, findTaskOriginChain, renderTaskOriginChain } from './delivery-evidence.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from './task-stamps.js';
import { retireEngineEventsForTask } from '../agent/v2/counterparty.js';
import { createLogger } from '../logger.js';
import {
  createProject,
  getProject,
  createTask,
  getTask,
  listTasks,
  listProjects,
  updateTask,
  updateProject,
  resolveTaskId,
  resolveProjectId,
  formatResolveError,
  closeProjectAndOpenTasks,
  clearPokeLog,
} from './schema.js';
import { ensurePMAgentRunning, noteTransitionForReview } from './pm-agent.js';
import { injectTaskAssignmentNotification, claimAssignmentNoticeForTerminalTask } from './notify.js';
import { writeTaskLog } from './task-log.js';
import { calculateNextRun, normalizeDbTimestamp, parseDaysOfWeek, wallToInstant, getBoxTimeZone, type ScheduledTask, type WallClock } from '../scheduler/engine.js';
import { onTaskRunComplete, terminateLiveScheduleOnFallen } from '../scheduler/runner.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../gateway/ws.js';
import { getPrimaryAgentId, isPrimaryAgent, getOwnerName, isPMAgent } from '../config/platform.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { currentTurnNumber, getTurnReceipts, getWorkOriginForAgent, currentTurnRoot } from '../agent/turn-state.js';
import { getReceiptsByIds, stampReceiptsTask, type ToolReceiptRow } from '../receipts/store.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { formatTimeForAgent } from '../services/format-time.js';

const logger = createLogger('tracker-tools');

// Re-exported from the shared helpers so the trackerCreateTask /
// trackerUpdateStatus call sites keep working with their existing usage.
// The canonical implementation lives in agent/tool-helpers.ts.
import { resolveAgentRef as resolveAgentName } from '../agent/tool-helpers.js';

// ── Notify primary agent of task/project completion ──


// Ticket stamps (2026-07-22): the tracker read surfaces render the engine's
// stamp line from the columns; the live delivery-evidence join stays as
// backfill for rows that predate migration 124.
function getTaskStampFields(taskId: string): TaskStampFields | null {
  try {
    return getDb().prepare(
      `SELECT id, last_activity_turn, last_activity_at, last_activity_outcome,
              last_answered_turn, last_answered_at, last_delivery_summary,
              step_number, total_steps, project_id
         FROM tasks WHERE id = ?`,
    ).get(taskId) as TaskStampFields | null;
  } catch {
    return null;
  }
}
function notifyPrimaryAgent(message: string, callingAgentId: string, forceNotify = false): void {
  const primaryId = getPrimaryAgentId();
  // Don't notify if the primary agent is the one completing the task (unless forced)
  if (isPrimaryAgent(callingAgentId) && !forceNotify) return;

  try {
    const msgId = uuidv4();
    // Store as 'system' role -- informational, does NOT need a response.
    // The primary agent will see it in context on its next turn.
    // We do NOT call handleMessage here -- task updates are informational,
    // not conversations that require a reply. This prevents the primary
    // agent from waking up and responding to every sub-agent status change.
    const content = `[SOURCE: TRACKER TASK UPDATE, automated status update, not a message from the user] ${message}`;
    insertMessageIfAbsent({ id: msgId, agentId: primaryId, role: 'system', content });

    broadcast({
      type: 'chat:message',
      agentId: primaryId,
      message: {
        id: msgId,
        agentId: primaryId,
        role: 'system' as const,
        content,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });
  } catch { /* best-effort */ }
}

// ── RC-18: local wall-clock schedule input ──
//
// The model's single biggest schedule failure is doing timezone math itself
// (P-2: "9 PM PT" written as a botched UTC offset lands the anchor an hour off).
// Let the model hand us the wall-clock time it means and convert it engine-side
// with the SAME wallToInstant the scheduler uses, so the offset is never the
// model's job. Accepts a tz-less "YYYY-MM-DDTHH:MM[:SS]" (or space separator)
// plus an optional IANA timezone (defaults to the box timezone).
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
function resolveLocalWallClock(
  localTime: string,
  tz?: string,
): { ok: true; iso: string; zone: string } | { ok: false; error: string } {
  const m = WALL_CLOCK_RE.exec(localTime.trim());
  if (!m) {
    return {
      ok: false,
      error:
        `Error: local_time="${localTime}" must be a wall-clock time with NO timezone offset, in the form ` +
        `"YYYY-MM-DDThh:mm" or "YYYY-MM-DD hh:mm[:ss]" (24-hour), e.g. "2026-07-16T21:00" for 9 PM. ` +
        `The engine converts it to the correct instant for the box timezone, do NOT do the UTC math yourself. ` +
        `Pass local_timezone (IANA, e.g. "America/Los_Angeles") if it should be resolved in a specific zone.`,
    };
  }
  const zone = tz && tz.trim() ? tz.trim() : getBoxTimeZone();
  const wall: WallClock = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0,
  };
  try {
    const instant = wallToInstant(wall, zone);
    if (isNaN(instant.getTime())) {
      return { ok: false, error: `Error: local_time="${localTime}" in timezone "${zone}" did not resolve to a valid instant.` };
    }
    return { ok: true, iso: instant.toISOString(), zone };
  } catch (err) {
    return { ok: false, error: `Error: could not resolve local_time="${localTime}" in timezone "${zone}": ${err instanceof Error ? err.message : String(err)}.` };
  }
}

// RC-18: one-line wall-clock echo + re-call nudge for any schedule write, so the
// wall time the agent (and user) care about is shown next to the canonical UTC
// instant. formatTimeForAgent already renders BOTH the localized form (with tz
// abbreviation) and the UTC ISO, so an agent can never misread an unlabeled ISO.
function scheduleEchoLines(scheduledStartIso: string | null, nextRunIso: string | null): string[] {
  const lines: string[] = [];
  if (scheduledStartIso) {
    lines.push(`Scheduled (local): ${formatTimeForAgent(scheduledStartIso)}`);
  }
  if (nextRunIso) {
    lines.push(`Next run (local): ${formatTimeForAgent(nextRunIso)}`);
  }
  if (scheduledStartIso || nextRunIso) {
    lines.push('If this local time is NOT what the user asked for, re-call with the corrected time (or pass local_time="YYYY-MM-DDThh:mm" and let the engine do the timezone conversion).');
  }
  return lines;
}

// P2 drive boundary (owner status-truth invariant, 2026-07-21):
// markDeliverableShown was DELETED. It was the hidden-second-status writer: a
// flag on an in_progress row that contradicted the visible status and stood
// the poke ladder down (the yacht-research silent hour). Statuses are promises
// the engine enforces; delivered work is protected by the Key-1 state
// (complete + complete_validated=0, filed through the sanctioned receipt paths
// and PM-validated) plus the retask allow_regenerate gate below. The
// deliverable_shown COLUMN (migration 108) remains as read-only legacy data
// for rows stamped before this release; no writer exists.

// ── Close an engine-owned same-turn scaffold (demolition Phase 1.7 #2) ──
//
// Narrow carve-out from the two-key contract, and the ONLY engine path that may
// write status='complete' on a task. The turn-start / mid-turn multistep
// classifier opens a tracker project+task FOR the model (an ENGINE_AUTO_MARKER
// scaffold) when a user request looks project-worthy but the model has not
// opened the tracker itself. On a read-only conversation turn the going-idle
// machinery never fires, so the engine's OWN scaffold would dangle in_progress
// and later trip the PM poke chain into re-delivering the answer as a "ghost
// done". The engine owns the lifecycle of the tasks IT opens, so it may close
// THIS one, but only under three guards and WITHOUT forging the PM's key:
//
//   1. the task's PROJECT carries the ENGINE_AUTO_MARKER (the marker rides the
//      project description, not the task): it is an engine scaffold, not agent-
//      or user-authored work, AND
//   2. the task was created within THIS turn. There is no turn_number column on
//      tasks, so we bound "this turn" by created_at recency using the same
//      "-5 minutes" window findRecentNearDuplicateProject uses to define the
//      same-turn case; an older scaffold belongs to a prior turn and is the PM
//      sweep's to adjudicate, AND
//   3. the close lands complete_validated=0 (UNVALIDATED). The PM sweep still
//      validates it against the goal exactly like an agent-requested close. The
//      engine RECORDS the delivery; it does not adjudicate success. This is the
//      difference from the demolished forgery (which stamped complete_validated=1
//      so the PM's key could never turn).
//
// One-shot, non-recurring only. Runs the same terminal cascade an agent-requested
// close runs (dependency release + project rollup + assignment-notice neutralize,
// so the still-pending notice can't re-fire as a fresh "begin working" prompt and
// re-drive a redo). Returns true when it closed the task.
export async function closeEngineScaffoldSameTurn(
  agentId: string,
  taskId: string,
  deliveredReply: string,
): Promise<boolean> {
  const db = getDb();
  const task = db.prepare(`
    SELECT t.id, t.status, t.project_id, t.repeat_interval, t.assigned_to, t.created_at, t.origin_turn,
           p.description AS project_description
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.id = ?
  `).get(taskId) as {
    id: string; status: string; project_id: string | null; repeat_interval: number | null;
    assigned_to: string | null; created_at: string; origin_turn: number | null; project_description: string | null;
  } | undefined;
  if (!task) return false;
  // Genuinely open, one-shot only (a recurring schedule is advanced by the
  // scheduler, never terminally closed here).
  if (task.status !== 'in_progress') return false;
  if (task.repeat_interval !== null) return false;
  // Guard 1: must be an engine scaffold (marker rides the PROJECT description).
  if (!task.project_description || !task.project_description.startsWith(ENGINE_AUTO_MARKER)) return false;
  // Guard 2, P4 rekey: "created within this turn" is now IDENTITY, not a
  // clock: the task's origin_turn (P1 spine) equals the live turn number.
  // The 5-minute created_at window survives only as the pre-spine fallback
  // for origin_turn NULL rows, and slow turns no longer silently fail this
  // guard (the old window's confessed defect).
  const liveTurn = currentTurnNumber.get(agentId) ?? null;
  if (task.origin_turn != null && liveTurn != null) {
    if (task.origin_turn !== liveTurn) return false;
  } else {
    const createdMs = new Date(task.created_at.includes('Z') ? task.created_at : task.created_at + 'Z').getTime();
    if (Number.isNaN(createdMs) || Date.now() - createdMs > 5 * 60 * 1000) return false;
  }

  const resultText = (deliveredReply.replace(/\s+/g, ' ').trim().slice(0, 2000))
    || 'Delivered to the user in chat this turn (engine same-turn scaffold close).';
  const evidenceJson = JSON.stringify([
    {
      kind: 'user_visible_reply',
      claim: 'engine-scaffolded task; the model delivered the result to the user in chat this turn; the engine closed its own scaffold against that delivered reply, UNVALIDATED (the PM sweep validates it against the goal)',
    },
  ]);

  // Guard 3: land complete_validated=0. The two-key contract holds, the PM's key
  // still turns. Single writer line (door-lock allow-listed in
  // two-key-conformance.test.ts as the sole engine status='complete' writer).
  const res = db.prepare(`
    UPDATE tasks
    SET status = 'complete', complete_validated = 0, completed_at = datetime('now'),
        result = ?, evidence_json = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'in_progress' AND repeat_interval IS NULL
  `).run(resultText, evidenceJson, taskId);
  if (res.changes === 0) return false;

  try {
    writeTaskLog({
      taskId,
      fromEntity: 'engine',
      entryKind: 'auto_sweep',
      fromStatus: 'in_progress',
      toStatus: 'complete',
      actionTaken: 'engine closed its own same-turn scaffold',
      reason: 'engine closed its own same-turn scaffold; unvalidated; PM sweep validates',
      note: resultText,
      evidenceJson,
    });
  } catch { /* best effort */ }

  // Same terminal cascade an agent-requested close runs.
  try {
    const { checkDependencies } = await import('./pm-agent.js');
    checkDependencies(taskId);
  } catch { /* best effort */ }
  try {
    checkProjectCompletion(task.project_id, agentId);
  } catch { /* best effort */ }
  claimAssignmentNoticeForTerminalTask(task.assigned_to ?? agentId, taskId);

  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  logger.info('Engine closed its own same-turn scaffold against the delivered reply (unvalidated; PM sweep validates)', {
    agentId, taskId,
  }, agentId);
  return true;
}

/**
 * Owner ruling (2026-07-19): file the assignee's KEY-1 close request from the
 * deliverable receipt itself. When the ASSIGNED worker returns a terminal
 * success reply on the very thread its ASSIGN auto-task was created from, the
 * delivered content IS the close-out in substance; the weakest model routinely
 * delivers the work and then skips the tracker_update_status form. The engine
 * files ONLY Key 1: status='complete' with complete_validated = 0 and the
 * delivered text attached as result/evidence; the PM independently validates
 * (Key 2 untouched) and rejects/reopens garbage. This is NOT the demolished
 * forgery: that GUESSED doneness from prose adjacency and STAMPED
 * complete_validated=1 so nothing ever verified anything. Worst case here is a
 * poor deliverable sitting visibly in the validation queue where the checker
 * catches it. Success intents only (never FAIL), the exact assignee only, the
 * exact thread only, one-shots only.
 */
export async function fileAssignDeliverableCloseRequest(
  senderAgentId: string,
  threadId: string,
  deliveredText: string,
): Promise<boolean> {
  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, assigned_to, project_id FROM tasks
    WHERE a2a_thread_id = ? AND assigned_to = ? AND status = 'in_progress'
      AND repeat_interval IS NULL AND is_paused = 0
    LIMIT 1
  `).get(threadId, senderAgentId) as { id: string; title: string; assigned_to: string | null; project_id: string | null } | undefined;
  if (!task) return false;

  const resultText = deliveredText.replace(/\s+/g, ' ').trim().slice(0, 2000)
    || 'Terminal deliverable returned on the assignment thread.';
  const evidenceJson = JSON.stringify([
    {
      kind: 'a2a_deliverable',
      claim: 'the assignee returned a terminal deliverable on the assignment thread; the engine filed this close request from that receipt; the PM validates it against the goal',
      pointer: `thread ${threadId.slice(0, 8)}`,
    },
  ]);

  // Same sanctioned Key-1 landing as every agent-request close: unvalidated.
  const res = db.prepare(`
    UPDATE tasks
    SET status = 'complete', complete_validated = 0, completed_at = datetime('now'),
        result = ?, evidence_json = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'in_progress' AND repeat_interval IS NULL
  `).run(resultText, evidenceJson, task.id);
  if (res.changes === 0) return false;

  try {
    writeTaskLog({
      taskId: task.id,
      fromEntity: 'engine',
      entryKind: 'transition',
      fromStatus: 'in_progress',
      toStatus: 'complete',
      actionTaken: 'close request filed from assignment-thread deliverable',
      reason: 'assignee returned a terminal deliverable on its ASSIGN thread; Key 1 filed from that receipt with the delivered content as evidence; unvalidated, the PM sweep validates',
      note: resultText,
      evidenceJson,
    });
  } catch { /* best effort */ }

  try {
    const { checkDependencies } = await import('./pm-agent.js');
    checkDependencies(task.id);
  } catch { /* best effort */ }
  try {
    checkProjectCompletion(task.project_id, senderAgentId);
  } catch { /* best effort */ }
  // The assigner is the deliverable's RECIPIENT in the same delivery, so no
  // hand-back relay here (it would duplicate the content they just received);
  // only the pending assignment notice is claimed.
  claimAssignmentNoticeForTerminalTask(senderAgentId, task.id);

  const fresh = getTask(task.id);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
  logger.info('Filed Key-1 close request from assignment-thread deliverable (unvalidated; PM validates)', {
    taskId: task.id, threadId: threadId.slice(0, 8), assignee: senderAgentId,
  }, senderAgentId);
  return true;
}

// D-K (owner decision): a project auto-completes AS SUCCESS only when every
// task is 'complete'. When it runs out of open tasks but at least one task
// FELL, we do NOT close it as a success. We leave it OPEN (status stays
// 'active', so it stays in the working view) and stamp this marker into its
// description so the owner sees it needs attention. The marker doubles as the
// idempotence guard: it lets the failure notice fire exactly once, when the
// project first ENTERS the all-terminal-with-fallen state, mirroring the
// flip-once discipline the success path gets from its status check.
const NEEDS_ATTENTION_MARKER = '[needs-attention]';

// checkProjectCompletion is the SINGLE authority for the success-vs-fail-open
// call. Every completion path funnels through it, callers that want to react
// to the outcome (e.g. the tool result text) read this return value.
// Exported for the paths OUTSIDE this module that can put a task into a
// terminal state (PM stale-task sweeper, scheduler failed-final-run); those
// import it dynamically because this module statically imports pm-agent.
export type ProjectCompletionOutcome =
  | 'completed'        // every task complete: umbrella auto-closed as success
  | 'needs_attention'  // no open tasks left but >=1 fell: left open + labelled
  | 'still_open'       // at least one task is still genuinely open
  | 'noop';            // no project, already handled, or an error

export function checkProjectCompletion(projectId: string | null, callingAgentId: string): ProjectCompletionOutcome {
  if (!projectId) return 'noop';
  try {
    const db = getDb();

    // Any task still genuinely open (not in a terminal state)? If so the
    // project keeps running, there's nothing to decide yet.
    const open = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE project_id = ? AND status NOT IN ('complete', 'fallen')
    `).get(projectId) as { count: number };
    if (open.count > 0) return 'still_open';

    const project = db.prepare('SELECT title, description, status FROM projects WHERE id = ?')
      .get(projectId) as { title: string; description: string | null; status: string } | undefined;
    if (!project) return 'noop';
    if (project.status === 'complete') return 'noop';

    // No open tasks remain. Distinguish a genuine success (EVERY task
    // complete) from a project that ran out of work with at least one task
    // fallen. Only the former auto-closes.
    const fallen = db.prepare(`
      SELECT title FROM tasks
      WHERE project_id = ? AND status = 'fallen'
      ORDER BY step_number ASC, created_at ASC
    `).all(projectId) as Array<{ title: string }>;

    if (fallen.length === 0) {
      // ── Genuine success: auto-close the umbrella (the reason auto-complete
      //    exists). completed_at is stamped here so every path that closes a
      //    project through this helper records the close time consistently.
      db.prepare("UPDATE projects SET status = 'complete', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(projectId);

      // Count the tasks for the brief completion line. comms-audit rank 5: the old
      // code enumerated EVERY task ("- title: status, last-notes-line") into the notice
      //, a firehose duplicating the kanban board. The board already shows the per-task
      // detail; the notice only needs the count.
      const tasks = db.prepare(`
        SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?
      `).get(projectId) as { count: number };

      // v2.7.2, fixes the duplicate-final-answer failure shape:
      //
      //   1. forceNotify dropped from true → the default false. When the
      //      PRIMARY agent itself completes the final task, they don't
      //      need a separate "project complete!" message, they just made
      //      the action that completed it and their own response wraps
      //      up the work. The notification was firing mid-turn, getting
      //      pulled into their next context iteration, and prompting a
      //      duplicate tracker_update_status + redundant "Done" wrap-up.
      //
      //      Sub-agent completing the last task still notifies primary,
      //      because callingAgentId != primaryId and the function's
      //      built-in isPrimaryAgent check lets it through.
      //
      //   2. Text rewritten to be a pure status record, not an
      //      instruction. The old text said "Please review the results
      //      and let the owner know" which the model interpreted as a fresh
      //      assignment and kept working. The new text contains no
      //      verbs aimed at the reader, it's just the completion fact.
      const completionLine = `[tracker:project_complete] "${project.title}", ${tasks.count} task${tasks.count === 1 ? '' : 's'} closed.`;
      notifyPrimaryAgent(completionLine, callingAgentId);

      logger.info('Project completed', { projectId, title: project.title, taskCount: tasks.count });

      // Re-select the FULL project row so the board doesn't blank other fields
      // (a 3-field partial under `data:` would wipe the rest of the card on a
      // still-active project; harmless here since it leaves the active list, but
      // we match the canonical full-row idiom to keep the wire contract honest).
      const completedProject = getProject(projectId);
      if (completedProject) {
        broadcast({ type: 'tracker:project_updated', data: completedProject });
      }
      return 'completed';
    }

    // ── D-K fail-open: no open tasks left but >=1 fell. Leave the project
    //    OPEN and labelled instead of announcing success. Idempotence: the
    //    description marker is the "already fired" guard, so the failure
    //    notice is sent once, when the project first ENTERS this state.
    if ((project.description ?? '').includes(NEEDS_ATTENTION_MARKER)) return 'noop';

    const fallenTitles = fallen.map(t => `"${t.title}"`).join(', ');
    const markerLine = `${NEEDS_ATTENTION_MARKER} ${fallen.length} task${fallen.length === 1 ? '' : 's'} fell (${fallenTitles}); project left open for attention.`;
    const newDescription = project.description ? `${project.description}\n\n${markerLine}` : markerLine;
    // updateProject persists the label AND broadcasts the full project row so
    // the dashboard repaints. Status stays 'active', so the project stays in
    // the working view (the owner's "still open" signal) instead of dropping
    // into completed history. The primary notice names WHICH tasks fell in
    // plain language, as a pure status record (no verbs aimed at the reader,
    // same v2.7.2 discipline as the success line above).
    updateProject(projectId, { description: newDescription });

    // The "[tracker:project_needs_attention]" prefix is load-bearing: it makes
    // this fail-open notice render in the owner's DEFAULT (non-wordy) chat, not
    // just wordy mode (dashboard OWNER_ALERT_SYSTEM_PREFIXES; the dashboard
    // strips this tag + notifyPrimaryAgent's [SOURCE: ...] envelope for display).
    // Keep the prefix if you reword the message.
    const failureLine = `[tracker:project_needs_attention] "${project.title}" is NOT complete: ${fallen.length} task${fallen.length === 1 ? '' : 's'} fell (${fallenTitles}). The project is left open and flagged for attention.`;
    notifyPrimaryAgent(failureLine, callingAgentId);

    logger.info('Project left open with fallen tasks', { projectId, title: project.title, fallenCount: fallen.length });
    return 'needs_attention';
  } catch (err) {
    logger.error('checkProjectCompletion failed', { projectId, error: err instanceof Error ? err.message : String(err) });
    return 'noop';
  }
}

// ── trackerCreateProject ──

// Stop-words used by the near-duplicate detector. Common low-information
// words that should not drive a duplicate match by themselves.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with',
  'by', 'from', 'is', 'as', 'at', 'be', 'this', 'that', 'these', 'those',
  'project', 'task', 'work', 'plan', 'review', 'new',
]);

function normalizeTitle(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// Mirror of ENGINE_AUTO_MARKER in classifiers/multistep.ts. Duplicated
// here rather than imported to avoid a cross-package import path through
// the v2 classifier dir for a one-string constant.
const ENGINE_AUTO_MARKER = '[engine:multistep] ';

interface DuplicateMatch {
  id: string;
  title: string;
  createdMinutesAgo: number;
  /** True when the existing project was opened by the engine's multistep
   * classifier on the agent's most recent user turn (not by the agent
   * calling tracker_create_project themselves). */
  engineAutoCreated: boolean;
  /** First in_progress / on_deck task on the existing project, if any, 
   * the natural target for tracker_edit_task. */
  firstOpenTask: { id: string; title: string } | null;
}

/**
 * Near-duplicate guard with two prongs:
 *
 *   (a) Engine-auto-created override: if the creator has ANY active
 *       project with the ENGINE_AUTO_MARKER in its description created
 *       in the last 5 minutes, treat that as a duplicate of whatever
 *       the agent is now trying to create, regardless of title
 *       similarity. The engine just opened a project for this turn;
 *       the agent should edit it, not parallel it. (Without this, the
 *       agent's better name often diverges enough from the engine's
 *       slice-of-prompt name to clear the Jaccard threshold.)
 *
 *   (b) Token-Jaccard fallback for agent-vs-agent dups: ≥ 0.6 overlap,
 *       ≥ 2 shared content tokens, last 60 minutes. Catches the
 *       post-compaction "I forgot I made this project" failure shape.
 */
function findRecentNearDuplicateProject(
  creatorId: string,
  title: string,
): DuplicateMatch | null {
  const db = getDb();

  // (a) P3 rekey onto the P1 spine: an engine scaffold born from the SAME ask
  //     as the creating agent's current turn is THE duplicate, by identity
  //     (source_message_id equality), no clock guessing. The marker+5-minute
  //     window survives only as the pre-spine fallback for rootless rows.
  const turnRoot = currentTurnRoot.get(creatorId) ?? null;
  const rootMatch = turnRoot?.sourceMessageId ? db.prepare(`
    SELECT id, title, created_at FROM projects
    WHERE created_by = ?
      AND status = 'active'
      AND origin_kind = 'engine_scaffold'
      AND source_message_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(creatorId, turnRoot.sourceMessageId) as { id: string; title: string; created_at: string } | undefined : undefined;
  const engineAuto = rootMatch ?? db.prepare(`
    SELECT id, title, created_at FROM projects
    WHERE created_by = ?
      AND status = 'active'
      AND description LIKE ? || '%'
      AND datetime(created_at) >= datetime('now', '-5 minutes')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(creatorId, ENGINE_AUTO_MARKER) as { id: string; title: string; created_at: string } | undefined;

  if (engineAuto) {
    const createdMs = new Date(engineAuto.created_at.includes('Z') ? engineAuto.created_at : engineAuto.created_at + 'Z').getTime();
    const firstOpen = db.prepare(`
      SELECT id, title FROM tasks
      WHERE project_id = ? AND status IN ('in_progress', 'on_deck')
      ORDER BY step_number ASC NULLS LAST, created_at ASC
      LIMIT 1
    `).get(engineAuto.id) as { id: string; title: string } | undefined;
    return {
      id: engineAuto.id,
      title: engineAuto.title,
      createdMinutesAgo: Math.max(1, Math.round((Date.now() - createdMs) / 60000)),
      engineAutoCreated: true,
      firstOpenTask: firstOpen ?? null,
    };
  }

  // (b) Jaccard fallback for agent-created near-dups.
  const recent = db.prepare(`
    SELECT id, title, created_at FROM projects
    WHERE created_by = ?
      AND status = 'active'
      AND datetime(created_at) >= datetime('now', '-60 minutes')
    ORDER BY created_at DESC
    LIMIT 20
  `).all(creatorId) as Array<{ id: string; title: string; created_at: string }>;

  if (recent.length === 0) return null;

  const newTokens = normalizeTitle(title);
  if (newTokens.length === 0) return null;
  const newSet = new Set(newTokens);

  for (const row of recent) {
    const oldTokens = normalizeTitle(row.title);
    if (oldTokens.length === 0) continue;
    const oldSet = new Set(oldTokens);

    const intersection = new Set([...newSet].filter(w => oldSet.has(w)));
    if (intersection.size < 2) continue;

    const union = new Set([...newSet, ...oldSet]);
    const jaccard = intersection.size / union.size;
    if (jaccard >= 0.6) {
      const createdMs = new Date(row.created_at.includes('Z') ? row.created_at : row.created_at + 'Z').getTime();
      const firstOpen = db.prepare(`
        SELECT id, title FROM tasks
        WHERE project_id = ? AND status IN ('in_progress', 'on_deck')
        ORDER BY step_number ASC NULLS LAST, created_at ASC
        LIMIT 1
      `).get(row.id) as { id: string; title: string } | undefined;
      return {
        id: row.id,
        title: row.title,
        createdMinutesAgo: Math.max(1, Math.round((Date.now() - createdMs) / 60000)),
        engineAutoCreated: false,
        firstOpenTask: firstOpen ?? null,
      };
    }
  }
  return null;
}

export function trackerCreateProject(agentId: string, args: Record<string, unknown>): string {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const description = args.description as string | undefined;
    const level = typeof args.level === 'number' ? args.level : 1;

    const tasksInput = args.tasks as Array<{
      title: string;
      description?: string;
      goal?: string;
      assignedTo?: string;
      priority?: 'high' | 'normal' | 'low';
      stepNumber?: number;
      dependsOn?: string[];
      phase?: number;
    }> | undefined;

    // Hard engine gate (2026-06-03 bug fix): a project MUST be opened
    // with at least one task. Agents were creating projects without any
    // task, leaving the project sitting open with nothing to do, PM
    // pokes piling up, and no recovery path. The fix is at the engine,
    // not in the prompt: refuse the create if `tasks` is missing or
    // empty. The agent can always add more tasks later with
    // tracker_create_task once the work shape clarifies.
    if (!tasksInput || tasksInput.length === 0 || !tasksInput.some((t) => typeof t.title === 'string' && t.title.trim().length > 0)) {
      return (
        `Error: tracker_create_project requires at least one task. ` +
        `Open it like this:\n` +
        `  tracker_create_project(\n` +
        `    title: "...",\n` +
        `    level: 1,\n` +
        `    tasks: [{ title: "<the first concrete thing you'll do>", assigned_to: "${agentId}" }]\n` +
        `  )\n\n` +
        `If you don't know every step upfront, that's fine, just put down the FIRST one (e.g. "scope the deliverable", ` +
        `"draft the outline", "pull source data"). Add more tasks incrementally with tracker_create_task as the shape clarifies. ` +
        `A project with zero tasks is a stuck project, PM has no row to poke, you have nothing to mark complete, ` +
        `and the tracker can't tell whether the work is done.`
      );
    }

    // Resolve inline task assignees (name / short id -> full agent id) BEFORE
    // anything is written. tasks.assigned_to carries a FOREIGN KEY to agents(id);
    // the standalone tracker_create_task verb resolves refs (below, ~:790) but
    // this inline path passed them through raw, so an agent NAME failed the FK
    // mid-create and stranded an empty project row (2026-07-17 run bmrpkqai2v6:
    // two orphan projects, raw "FOREIGN KEY constraint failed" to the model).
    // Same resolver, same teaching error, and nothing is written on a bad ref.
    for (const t of tasksInput) {
      const raw = t as Record<string, unknown>;
      const ref = (typeof raw.assignedTo === 'string' && raw.assignedTo) ||
                  (typeof raw.assigned_to === 'string' && raw.assigned_to) || '';
      if (ref.trim().length > 0) {
        const r = resolveAgentName(ref);
        if (!r.ok) return r.error;
        t.assignedTo = r.id;
      }
    }

    // Duplicate guard. Catches the most common failure shape: agent gets
    // compacted mid-task, loses the project it already opened, and creates
    // a near-identical one. Agents can override by setting allow_duplicate=true
    // (rare, usually only valid for genuinely independent re-runs).
    const allowDuplicate = args.allow_duplicate === true;
    if (!allowDuplicate) {
      const dup = findRecentNearDuplicateProject(agentId, title);
      if (dup) {
        const shortPid = dup.id.slice(0, 8);
        const firstTaskHint = dup.firstOpenTask
          ? ` First open task: "${dup.firstOpenTask.title}" (id=${dup.firstOpenTask.id.slice(0, 8)}).`
          : '';
        if (dup.engineAutoCreated) {
          // NEXT-WAVE item 4 (absorb, don't refuse): the engine auto-opened this
          // project for the CURRENT user turn (the multi-step classifier does this
          // so the agent doesn't have to remember to call tracker_create_project),
          // so the agent's own create is a duplicate of it. The old "Refused:" wall
          // burned turns on rediscovery AND reads to the battery as an engine-
          // refusal signature. Absorb it instead: an OK-shaped no-op that names the
          // existing project + its first task, so the agent just continues in it
          // without a scold.
          return (
            `[OK] Already tracked, no new project created. The engine auto-opened project "${dup.title}" (id=${shortPid}) for this request, so you don't need to create one, keep going in it.${firstTaskHint} ` +
            `Continue inside it: tracker_edit_task(task_id=<id>, title=..., description=...) to refine the first task, ` +
            `tracker_create_task(project_id="${shortPid}", title=..., step_number=..., assigned_to=...) to add more steps, ` +
            `and tracker_update_status / tracker_complete_step as you finish each. ` +
            `(If you genuinely need a separate, unrelated project, retry with allow_duplicate=true.)`
          );
        }
        return (
          `Refused: project "${dup.title}" (id=${shortPid}) was already created by you ${dup.createdMinutesAgo} minute(s) ago and is still active, the new title "${title}" looks like a near-duplicate.${firstTaskHint} ` +
          `Use the existing project: tracker_get_status(id="${shortPid}") to see current tasks, tracker_edit_task to rename/rescope a task, tracker_create_task(project_id="${shortPid}", ...) to add new steps, or tracker_close_project(project_id="${shortPid}", status="cancelled", reason="...") if it was a mistake. ` +
          `If this really is unrelated work that happens to share keywords, retry with allow_duplicate=true.`
        );
      }
    }

    const result = createProject({
      origin: getWorkOriginForAgent(agentId, 'model'),
      title,
      description,
      level,
      createdBy: agentId,
      tasks: tasksInput,
    });

    // Give every inline task a goal. The tasks[] shape historically carried no
    // goal field, so createProject left them goal=NULL, which makes them
    // impossible for PM to validate ("(none recorded)"): PM reverts each
    // completion and the agent re-submits forever (the validation ping-pong the
    // user reported). Mirror tracker_create_task: default the goal from the
    // caller-provided goal (if any), else the task's description, else its
    // title. Only fill when empty, never overwrite a real goal.
    for (let i = 0; i < result.taskIds.length; i++) {
      const id = result.taskIds[i];
      const t = getTask(id);
      if (!t) continue;
      const provided = typeof tasksInput?.[i]?.goal === 'string' ? (tasksInput[i].goal as string).trim() : '';
      const goal = provided || (t.description ? t.description.trim() : '') || (t.title ? t.title.trim() : '');
      if (!goal) continue;
      try {
        getDb().prepare(`UPDATE tasks SET goal = ? WHERE id = ? AND (goal IS NULL OR goal = '')`).run(goal, id);
      } catch (err) {
        logger.warn('Failed to default goal on inline project task (non-fatal)', { taskId: id, error: err instanceof Error ? err.message : String(err) }, agentId);
      }
    }

    // Auto-spawn PM agent if not running
    try {
      ensurePMAgentRunning();
    } catch (err) {
      logger.warn('Failed to ensure PM agent is running', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    let taskSummary = '';
    if (result.taskIds.length > 0) {
      const taskLines = result.taskIds.map((id, i) => {
        const t = getTask(id);
        const step = t?.stepNumber !== null ? ` (step ${t?.stepNumber})` : '';
        const status = t?.status ?? 'on_deck';
        return `  ${i + 1}. "${t?.title ?? 'Unknown'}", ID: ${id}${step} [${status}]`;
      });
      taskSummary = `\nTasks (${result.taskIds.length}):\n${taskLines.join('\n')}`;
    }

    // Notify assignees of nested tasks (skips the creator's own tasks).
    // Mirrors trackerCreateTask's notification path so tasks created via
    // create_project don't silently sit waiting for someone to notice.
    for (const taskId of result.taskIds) {
      const t = getTask(taskId);
      if (!t || !t.assignedTo) continue;
      // Skip tasks with a future scheduled_start, scheduler handles those
      if (t.scheduledStart) {
        const scheduledMs = new Date(t.scheduledStart.includes('Z') ? t.scheduledStart : t.scheduledStart + 'Z').getTime();
        if (scheduledMs > Date.now()) continue;
      }
      injectTaskAssignmentNotification({
        assignedAgentId: t.assignedTo,
        creatorAgentId: agentId,
        taskId,
        title: t.title,
        description: t.description ?? null,
        projectId: result.projectId,
        priority: t.priority ?? null,
      });
    }

    return `[OK] project_id=${result.projectId} | title=${title}\n\nProject created successfully.${taskSummary}\n\nUse tracker_complete_step(task_id="<full task ID>") to mark steps complete.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateProject failed', { error: msg }, agentId);
    return `Error creating project: ${msg}`;
  }
}

// ── trackerCreateTask ──

export function trackerCreateTask(agentId: string, args: Record<string, unknown>): string {
  try {
    const title = args.title as string;
    if (!title) return 'Error: title is required';

    const projectId = args.projectId as string | undefined;
    const description = args.description as string | undefined;
    // Phase B.1: goal is required on every new task (Q6). PM is the supreme
    // authority on whether the work matches; without a goal there is nothing
    // to compare result+evidence against. The engine accepts `goal` (camelCase)
    // or `goal_description` (legacy alias). Empty string is rejected.
    let goal = typeof args.goal === 'string' ? args.goal.trim() : '';
    if (!goal && typeof description === 'string' && description.trim()) {
      // Permissive fallback for now: copy description into goal when caller
      // forgot. Logged so we can see who needs prompt updates. Once every
      // caller is migrated this fallback can be removed and we hard-reject.
      goal = description.trim();
      logger.info('tracker_create_task: goal omitted, defaulted from description', { agentId, title }, agentId);
    }
    if (!goal) {
      return 'Error: `goal` is required. One-sentence definition of done that PM will compare result + evidence against. Example: goal="migrate all 12 routes under packages/server/src/gateway/routes/ to the new auth middleware, with each route\'s tests passing".';
    }
    // Default assigned_to to the calling agent if not specified
    // Resolve agent name to ID if a name was passed instead of a UUID
    let assignedTo = (args.assignedTo as string | undefined) ?? agentId;
    if (assignedTo) {
      const r = resolveAgentName(assignedTo);
      if (!r.ok) return r.error;
      assignedTo = r.id;
    }
    if (projectId) {
      const projectRow = getDb().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
      if (!projectRow) {
        return `Error: project '${projectId}' does not exist (it may have been deleted or completed). Call tracker_list_projects to see current projects, or omit projectId to start a fresh one.`;
      }
    }
    const priority = args.priority as 'high' | 'normal' | 'low' | undefined;
    const stepNumber = args.stepNumber as number | undefined;
    const dependsOn = args.dependsOn as string[] | undefined;
    const phase = args.phase as number | undefined;

    // RC-18: local wall-clock schedule input. When the caller passes local_time
    // (a tz-less wall clock) instead of doing the UTC math itself, convert it
    // engine-side into scheduled_start. Explicit scheduled_start wins if both are
    // given. Anchor defaults to scheduled_start downstream, so we only set the
    // start here.
    if (args.local_time !== undefined && args.local_time !== null && args.local_time !== '' && !args.scheduled_start) {
      if (typeof args.local_time !== 'string') {
        return 'Error: local_time must be a string wall-clock time, e.g. "2026-07-16T21:00".';
      }
      const tz = (args.local_timezone ?? args.tz) as string | undefined;
      const resolved = resolveLocalWallClock(args.local_time, typeof tz === 'string' ? tz : undefined);
      if (!resolved.ok) return resolved.error;
      args.scheduled_start = resolved.iso;
    }

    // 2026-07-03: schedule timestamps must be parseable, checked BEFORE the
    // row is created. An unparseable scheduled_start used to be kept verbatim
    // ("keep original if parse fails") and written into scheduled_start AND
    // next_run_at; the scheduler's `next_run_at <= <now ISO>` string
    // comparison then never matches, so the task sits schedule_status=
    // 'waiting' forever and SILENTLY never fires (observed live via the
    // behavioral harness: reminder_create when="in 2 minutes" produced a
    // reminder that never fired). The engine rejects it at the boundary with
    // a corrective hint; resolving relative phrases is the model's job
    // (get_current_time + offset), per the tool docs it already has.
    for (const field of ['scheduled_start', 'anchor_time']) {
      const value = args[field];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string' || isNaN(new Date(value).getTime())) {
        return (
          `Error: ${field}="${String(value)}" is not a parseable datetime, so the scheduler could never ` +
          `fire this task (it would wait forever). Resolve relative times yourself: call get_current_time, ` +
          `add the offset (e.g. "in 2 minutes" = current UTC + 2 minutes), and re-call with an ISO 8601 ` +
          `UTC timestamp, e.g. ${field}="2026-07-03T16:38:00Z".`
        );
      }
    }

    // FA-S4: a specific_days schedule needs at least one weekday. An empty or
    // invalid repeat_days_of_week allowlist silently degrades the recurrence
    // into a single fire then complete (calculateNextRun's specific_days walk
    // makes no progress with no allowed day, so next_run_at resolves once and
    // then never again). Reject at the boundary, before the row is created,
    // same fail-loud contract the parseability check above enforces. Only
    // matters when a schedule is actually being written (scheduled_start set).
    if (args.scheduled_start && args.repeat_unit === 'specific_days'
        && !parseDaysOfWeek((args.repeat_days_of_week as string | undefined) ?? null)) {
      return (
        'Error: repeat_unit="specific_days" needs at least one weekday in repeat_days_of_week ' +
        '(comma-separated 0=Sun..6=Sat, e.g. "1,3" for Mon+Wed). With no valid days the task would ' +
        'fire once and then never repeat. Either pass repeat_days_of_week with the days you want, or ' +
        'use repeat_unit="weeks" with repeat_interval=1 for a plain weekly cadence.'
      );
    }

    // Near-duplicate guard (2026-06-02 bug fix). Without this, a hoarding-
    // gate error on file_read/exec can put the agent into a loop where
    // every iteration calls tracker_create_task with the same title, 27
    // duplicates landed in one session before this guard. Two prongs,
    // both within a 5-minute window because tasks turn over faster than
    // projects:
    //   (a) Exact-title-match by the same creator + same assignee.
    //   (b) Jaccard ≥ 0.6 on normalised content tokens, ≥ 2 shared tokens.
    // Agent can override with allow_duplicate=true when the dup match is
    // a false positive (e.g. genuinely separate work that shares keywords).
    const allowDuplicate = (args.allow_duplicate as boolean) ?? false;
    if (!allowDuplicate) {
      const db = getDb();
      const exact = db.prepare(`
        SELECT id, substr(id, 1, 8) as id8 FROM tasks
        WHERE created_by = ?
          AND LOWER(title) = LOWER(?)
          AND COALESCE(assigned_to, '') = COALESCE(?, '')
          AND status IN ('on_deck', 'in_progress', 'paused', 'blocked')
          AND datetime(created_at) >= datetime('now', '-5 minutes')
        ORDER BY created_at DESC
        LIMIT 1
      `).get(agentId, title, assignedTo ?? null) as { id: string; id8: string } | undefined;
      if (exact) {
        return (
          `Error: a task with this exact title was created by you in the last 5 minutes (id=${exact.id8}, assigned to the same agent). ` +
          `If you meant to update that task, call tracker_update_status / tracker_edit_task on id=${exact.id8}. ` +
          `If this is genuinely separate work that happens to share a title, re-call with allow_duplicate=true.`
        );
      }

      const newTokens = normalizeTitle(title);
      if (newTokens.length >= 2) {
        const newSet = new Set(newTokens);
        const recent = db.prepare(`
          SELECT id, title, substr(id, 1, 8) as id8 FROM tasks
          WHERE created_by = ?
            AND status IN ('on_deck', 'in_progress', 'paused', 'blocked')
            AND datetime(created_at) >= datetime('now', '-5 minutes')
          ORDER BY created_at DESC
          LIMIT 20
        `).all(agentId) as Array<{ id: string; title: string; id8: string }>;
        for (const row of recent) {
          const oldTokens = normalizeTitle(row.title);
          if (oldTokens.length < 2) continue;
          const oldSet = new Set(oldTokens);
          const intersection = new Set([...newSet].filter(w => oldSet.has(w)));
          if (intersection.size < 2) continue;
          const union = new Set([...newSet, ...oldSet]);
          const jaccard = intersection.size / union.size;
          if (jaccard >= 0.6) {
            return (
              `Error: a near-duplicate task "${row.title}" (id=${row.id8}) was created by you in the last 5 minutes (token-overlap ${(jaccard * 100).toFixed(0)}%). ` +
              `If you meant to update that task, call tracker_update_status / tracker_edit_task on id=${row.id8}. ` +
              `If this is genuinely separate work, re-call with allow_duplicate=true.`
            );
          }
        }
      }
    }

    const taskId = createTask({
      origin: getWorkOriginForAgent(agentId, (args.kind as string | undefined) === 'reminder' ? 'reminder' : 'model'),
      projectId,
      title,
      description,
      assignedTo,
      createdBy: agentId,
      priority,
      stepNumber,
      dependsOn,
      phase,
      kind: args.kind as string | undefined,
    });

    // Persist the goal onto the new row. (createTask itself only writes the
    // legacy columns; adding goal as an extra parameter would force every
    // call site to update. Cleaner to set it here.)
    try {
      getDb().prepare(`UPDATE tasks SET goal = ? WHERE id = ?`).run(goal, taskId);
    } catch (err) {
      logger.warn('Failed to persist goal on new task (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }

    // Status reconciliation. v2.8.x rule: 'on_deck' is reserved for
    // tasks with a FUTURE scheduled_start (the scheduler owns the
    // transition to 'in_progress' at fire time). Anything else lands
    // in 'in_progress' immediately so the assigned agent and the PM
    // keep seeing it as work to do, sitting in 'on_deck' without a
    // schedule was the failure mode where agents created multi-task
    // projects, worked the first one, and never returned to the rest.
    // The schema default (set in createTask above) is now 'in_progress'
    // for all rows; we only override to 'on_deck' here when a future
    // schedule justifies it.
    let scheduledStart = args.scheduled_start as string | undefined;
    if (scheduledStart) {
      // Parseability was validated before the row was created (above); this
      // just normalizes to ISO so every downstream comparison is consistent.
      const parsed = new Date(scheduledStart);
      if (!isNaN(parsed.getTime())) scheduledStart = parsed.toISOString();
    }
    // hasFutureSchedule is true only when scheduled_start is in the
    // future (past-dated scheduled_start counts as "fire ASAP" and lands
    // in_progress immediately), OR when repeat_interval is set (recurring
    // tasks always go through the scheduler).
    const scheduledStartIsFuture = !!(
      scheduledStart && new Date(scheduledStart).getTime() > Date.now()
    );
    const hasFutureSchedule = scheduledStartIsFuture || !!args.repeat_interval;
    if (hasFutureSchedule) {
      try {
        updateTask(taskId, { status: 'on_deck' });
      } catch { /* ignore */ }
    }

    // Auto-spawn PM agent if not running
    try {
      ensurePMAgentRunning();
    } catch (err) {
      logger.warn('Failed to ensure PM agent is running', {
        error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }

    // Handle scheduling
    if (scheduledStart) {
      const db = getDb();
      const repeatInterval = args.repeat_interval as number | undefined;
      const repeatUnit = args.repeat_unit as string | undefined;
      const repeatEndType = (args.repeat_end_type as string | undefined) ?? 'never';
      const repeatEndValue = args.repeat_end_value as string | undefined;
      // v2.5.2, specific_days uses an explicit day-of-week allowlist.
      // Already normalized to CSV-of-ints by the tool dispatcher.
      const repeatDaysOfWeek = args.repeat_days_of_week as string | undefined;
      // v2.5.45, anchor_time defaults to scheduled_start, normalizing
      // wall-clock alignment for all future recurring runs. Caller can
      // override (e.g. agent setting "anchor at 06:00 even though I'm
      // creating this at 14:23").
      let anchorTime = args.anchor_time as string | undefined;
      if (anchorTime) {
        // Validated parseable at the top of this function; normalize to ISO.
        const parsed = new Date(anchorTime);
        if (!isNaN(parsed.getTime())) anchorTime = parsed.toISOString();
      } else if (repeatInterval) {
        anchorTime = scheduledStart;
      }

      const taskForCalc = {
        id: taskId,
        scheduled_start: scheduledStart,
        repeat_interval: repeatInterval ?? null,
        repeat_unit: repeatUnit ?? null,
        repeat_end_type: repeatEndType,
        repeat_end_value: repeatEndValue ?? null,
        run_count: 0,
        is_paused: 0,
        last_run_at: null,
        next_run_at: null,
        schedule_status: 'waiting',
        repeat_days_of_week: repeatDaysOfWeek ?? null,
        anchor_time: anchorTime ?? null,
      };
      const nextRun = calculateNextRun(taskForCalc) ?? scheduledStart;

      db.prepare(`
        UPDATE tasks SET
          scheduled_start = ?, repeat_interval = ?, repeat_unit = ?,
          repeat_end_type = ?, repeat_end_value = ?,
          repeat_days_of_week = ?, anchor_time = ?,
          next_run_at = ?, schedule_status = 'waiting',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(scheduledStart, repeatInterval ?? null, repeatUnit ?? null, repeatEndType, repeatEndValue ?? null, repeatDaysOfWeek ?? null, anchorTime ?? null, nextRun, taskId);
    }

    // Handle group assignment (validated: an unknown group id would otherwise
    // surface as a raw FK error the model cannot act on)
    const assignedToGroup = args.assigned_to_group as string | undefined;
    if (assignedToGroup) {
      const db = getDb();
      const groupRow = db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(assignedToGroup);
      if (!groupRow) {
        return `Error: agent group '${assignedToGroup}' does not exist. The task was created assigned to you; use tracker_edit_task to reassign once you have a valid group id.`;
      }
      db.prepare("UPDATE tasks SET assigned_to_group = ?, assigned_to = NULL, updated_at = datetime('now') WHERE id = ?").run(assignedToGroup, taskId);
    }

    const parts = [
      `[OK] task_id=${taskId} | title=${title}`,
      ``,
      `Task created successfully.`,
    ];
    if (projectId) parts.push(`Project: ${projectId}`);
    if (assignedTo) parts.push(`Assigned to: ${assignedTo}`);
    if (assignedToGroup) parts.push(`Assigned to group: ${assignedToGroup}`);
    if (priority) parts.push(`Priority: ${priority}`);
    if (scheduledStart) {
      // RC-18: echo the wall-clock (with tz + canonical UTC) instead of a raw ISO,
      // and show the computed next run, so the anchor the user cares about is
      // visible and any timezone mistake is caught before it fires.
      const createdTask = getTask(taskId);
      for (const line of scheduleEchoLines(scheduledStart, createdTask?.nextRunAt ?? null)) {
        parts.push(line);
      }
    }

    // Notify assigned agent about the new task (unless they created it themselves,
    // or it's a scheduled task, the scheduler handles those).
    if (assignedTo && !hasFutureSchedule) {
      injectTaskAssignmentNotification({
        assignedAgentId: assignedTo,
        creatorAgentId: agentId,
        taskId,
        title,
        description: description ?? null,
        projectId: projectId ?? null,
        priority: priority ?? null,
      });
    }

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCreateTask failed', { error: msg }, agentId);
    return `Error creating task: ${msg}`;
  }
}

// ── reminderCreate ──
//
// Thin wrapper around trackerCreateTask that handles the "user asked for
// a reminder" intent. The agent calls this with `what` (required) and
// `when` (optional). If `when` is missing, returns an ASK_USER
// instruction so the agent loops back, asks the user, and re-fires with
// the resolved ISO time. Otherwise creates a tracker task with
// kind='reminder' and the supplied schedule, the scheduler then fires
// it with the reminder-flavored template (see scheduler/runner.ts).

export function reminderCreate(agentId: string, args: Record<string, unknown>): string {
  const what = (args.what as string | undefined)?.trim();
  if (!what) return 'Error: `what` is required (the reminder text).';

  const when = (args.when as string | undefined)?.trim();
  // RC-18: a local wall-clock (local_time) is an accepted alternative to `when`;
  // the engine converts it to the anchor instant, so the model never does UTC math.
  const localTime = (args.local_time as string | undefined)?.trim();
  if (!when && !localTime) {
    return (
      'ASK_USER: This reminder needs a time. Ask the user when they would like to be ' +
      'reminded ("in 5 minutes", "tomorrow at 8am", "every Monday at 9am"). ' +
      'Once they answer, either call get_current_time to anchor relative times and re-call ' +
      'reminder_create with `when` set to the resolved ISO 8601 datetime, OR pass ' +
      'local_time="YYYY-MM-DDThh:mm" (24-hour wall clock) and let the engine do the timezone ' +
      'conversion. Do NOT create the reminder yet.'
    );
  }

  // 2026-07-03: same boundary validation trackerCreateTask enforces, but with
  // a `when`-flavored message (that is the arg the caller actually used). An
  // unparseable `when` used to flow into next_run_at verbatim and the reminder
  // silently never fired (behavioral harness caught when="in 2 minutes").
  if (when && isNaN(new Date(when).getTime())) {
    return (
      `Error: when="${when}" is not a parseable datetime, so this reminder would never fire. ` +
      `Resolve the relative time yourself: call get_current_time, add the offset ` +
      `(e.g. "in 2 minutes" = current UTC + 2 minutes), then re-call reminder_create with an ` +
      `ISO 8601 UTC timestamp, e.g. when="2026-07-03T16:38:00Z". Or pass local_time="YYYY-MM-DDThh:mm".`
    );
  }

  // Title is for the kanban, keep short and recognizable.
  const titleSnippet = what.length > 60 ? what.slice(0, 57).trimEnd() + '…' : what;

  return trackerCreateTask(agentId, {
    title: `Reminder: ${titleSnippet}`,
    description: what,
    kind: 'reminder',
    scheduled_start: when,
    // RC-18: forward the wall-clock inputs; trackerCreateTask converts local_time
    // to scheduled_start engine-side when scheduled_start (`when`) is absent.
    local_time: localTime,
    local_timezone: args.local_timezone,
    tz: args.tz,
    // Caller may pass repeat params through for recurring reminders
    // ("every Monday at 9am"). Same shape as tracker_create_task.
    repeat_interval: args.repeat_interval,
    repeat_unit: args.repeat_unit,
    repeat_end_type: args.repeat_end_type,
    repeat_end_value: args.repeat_end_value,
    repeat_days_of_week: args.repeat_days_of_week,
    anchor_time: args.anchor_time,
  });
}

// ── trackerUpdateStatus ──

// C26: the published evidence-kind allowlist. Before this, the complete gate
// checked only that each entry HAD a kind + claim, so any invented kind
// ("vibes") passed. `verified_receipt` is reserved to the engine and rejected
// when an agent supplies it (the engine appends its own after the gate passes).
const VALID_EVIDENCE_KINDS = new Set([
  'claim', 'file_modified', 'file_read', 'tool_call_ref', 'output_paste', 'external_action', 'quote',
]);

/** A tier-2 receipt counts as gate-passing when Graph accepted it (async index). */
function receiptDetailAccepted(row: ToolReceiptRow): boolean {
  if (!row.detail) return false;
  try {
    const d = JSON.parse(row.detail) as { accepted?: unknown };
    return d.accepted === true;
  } catch {
    return false;
  }
}

export function trackerUpdateStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    // Normalize the status at the tool boundary. Previously an unrecognized
    // value (a weak model saying "done"/"in progress"/"todo") was written to
    // the DB verbatim: only the exact string 'complete' sets completed_at and
    // fires project-completion, so a task marked "done" looked like success yet
    // was never actually completed and showed in no kanban column. Map the
    // clear synonyms to the canonical six and REJECT anything else with
    // guidance, so a mislabel is corrected or refused, never silently stored.
    // The failure words map per owner decision 2026-07-04: "stuck" -> blocked
    // (needs the owner), "failed"/"cancelled" -> fallen (give up, archive).
    const rawStatus = args.status as string | undefined;
    let status: string | undefined = rawStatus;
    if (rawStatus !== undefined) {
      const CANONICAL_STATUSES = ['on_deck', 'in_progress', 'paused', 'complete', 'blocked', 'fallen'];
      const STATUS_SYNONYMS: Record<string, string> = {
        done: 'complete', finished: 'complete', completed: 'complete', complete: 'complete',
        in_progress: 'in_progress', inprogress: 'in_progress', working: 'in_progress',
        active: 'in_progress', doing: 'in_progress', started: 'in_progress', wip: 'in_progress',
        on_deck: 'on_deck', ondeck: 'on_deck', todo: 'on_deck', to_do: 'on_deck',
        queued: 'on_deck', backlog: 'on_deck', pending: 'on_deck',
        paused: 'paused', pause: 'paused', on_hold: 'paused', hold: 'paused', waiting: 'paused', parked: 'paused',
        blocked: 'blocked', block: 'blocked', stuck: 'blocked', stalled: 'blocked',
        fallen: 'fallen', failed: 'fallen', fail: 'fallen', cancelled: 'fallen',
        canceled: 'fallen', abandoned: 'fallen', dropped: 'fallen', wontfix: 'fallen',
      };
      const key = rawStatus.trim().toLowerCase().replace(/[\s-]+/g, '_');
      const mapped = CANONICAL_STATUSES.includes(key) ? key : STATUS_SYNONYMS[key];
      if (!mapped) {
        return (
          `Error: "${rawStatus}" is not a recognized task status. Use one of: on_deck, in_progress, paused, complete, blocked, fallen. ` +
          `Common words map automatically ("done"/"finished" to complete, "in progress" to in_progress, "todo" to on_deck, "on hold"/"waiting" to paused). ` +
          `For a task that failed or is stuck, choose "fallen" (give up, archive) or "blocked" (needs the owner) explicitly.`
        );
      }
      status = mapped;
    }
    let assignedTo = args.assignedTo as string | undefined;
    if (assignedTo) {
      const r = resolveAgentName(assignedTo);
      if (!r.ok) return r.error;
      assignedTo = r.id;
    }
    const priority = args.priority as string | undefined;

    if (!status && !assignedTo && !priority) {
      return 'Error: at least one of status, assignedTo, or priority must be provided';
    }

    // Check if this is a scheduled recurring task. Also snapshot the prior
    // status so we can emit a task_log transition entry below with the
    // accurate from→to pair (we cannot read it AFTER updateTask, the row
    // already moved by then).
    const db = getDb();
    const taskRow = db.prepare('SELECT title, schedule_status, repeat_interval, status as prior_status FROM tasks WHERE id = ?').get(taskId) as { title: string; schedule_status: string; repeat_interval: number | null; prior_status: string } | undefined;
    const isScheduledRecurring = taskRow && taskRow.schedule_status !== 'unscheduled' && taskRow.repeat_interval;
    const priorStatus = taskRow?.prior_status ?? null;

    // v2.10.1, idempotency check. When the agent calls
    // tracker_update_status with a status that the task is already at,
    // do nothing and tell the agent clearly. Pre-fix the call still ran
    // the full update + emitted "[OK] Task updated" + sent the success
    // notification, which read to the agent as "I did real work" and
    // encouraged re-closing already-complete tasks based on stale
    // scheduler triggers still in its context window
    // (production incident 2026-06-08: agent close-loop on already-
    // complete recurring emails). Skip only when status is the only
    // requested change; if the call also changes assignedTo or
    // priority, fall through to the normal update so those land.
    if (
      status &&
      !assignedTo &&
      !priority &&
      priorStatus === status &&
      // For recurring per-run completion, "complete" is a real
      // transition every run even when the row currently reads
      // complete (the prior run's terminal state). Let the normal
      // path handle it so the scheduler advances.
      !(status === 'complete' && isScheduledRecurring)
    ) {
      return (
        `[NO-OP] task_id=${taskId} | status=${status}, already at this status, no change made.\n\n` +
        `Task: ${taskRow?.title ?? '(unknown title)'}`
      );
    }

    const updates: Record<string, string | null> = {};
    if (status) updates.status = status;
    if (assignedTo) updates.assignedTo = assignedTo;
    if (priority) updates.priority = priority;

    // v2.8.x rule: 'on_deck' is reserved for tasks with a FUTURE
    // scheduled_start (the scheduler owns the transition to 'in_progress'
    // at fire time). Anything else belongs in 'in_progress' so the work
    // stays visible to the assigned agent and the PM. Refuse explicit
    // moves to 'on_deck' on tasks without a future schedule so agents
    // don't accidentally park work in the "waiting for never" bucket, 
    // the failure mode being addressed is the agent creating tasks,
    // working one, and forgetting the rest.
    if (status === 'on_deck' && !isPMAgent(agentId)) {
      const sched = db.prepare(
        'SELECT scheduled_start, repeat_interval, next_run_at FROM tasks WHERE id = ?'
      ).get(taskId) as { scheduled_start: string | null; repeat_interval: number | null; next_run_at: string | null } | undefined;
      const nowMs = Date.now();
      const futureScheduledStart = !!(
        sched?.scheduled_start && new Date(normalizeDbTimestamp(sched.scheduled_start)).getTime() > nowMs
      );
      const futureNextRun = !!(
        sched?.next_run_at && new Date(normalizeDbTimestamp(sched.next_run_at)).getTime() > nowMs
      );
      const isRecurring = !!sched?.repeat_interval;
      if (!futureScheduledStart && !futureNextRun && !isRecurring) {
        return (
          `Error: status="on_deck" is reserved for tasks with a FUTURE scheduled_start ` +
          `(or a recurring schedule). This task has no future schedule, so it belongs in ` +
          `"in_progress" until you actively work it. If you want to park it for later, ` +
          `set a scheduled_start with tracker_edit_task first, then move to on_deck. ` +
          `If you're done, use status="complete". If you're waiting on the user, use ` +
          `status="paused" with notes naming what you're waiting for.`
        );
      }
    }

    // Pass resume_at through for timed pauses
    const resumeAt = args.resume_at as string | undefined;
    if (status === 'paused' && resumeAt) {
      updates.pausedUntil = resumeAt;
    }

    // PM is the overseer. Its proactive transitions skip the worker-targeted
    // hard gates below. The audit trail still logs from_entity='pm', and
    // the validate_*/override tools are the structured PM paths.
    const callerIsPM = isPMAgent(agentId);

    // ── Pause-reason engine pre-check (v2.7.18) ──
    // Pausing without a real wait condition was the most common gaming
    // pattern: agents marked tasks paused just to silence PM pokes. The
    // engine refuses empty/short notes here; PM validates the SUBSTANCE of
    // the reason on its next tick (see pause_validated column + the
    // tracker_validate tool).
    if (status === 'paused' && !callerIsPM) {
      const pauseNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      const MIN_PAUSE_NOTES_LEN = 15;
      if (pauseNotes.length < MIN_PAUSE_NOTES_LEN) {
        return (
          `Error: paused tasks require a clear reason in \`notes\` (minimum ${MIN_PAUSE_NOTES_LEN} characters). ` +
          `\`notes\` must name the specific external trigger you're waiting on - for example: ` +
          `"waiting for user to reboot ESP board", "waiting for vendor to send tracking number". ` +
          `If you're stuck and don't know what to do, that's NOT a paused condition - use \`status="blocked"\` ` +
          `with the real reason so the user knows. If you're just done with the task, use \`status="complete"\`. ` +
          `Pausing without a real reason will be reverted by the PM agent on its next tick.`
        );
      }
      // Anti-gaming sniff: catch phrases that signal the agent is hiding
      // from PM rather than waiting on a real condition. PM still gets the
      // final say, but we may as well refuse the obvious cases at the door.
      const lower = pauseNotes.toLowerCase();
      const gamingSignals = ['pm keeps', 'pm is', 'silence pm', 'stop the pm', 'nagging', 'stop poking', 'stop the poke'];
      const matched = gamingSignals.find(s => lower.includes(s));
      if (matched) {
        return (
          `Error: this pause reason ("${pauseNotes.slice(0, 100)}") reads as an attempt to silence the PM, not a real wait condition. ` +
          `If you're stuck, use \`status="blocked"\` with the real reason. ` +
          `If you actually have a user-facing question, ask the user first then re-pause with a concrete "waiting for X" reason.`
        );
      }
    }

    // ── Phase B.1: complete engine hard gate ──
    // Structure only. Engine never inspects evidence content; that is PM's job.
    if (status === 'complete' && !callerIsPM) {
      const result = typeof args.result === 'string' ? args.result.trim() : '';
      const evidence = Array.isArray(args.evidence) ? args.evidence : null;
      if (!result) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing result field on complete');
        return (
          `Error: status="complete" requires a non-empty \`result\` field describing what was done. ` +
          `Example call: tracker_update_status(task_id="${taskId}", status="complete", result="migrated 12 routes to new auth middleware", evidence=[{kind:"file_modified", claim:"12 routes updated", pointer:"packages/server/src/gateway/routes/"}, {kind:"tool_call_ref", claim:"18 file_edit calls completed"}]).` +
          breaker
        );
      }
      if (!evidence || evidence.length === 0) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing or empty evidence array on complete');
        return (
          `Error: status="complete" requires \`evidence\` as a non-empty array. Each entry must be {kind, claim, pointer?}. ` +
          `Supported kinds (text-only, PM-readable): claim, file_modified, file_read, tool_call_ref, output_paste, external_action, quote. ` +
          `Example: evidence=[{kind:"file_modified", claim:"updated 12 routes", pointer:"packages/server/src/gateway/routes/"}, {kind:"tool_call_ref", claim:"18 file_edit calls succeeded"}].` +
          breaker
        );
      }
      // Each entry must carry real evidence CONTENT (a non-empty `claim`); the
      // `kind` is only a PM-readable LABEL. The correctness-floor model routinely
      // mislabels the kind (e.g. kind="web_fetch", the tool it just called) while
      // still handing over a valid claim. Forgive the LABEL, never the substance:
      // an unrecognized kind is COERCED to the catch-all `claim` (the model's
      // claim text is preserved, its attempted label noted) instead of failing
      // the close. What stays HARD: (a) each entry must be a real object, (b) it
      // must have a non-empty claim (THAT is the evidence-required rule,
      // unchanged), and (c) the engine-reserved `verified_receipt` kind is still
      // refused so an agent cannot fabricate a machine receipt.
      const normEvidence: Array<Record<string, unknown>> = [];
      for (let i = 0; i < evidence.length; i++) {
        const e = evidence[i] as Record<string, unknown> | null;
        if (!e || typeof e !== 'object') {
          const breaker = noteHardGateRejection(taskId, agentId, `evidence[${i}] is not an object`);
          return `Error: evidence[${i}] must be an object with {kind, claim, pointer?}, got ${typeof e}.${breaker}`;
        }
        const rawKind = typeof e.kind === 'string' ? e.kind.trim() : '';
        const claim = typeof e.claim === 'string' ? e.claim.trim() : '';
        if (!claim) {
          const breaker = noteHardGateRejection(taskId, agentId, `evidence[${i}] missing claim`);
          return `Error: evidence[${i}] must carry a non-empty \`claim\` string describing the concrete artifact (file path, count, id, what you did). The \`kind\` is only a label; the claim is the evidence.${breaker}`;
        }
        // C26: verified_receipt is engine-only; the engine appends it after the
        // gate passes. An agent supplying it is trying to fabricate a receipt.
        if (rawKind === 'verified_receipt') {
          const breaker = noteHardGateRejection(taskId, agentId, `evidence[${i}] used the reserved verified_receipt kind`);
          return `Error: evidence[${i}] kind "verified_receipt" is reserved for the engine and cannot be supplied by an agent. The engine writes verified receipts itself from the tool's provider response. Use one of: ${[...VALID_EVIDENCE_KINDS].join(', ')}.${breaker}`;
        }
        // C26 (softened, correctness-floor): a recognized kind passes through; an
        // unrecognized/empty label is coerced to `claim` rather than rejected, so
        // valid-shaped evidence with a wrong kind label is ACCEPTED. The claim
        // text is kept verbatim and the attempted label appended so nothing is
        // hidden and PM still sees exactly what the agent meant.
        if (VALID_EVIDENCE_KINDS.has(rawKind)) {
          normEvidence.push({ ...e, kind: rawKind, claim });
        } else {
          const note = rawKind ? ` [labeled "${rawKind}"]` : '';
          normEvidence.push({ ...e, kind: 'claim', claim: `${claim}${note}` });
        }
      }
      // ── C26 receipt gate ──
      // A turn that ran a tier-1/2 (machine-verifiable) send tool must produce a
      // verified receipt to close as complete. This makes Layer 1 a REAL gate
      // for the send subset, on the weakest model, instead of structure-only.
      // Tier-3 (iMessage) turns impose NO new requirement; a turn that ran no
      // receipt tool at all keeps the existing prose-evidence + PM path (D-3).
      const turnReceiptIds = getTurnReceipts(agentId);
      const receiptRows = turnReceiptIds.length > 0 ? getReceiptsByIds(turnReceiptIds) : [];
      const tier12 = receiptRows.filter(r => r.tier === 1 || r.tier === 2);
      if (tier12.length > 0) {
        const satisfied = tier12.some(r => r.verified === 1 || (r.tier === 2 && receiptDetailAccepted(r)));
        if (!satisfied) {
          const worst = tier12[0];
          const breaker = noteHardGateRejection(taskId, agentId, `send via ${worst.tool} not verified by receipt`);
          return (
            `Error: this turn ran a send tool (${worst.tool}) but the engine could NOT verify the send landed ` +
            `(basis=${worst.basis}, detail=${worst.detail ?? '(none)'}). A send-class task cannot be marked complete ` +
            `until delivery is confirmed. The send may still have gone out: verify FIRST (check the sent folder / thread / recipient) ` +
            `and re-send only if you confirm it did not land. If it genuinely failed, mark the task blocked with the reason. ` +
            `Do not claim it was sent.${breaker}`
          );
        }
      }

      // On pass, the engine appends one verified_receipt evidence entry per
      // receipt written THIS turn (tier 3 included, honestly marked unverified)
      // so PM's existing evidence-reading flow sees the machine receipts, then
      // stamps task_id on the consumed rows. Engine-authored, appended AFTER the
      // agent-supplied evidence was validated above.
      const evidenceOut: unknown[] = [...normEvidence];
      for (const r of receiptRows) {
        const label = r.verified === 1 ? 'verified' : 'unverified';
        const idPart = r.provider_id ? `, id ${r.provider_id}` : '';
        evidenceOut.push({ kind: 'verified_receipt', claim: `${r.tool} ${label} (${r.basis})${idPart}`, pointer: r.id });
      }

      // Persist result + (augmented) evidence on the task row for PM to read.
      try {
        db.prepare(`UPDATE tasks SET result = ?, evidence_json = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(result, JSON.stringify(evidenceOut), taskId);
      } catch (err) {
        logger.warn('Failed to persist result/evidence on complete (non-fatal)', {
          taskId, error: err instanceof Error ? err.message : String(err),
        });
      }
      // Stamp task_id (+ updated_at) on the receipts consumed as evidence.
      if (turnReceiptIds.length > 0) stampReceiptsTask(turnReceiptIds, taskId);
      // Clear circuit-breaker tracking, the hard gate accepted.
      clearHardGateBreaker(taskId, agentId);
    }

    // ── Phase B.1: blocked engine hard gate ──
    if (status === 'blocked' && !callerIsPM) {
      const blockedNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      const MIN_BLOCKED_NOTES_LEN = 15;
      if (blockedNotes.length < MIN_BLOCKED_NOTES_LEN) {
        const breaker = noteHardGateRejection(taskId, agentId, 'missing or short blocked reason');
        return (
          `Error: status="blocked" requires a clear reason in \`notes\` (minimum ${MIN_BLOCKED_NOTES_LEN} characters). ` +
          `Name the specific obstacle (e.g. "need API key for service X", "external service Y is returning 500s"). ` +
          `If you are paused waiting for the user to do something, use status="paused" with notes naming the wait condition instead.` +
          breaker
        );
      }
      clearHardGateBreaker(taskId, agentId);
    }

    // For recurring tasks being marked complete with complete_all_runs=true,
    // the agent is asserting that NO further runs are needed. Stop the
    // schedule immediately and bypass per-run PM validation, this is the
    // "I did them all internally, please close the loop" path.
    if (status === 'complete' && isScheduledRecurring && (args.complete_all_runs as boolean) === true) {
      const notes = args.notes as string | undefined;
      db.prepare("UPDATE tasks SET status = 'complete', schedule_status = 'completed', is_paused = 1, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
      db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = ? WHERE task_id = ? AND status = 'running'").run(notes ?? 'All runs completed by agent', taskId);
      const updatedTask = getTask(taskId)!;
      broadcast({ type: 'tracker:task_updated', data: updatedTask });
      notifyPrimaryAgent(
        `Recurring task "${updatedTask.title}" fully completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId} (all runs done).`, // comms-audit rank 5: dropped verbatim ` Notes: ${notes}` inline (full work-log firehose); notes live on the task row for deliberate pull
        agentId,
      );
      checkProjectCompletion(updatedTask.projectId, agentId);
      return `Recurring task "${updatedTask.title}" fully completed. Schedule stopped. All runs marked done.`;
    }

    // Recurring per-run complete (non-terminal): advance the schedule
    // immediately so the wall-clock anchor is preserved. PM validation
    // happens as an async audit on task_log but does NOT gate the next
    // fire, late validation must never lose a scheduled run. The hard
    // gate above already validated result+evidence presence, so we have
    // a clean record to archive.
    //
    // Detection: probe calculateNextRun with run_count+1. If it would
    // return null, this run is the TERMINAL close and we hold for the PM's
    // validation (matches one-shot complete semantics, final state needs
    // the same review discipline).
    if (status === 'complete' && isScheduledRecurring) {
      // ── RC-17.1: open-occurrence gate ──
      // A recurring per-run complete only makes sense when there is an
      // actually-open occurrence: the scheduler must have fired this run
      // (schedule_status='running') AND a matching 'running' task_runs row must
      // exist. The same-status NO-OP guard above deliberately EXEMPTS recurring
      // completes, so every stray/stale `complete` call reaches this block; a
      // stale scheduler trigger still sitting in the agent's context would
      // otherwise advance the schedule again (inflating run_count) or, worse,
      // close a different occurrence (F-16). Require both signals; without them
      // this is a stale trigger from a run that already closed, so return the
      // existing [NO-OP] stale-trigger text and do NOT advance. The deliberate
      // "stop the whole schedule" path (complete_all_runs=true) is handled
      // above this block and is intentionally not gated.
      const openRun = db.prepare(
        `SELECT id FROM task_runs WHERE task_id = ? AND status = 'running' ORDER BY run_number DESC LIMIT 1`
      ).get(taskId) as { id: string } | undefined;
      const scheduleStatusNow = (
        db.prepare('SELECT schedule_status FROM tasks WHERE id = ?').get(taskId) as { schedule_status: string } | undefined
      )?.schedule_status;
      if (!openRun || scheduleStatusNow !== 'running') {
        return (
          `[NO-OP] task_id=${taskId} | status=complete, no open scheduled run to complete, no change made.\n\n` +
          `Task: ${taskRow?.title ?? '(unknown title)'}\n\n` +
          `To STOP the whole recurring schedule, call tracker_update_status with complete_all_runs=true.`
        );
      }

      const detail = db.prepare(`
        SELECT scheduled_start, repeat_interval, repeat_unit, repeat_end_type,
               repeat_end_value, repeat_days_of_week, anchor_time, run_count,
               is_paused, last_run_at, next_run_at, schedule_status
        FROM tasks WHERE id = ?
      `).get(taskId) as {
        scheduled_start: string | null; repeat_interval: number | null;
        repeat_unit: string | null; repeat_end_type: string | null;
        repeat_end_value: string | null; repeat_days_of_week: string | null;
        anchor_time: string | null; run_count: number; is_paused: number;
        last_run_at: string | null; next_run_at: string | null; schedule_status: string;
      } | undefined;

      const wouldBeTerminal = (() => {
        if (!detail) return false;
        const probe: ScheduledTask = {
          id: taskId,
          scheduled_start: detail.scheduled_start,
          repeat_interval: detail.repeat_interval,
          repeat_unit: detail.repeat_unit,
          repeat_end_type: detail.repeat_end_type,
          repeat_end_value: detail.repeat_end_value,
          repeat_days_of_week: detail.repeat_days_of_week,
          anchor_time: detail.anchor_time,
          run_count: detail.run_count + 1,
          is_paused: detail.is_paused,
          last_run_at: new Date().toISOString(),
          next_run_at: detail.next_run_at,
          schedule_status: detail.schedule_status,
        };
        return calculateNextRun(probe) === null;
      })();

      if (!wouldBeTerminal) {
        // Non-terminal recurring per-run: archive result+evidence to
        // task_log for audit and advance the schedule immediately.
        const runResult = typeof args.result === 'string' ? args.result.trim() : '';
        const evidenceJson = Array.isArray(args.evidence) ? JSON.stringify(args.evidence) : null;
        try {
          writeTaskLog({
            taskId,
            fromEntity: `agent:${agentId}`,
            entryKind: 'transition',
            fromStatus: 'in_progress',
            toStatus: 'on_deck',
            actionTaken: `recurring per-run complete (run #${detail!.run_count + 1})`,
            reason: runResult || null,
            note: runResult || null,
            evidenceJson,
          });
        } catch (err) {
          logger.warn('Failed to archive recurring per-run to task_log (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        }
        // Clear result/evidence on the task row so the next fire starts
        // from scratch, the per-run record lives in task_log.
        db.prepare(`UPDATE tasks SET result = NULL, evidence_json = NULL WHERE id = ?`).run(taskId);
        // Advance the schedule (fire-and-forget, same pattern the
        // generic complete handler uses below).
        const notes = args.notes as string | undefined;
        onTaskRunComplete(taskId, 'complete', notes ?? '').catch(err => {
          logger.warn('onTaskRunComplete failed during recurring per-run advance (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        });
        const updatedTask = getTask(taskId)!;
        const nextRunFmt = updatedTask.nextRunAt ? formatTimeForAgent(updatedTask.nextRunAt) : null;
        notifyPrimaryAgent(
          `Recurring run completed by ${updatedTask.assignedToName ?? updatedTask.assignedTo ?? agentId}: "${updatedTask.title}". Run ${updatedTask.runCount}${nextRunFmt ? `, next: ${nextRunFmt}` : ''}.`, // comms-audit rank 5: dropped verbatim ` Notes: ${notes}` inline (full work-log firehose); notes live on the task row for deliberate pull
          agentId,
        );
        return [
          `Run completed for recurring task.`,
          `Task: ${updatedTask.title} (${updatedTask.id})`,
          `Runs completed: ${updatedTask.runCount}`,
          nextRunFmt ? `Next run: ${nextRunFmt}` : 'No further runs scheduled.',
        ].join('\n');
      }
      // Terminal recurring complete: fall through to the standard complete
      // flow. The hard gate persists result/evidence, status flips to
      // 'complete', complete_validated stays 0, and the PM's terminal-close
      // validation runs against this final state. checkProjectCompletion
      // and dep cascades fire when the PM validates.
    }

    const task = updateTask(taskId, updates);

    if (!task) {
      // We already resolved taskId above, so the id existed at resolve time.
      // A null return from updateTask now means one of two rare things:
      //   1. Another agent deleted the task between resolve and update
      //   2. The task was deleted between the UPDATE and the SELECT
      // Either way, the task genuinely no longer exists, not a prefix mismatch.
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // Phase B.0: write the transition + any supplied notes to task_log.
    // tasks.notes is now read-only legacy (Q7), new code does not append to it.
    {
      const fromEntity = isPMAgent(agentId)
        ? 'pm'
        : `agent:${agentId}`;

      if (status && status !== priorStatus) {
        writeTaskLog({
          taskId,
          fromEntity,
          entryKind: 'transition',
          fromStatus: priorStatus,
          toStatus: status,
          actionTaken: 'tracker_update_status',
        });
        // Event-driven PM wake: buffer + 10s debounce, then runPMReview.
        // Smell detector also fires inside noteTransitionForReview.
        noteTransitionForReview(taskId, status);
      }
      const persistNotes = typeof args.notes === 'string' ? args.notes.trim() : '';
      if (persistNotes.length > 0) {
        writeTaskLog({
          taskId,
          fromEntity,
          entryKind: 'observation',
          note: persistNotes,
          actionTaken: status ? `notes attached to status=${status}` : 'notes attached',
        });
      }
    }

    // When a task reaches a terminal state, neutralize its still-pending
    // assignment notice (C2): the scaffold pushed it inline this turn, so the
    // persisted conv_key=NULL copy must not re-fire as a fresh "begin working"
    // prompt after the task is already done and re-drive a redo. Only touches the
    // notice for THIS task; genuinely-open tasks keep their pending notice so the
    // dangling-recovery machinery still fires.
    if ((status === 'complete' || status === 'fallen' || status === 'cancelled') && task.assignedTo) {
      claimAssignmentNoticeForTerminalTask(task.assignedTo, taskId);
    }

    // Notify primary agent when a task completes
    if (status === 'complete') {
      const notes = args.notes as string | undefined;
      notifyPrimaryAgent(
        `Task "${task.title}" completed by ${task.assignedToName ?? task.assignedTo ?? agentId}.`, // comms-audit rank 5: dropped verbatim ` Notes: ${notes}` inline (full work-log firehose); notes live on the task row for deliberate pull
        agentId,
      );
      // W3-4: ASSIGN hand-back guarantee (engine-side, weakest-model-proof).
      relayAssignHandbackIfMissing(taskId);
      // Handle one-time scheduled task completion. Recurring tasks are
      // gated out, their per-run advance happens only after the PM
      // validates this run via tracker_validate. Calling
      // onTaskRunComplete here would silently advance the schedule and
      // bypass PM review (the bug v2.8.2 fixes).
      if (!isScheduledRecurring) {
        try {
          onTaskRunComplete(taskId, 'complete', notes ?? '');
        } catch { /* not a scheduled task */ }
      }
      checkProjectCompletion(task.projectId, agentId);
    }

    // D-K: a 'fallen' transition can be the one that empties the project of open
    // tasks (fall-last ordering), so the fail-open check must run here too, not
    // only on completions. Idempotent: still_open/noop guards make extra calls harmless.
    let fallenScheduleNote: string | null = null;
    if (status === 'fallen') {
      // RC-17.5: 'fallen' on a live schedule must also STOP the schedule, or the
      // due query (which filters only schedule_status/is_paused, not status)
      // keeps firing it (F-17). Terminate it, close any open run as skipped, and
      // SAY so in the result.
      const term = terminateLiveScheduleOnFallen(taskId, 'the task was marked fallen (given up on)');
      if (term.terminated) {
        fallenScheduleNote =
          `Schedule stopped so it cannot fire again` +
          (term.runsSkipped > 0 ? `; ${term.runsSkipped} open run(s) skipped` : '') +
          (term.isReminder && term.runsSkipped > 0 ? ` (owner told the reminder was skipped)` : '') +
          '.';
      }
      checkProjectCompletion(task.projectId, agentId);
    }

    const parts = [
      `[OK] task_id=${task.id} | status=${task.status}`,
      ``,
      `Task updated: ${task.title}`,
    ];
    if (fallenScheduleNote) parts.push(fallenScheduleNote);
    if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
    parts.push(`Priority: ${task.priority}`);
    if (task.status === 'paused' && task.pausedUntil) {
      parts.push(`Auto-resumes: ${formatTimeForAgent(task.pausedUntil)} (will restore to "${task.statusBeforePause ?? 'on_deck'}")`);
    } else if (task.status === 'paused') {
      parts.push('Paused indefinitely, must be resumed manually.');
    }

    // Apprentice safety net: if an apprentice just marked their OWN primary task
    // 'complete' via tracker_update_status, they almost certainly meant to finalize
    // their work. tracker_update_status alone leaves them idle, their parent will
    // never get the structured completion notification. Nudge them to call
    // complete_task on the next turn.
    if (status === 'complete') {
      const agentRow = db.prepare('SELECT classification, task_id FROM agents WHERE id = ?').get(agentId) as { classification: string; task_id: string | null } | undefined;
      if (agentRow && agentRow.classification === 'apprentice' && agentRow.task_id === taskId) {
        parts.push('');
        parts.push('[REMINDER] You just marked your own assigned task complete, but you have NOT finalized your work. tracker_update_status alone does not terminate you or notify your parent. Call complete_task(status="complete", summary="<your result>") on your next turn to wrap up properly.');
      }
    }

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerUpdateStatus failed', { error: msg }, agentId);
    return `Error updating task: ${msg}`;
  }
}

// ── W3-4: ASSIGN hand-back guarantee ──
// When an agent delegates via send_to_agent(intent=ASSIGN), the engine
// auto-creates a thread-linked tracker task (autoCreateAssignTask) and the
// delivery footer promises the sender "gets the completion notice". Pre-fix
// nothing enforced that promise: the assignee could close the task via
// tracker_update_status WITHOUT ever sending the work product back on the
// thread, and a non-primary assigner heard nothing (behavioral run
// bmr59ix4lsg, multi-agent-project). Correctness is the engine's job, so at
// complete-time: if the assigner has not received ANY on-thread message from
// the assignee since the task was created, relay the tracker close-out
// (result text, which the complete hard gate requires) to the assigner on the
// SAME thread as intent=COMPLETE (terminal + wake; completion intents skip
// semantic dedup by design). Respects the existing transport machinery, no
// new lanes. Fire-and-forget: a relay failure never blocks the completion.
function relayAssignHandbackIfMissing(taskId: string): void {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT created_by, assigned_to, a2a_thread_id, created_at, title, result FROM tasks WHERE id = ?'
    ).get(taskId) as {
      created_by: string | null;
      assigned_to: string | null;
      a2a_thread_id: string | null;
      created_at: string;
      title: string;
      result: string | null;
    } | undefined;
    if (!row?.a2a_thread_id || !row.created_by || !row.assigned_to) return;
    if (row.created_by === row.assigned_to) return; // self-assignment, no counterparty owed a hand-back
    // Did the assigner already hear from the assignee on this thread during
    // this task's lifetime (ANSWER/DELIVERABLE/COMPLETE/anything)? Then the
    // hand-back happened, nothing to relay.
    const heardAlready = (): boolean => !!getDb().prepare(
      `SELECT rowid FROM messages
       WHERE agent_id = ? AND source_agent_id = ? AND a2a_thread_id = ? AND created_at >= ?
       LIMIT 1`
    ).get(row.created_by, row.assigned_to, row.a2a_thread_id, row.created_at);
    if (heardAlready()) return;

    const payload =
      `${row.result?.trim() || `Task "${row.title}" was closed as complete (no result text recorded).`}\n\n` +
      `[Engine relay: the assignee closed the assigned task "${row.title}" (${taskId.slice(0, 8)}) ` +
      `without replying on this thread; the text above is the recorded close-out result.]`;

    void (async () => {
      // Grace period, then re-check. Models routinely batch
      // tracker_update_status(complete) and the real send_to_agent hand-back
      // in the SAME tool batch (either order); relaying immediately at
      // complete-time double-delivers when the send lands milliseconds later
      // (observed: primary agent completing a delegated office task). The
      // relay exists for the assignee that never sends at all, so waiting a
      // beat costs nothing.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      if (heardAlready()) return;
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const result = await deliverA2AMessage({
        intent: 'COMPLETE',
        threadId: row.a2a_thread_id as string,
        requiresResponse: false,
        payload,
        toAgent: row.created_by as string,
        fromAgent: row.assigned_to as string,
      });
      if (result.delivered) {
        logger.info('ASSIGN hand-back relayed to assigner at complete-time', {
          taskId, threadId: row.a2a_thread_id, assigner: row.created_by, assignee: row.assigned_to,
        }, row.assigned_to as string);
      } else {
        logger.warn('ASSIGN hand-back relay was not delivered', {
          taskId, threadId: row.a2a_thread_id, reason: result.reason,
        }, row.assigned_to as string);
      }
    })().catch((err) => {
      logger.warn('ASSIGN hand-back relay failed (non-fatal)', {
        taskId, error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logger.warn('ASSIGN hand-back check failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── trackerAddNotes ──
//
// Phase B.0: writes an observation entry to task_log instead of appending to
// the legacy tasks.notes column. Call signature is unchanged so agents do
// not need to relearn.

export function trackerAddNotes(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    const notes = args.notes as string;
    if (!notes) return 'Error: notes is required';

    const fromEntity = isPMAgent(agentId) ? 'pm' : `agent:${agentId}`;
    writeTaskLog({
      taskId,
      fromEntity,
      entryKind: 'observation',
      note: notes,
    });

    return `[OK] task_id=${taskId}\n\nObservation appended to task_log.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerAddNotes failed', { error: msg }, agentId);
    return `Error adding notes: ${msg}`;
  }
}

// C27: trackerEditNotes + trackerClearNotes (dead v2.8.0 stubs that always
// returned an Error directive) were DELETED along with their tool defs; the old
// tool names are now tombstone aliases (tools/aliases.ts).

// ── trackerEditTask ──
// Edit any structural field on a task, title, description, dependencies,
// step ordering, schedule. This is the catch-all editor; status changes still
// go through trackerUpdateStatus (because completing a task has notification
// + project-rollup side-effects), and the schedule pause/resume pair stays on
// trackerPauseSchedule / trackerResumeSchedule (because those write a reason
// and notify the PM differently).
//
// Everything else lives here. If a future field is added to the tasks table,
// the rule of thumb is: "does setting it have a side-effect beyond the row
// update?" If no, add it to this tool. If yes, give it its own tool.

export function trackerEditTask(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string;
    if (!rawTaskId) return 'Error: taskId is required';

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    // RC-18: local wall-clock schedule input on edit too. Convert local_time to
    // scheduled_start engine-side before the field reads below. Explicit
    // scheduled_start wins if both are given.
    if (args.local_time !== undefined && args.local_time !== null && args.local_time !== ''
        && args.scheduledStart === undefined && args.scheduled_start === undefined) {
      if (typeof args.local_time !== 'string') {
        return 'Error: local_time must be a string wall-clock time, e.g. "2026-07-16T21:00".';
      }
      const tz = (args.local_timezone ?? args.tz) as string | undefined;
      const resolvedWall = resolveLocalWallClock(args.local_time, typeof tz === 'string' ? tz : undefined);
      if (!resolvedWall.ok) return resolvedWall.error;
      args.scheduled_start = resolvedWall.iso;
    }

    const title = args.title as string | undefined;
    const description = args.description as string | undefined;
    const dependsOn = args.dependsOn ?? args.depends_on;
    const stepNumber = (args.stepNumber ?? args.step_number) as number | null | undefined;
    const phase = args.phase as number | null | undefined;
    const scheduledStart = (args.scheduledStart ?? args.scheduled_start) as string | null | undefined;
    const repeatInterval = (args.repeatInterval ?? args.repeat_interval) as number | null | undefined;
    const repeatUnit = (args.repeatUnit ?? args.repeat_unit) as string | null | undefined;
    const repeatEndType = (args.repeatEndType ?? args.repeat_end_type) as string | null | undefined;
    const repeatEndValue = (args.repeatEndValue ?? args.repeat_end_value) as string | null | undefined;
    const repeatDaysOfWeek = (args.repeatDaysOfWeek ?? args.repeat_days_of_week) as string | null | undefined;
    const anchorTime = (args.anchorTime ?? args.anchor_time) as string | null | undefined;
    const priority = args.priority as string | undefined;
    const notes = args.notes as string | undefined;
    const goal = args.goal as string | undefined;

    const editableKeys = [
      title, description, dependsOn, stepNumber, phase,
      scheduledStart, repeatInterval, repeatUnit, repeatEndType, repeatEndValue,
      repeatDaysOfWeek, anchorTime,
      priority, notes, goal,
    ];
    if (editableKeys.every(v => v === undefined)) {
      return 'Error: at least one editable field must be provided. Editable: title, description, goal, depends_on, step_number, phase, scheduled_start, repeat_interval, repeat_unit, repeat_end_type, repeat_end_value, repeat_days_of_week, anchor_time, priority, notes. (For status changes use tracker_update_status; for assignee changes use tracker_reassign_task; for pause/resume use tracker_pause_schedule.)';
    }

    // Recurring-schedule integrity gate. Same shape as the gate in
    // tracker_create_task's dispatch, the edit path is the OTHER way to
    // produce a partial schedule (e.g. add repeat_interval to a row that
    // had no repeat_unit, or strip repeat_unit while leaving
    // repeat_interval set). Compute the EFFECTIVE post-edit values and
    // reject before applying the update so the agent gets clear feedback.
    const isScheduleEdit =
      scheduledStart !== undefined ||
      repeatInterval !== undefined ||
      repeatUnit !== undefined;
    if (isScheduleEdit) {
      const current = getDb().prepare(`
        SELECT scheduled_start, repeat_interval, repeat_unit FROM tasks WHERE id = ?
      `).get(taskId) as { scheduled_start: string | null; repeat_interval: number | null; repeat_unit: string | null } | undefined;
      const VALID_REPEAT_UNITS = new Set([
        'minutes', 'hours', 'days', 'weeks', 'months', 'years', 'weekdays', 'specific_days',
      ]);
      const effScheduledStart = scheduledStart === undefined
        ? current?.scheduled_start ?? null
        : (scheduledStart ?? null);
      const effInterval = repeatInterval === undefined
        ? current?.repeat_interval ?? null
        : (repeatInterval ?? null);
      const effUnit = repeatUnit === undefined
        ? current?.repeat_unit ?? null
        : (repeatUnit ?? null);
      const effHasInterval = effInterval !== null && effInterval !== undefined;
      const effHasUnit = effUnit !== null && effUnit !== undefined && effUnit !== '';
      // Catch invalid unit first so a typo like "weekly" produces a
      // corrective hint instead of a misleading missing-interval message.
      if (effHasUnit && !VALID_REPEAT_UNITS.has(effUnit as string)) {
        return `Error: repeat_unit="${effUnit}" is not a valid unit. Valid values: minutes, hours, days, weeks, months, years, weekdays, specific_days. Common mistakes: "weekly" → repeat_unit="weeks"; "daily" → repeat_unit="days".`;
      }
      if (effHasInterval && !effHasUnit) {
        return 'Error: this edit would leave the task with repeat_interval set but no repeat_unit. The task would fire at most once. Either set repeat_unit (one of: minutes, hours, days, weeks, months, years, weekdays, specific_days), or clear repeat_interval (pass null) to turn off recurrence.';
      }
      if (effHasUnit && !effHasInterval && effUnit !== 'specific_days') {
        return `Error: this edit would leave the task with repeat_unit="${effUnit}" but no repeat_interval. The scheduler can't compute the next run. Either set repeat_interval (e.g. 1 for "every ${effUnit!.replace(/s$/, '')}"), or clear repeat_unit to turn off recurrence.`;
      }
      if ((effHasInterval || effHasUnit) && !effScheduledStart) {
        return 'Error: this edit would leave the task with recurring fields set but no scheduled_start. The scheduler has no anchor for the first run. Either set scheduled_start to an ISO 8601 timestamp, or clear repeat_interval and repeat_unit to turn off recurrence.';
      }
    }

    // FA-S4: reject an effective specific_days schedule with an empty
    // day-of-week allowlist. specific_days + no valid days silently degrades
    // to a single fire then complete (calculateNextRun's specific_days walk
    // can't advance without an allowed day). This runs whenever the edit could
    // change the effective unit OR the day list, including the days-only edit
    // (repeat_days_of_week -> [] / null) the schedule-integrity gate above does
    // not cover because it only triggers on scheduled_start/interval/unit
    // changes. Mirrors the fail-loud creator check in trackerCreateTask.
    if (repeatUnit !== undefined || repeatDaysOfWeek !== undefined) {
      const cur = getDb().prepare(
        'SELECT repeat_unit, repeat_days_of_week FROM tasks WHERE id = ?',
      ).get(taskId) as { repeat_unit: string | null; repeat_days_of_week: string | null } | undefined;
      const effUnit = repeatUnit === undefined ? (cur?.repeat_unit ?? null) : (repeatUnit ?? null);
      const effDays = repeatDaysOfWeek === undefined ? (cur?.repeat_days_of_week ?? null) : (repeatDaysOfWeek ?? null);
      if (effUnit === 'specific_days' && !parseDaysOfWeek(effDays)) {
        return (
          'Error: repeat_unit="specific_days" needs at least one weekday in repeat_days_of_week ' +
          '(comma-separated 0=Sun..6=Sat, e.g. "1,3" for Mon+Wed). This edit would leave it with no ' +
          'valid days, so the task would fire once and then never repeat. Either pass repeat_days_of_week ' +
          'with the days you want, or switch repeat_unit (e.g. "weeks" with repeat_interval=1 for a plain ' +
          'weekly cadence).'
        );
      }
    }

    // Phase B.1: goal edits are special. PM watches for goalpost-narrowing
    // mid-work. We log both old and new with a diff, so PM can see history
    // when validating later.
    if (goal !== undefined) {
      const goalTrimmed = goal.trim();
      if (!goalTrimmed) {
        return 'Error: goal cannot be empty. To edit other fields without changing goal, omit goal from the args.';
      }
      try {
        const priorGoal = getDb().prepare(`SELECT goal FROM tasks WHERE id = ?`).get(taskId) as { goal: string | null } | undefined;
        getDb().prepare(`UPDATE tasks SET goal = ?, updated_at = datetime('now') WHERE id = ?`).run(goalTrimmed, taskId);
        writeTaskLog({
          taskId,
          fromEntity: isPMAgent(agentId) ? 'pm' : `agent:${agentId}`,
          entryKind: 'observation',
          actionTaken: 'goal_edited',
          note: `BEFORE: ${priorGoal?.goal ?? '(none)'} -- AFTER: ${goalTrimmed}`,
        });
      } catch (err) {
        logger.warn('goal edit persist failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── RC-16: task content (title/description) edits are audited AND guarded ──
    // Snapshot title/description/original_description BEFORE the update so we can
    // (a) write a task_log audit entry for content edits, the same discipline
    // goal edits already get above, and (b) enforce the exact-revert guard. Two
    // structural defects made P-1 (a silent description revert) possible and
    // invisible: any agent could rewrite any task's description with no guard,
    // and description/title edits were NOT task_log-audited (only goal edits).
    const contentSnapshot = (title !== undefined || description !== undefined)
      ? getDb().prepare('SELECT title, description, original_description FROM tasks WHERE id = ?')
          .get(taskId) as { title: string | null; description: string | null; original_description: string | null } | undefined
      : undefined;

    // Exact-revert guard (RC-16): restoring `description` to a value that is
    // byte-identical to the immutable `original_description`, while the current
    // description has already been edited away from it (a later edit exists),
    // requires an explicit revert_to_original=true. This blocks the silent
    // "restore the stale original over a legitimate later edit" write (P-1)
    // without preventing an intentional, acknowledged revert.
    if (description !== undefined && description !== null && description !== '' && contentSnapshot) {
      const orig = contentSnapshot.original_description;
      const cur = contentSnapshot.description;
      const isByteIdenticalToOriginal = orig !== null && description === orig;
      const laterEditExists = cur !== orig; // current diverged from the original ask
      if (isByteIdenticalToOriginal && laterEditExists && args.revert_to_original !== true) {
        return (
          `Error: this edit restores the description to the task's ORIGINAL text byte-for-byte, over a later edit that changed it. ` +
          `That is usually an accidental revert of intended work (a stale copy overwriting the current description). ` +
          `If you really mean to roll the description back to the original ask, re-call with revert_to_original=true. ` +
          `Otherwise, edit from the CURRENT description instead of pasting the original back.`
        );
      }
    }

    const updates: Parameters<typeof updateTask>[1] = {};
    if (title !== undefined) {
      if (!title.trim()) return 'Error: title cannot be empty';
      updates.title = title.trim();
    }
    if (description !== undefined) {
      updates.description = description === '' ? null : description;
    }
    if (dependsOn !== undefined) {
      if (!Array.isArray(dependsOn)) return 'Error: depends_on must be an array of task IDs (or [] to clear)';
      updates.dependsOn = dependsOn as string[];
    }
    if (stepNumber !== undefined) updates.stepNumber = stepNumber;
    if (phase !== undefined) updates.phase = phase;
    if (scheduledStart !== undefined) {
      // Normalize to UTC ISO so downstream scheduling code doesn't trip on
      // a local-time string, same handling as trackerCreateTask.
      if (scheduledStart === null || scheduledStart === '') {
        updates.scheduledStart = null;
      } else {
        try {
          const parsed = new Date(scheduledStart);
          updates.scheduledStart = isNaN(parsed.getTime()) ? scheduledStart : parsed.toISOString();
        } catch {
          updates.scheduledStart = scheduledStart;
        }
      }
    }
    if (repeatInterval !== undefined) updates.repeatInterval = repeatInterval;
    if (repeatUnit !== undefined) updates.repeatUnit = repeatUnit;
    if (repeatEndType !== undefined) updates.repeatEndType = repeatEndType;
    if (repeatEndValue !== undefined) updates.repeatEndValue = repeatEndValue;
    if (repeatDaysOfWeek !== undefined) updates.repeatDaysOfWeek = repeatDaysOfWeek;
    if (anchorTime !== undefined) {
      if (anchorTime === null || anchorTime === '') {
        updates.anchorTime = null;
      } else {
        try {
          const parsed = new Date(anchorTime);
          updates.anchorTime = isNaN(parsed.getTime()) ? anchorTime : parsed.toISOString();
        } catch {
          updates.anchorTime = anchorTime;
        }
      }
    }
    if (priority !== undefined) updates.priority = priority;
    if (notes !== undefined) updates.notes = notes;

    const task = updateTask(taskId, updates);
    if (!task) {
      return `Error: Task ${taskId} was deleted before the update completed. It no longer exists.`;
    }

    // RC-16: audit title/description content edits in task_log, the same
    // discipline goal edits get above. Only logging goal edits is exactly what
    // made P-1 (a description revert) invisible; content edits now leave the same
    // before/after trail so a reviewer / PM can see who changed the user-facing
    // task text and to what.
    if (contentSnapshot) {
      const contentEditor = isPMAgent(agentId) ? 'pm' : `agent:${agentId}`;
      if (title !== undefined && title.trim() !== (contentSnapshot.title ?? '')) {
        writeTaskLog({
          taskId,
          fromEntity: contentEditor,
          entryKind: 'observation',
          actionTaken: 'title_edited',
          note: `BEFORE: ${contentSnapshot.title ?? '(none)'} -- AFTER: ${title.trim()}`,
        });
      }
      if (description !== undefined) {
        const newDesc = description === '' ? null : description;
        if (newDesc !== (contentSnapshot.description ?? null)) {
          writeTaskLog({
            taskId,
            fromEntity: contentEditor,
            entryKind: 'observation',
            actionTaken: args.revert_to_original === true ? 'description_edited (revert_to_original)' : 'description_edited',
            note: `BEFORE: ${contentSnapshot.description ?? '(none)'} -- AFTER: ${newDesc ?? '(cleared)'}`,
          });
        }
      }
    }

    // v2.5.3, if any schedule field changed, recompute next_run_at so the
    // scheduler picks up the edit. Without this, agents could change the
    // recurrence (interval, unit, day-of-week list, end conditions) but the
    // task would still fire at the old cadence until the next natural run.
    const scheduleChanged = (
      scheduledStart !== undefined ||
      repeatInterval !== undefined ||
      repeatUnit !== undefined ||
      repeatEndType !== undefined ||
      repeatEndValue !== undefined ||
      repeatDaysOfWeek !== undefined ||
      anchorTime !== undefined
    );
    if (scheduleChanged) {
      try {
        const db = getDb();
        const row = db.prepare(`
          SELECT id, scheduled_start, repeat_interval, repeat_unit,
                 repeat_end_type, repeat_end_value, repeat_days_of_week,
                 anchor_time,
                 run_count, is_paused, last_run_at, next_run_at, schedule_status
          FROM tasks WHERE id = ?
        `).get(taskId) as {
          id: string;
          scheduled_start: string | null;
          repeat_interval: number | null;
          repeat_unit: string | null;
          repeat_end_type: string | null;
          repeat_end_value: string | null;
          repeat_days_of_week: string | null;
          anchor_time: string | null;
          run_count: number;
          is_paused: number;
          last_run_at: string | null;
          next_run_at: string | null;
          schedule_status: string;
        } | undefined;
        if (row) {
          const nextRun = calculateNextRun(row);
          // Only set schedule_status to 'waiting' if there is a future run.
          // calculateNextRun returns null for completed/non-recurring tasks
          // that have already fired, in that case leave whatever status was
          // there (typically 'completed' or 'idle').
          if (nextRun) {
            db.prepare(`
              UPDATE tasks
              SET next_run_at = ?, schedule_status = 'waiting', updated_at = datetime('now')
              WHERE id = ?
            `).run(nextRun, taskId);
          } else if (row.scheduled_start === null) {
            // Schedule was cleared entirely, drop next_run_at too.
            db.prepare(`
              UPDATE tasks
              SET next_run_at = NULL, schedule_status = 'idle', updated_at = datetime('now')
              WHERE id = ?
            `).run(taskId);
          }
        }
      } catch (recalcErr) {
        // Non-fatal: the row update succeeded; only the recompute failed.
        // Log it so we notice, but don't fail the edit.
        logger.warn('trackerEditTask: schedule recompute failed', {
          taskId,
          error: recalcErr instanceof Error ? recalcErr.message : String(recalcErr),
        }, agentId);
      }
    }

    const changed: string[] = [];
    for (const k of Object.keys(updates)) changed.push(k);

    const editParts = [
      `[OK] task_id=${task.id}`,
      ``,
      `Task updated: ${task.title}`,
      `Fields changed: ${changed.join(', ')}`,
    ];
    // RC-18: if the schedule changed, echo the wall-clock anchor + next run so a
    // timezone mistake is caught before the next fire.
    if (scheduleChanged) {
      const fresh = getTask(taskId);
      for (const line of scheduleEchoLines(fresh?.scheduledStart ?? null, fresh?.nextRunAt ?? null)) {
        editParts.push(line);
      }
    }
    return editParts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerEditTask failed', { error: msg }, agentId);
    return `Error editing task: ${msg}`;
  }
}

// ── trackerGetStatus ──

export function trackerGetStatus(agentId: string, args: Record<string, unknown>): string {
  try {
    const rawTaskId = args.taskId as string | undefined;
    const rawProjectId = args.projectId as string | undefined;

    // The dispatcher in agent/tools.ts passes the same input as BOTH
    // taskId and projectId to let either side succeed. Try to resolve
    // the task first; if that fails, fall through and try the project
    // (but don't surface the task's not_found error if the project
    // resolves).
    if (rawTaskId) {
      const taskResolved = resolveTaskId(rawTaskId, agentId);
      if (taskResolved.ok) {
        const task = getTask(taskResolved.id);
        if (!task) return `Error: Task ${taskResolved.id} was deleted before it could be read.`;

        const parts = [
          `[OK] task_id=${task.id} | status=${task.status} | priority=${task.priority}`,
          ``,
          `Task: ${task.title}`,
        ];
        if (task.projectId) {
          const statusDb = getDb();
          const proj = statusDb.prepare('SELECT title FROM projects WHERE id = ?').get(task.projectId) as { title: string } | undefined;
          parts.push(`Project: ${proj?.title ?? task.projectId}`);
        }
        if (task.assignedTo) parts.push(`Assigned to: ${task.assignedToName ?? task.assignedTo}`);
        // The origin chain, in the agent's own view (2026-07-22 owner ruling:
        // the point of the identity work is that the AGENT can discern where a
        // task came from and connect it to its conversation and prompt).
        {
          const origin = findTaskOriginChain(task.id);
          if (origin) parts.push(`Origin: ${renderTaskOriginChain(origin)}`);
        }
        if (task.description) parts.push(`Description: ${task.description}`);
        if (task.stepNumber !== null) parts.push(`Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}`);
        if (task.dependsOn.length > 0) {
          const depNames = task.dependsOn.map(depId => {
            const dep = getTask(depId);
            return dep ? dep.title : depId;
          });
          parts.push(`Depends on: ${depNames.join(', ')}`);
        }
        // RC-18: surface the schedule so the description's prose time ("9 PM PT")
        // and the actual anchor are visible side by side (P-2 was invisible
        // because get_status never showed the schedule). Wall-clock + UTC via
        // formatTimeForAgent so the time can't be misread.
        if (task.scheduleStatus && task.scheduleStatus !== 'unscheduled') {
          const cadence = task.repeatInterval && task.repeatUnit
            ? `every ${task.repeatInterval} ${task.repeatUnit}`
            : 'one-time';
          parts.push(`Schedule: ${cadence} | status=${task.scheduleStatus}${task.isPaused ? ' (paused)' : ''}`);
          if (task.scheduledStart) parts.push(`  Anchor: ${formatTimeForAgent(task.scheduledStart)}`);
          parts.push(`  Next run: ${task.nextRunAt ? formatTimeForAgent(task.nextRunAt) : 'none scheduled'}`);
          if (task.runCount) parts.push(`  Runs completed: ${task.runCount}`);
        }
        if (task.notes) parts.push(`\nNotes:\n${task.notes}`);
        parts.push(`Created: ${task.createdAt}`);
        parts.push(`Updated: ${task.updatedAt}`);
        if (task.completedAt) parts.push(`Completed: ${task.completedAt}`);
        // 2026-07-22 production incident: the status READ is where the re-work
        // spiral started. The read renders the ticket's STAMPS (engine-observed
        // state) plus live step facts; the delivery-evidence join backfills
        // rows that predate the stamp columns.
        {
          const st = getTaskStampFields(task.id);
          if (st) {
            const steps = renderStepFacts(st);
            parts.push(`State: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`);
          }
        }
        if (task.status === 'in_progress') {
          // Tangibility rule (battery catch 2026-07-22): the ALREADY-DELIVERED
          // block requires a recorded handover, never a bare reply.
          const st = getTaskStampFields(task.id);
          const stamped = !!st && st.last_answered_turn !== null && !!st.last_delivery_summary;
          const evRaw = stamped ? null : findDeliveryEvidenceForTask(task.id);
          const ev = evRaw && (evRaw.artifacts.length > 0 || evRaw.deliveredVia.length > 0) ? evRaw : null;
          if (stamped || ev) {
            const evLine = stamped
              ? `answered on turn ${st!.last_answered_turn} (${st!.last_answered_at} UTC)${st!.last_delivery_summary ? `; ${st!.last_delivery_summary}` : ''}`
              : renderDeliveryEvidence(ev!);
            parts.push(
              `\n[ENGINE RECORD: this task's work appears ALREADY DELIVERED, ${evLine}. ` +
              `If that delivery completed the task, close it NOW with tracker_update_status(status="complete") (or tracker_complete_step) ` +
              `and do NOT redo or re-deliver the work. Only continue working if something genuinely remains.]`
            );
          }
        }

        return parts.join('\n');
      }
      // Task resolution failed, if we also have a projectId (usually the
      // same string), try the project branch below before reporting.
      if (!rawProjectId) {
        return formatResolveError('task', rawTaskId, taskResolved);
      }
    }

    if (rawProjectId) {
      const projectResolved = resolveProjectId(rawProjectId, agentId);
      if (!projectResolved.ok) {
        return formatResolveError('project', rawProjectId, projectResolved);
      }
      const project = getProject(projectResolved.id);
      if (!project) return `Error: Project ${projectResolved.id} was deleted before it could be read.`;

      const parts = [
        `[OK] project_id=${project.id} | status=${project.status} | phase=${project.currentPhase}/${project.phaseCount}`,
        ``,
        `Project: ${project.title}`,
        `Level: ${project.level}`,
        '',
        `Task Summary:`,
        `  On Deck: ${project.taskCounts.pending}`,
        `  In Progress: ${project.taskCounts.inProgress}`,
        `  Complete: ${project.taskCounts.complete}`,
        `  Blocked: ${project.taskCounts.blocked}`,
        `  Fallen: ${project.taskCounts.failed}`,
      ];

      if (project.tasks.length > 0) {
        parts.push('');
        parts.push('Tasks:');
        for (const task of project.tasks) {
          const assignee = task.assignedTo ? ` [${task.assignedTo}]` : '';
          const step = task.stepNumber !== null ? `#${task.stepNumber} ` : '';
          parts.push(`  ${step}[${task.status}] ${task.title}${assignee} (${task.priority})`);
        }
      }

      return parts.join('\n');
    }

    return 'Error: either taskId or projectId is required';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerGetStatus failed', { error: msg }, agentId);
    return `Error getting status: ${msg}`;
  }
}

// ── trackerListActive ──

export function trackerListActive(agentId: string, args: Record<string, unknown>): string {
  try {
    const scope = args.scope as 'tasks' | 'projects' | 'all' | undefined ?? 'all';
    const filterAssignedTo = args.assignedTo as string | undefined;
    const filterStatus = args.status as string | undefined;
    const verbose = args.verbose as boolean | undefined;
    const parts: string[] = [];
    let totalShown = 0;

    // Helper: format one task row. In verbose mode, append the description
    // line. In compact mode, just title + assignee + priority.
    const taskRow = (t: { id: string; title: string; assignedTo: string | null; assignedToName: string | null; priority: string; description: string | null }) => {
      const assignee = t.assignedTo ? ` [${t.assignedToName ?? t.assignedTo}]` : ' [unassigned]';
      const head = `  [${t.id.slice(0, 8)}] ${t.title}${assignee} (${t.priority})`;
      if (verbose && t.description) {
        const desc = t.description.length > 200 ? t.description.slice(0, 200) + '...' : t.description;
        return `${head}\n    → ${desc}`;
      }
      return head;
    };

    if (scope === 'projects' || scope === 'all') {
      const projects = listProjects({ status: 'active' });
      if (projects.length > 0) {
        parts.push(`Active Projects (${projects.length}):`);
        for (const p of projects) {
          parts.push(`  [${p.id.slice(0, 8)}] ${p.title} (phase ${p.currentPhase}/${p.phaseCount})`);
        }
        totalShown += projects.length;
      } else {
        parts.push('No active projects.');
      }
    }

    if (scope === 'tasks' || scope === 'all') {
      if (filterStatus) {
        const filtered = listTasks({ status: filterStatus, assignedTo: filterAssignedTo });
        if (filtered.length > 0) {
          parts.push(`${filterStatus.replace('_', ' ')} Tasks (${filtered.length}):`);
          for (const t of filtered) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += filtered.length;
        } else {
          parts.push(`No ${filterStatus} tasks.`);
        }
      } else {
        const taskFilter = filterAssignedTo ? { assignedTo: filterAssignedTo } : undefined;
        const inProgress = listTasks({ status: 'in_progress', ...taskFilter });
        const pending = listTasks({ status: 'on_deck', ...taskFilter });
        const blocked = listTasks({ status: 'blocked', ...taskFilter });

        if (inProgress.length > 0) {
          parts.push('');
          parts.push(`In Progress Tasks (${inProgress.length}):`);
          for (const t of inProgress) {
            parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
            // 2026-07-22: origin + STAMPS in-band on every list read, so the
            // agent connects the task to its conversation and knows its state
            // without guessing (the re-work spiral started at a status read
            // that repeated the lying in_progress).
            const tid = (t as { id: string }).id;
            const origin = findTaskOriginChain(tid);
            if (origin) parts.push(`      ^ origin: ${renderTaskOriginChain(origin)}`);
            const st = getTaskStampFields(tid);
            if (st) {
              const steps = renderStepFacts(st);
              parts.push(`      ^ state: ${renderTaskStamps(st)}${steps ? ` | ${steps}` : ''}`);
            }
            if (!st || st.last_answered_turn === null || !st.last_delivery_summary) {
              const ev = findDeliveryEvidenceForTask(tid);
              if (ev && (ev.artifacts.length > 0 || ev.deliveredVia.length > 0)) {
                parts.push(`      ^ ENGINE RECORD: appears already delivered (${renderDeliveryEvidence(ev)}); close it complete, do not redo.`);
              }
            }
          }
          totalShown += inProgress.length;
        }
        if (pending.length > 0) {
          parts.push('');
          parts.push(`On Deck Tasks (${pending.length}):`);
          for (const t of pending.slice(0, 10)) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          if (pending.length > 10) parts.push(`  ... and ${pending.length - 10} more`);
          totalShown += Math.min(pending.length, 10);
        }
        if (blocked.length > 0) {
          parts.push('');
          parts.push(`Blocked Tasks (${blocked.length}):`);
          for (const t of blocked) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += blocked.length;
        }

        const paused = listTasks({ status: 'paused', ...taskFilter });
        if (paused.length > 0) {
          parts.push('');
          parts.push(`Paused Tasks (${paused.length}):`);
          for (const t of paused) parts.push(taskRow(t as Parameters<typeof taskRow>[0]));
          totalShown += paused.length;
        }

        if (inProgress.length === 0 && pending.length === 0 && blocked.length === 0) {
          parts.push('');
          parts.push('No active tasks.');
        }
      }
    }

    // Trailer: always tell the agent how to drill in. In compact mode also
    // mention verbose=true.
    if (totalShown > 0) {
      parts.push('');
      if (verbose) {
        parts.push('Tip: tracker_get_status(id="<task_id>") for notes, depends_on, schedule, and full description.');
      } else {
        parts.push(`${totalShown} task/project row${totalShown === 1 ? '' : 's'} shown (compact). For full detail on one: tracker_get_status(id=<task_or_project_id>). For descriptions on every result: re-call tracker_list_active with verbose=true.`);
      }
    }

    return parts.join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerListActive failed', { error: msg }, agentId);
    return `Error listing active items: ${msg}`;
  }
}

// ── trackerCompleteStep ──

export function trackerCompleteStep(agentId: string, args: Record<string, unknown>): string {
  try {
    let rawTaskId = (args.taskId as string) ?? (args.task_id as string);
    if (!rawTaskId) {
      // task_id omitted. A single-task agent (the floor model working its one
      // assigned step) routinely leaves it off, and hard-erroring here failed
      // a behavioral run (sig a5307041). Resolve to the agent's ONE obvious
      // in-progress task when exactly one exists; never auto-pick when there
      // are multiple candidates (that would silently complete the wrong task).
      const db0 = getDb();
      const candidates = db0.prepare(
        "SELECT id, title FROM tasks WHERE assigned_to = ? AND status = 'in_progress'",
      ).all(agentId) as Array<{ id: string; title: string }>;
      if (candidates.length === 1) {
        rawTaskId = candidates[0].id;
      } else if (candidates.length === 0) {
        return 'Error: `task_id` is required, and you have no in-progress task to complete. Start a task first (tracker_update_status status="in_progress") or pass the task_id explicitly.';
      } else {
        const shown = candidates.map(c => `${c.id.slice(0, 8)} (${c.title})`).join(', ');
        return `Error: \`task_id\` is required. You have ${candidates.length} in-progress tasks, so I cannot guess which one to complete. Pass the task_id explicitly. Candidates: ${shown}`;
      }
    }

    const resolved = resolveTaskId(rawTaskId, agentId);
    if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
    const taskId = resolved.id;

    const notes = args.notes as string | undefined;
    const db = getDb();

    // Get the completed task
    const task = getTask(taskId);
    if (!task) return `Error: Task ${taskId} was deleted before completion could be recorded.`;

    // Guard: don't complete a paused task, it was intentionally put on hold
    if (task.status === 'paused') {
      return `Error: Task "${task.title}" is paused. It cannot be completed while paused. Unpause it first (tracker_update_status with status="in_progress") or ask ${getOwnerName()} for instructions.`;
    }

    // ── RC-17.3: recurring-aware refusal ──
    // tracker_complete_step is the project-step sequencer: it does a bare
    // updateTask(status='complete') with ZERO run bookkeeping. On a scheduled
    // recurring task that is fatal, it flips the row to 'complete' while the
    // scheduler's occurrence (task_runs row + schedule_status='running') stays
    // open, orphaning the run and skipping the per-run advance / PM validation.
    // Refuse and route the agent to the recurring-aware path instead of silently
    // corrupting the schedule state.
    const isScheduledRecurring = task.scheduleStatus !== 'unscheduled' && !!task.repeatInterval;
    if (isScheduledRecurring) {
      return (
        `Error: "${task.title}" (${taskId.slice(0, 8)}) is a scheduled recurring task, so it is not a project step to sequence. ` +
        `Do NOT use tracker_complete_step on it (that would leave the scheduler's run open and skip the per-run advance). ` +
        `To finish THIS run, call tracker_update_status(task_id="${taskId}", status="complete", result="...", evidence=[...]); the engine advances the schedule to the next run. ` +
        `To stop the whole recurring schedule (no more runs), call tracker_update_status(task_id="${taskId}", status="complete", complete_all_runs=true).`
      );
    }

    // Mark current task as complete
    updateTask(taskId, { status: 'complete', notes: notes ? `[Completed] ${notes}` : '[Completed]' });

    let nextTaskInfo = '';

    // Find and start the next step in the same project
    if (task.projectId && task.stepNumber !== null) {
      const nextStep = db.prepare(`
        SELECT id, title, step_number FROM tasks
        WHERE project_id = ? AND step_number > ? AND status = 'on_deck'
        ORDER BY step_number ASC
        LIMIT 1
      `).get(task.projectId, task.stepNumber) as { id: string; title: string; step_number: number } | undefined;

      if (nextStep) {
        updateTask(nextStep.id, { status: 'in_progress' });
        nextTaskInfo = `\nNext step started: "${nextStep.title}" (${nextStep.id}), step ${nextStep.step_number}, now in_progress.`;
      }
    }

    // Project-level completion is decided in ONE place: checkProjectCompletion.
    // It is the sole authority for the success-vs-fail-open call (D-K), so the
    // inline "mark complete" shortcut that used to live here is gone, it would
    // have flipped a project with fallen tasks straight to complete behind this
    // helper's back. Run it AFTER the next-step advance so an in_progress
    // successor keeps the project open, then turn the outcome into the tool's
    // status line (only when this completion did not itself start a next step).
    const projectOutcome = checkProjectCompletion(task.projectId, agentId);
    if (!nextTaskInfo && task.projectId) {
      if (projectOutcome === 'completed') {
        nextTaskInfo = '\nAll steps complete, project marked as complete!';
      } else if (projectOutcome === 'needs_attention') {
        nextTaskInfo = '\nAll remaining steps are closed, but at least one task fell. The project is left open and flagged for attention.';
      } else if (projectOutcome === 'still_open') {
        const remaining = db.prepare(`
          SELECT COUNT(*) as count FROM tasks
          WHERE project_id = ? AND status NOT IN ('complete', 'fallen')
        `).get(task.projectId) as { count: number };
        nextTaskInfo = `\nNo next sequential step found. ${remaining.count} task(s) remaining in project.`;
      }
    }

    // Notify primary agent of step completion
    notifyPrimaryAgent(
      `Step completed: "${task.title}"${nextTaskInfo}`,
      agentId,
    );

    logger.info('Step completed', { taskId, nextTaskInfo: nextTaskInfo.trim() }, agentId);
    return `[OK] task_id=${taskId} | status=complete\n\nStep completed: "${task.title}".${nextTaskInfo}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCompleteStep failed', { error: msg }, agentId);
    return `Error completing step: ${msg}`;
  }
}

// ── trackerEditProject ──
//
// Rename / re-describe a project. Until now, projects literally had no
// editable title, only status and currentPhase could be changed. Added
// so the PM agent can rename engine-auto-created projects (the multistep
// classifier names them with a slice of the user prompt; PM rewrites
// both project and first task to clean names on its next turn).

export function trackerEditProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId, agentId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

  const title = args.title as string | undefined;
  const description = args.description as string | null | undefined;

  if (title === undefined && description === undefined) {
    return 'Error: at least one of title or description must be provided.';
  }

  const project = getProject(projectId);
  if (!project) return `Error: Project ${projectId} was deleted before edit could be applied.`;

  const updates: Parameters<typeof updateProject>[1] = {};
  if (title !== undefined) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return 'Error: title cannot be empty.';
    updates.title = trimmed.slice(0, 200);
  }
  if (description !== undefined) {
    let next = description === null || description === '' ? null : String(description);
    // ENGINE_AUTO_MARKER is engine metadata, not model-editable: mechanisms key
    // on it structurally (same-turn scaffold close guard, the near-dup steer,
    // the unanswered-scaffold probe). If the CURRENT description carries the
    // marker, any rewrite keeps it as the prefix (2026-07-17: a PM description
    // rewrite stripped it and the scaffold stopped reading as engine-created).
    if (project.description?.startsWith(ENGINE_AUTO_MARKER) && (next === null || !next.startsWith(ENGINE_AUTO_MARKER))) {
      next = ENGINE_AUTO_MARKER + (next ?? '');
    }
    updates.description = next;
  }

  try {
    updateProject(projectId, updates);
    const fields = Object.keys(updates).join(', ');
    return `[OK] project_id=${projectId}\n\nProject updated. Fields changed: ${fields}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerEditProject failed', { projectId, error: msg }, agentId);
    return `Error editing project: ${msg}`;
  }
}

// ── trackerCloseProject ──
//
// One call to close a whole project AND every open task on it. The use case
// is "I abandoned this project / it duplicates something else / scope
// changed, just close it out cleanly." Without this tool, agents either
// leave tasks stranded forever in on_deck or have to loop calling
// tracker_update_status one task at a time.

export function trackerCloseProject(agentId: string, args: Record<string, unknown>): string {
  const rawProjectId = (args.project_id ?? args.projectId) as string | undefined;
  if (!rawProjectId) return 'Error: project_id is required.';

  const resolved = resolveProjectId(rawProjectId, agentId);
  if (!resolved.ok) return formatResolveError('project', rawProjectId, resolved);
  const projectId = resolved.id;

  // Default to status='cancelled', most calls to this tool are clean-up of
  // abandoned/duplicated projects rather than "we actually finished it."
  // Agents who really did finish all the work should pass status='complete'.
  const rawStatus = (args.status as string | undefined)?.toLowerCase() ?? 'cancelled';
  if (rawStatus !== 'complete' && rawStatus !== 'cancelled') {
    return 'Error: status must be either "complete" (all work was actually done) or "cancelled" (abandoned / duplicated / scope changed).';
  }
  const status = rawStatus as 'complete' | 'cancelled';

  const reason = (args.reason as string | undefined)?.trim();
  if (!reason || reason.length < 4) {
    return 'Error: reason is required (a short sentence on why this project is being closed, will be appended to every task as a note for the audit trail).';
  }

  const project = getProject(projectId);
  if (!project) return `Error: Project ${projectId} was deleted before close could be applied.`;

  try {
    const result = closeProjectAndOpenTasks({
      projectId,
      closingAgentId: agentId,
      taskStatus: status,
      projectStatus: status,
      reason,
    });
    notifyPrimaryAgent(
      `Project "${project.title}" was bulk-closed by ${agentId} (status=${status}). ${result.tasksClosed} open task(s) closed; ${result.alreadyClosed} were already terminal. Reason: ${reason}`,
      agentId,
    );
    return [
      `[OK] project_id=${projectId} | status=${status}`,
      ``,
      `Project "${project.title}" closed.`,
      `Tasks closed by this call: ${result.tasksClosed}`,
      `Tasks already in a terminal state (skipped): ${result.alreadyClosed}`,
      `Reason recorded on each closed task: ${reason}`,
    ].join('\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('trackerCloseProject failed', { projectId, error: msg }, agentId);
    return `Error closing project: ${msg}`;
  }
}

// ── trackerValidatePause (v2.7.18) ──
//
// PM-only tool. For each paused task with pause_validated=0, PM judges
// whether the pause is a real wait condition or gaming.
//
// On valid=true: pause_validated=1; task stays paused; PM stops surfacing
// the task as an UNVALIDATED_PAUSE issue.
//
// On valid=false: task is reverted to in_progress, the assigned agent
// gets a directive via send_to_agent explaining why their pause was
// rejected and what to do instead.

export async function trackerValidatePause(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(
    "SELECT id, title, status, assigned_to, notes, pause_validated, goal FROM tasks WHERE id = ?",
  ).get(taskId) as { id: string; title: string; status: string; assigned_to: string | null; notes: string | null; pause_validated: number; goal: string | null } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'paused') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "paused". Nothing to validate.`;
  }

  if (args.valid) {
    db.prepare("UPDATE tasks SET pause_validated = 1, updated_at = datetime('now') WHERE id = ?").run(taskId);
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'paused',
      toStatus: 'paused',
      actionTaken: 'tracker_validate(kind=pause, valid=true)',
      reason: 'PM blessed the pause as legitimate',
    });
    // Real-time dashboard sync: the validate-success path bypasses
    // updateTask() and writes the validation flag via direct SQL, so
    // we have to broadcast manually for the bug icon to clear without
    // a manual refresh.
    const fresh = getTask(taskId);
    if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
    logger.info('Pause validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Pause validated on "${task.title}" (${taskId}). PM will leave this task alone until the agent un-pauses it.`;
  }

  // Reject path. Revert to PM-chosen target_status (default in_progress) and notify the assigned agent.
  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence explanation for the agent (e.g. "no specific wait condition; you never actually asked the user anything").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck', 'blocked']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for a pause rejection. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  // Use updateTask so is_paused gets cleared and pause fields reset.
  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before pause-reject could land.`;
  // Increment revert_count and log the reject + transition.
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  // updateTask already broadcast with the status flip, but revert_count
  // moved after that broadcast, re-broadcast so the dashboard's copy
  // matches the row.
  const freshPauseReject = getTask(taskId);
  if (freshPauseReject) broadcast({ type: 'tracker:task_updated', data: freshPauseReject });
  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'paused',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate(kind=pause, valid=false)',
    reason: rejectReason,
  });
  // Check whether revert_count just crossed the stalemate threshold.
  await maybeTriggerStalemate(taskId, pmAgentId);

  // Direct A2A message to the assigned agent so they see the rejection on
  // their next turn. Fire-and-forget; if delivery fails, log and continue -
  // PM has done its part by reverting the status.
  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your pause on "${task.title}" (${taskId.slice(0, 8)}) was lifted back to in_progress, PM didn't see a real wait condition. This is a routine check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `Pick one and move: (a) finish the work and mark complete with result + evidence, (b) mark blocked with the real obstacle if you can't proceed, (c) ask the user a specific question and re-pause naming what you're waiting for. Don't re-pause with the same notes, PM will reject again.`;
      const { v4: uuidv4 } = await import('uuid');
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: uuidv4(),
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Failed to send pause-rejection notice to agent', {
        taskId, assignedTo: task.assigned_to,
        error: err instanceof Error ? err.message : String(err),
      }, pmAgentId);
    }
  }

  logger.info('Pause rejected by PM', { taskId, pmAgentId, rejectReason }, pmAgentId);
  return (
    `[OK] Pause rejected on "${task.title}" (${taskId}). Task reverted to in_progress. ` +
    `Rejection reason recorded: "${rejectReason}". ` +
    `${task.assigned_to ? `Notified ${task.assigned_to} via send_to_agent.` : 'Task has no assigned agent to notify.'}`
  );
}

// ── trackerRetask ──
//
// PM-only forward-leaning verb. Use when an agent's outcome on a task is
// wrong (work skipped, channel wrong, evidence missing, claim doesn't
// match goal) and you want them to redo it with specific guidance, 
// instead of just confirming a pause or rejecting a complete.
//
// Works from any status except 'cancelled'. Resets validation flags so
// the engine treats the next pass as fresh. Increments revert_count
// (this is functionally a PM revert). Delivers the directive over A2A
// to the assigned agent. May trigger stalemate if PM and agent are
// ping-ponging the same task.
//
// Required: directive >= 30 chars so PM can't fire a one-liner.

export async function trackerRetask(
  pmAgentId: string,
  args: { task_id: string; directive: string; target_status?: string; allow_regenerate?: boolean },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const directive = (args.directive ?? '').trim();
  if (directive.length < 30) {
    return 'Error: directive must be at least 30 characters. Tell the agent concretely what they did wrong and what to do instead (e.g. "you posted the brief in chat but the task specifies email delivery; please call send_email with the same content to user@example.com").';
  }

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(
    "SELECT id, title, status, assigned_to, goal, complete_validated, deliverable_shown FROM tasks WHERE id = ?",
  ).get(taskId) as { id: string; title: string; status: string; assigned_to: string | null; goal: string | null; complete_validated: number; deliverable_shown: number } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status === 'cancelled') {
    return `Error: task "${task.title}" (${taskId}) is cancelled. Cancelled tasks cannot be retasked. Create a new task instead.`;
  }
  // Delivered-work backstop (two-key restoration; replaces the old C2 block that
  // keyed on the forged complete_validated=1 flag). deliverable_shown=1 means the
  // assignee already delivered this task's result to the user in a reply.
  // Re-driving the assignee on it regenerates/overwrites work the user was already
  // shown, producing a divergent second version and a second "done". Refuse UNLESS
  // the PM explicitly opts in with allow_regenerate=true (the PM has judged the
  // delivered work genuinely misses the goal and a fresh pass is warranted). This
  // keys on the neutral fact marker, never on a completion flag, so it protects the
  // artifact without pretending the task closed.
  const deliveredProtection =
    task.deliverable_shown === 1 /* legacy rows, pre drive-boundary */ ||
    (task.status === 'complete' && task.complete_validated === 0) /* Key-1 filed, awaiting PM validation */;
  if (deliveredProtection && args.allow_regenerate !== true) {
    return `Error: task "${task.title}" (${taskId.slice(0, 8)}) already had its deliverable delivered to the user (deliverable_shown=1). Retasking it would regenerate and overwrite delivered work, producing a divergent second version. If the delivered work genuinely misses the goal and you want the assignee to redo it, re-call tracker_retask with allow_regenerate=true. Otherwise, if the delivery meets the goal, let the assignee close it out (tracker_update_status) and validate that with tracker_validate; if entirely new work is needed, create a NEW task with tracker_create_task.`;
  }
  if (!task.assigned_to) {
    return `Error: task "${task.title}" (${taskId}) has no assigned agent. Use tracker_reassign_task first, then retask.`;
  }

  const targetStatus = args.target_status ?? 'in_progress';
  const ALLOWED_TARGETS = new Set(['in_progress', 'on_deck']);
  if (!ALLOWED_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed for retask. Use 'in_progress' (default) or 'on_deck'.`;
  }

  // Drive status through updateTask so is_paused / pause fields reset
  // correctly when retasking out of paused.
  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before retask could land.`;

  // Reset validation flags so engine and PM treat the next pass as
  // fresh, and bump revert_count (a retask is a PM revert of the
  // agent's outcome). Done in one statement.
  db.prepare(`
    UPDATE tasks
    SET pause_validated = 0,
        complete_validated = 0,
        blocked_validated = 0,
        revert_count = revert_count + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  // Retask is a remediation: the PM is sending the agent back to redo the
  // work, which starts a fresh escalation cycle. Clear the poke_log so the
  // deterministic ladder re-arms from nudge(1) if this task stalls again.
  // Clearing at a remediation event (never mid-cycle) keeps the cross-restart
  // poke dedup intact.
  clearPokeLog(taskId);

  const fresh = getTask(taskId);
  if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'directive',
    fromStatus: task.status,
    toStatus: targetStatus,
    actionTaken: 'tracker_retask',
    reason: directive,
  });

  await maybeTriggerStalemate(taskId, pmAgentId);

  // Deliver the PM's directive to the assigned agent as a system-injected
  // user turn (same transport as validate_pause's reject path). Fire-
  // and-forget; PM has already moved the status.
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    const body =
      `PM retask on "${task.title}" (${taskId.slice(0, 8)}). Task is back to ${targetStatus}.\n\n` +
      `PM directive: ${directive}\n\n` +
      `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
      `Do the work the directive describes, then close out (tracker_update_status with status="complete", a clear result, and evidence pointing at the concrete artifact, file path, message id, tool_call_ref, etc.). Don't just acknowledge; do the thing.`;
    const { v4: uuidv4 } = await import('uuid');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: uuidv4(),
      requiresResponse: true,
      payload: body,
      toAgent: task.assigned_to,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Failed to deliver retask directive to agent', {
      taskId, assignedTo: task.assigned_to,
      error: err instanceof Error ? err.message : String(err),
    }, pmAgentId);
  }

  logger.info('Task retasked by PM', { taskId, pmAgentId, targetStatus, directiveLength: directive.length }, pmAgentId);
  return (
    `[OK] Retasked "${task.title}" (${taskId}) from ${task.status} to ${targetStatus}. ` +
    `Directive delivered to ${task.assigned_to}. revert_count incremented.`
  );
}

// ── trackerPauseSchedule ──

export function trackerPauseSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const markComplete = (args.mark_complete as boolean) ?? false;

  const db = getDb();
  const task = db.prepare('SELECT id, title, schedule_status, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; title: string; schedule_status: string; project_id: string } | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before pause could be applied.`;
  if (task.schedule_status === 'unscheduled') {
    return (
      `Refused: tracker_pause_schedule is for recurring/scheduled tasks only, "${task.title}" has no schedule. ` +
      `For a one-shot task: if the work is DONE, call tracker_update_status(task_id="${task.id}", status="complete"). ` +
      `If you're stuck, call tracker_update_status(..., status="blocked", notes="why"). ` +
      `If the task is no longer needed, call tracker_update_status(..., status="paused", resume_at="<ISO datetime>") to pause until a specific time, or, if you want it cleanly off the active board, tracker_close_project for whole-project cleanup. ` +
      `Pausing a one-shot task without a resume_at strands it: it sits in the Paused column, can\'t be completed without unpausing, and the PM stops watching it.`
    );
  }

  if (markComplete) {
    // Stop the schedule AND mark the task as complete (terminal state)
    db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'completed', status = 'complete', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
    db.prepare("UPDATE task_runs SET status = 'complete', completed_at = datetime('now'), result_summary = 'Schedule stopped and marked complete' WHERE task_id = ? AND status = 'running'").run(taskId);
    const freshSchedDone = getTask(taskId);
    if (freshSchedDone) broadcast({ type: 'tracker:task_updated', data: freshSchedDone });
    logger.info('Schedule paused and task marked complete', { taskId }, agentId);
    checkProjectCompletion(task.project_id, agentId);
    return `Schedule stopped and task "${task.title}" marked complete.`;
  }

  db.prepare("UPDATE tasks SET is_paused = 1, schedule_status = 'paused', status = 'paused', updated_at = datetime('now') WHERE id = ?").run(taskId);
  const freshSchedPaused = getTask(taskId);
  if (freshSchedPaused) broadcast({ type: 'tracker:task_updated', data: freshSchedPaused });
  logger.info('Schedule paused', { taskId }, agentId);
  return `Schedule paused for "${task.title}". Status set to "paused", stale detection and PM monitoring will ignore it until resumed.`;
}

// ── trackerResumeSchedule ──

export function trackerResumeSchedule(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = args.taskId as string;
  if (!rawTaskId) return 'Error: taskId is required';

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} was deleted before resume could be applied.`;

  
  const scheduledTask = {
    id: task.id as string,
    scheduled_start: task.scheduled_start as string | null,
    repeat_interval: task.repeat_interval as number | null,
    repeat_unit: task.repeat_unit as string | null,
    repeat_end_type: task.repeat_end_type as string | null,
    repeat_end_value: task.repeat_end_value as string | null,
    run_count: (task.run_count as number) ?? 0,
    is_paused: 0, // pretend unpaused for calculation
    last_run_at: task.last_run_at as string | null,
    next_run_at: null,
    schedule_status: 'waiting',
    anchor_time: task.anchor_time as string | null,
  };

  const nextRun = calculateNextRun(scheduledTask);
  // missed_runs_paused_at = NULL: an explicit resume also disarms the D12
  // engine fallback for a pause the missed-runs detector set.
  db.prepare("UPDATE tasks SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck', next_run_at = ?, missed_runs_paused_at = NULL, updated_at = datetime('now') WHERE id = ?").run(nextRun, taskId);
  const freshResumed = getTask(taskId);
  if (freshResumed) broadcast({ type: 'tracker:task_updated', data: freshResumed });

  logger.info('Schedule resumed', { taskId, nextRun }, agentId);
  return `Schedule resumed for "${task.title as string}". Next run: ${nextRun ?? 'none'}`;
}

// ── trackerResolveMissedRuns (v2.5.45) ──
// Called by the assigned agent after the scheduler fires a "missed runs"
// alert. Three actions: run_now, skip, pause. See the alert text in
// runner.ts / alertMissedRuns for the semantics.

export function trackerResolveMissedRuns(agentId: string, args: Record<string, unknown>): string {
  const rawTaskId = (args.task_id ?? args.taskId) as string | undefined;
  if (!rawTaskId) return 'Error: task_id is required.';
  const action = args.action as string | undefined;
  if (!action || !['run_now', 'skip', 'pause'].includes(action)) {
    return 'Error: action must be one of: "run_now", "skip", "pause".';
  }

  const resolved = resolveTaskId(rawTaskId, agentId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
  if (!task) return `Error: Task ${taskId} no longer exists.`;
  const title = (task.title as string) ?? '(untitled)';

  if (action === 'pause') {
    // Already paused by the alert handler; confirm and exit. D12: clear
    // missed_runs_paused_at so the engine's auto-skip fallback stands down.
    // The agent explicitly chose to keep the task paused, and the model
    // tool takes precedence over the fallback when called first.
    db.prepare(`
      UPDATE tasks SET missed_runs_paused_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND missed_runs_paused_at IS NOT NULL
    `).run(taskId);
    logger.info('Missed-runs resolved: pause', { taskId }, agentId);
    return `OK: task "${title}" stays paused. The user can resume it from the dashboard, or you can later call tracker_resume_schedule.`;
  }

  if (action === 'skip') {
    // Compute next future anchor (strictly > now). calculateNextRun
    // already does this when fed an unpaused snapshot, its inner loop
    // walks the anchor forward until it lands in the future.
    const scheduledTask: ScheduledTask = {
      id: task.id as string,
      scheduled_start: task.scheduled_start as string | null,
      repeat_interval: task.repeat_interval as number | null,
      repeat_unit: task.repeat_unit as string | null,
      repeat_end_type: task.repeat_end_type as string | null,
      repeat_end_value: task.repeat_end_value as string | null,
      run_count: (task.run_count as number) ?? 0,
      is_paused: 0,
      last_run_at: new Date().toISOString(), // pretend a run just happened, so the loop skips current slot
      next_run_at: null,
      schedule_status: 'waiting',
      repeat_days_of_week: task.repeat_days_of_week as string | null,
      anchor_time: task.anchor_time as string | null,
    };
    const nextRun = calculateNextRun(scheduledTask);
    if (!nextRun) {
      // End conditions reached or anchor unset, leave paused.
      return `Could not compute a next-run for "${title}" (likely past repeat_end_value or anchor missing). Task stays paused; investigate manually.`;
    }
    db.prepare(`
      UPDATE tasks
      SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck',
          next_run_at = ?, missed_runs_paused_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextRun, taskId);
    logger.info('Missed-runs resolved: skip', { taskId, nextRun }, agentId);
    return `OK: task "${title}" unpaused. All missed slots skipped. Next run: ${nextRun}.`;
  }

  // action === 'run_now': fire one catch-up run immediately. Set
  // next_run_at to now so the next scheduler tick picks it up. After
  // that run completes, onTaskRunComplete will compute the natural
  // next anchor and the task resumes its normal cadence.
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE tasks
    SET is_paused = 0, schedule_status = 'waiting', status = 'on_deck',
        next_run_at = ?, missed_runs_paused_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(nowIso, taskId);
  logger.info('Missed-runs resolved: run_now', { taskId }, agentId);
  return `OK: task "${title}" unpaused and scheduled to fire on the next scheduler tick (within ~1 minute). Schedule resumes on its normal anchor after this run completes.`;
}

/**
 * tracker_apply_user_validation, used by the primary agent when the user
 * replies to a "[VALIDATION CHECK]" system message in chat. The user is
 * telling us whether work that's been sitting unvalidated is actually
 * done or not.
 *
 * Args:
 *   - task_id: the task being validated
 *   - validated: true if user confirmed it's actually done; false to revert
 *   - user_quote: the user's exact reply for audit
 *   - feedback: optional feedback to relay to the assigned agent when
 *     validated=false (e.g. "no, the script didn't actually run; rerun it")
 *
 * On validated=true: flips the matching *_validated flag to 1, logs as
 * from_entity='user' via primary, clears the bug icon. Mirrors the
 * dashboard /user-validate endpoint.
 *
 * On validated=false: reverts to in_progress, increments revert_count,
 * appends feedback as an observation entry, A2A-pings the assigned agent
 * with the feedback. The assigned agent picks up where they left off.
 */
export async function trackerApplyUserValidation(
  callerAgentId: string,
  args: { task_id: string; validated: boolean; user_quote: string; feedback?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const userQuote = (args.user_quote ?? '').trim();
  if (!userQuote) return 'Error: user_quote is required (the user\'s exact reply, for the audit trail).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, complete_validated, pause_validated, blocked_validated, validation_thread_id
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    complete_validated: number; pause_validated: number; blocked_validated: number;
    validation_thread_id: string | null;
  } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;
  // P5b: the verdict ask recorded WHICH conversation it went to
  // (validation_thread_id = the owner conversation id). Soft continuity
  // check, first release: verify the applying turn's served ask lives in that
  // conversation; log + audit on mismatch, never block (legacy escalations
  // carry random uuids).
  try {
    const root = currentTurnRoot.get(callerAgentId);
    if (task.validation_thread_id && root?.sourceMessageId) {
      const askRow = db.prepare('SELECT conversation_id FROM messages WHERE id = ?')
        .get(root.sourceMessageId) as { conversation_id: string | null } | undefined;
      if (askRow?.conversation_id && askRow.conversation_id !== task.validation_thread_id) {
        logger.warn('user-verdict continuity: the applying reply came from a DIFFERENT conversation than the verdict ask', {
          taskId, askConversation: askRow.conversation_id, verdictConversation: task.validation_thread_id,
        });
        const { writeTaskLog } = await import('./task-log.js');
        try {
          writeTaskLog({ taskId, fromEntity: 'engine', entryKind: 'observation',
            reason: 'verdict-continuity mismatch (soft)', note: `reply conv ${askRow.conversation_id} != ask conv ${task.validation_thread_id}` });
        } catch { /* audit only */ }
      }
    }
  } catch { /* soft check only */ }

  let flagColumn: 'complete_validated' | 'pause_validated' | 'blocked_validated' | null = null;
  if (task.status === 'complete') flagColumn = 'complete_validated';
  else if (task.status === 'paused') flagColumn = 'pause_validated';
  else if (task.status === 'blocked') flagColumn = 'blocked_validated';
  if (!flagColumn) {
    return `Error: task "${task.title}" (${taskId.slice(0, 8)}) is currently status="${task.status}". User-validation only applies to complete/paused/blocked.`;
  }

  if (args.validated) {
    db.prepare(`UPDATE tasks SET ${flagColumn} = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync after direct SQL flag-set.
    const freshUserValid = getTask(taskId);
    if (freshUserValid) broadcast({ type: 'tracker:task_updated', data: freshUserValid });
    writeTaskLog({
      taskId,
      fromEntity: 'user',
      entryKind: 'transition',
      fromStatus: task.status,
      toStatus: task.status,
      actionTaken: `apply_user_validation via ${callerAgentId} (${flagColumn}=1)`,
      reason: 'user confirmed in chat reply',
      note: userQuote,
    });
    logger.info('User validation applied via chat reply', { taskId, callerAgentId, flagColumn }, callerAgentId);
    return `[OK] task "${task.title}" (${taskId.slice(0, 8)}) marked validated by user (${flagColumn}=1). Bug icon cleared.`;
  }

  // Reject path: revert to in_progress, add feedback as observation, ping the assigned agent.
  const feedback = (args.feedback ?? '').trim();
  const updated = updateTask(taskId, { status: 'in_progress' });
  if (!updated) return `Error: task ${taskId} was deleted before user-revert could land.`;
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  const freshUserReject = getTask(taskId);
  if (freshUserReject) broadcast({ type: 'tracker:task_updated', data: freshUserReject });

  writeTaskLog({
    taskId,
    fromEntity: 'user',
    entryKind: 'reject',
    fromStatus: task.status,
    toStatus: 'in_progress',
    actionTaken: `apply_user_validation via ${callerAgentId} (validated=false)`,
    reason: feedback || 'user said work was not actually done',
    note: userQuote,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `User reviewed task "${task.title}" (${taskId.slice(0, 8)}) and said it is NOT actually ${task.status}. ` +
        `User's reply: "${userQuote}". ` +
        (feedback ? `Feedback to address: ${feedback}. ` : '') +
        `Task is back to in_progress. Address the feedback, then resubmit with proper result + evidence.`;
      await deliverA2AMessage({
        intent: 'ASSIGN',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: callerAgentId,
      });
    } catch (err) {
      logger.warn('apply_user_validation: A2A delivery to assigned agent failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info('User reverted via chat reply', { taskId, callerAgentId, hasFeedback: feedback.length > 0 }, callerAgentId);
  return `[OK] task "${task.title}" (${taskId.slice(0, 8)}) reverted to in_progress. Assigned agent (${task.assigned_to ?? 'unassigned'}) notified with the feedback.`;
}

// ──────────────────────────────────────────────────────────────────────
// Phase B.1: validation + override + user-verdict tools
// ──────────────────────────────────────────────────────────────────────

const USER_VERDICT_THRESHOLDS: Record<string, number> = {
  high: 2,
  normal: 3,
  low: 5,
};

const ALLOWED_REJECT_TARGETS = new Set(['in_progress', 'on_deck', 'blocked']);

// Hard-gate circuit-breaker. Counts consecutive engine hard-gate
// rejections per (task, agent). After HARD_GATE_BREAKER_LIMIT, the
// engine auto-queues an OVERRIDE_REQUEST on the agent's behalf and the
// thrashing stops. In-memory is fine: a server restart resets all
// counters and the agent gets fresh chances. Phase B.1.
const HARD_GATE_BREAKER_LIMIT = 3;
interface BreakerState {
  count: number;
  reasons: string[];
  firstAt: number;
}
const hardGateBreaker = new Map<string, BreakerState>();
function breakerKey(taskId: string, agentId: string): string {
  return `${taskId}::${agentId}`;
}
/**
 * Record one hard-gate rejection. Returns a suffix string to append to
 * the agent-facing error. After the limit hits, the suffix tells the
 * agent the engine queued an override on their behalf.
 */
function noteHardGateRejection(taskId: string, agentId: string, reason: string): string {
  const key = breakerKey(taskId, agentId);
  const prev = hardGateBreaker.get(key);
  const next: BreakerState = prev
    ? { count: prev.count + 1, reasons: [...prev.reasons, reason].slice(-HARD_GATE_BREAKER_LIMIT), firstAt: prev.firstAt }
    : { count: 1, reasons: [reason], firstAt: Date.now() };
  hardGateBreaker.set(key, next);

  if (next.count >= HARD_GATE_BREAKER_LIMIT) {
    // Auto-queue an OVERRIDE_REQUEST on the agent's behalf.
    try {
      const justification =
        `Engine hard-gate circuit-breaker auto-fired after ${next.count} consecutive same-task hard-gate rejections by ${agentId}. ` +
        `Last reasons (most recent first): ${next.reasons.slice().reverse().join(' | ')}. ` +
        `Either the agent is misinterpreting the schema or the engine is wrong; PM should decide.`;
      const db = getDb();
      const existing = db.prepare(`
        SELECT id FROM task_override_requests
        WHERE task_id = ? AND requested_by = ? AND status = 'pending'
        LIMIT 1
      `).get(taskId, agentId) as { id: string } | undefined;
      if (!existing) {
        const id = uuidv4();
        db.prepare(`
          INSERT INTO task_override_requests
            (id, task_id, requested_by, requested_status, justification, last_engine_error, attempts_attached, status, created_at)
          VALUES (?, ?, ?, 'complete', ?, ?, ?, 'pending', datetime('now'))
        `).run(id, taskId, agentId, justification, reason, next.count);
        writeTaskLog({
          taskId,
          fromEntity: 'engine',
          entryKind: 'override',
          actionTaken: 'hard-gate circuit-breaker auto-fired',
          reason: justification,
        });
        logger.warn('Hard-gate circuit-breaker fired', { taskId, agentId, count: next.count }, agentId);
      }
    } catch (err) {
      logger.warn('Circuit-breaker auto-override queue failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    // Reset after firing so the agent doesn't loop on the breaker too.
    hardGateBreaker.delete(key);
    return ` (Circuit-breaker: engine queued an OVERRIDE_REQUEST on your behalf after ${HARD_GATE_BREAKER_LIMIT} consecutive hard-gate rejections on this task. Stop retrying; wait for PM to resolve.)`;
  }
  return ` (Attempt ${next.count}/${HARD_GATE_BREAKER_LIMIT} before circuit-breaker auto-queues an override.)`;
}
/**
 * Reset the breaker for a (task, agent) pair. Called when the hard gate
 * accepts a transition, the agent is back in a good state.
 */
function clearHardGateBreaker(taskId: string, agentId: string): void {
  hardGateBreaker.delete(breakerKey(taskId, agentId));
}

/**
 * Helper: after PM rejects a transition, see if revert_count has reached
 * the per-priority stalemate threshold. If so, flip awaiting_user_verdict
 * and dispatch a directive A2A to the assigned agent telling them to
 * call tracker_request_user_verdict.
 */
async function maybeTriggerStalemate(taskId: string, pmAgentId: string): Promise<void> {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, title, status, priority, assigned_to, revert_count, awaiting_user_verdict
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; priority: string;
    assigned_to: string | null; revert_count: number; awaiting_user_verdict: number;
  } | undefined;
  if (!row) return;
  if (row.awaiting_user_verdict === 1) return;
  const threshold = USER_VERDICT_THRESHOLDS[row.priority] ?? USER_VERDICT_THRESHOLDS.normal;
  if (row.revert_count < threshold) return;

  db.prepare(`
    UPDATE tasks
    SET awaiting_user_verdict = 1,
        user_verdict_requested_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);

  writeTaskLog({
    taskId,
    fromEntity: 'engine',
    entryKind: 'user_verdict_request',
    actionTaken: 'awaiting_user_verdict set',
    reason: `stalemate after ${row.revert_count} reverts (priority=${row.priority}, threshold=${threshold})`,
  });

  logger.warn('Stalemate triggered: awaiting_user_verdict set', {
    taskId, priority: row.priority, revertCount: row.revert_count, threshold,
  }, pmAgentId);

  if (!row.assigned_to) return;
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    const directive =
      `STALEMATE on task "${row.title}" (${taskId.slice(0, 8)}). ` +
      `Your submissions have been rejected ${row.revert_count} times (priority=${row.priority}, threshold=${threshold}). ` +
      `Call tracker_request_user_verdict with task_id="${taskId}", status_requested="<the status you believe is correct>", ` +
      `agent_summary="<one-paragraph recap of what you did>", and ` +
      `pm_rejection_summary="<one-paragraph recap of PM's stated objections>". ` +
      `The user will make the final call. While awaiting_user_verdict=1 the PM will leave this task alone, do not retry the rejected transition.`;
    await deliverA2AMessage({
      intent: 'ASSIGN',
      threadId: '',
      requiresResponse: true,
      payload: directive,
      toAgent: row.assigned_to,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Stalemate directive A2A delivery failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * tracker_validate, PM-only.
 *
 * Mirrors trackerValidatePause. On valid=true, complete_validated=1
 * fires, the dependency cascade runs, and (for recurring tasks) the
 * per-run archive-and-reset path takes over instead of terminal close.
 * On valid=false, the task reverts to target_status (default
 * in_progress), revert_count++, directive A2A goes to the assigned
 * agent, maybeTriggerStalemate fires if the threshold is hit.
 */
export async function trackerValidateComplete(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, priority, project_id, repeat_interval,
           next_run_at, complete_validated, result, evidence_json, goal
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    priority: string; project_id: string | null; repeat_interval: number | null;
    next_run_at: string | null; complete_validated: number;
    result: string | null; evidence_json: string | null; goal: string | null;
  } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'complete') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "complete". Nothing to validate.`;
  }
  if (task.complete_validated === 1) {
    return `Error: task "${task.title}" (${taskId}) is already complete_validated=1. No-op.`;
  }

  // Phase B.1: if there is a pending OVERRIDE_REQUEST on this task, the
  // agent has explicitly asked PM to make a judgment call. Validating the
  // underlying close without resolving the override leaves the override
  // queue stale and bypasses the structured ask. Refuse and direct PM to
  // tracker_override(override_request_id=..., approve=true|false).
  const pendingOverride = db.prepare(`
    SELECT id FROM task_override_requests
    WHERE task_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(taskId) as { id: string } | undefined;
  if (pendingOverride) {
    return (
      `Error: task "${task.title}" (${taskId.slice(0, 8)}) has a pending OVERRIDE_REQUEST (id=${pendingOverride.id.slice(0, 8)}). ` +
      `Resolve that first via tracker_override(override_request_id="${pendingOverride.id}", approve=true|false, reason="..."). ` +
      `Validating directly here would leave the override queue stale.`
    );
  }

  if (args.valid) {
    // Recurring-task branch: archive this run's result/evidence, then let
    // the scheduler's onTaskRunComplete decide whether to advance the
    // schedule (more runs) or close terminal. Previously this branch
    // used `task.next_run_at === null` to detect terminal, but the
    // scheduler doesn't null next_run_at on terminal close, so the
    // detection misfired and the PM mis-routed terminal closes through
    // the per-run reset, leaving inconsistent state. Now we just run
    // the same advance the scheduler would and observe the outcome.
    const isRecurring = task.repeat_interval !== null;

    if (isRecurring) {
      // Archive this run's result/evidence to task_log BEFORE clearing
      // them, preserves the per-run history.
      writeTaskLog({
        taskId,
        fromEntity: 'pm',
        entryKind: 'transition',
        fromStatus: 'complete',
        toStatus: 'pending-advance',
        actionTaken: `tracker_validate(kind=complete, valid=true), recurring per-run`,
        reason: 'PM blessed this run',
        note: task.result,
        evidenceJson: task.evidence_json,
      });
      // Clear result/evidence so the next run starts fresh.
      db.prepare(`UPDATE tasks SET result = NULL, evidence_json = NULL, updated_at = datetime('now') WHERE id = ?`).run(taskId);
      // Advance the schedule. onTaskRunComplete:
      //   - marks the running task_run row complete
      //   - increments run_count
      //   - calls calculateNextRun
      //   - sets status=on_deck + schedule_status=waiting (more runs), OR
      //     status=complete + schedule_status=completed (terminal)
      let advanced = false;
      try {
        const { onTaskRunComplete } = await import('../scheduler/runner.js');
        advanced = await onTaskRunComplete(taskId, 'complete', '(PM validated this run)');
      } catch (err) {
        logger.warn('onTaskRunComplete failed during recurring validate (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
      // Read back and decide which return path applies.
      const after = getTask(taskId);
      if (!after) {
        return `Error: task ${taskId} disappeared during recurring validate.`;
      }
      // ── RC-17.7: terminal misdetection fix ──
      // onTaskRunComplete NO-OPS when there is no open run (already closed /
      // advanced elsewhere) and leaves the row at its pre-existing 'complete'.
      // The old detector used `after.status === 'complete'`, so a no-op read as a
      // fresh terminal close and killed the ENTIRE recurring schedule
      // (complete_validated=1). Require a REAL advance: onTaskRunComplete must
      // have actually closed a run (advanced===true). If it did not, leave the
      // schedule fully intact and report the no-op honestly.
      if (!advanced) {
        logger.info('Recurring validate found no open run to advance (no-op); schedule left intact', { taskId, pmAgentId }, pmAgentId);
        return (
          `[NO-OP] No open run to validate on "${task.title}" (${taskId.slice(0, 8)}). ` +
          `This occurrence was already closed or advanced, so nothing changed and the recurring schedule was left intact. ` +
          `You do not need to re-validate already-closed runs; wait for the next scheduled fire if one is due.`
        );
      }
      // A genuine terminal close is signalled by schedule_status='completed'
      // (no further runs). A per-run advance leaves schedule_status='waiting'.
      const wasTerminal = after.scheduleStatus === 'completed';
      if (wasTerminal) {
        // Terminal close: flip complete_validated=1, run dep cascade.
        db.prepare(`UPDATE tasks SET complete_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
        const final = getTask(taskId);
        if (final) broadcast({ type: 'tracker:task_updated', data: final });
        try {
          const { checkDependencies } = await import('./pm-agent.js');
          checkDependencies(taskId);
        } catch (err) {
          logger.warn('checkDependencies failed after terminal recurring validate (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
        }
        try {
          checkProjectCompletion(task.project_id, pmAgentId);
        } catch { /* best-effort */ }
        logger.info('Recurring task terminal close validated by PM', { taskId, pmAgentId }, pmAgentId);
        return `[OK] Final run validated on "${task.title}" (${taskId.slice(0, 8)}). Recurring task closed terminal.`;
      }
      // Per-run advance: next run will need its own validation.
      const fresh = getTask(taskId);
      if (fresh) broadcast({ type: 'tracker:task_updated', data: fresh });
      logger.info('Per-run validation success, schedule advanced', { taskId, pmAgentId, runCount: after.runCount, nextRunAt: after.nextRunAt }, pmAgentId);
      return `[OK] Per-run validation success on "${task.title}" (${taskId.slice(0, 8)}). Schedule advanced to next run at ${after.nextRunAt ?? '(unknown)'}.`;
    }

    // Terminal close path: flip complete_validated=1, run dep cascade, notify parent.
    db.prepare(`UPDATE tasks SET complete_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync: complete_validated=1 cleared via direct SQL, not updateTask.
    const freshTerminal = getTask(taskId);
    if (freshTerminal) broadcast({ type: 'tracker:task_updated', data: freshTerminal });
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'complete',
      toStatus: 'complete',
      actionTaken: 'tracker_validate(kind=complete, valid=true), terminal',
      reason: 'PM blessed the complete',
    });
    try {
      const { checkDependencies } = await import('./pm-agent.js');
      checkDependencies(taskId);
    } catch (err) {
      logger.warn('checkDependencies failed after validate_complete (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
    // Project rollup if every sibling on the project is also validated-complete or terminal.
    try {
      checkProjectCompletion(task.project_id, pmAgentId);
    } catch { /* best-effort */ }

    logger.info('Complete validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Complete validated on "${task.title}" (${taskId}). Dependency cascade fired. Parent notified.`;
  }

  // Reject path.
  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence directive for the agent (e.g. "evidence does not show field-15 was migrated; finish that field and resubmit").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  if (!ALLOWED_REJECT_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before complete-reject could land.`;
  // Clear stale result/evidence on revert so the agent can resubmit cleanly.
  db.prepare(`
    UPDATE tasks
    SET revert_count = revert_count + 1,
        result = NULL,
        evidence_json = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId);
  // updateTask broadcast with stale result/evidence/revert_count above, 
  // re-broadcast so the dashboard's evidence panel reflects the cleared
  // state.
  const freshCompleteReject = getTask(taskId);
  if (freshCompleteReject) broadcast({ type: 'tracker:task_updated', data: freshCompleteReject });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'complete',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate(kind=complete, valid=false)',
    reason: rejectReason,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your complete on "${task.title}" (${taskId.slice(0, 8)}) was reverted to ${targetStatus} for a recheck, this is a routine PM check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `To close this out: address what PM flagged, then call tracker_update_status(status='complete') again with a clear result + evidence pointing at the concrete work (file paths, tool_call_ref, output paste, external_action). You don't have to redo work that's already done, just fix the gap PM named. PM validates fast when the evidence matches the goal. revert_count=${(updated as { revertCount?: number }).revertCount ?? '(incremented)'}.`;
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Reject directive A2A delivery failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await maybeTriggerStalemate(taskId, pmAgentId);

  logger.info('Complete rejected by PM', { taskId, pmAgentId, rejectReason, targetStatus }, pmAgentId);
  return `[OK] Complete rejected on "${task.title}" (${taskId}). Task reverted to "${targetStatus}". Reason logged: "${rejectReason}". ${task.assigned_to ? `Notified ${task.assigned_to} via send_to_agent.` : ''}`;
}

/**
 * tracker_validate, PM-only. Mirror of validate_complete for the
 * blocked transition. Bless or revert.
 */
export async function trackerValidateBlocked(
  pmAgentId: string,
  args: { task_id: string; valid: boolean; reject_reason?: string; target_status?: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';

  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status, assigned_to, priority, blocked_validated, goal
    FROM tasks WHERE id = ?
  `).get(taskId) as {
    id: string; title: string; status: string; assigned_to: string | null;
    priority: string; blocked_validated: number; goal: string | null;
  } | undefined;

  if (!task) return `Error: task ${taskId} not found.`;
  if (task.status !== 'blocked') {
    return `Error: task "${task.title}" (${taskId}) is currently status="${task.status}", not "blocked". Nothing to validate.`;
  }
  if (task.blocked_validated === 1) {
    return `Error: task "${task.title}" (${taskId}) is already blocked_validated=1. No-op.`;
  }

  if (args.valid) {
    db.prepare(`UPDATE tasks SET blocked_validated = 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
    // Real-time sync: blocked_validated flag set via direct SQL.
    const freshBlocked = getTask(taskId);
    if (freshBlocked) broadcast({ type: 'tracker:task_updated', data: freshBlocked });
    writeTaskLog({
      taskId,
      fromEntity: 'pm',
      entryKind: 'transition',
      fromStatus: 'blocked',
      toStatus: 'blocked',
      actionTaken: 'tracker_validate(kind=blocked, valid=true)',
      reason: 'PM blessed the block as real',
    });
    // comms-audit (actionable-but-invisible correctness bug): this is an ACTIONABLE
    // notice, the primary is told to "surface to the user or unblock manually", but it
    // used to go through notifyPrimaryAgent (role='system'), which the model-context
    // builder SKIPS, so the primary's model never saw it and could never take either
    // action. Route it through the model-visible awareness lane (postAgentNotice) so the
    // primary actually sees it and can act.
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'PM',
      intent: 'block_validated',
      brief: `I confirmed the block on "${task.title}" (${taskId.slice(0, 8)}) is a real obstacle. Please surface it to the user or unblock it manually.`,
    });
    logger.info('Block validated by PM', { taskId, pmAgentId }, pmAgentId);
    return `[OK] Block validated on "${task.title}" (${taskId}). Primary notified to investigate or unblock.`;
  }

  const rejectReason = (args.reject_reason ?? '').trim();
  if (!rejectReason) {
    return 'Error: reject_reason is required when valid=false. One-sentence directive (e.g. "you have not actually asked the user, do that first" or "this is a workaround not a block").';
  }
  const targetStatus = args.target_status ?? 'in_progress';
  if (!ALLOWED_REJECT_TARGETS.has(targetStatus)) {
    return `Error: target_status="${targetStatus}" is not allowed. Use 'in_progress' (default), 'on_deck', or 'blocked'.`;
  }

  const updated = updateTask(taskId, { status: targetStatus });
  if (!updated) return `Error: task ${taskId} was deleted before block-reject could land.`;
  db.prepare(`UPDATE tasks SET revert_count = revert_count + 1, updated_at = datetime('now') WHERE id = ?`).run(taskId);
  // Re-broadcast so revert_count reaches the dashboard.
  const freshBlockReject = getTask(taskId);
  if (freshBlockReject) broadcast({ type: 'tracker:task_updated', data: freshBlockReject });

  writeTaskLog({
    taskId,
    fromEntity: 'pm',
    entryKind: 'reject',
    fromStatus: 'blocked',
    toStatus: targetStatus,
    actionTaken: 'tracker_validate(kind=blocked, valid=false)',
    reason: rejectReason,
  });

  if (task.assigned_to) {
    try {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const directive =
        `Your block on "${task.title}" (${taskId.slice(0, 8)}) was reverted to ${targetStatus}, PM didn't see a real obstacle. Routine check, not a penalty.\n\n` +
        `PM's reason: ${rejectReason}\n\n` +
        `Task goal: ${task.goal ?? '(none recorded)'}\n\n` +
        `Address what PM flagged, then either complete with result + evidence, or re-block with a clearer reason naming the specific obstacle. Don't re-block with the same notes, PM will reject again.`;
      await deliverA2AMessage({
        intent: 'QUESTION',
        threadId: '',
        requiresResponse: true,
        payload: directive,
        toAgent: task.assigned_to,
        fromAgent: pmAgentId,
      });
    } catch (err) {
      logger.warn('Block reject directive A2A delivery failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await maybeTriggerStalemate(taskId, pmAgentId);

  logger.info('Block rejected by PM', { taskId, pmAgentId, rejectReason, targetStatus }, pmAgentId);
  return `[OK] Block rejected on "${task.title}" (${taskId}). Task reverted to "${targetStatus}".`;
}

/**
 * tracker_request_override, agent-side. Queues a request for PM (or
 * the user via dashboard) to manually force a status change that the
 * engine's hard gate refused, or that the agent thinks should land
 * despite a PM rejection.
 *
 * Rate limit: at most one pending request per (task, agent). A second
 * call while one is still pending returns an error referencing the
 * prior request id.
 *
 * Also called by the engine when the hard-gate circuit-breaker fires
 * (3 consecutive same-task hard-gate rejections by the same agent).
 */
export function trackerRequestOverride(
  agentId: string,
  args: { task_id: string; requested_status: string; justification: string },
): string {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const requestedStatus = (args.requested_status ?? '').trim();
  if (!requestedStatus) return 'Error: requested_status is required.';

  const justification = (args.justification ?? '').trim();
  if (justification.length < 30) {
    return 'Error: justification must be at least 30 characters. Explain in one sentence why the engine was wrong or why PM should reconsider (e.g. "tool_call id from 3 days ago, audit log rotated, artifact at /tmp/foo.sh still exists and was created by the call").';
  }

  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM task_override_requests
    WHERE task_id = ? AND requested_by = ? AND status = 'pending'
    LIMIT 1
  `).get(taskId, agentId) as { id: string } | undefined;
  if (existing) {
    return `Error: you already have a pending override request on this task (id=${existing.id.slice(0, 8)}). Wait for PM to resolve it before requesting again.`;
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO task_override_requests
      (id, task_id, requested_by, requested_status, justification, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(id, taskId, agentId, requestedStatus, justification);

  writeTaskLog({
    taskId,
    fromEntity: `agent:${agentId}`,
    entryKind: 'override',
    actionTaken: 'tracker_request_override',
    reason: justification,
    toStatus: requestedStatus,
  });

  logger.info('Override request queued', { taskId, agentId, requestedStatus, requestId: id }, agentId);
  return `[OK] override request queued (id=${id.slice(0, 8)}). PM will review on next tick. If no resolution within 12 hours the request auto-denies.`;
}

/**
 * tracker_override, PM-only. Resolves a queued OVERRIDE_REQUEST by
 * either approving (force the requested status through, bypassing the
 * engine hard gate) or denying (the engine was right; notify the
 * agent).
 *
 * Distinct from PM bare tracker_update_status: bare update_status is
 * proactive PM action with no pending request. Override resolves an
 * explicit ask.
 */
export async function trackerOverride(
  pmAgentId: string,
  args: { override_request_id: string; approve: boolean; reason: string },
): Promise<string> {
  const requestId = (args.override_request_id ?? '').trim();
  if (!requestId) return 'Error: override_request_id is required.';

  const reason = (args.reason ?? '').trim();
  if (!reason) return 'Error: reason is required (one sentence on why you approved or denied).';

  const db = getDb();
  const req = db.prepare(`
    SELECT id, task_id, requested_by, requested_status, justification, status
    FROM task_override_requests WHERE id = ? OR id LIKE ?
    LIMIT 1
  `).get(requestId, `${requestId}%`) as {
    id: string; task_id: string; requested_by: string;
    requested_status: string; justification: string; status: string;
  } | undefined;

  if (!req) return `Error: override request ${requestId} not found.`;
  if (req.status !== 'pending') {
    return `Error: override request ${req.id.slice(0, 8)} is already ${req.status}, cannot resolve again.`;
  }

  if (args.approve) {
    // Force the status through (bypass engine hard gate).
    const updated = updateTask(req.task_id, { status: req.requested_status });
    if (!updated) return `Error: task ${req.task_id} was deleted before override approval could land.`;
    // Override approval is authoritative: set the matching *_validated
    // flag so PM doesn't re-surface this row as unvalidated. Clear
    // revert_count and awaiting_user_verdict too.
    db.prepare(`
      UPDATE tasks
      SET revert_count = 0,
          awaiting_user_verdict = 0,
          user_verdict_requested_at = NULL,
          complete_validated = CASE WHEN ? = 'complete' THEN 1 ELSE complete_validated END,
          pause_validated = CASE WHEN ? = 'paused' THEN 1 ELSE pause_validated END,
          blocked_validated = CASE WHEN ? = 'blocked' THEN 1 ELSE blocked_validated END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(req.requested_status, req.requested_status, req.requested_status, req.task_id);
    // updateTask broadcast above with only the status flip, re-broadcast
    // so revert_count=0 and the matching *_validated flag reach the dashboard.
    const freshOverride = getTask(req.task_id);
    if (freshOverride) broadcast({ type: 'tracker:task_updated', data: freshOverride });
    db.prepare(`
      UPDATE task_override_requests
      SET status = 'approved', resolved_by = ?, resolved_reason = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(pmAgentId, reason, req.id);

    writeTaskLog({
      taskId: req.task_id,
      fromEntity: 'pm',
      entryKind: 'override',
      toStatus: req.requested_status,
      actionTaken: 'tracker_override(approve=true)',
      reason,
    });

    // D-K: an approved override to 'fallen' can be the transition that empties
    // the project of open tasks; run the fail-open check (idempotent).
    if (req.requested_status === 'fallen') {
      // RC-17.5: also STOP a live schedule so it cannot keep firing after the
      // override lands it in 'fallen' (mirror of the tool + dashboard paths).
      try {
        terminateLiveScheduleOnFallen(req.task_id, 'a PM override marked the task fallen (given up on)');
      } catch { /* best-effort */ }
      try {
        checkProjectCompletion(freshOverride?.projectId ?? null, pmAgentId);
      } catch { /* best-effort */ }
    }

    logger.info('Override approved by PM', { taskId: req.task_id, pmAgentId, requestId: req.id }, pmAgentId);
    return `[OK] override approved. Task ${req.task_id.slice(0, 8)} forced to "${req.requested_status}". Reason: ${reason}.`;
  }

  // Deny path: leave the task where it is, notify the agent.
  db.prepare(`
    UPDATE task_override_requests
    SET status = 'denied', resolved_by = ?, resolved_reason = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(pmAgentId, reason, req.id);
  writeTaskLog({
    taskId: req.task_id,
    fromEntity: 'pm',
    entryKind: 'override',
    actionTaken: 'tracker_override(approve=false)',
    reason: `denied: ${reason}`,
  });
  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: '',
      requiresResponse: true,
      payload: `Your override request on task ${req.task_id.slice(0, 8)} was denied by the PM. Reason: ${reason}. The engine's original objection stands; address it and resubmit cleanly.`,
      toAgent: req.requested_by,
      fromAgent: pmAgentId,
    });
  } catch (err) {
    logger.warn('Override deny notification failed (non-fatal)', { taskId: req.task_id, error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('Override denied by PM', { taskId: req.task_id, pmAgentId, requestId: req.id }, pmAgentId);
  return `[OK] override denied. Task left as-is. Agent notified.`;
}

/**
 * tracker_request_user_verdict, assigned-agent-side, only callable
 * while awaiting_user_verdict=1. Composes a user-facing message
 * describing the stalemate and routes it.
 */
export async function trackerRequestUserVerdict(
  agentId: string,
  args: { task_id: string; status_requested: string; agent_summary: string; pm_rejection_summary: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const statusRequested = (args.status_requested ?? '').trim();
  if (!statusRequested) return 'Error: status_requested is required (the status you believe is correct).';
  const agentSummary = (args.agent_summary ?? '').trim();
  if (agentSummary.length < 30) return 'Error: agent_summary must be at least 30 characters (a one-paragraph recap of what you did).';
  const pmRejectionSummary = (args.pm_rejection_summary ?? '').trim();
  if (pmRejectionSummary.length < 20) return 'Error: pm_rejection_summary must be at least 20 characters (one-paragraph recap of PM\'s stated objections).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, assigned_to, goal, awaiting_user_verdict
    FROM tasks WHERE id = ?
  `).get(taskId) as { id: string; title: string; assigned_to: string | null; goal: string | null; awaiting_user_verdict: number } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;
  if (task.awaiting_user_verdict !== 1) {
    return `Error: task ${taskId.slice(0, 8)} is not awaiting_user_verdict. This tool is only callable when the engine has flagged a stalemate.`;
  }
  if (task.assigned_to !== agentId) {
    return `Error: only the assigned agent (${task.assigned_to}) can request a user verdict on this task.`;
  }

  const userMessage =
    `Task "${task.title}" has stalled. Asking for your verdict.\n\n` +
    `Goal: ${task.goal ?? '(no goal recorded)'}\n\n` +
    `What I did: ${agentSummary}\n\n` +
    `PM rejected because: ${pmRejectionSummary}\n\n` +
    `My request: mark this "${statusRequested}". ` +
    `Your reply is the final call. ` +
    `Options: "complete" / "send it back" / "blocked" / "paused" / "I don't care, you decide".`;

  writeTaskLog({
    taskId,
    fromEntity: `agent:${agentId}`,
    entryKind: 'user_verdict_request',
    actionTaken: 'tracker_request_user_verdict composed and routed',
    note: userMessage,
    toStatus: statusRequested,
  });

  // Routing: if the assigned agent is the primary, the message goes
  // straight into the user chat via notifyPrimaryAgent (forceNotify=true).
  // Otherwise relay via A2A to the primary agent.
  try {
    if (isPrimaryAgent(agentId)) {
      // Use the existing primary notification path. notifyPrimaryAgent
      // suppresses self-notifications by default; forceNotify=true wakes
      // the primary's chat for the user.
      notifyPrimaryAgent(`[user verdict requested] ${userMessage}`, agentId, true);
    } else {
      const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
      const relayPayload =
        `Please relay to ${getOwnerName()}: a stalemate has been flagged on task "${task.title}" (${taskId.slice(0, 8)}) ` +
        `assigned to me (${agentId}). The user verdict request follows. Show this verbatim to ${getOwnerName()} in chat and ` +
        `then call tracker_apply_user_verdict(task_id="${taskId}", status="<the owner's choice>", user_quote="<their exact reply>") on my behalf.\n\n` +
        userMessage;
      await deliverA2AMessage({
        intent: 'ASSIGN',
        threadId: '',
        requiresResponse: true,
        payload: relayPayload,
        toAgent: getPrimaryAgentId(),
        fromAgent: agentId,
      });
    }
  } catch (err) {
    logger.warn('User verdict request routing failed (non-fatal)', { taskId, error: err instanceof Error ? err.message : String(err) });
  }

  logger.info('User verdict requested', { taskId, agentId, statusRequested }, agentId);
  return `[OK] user verdict requested on task ${taskId.slice(0, 8)}. The user will reply. While awaiting, do not retry the rejected transition.`;
}

/**
 * tracker_apply_user_verdict, the receiving agent (primary if relayed,
 * assigned agent if it owns the user chat) calls this with the user's
 * reply to land the final decision.
 */
export async function trackerApplyUserVerdict(
  agentId: string,
  args: { task_id: string; status: string; user_quote: string },
): Promise<string> {
  const rawTaskId = args.task_id;
  if (!rawTaskId) return 'Error: task_id is required.';
  const resolved = resolveTaskId(rawTaskId);
  if (!resolved.ok) return formatResolveError('task', rawTaskId, resolved);
  const taskId = resolved.id;

  const status = (args.status ?? '').trim();
  if (!status) return 'Error: status is required (the status the user chose).';
  const userQuote = (args.user_quote ?? '').trim();
  if (!userQuote) return 'Error: user_quote is required (the user\'s exact reply, for audit).';

  const db = getDb();
  const task = db.prepare(`
    SELECT id, title, status as current_status, awaiting_user_verdict, project_id
    FROM tasks WHERE id = ?
  `).get(taskId) as { id: string; title: string; current_status: string; awaiting_user_verdict: number; project_id: string | null } | undefined;
  if (!task) return `Error: task ${taskId} not found.`;
  if (task.awaiting_user_verdict !== 1) {
    return `Error: task ${taskId.slice(0, 8)} is not awaiting_user_verdict. Apply only works on stalemate-flagged tasks.`;
  }

  // Force the status, clear the stalemate flag, validate immediately
  // (user is the ultimate authority). updateTask handles is_paused etc.
  const updated = updateTask(taskId, { status });
  if (!updated) return `Error: task ${taskId} was deleted before user verdict could land.`;

  db.prepare(`
    UPDATE tasks
    SET awaiting_user_verdict = 0,
        user_verdict_requested_at = NULL,
        revert_count = 0,
        complete_validated = CASE WHEN ? = 'complete' THEN 1 ELSE complete_validated END,
        blocked_validated = CASE WHEN ? = 'blocked' THEN 1 ELSE blocked_validated END,
        pause_validated = CASE WHEN ? = 'paused' THEN 1 ELSE pause_validated END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, status, taskId);
  // updateTask broadcast the status flip above, re-broadcast so the
  // dashboard sees the validated flag flip and the stalemate clear.
  const freshUserVerdict = getTask(taskId);
  if (freshUserVerdict) broadcast({ type: 'tracker:task_updated', data: freshUserVerdict });

  writeTaskLog({
    taskId,
    fromEntity: 'user',
    entryKind: 'user_verdict_applied',
    fromStatus: task.current_status,
    toStatus: status,
    actionTaken: `applied via ${agentId}`,
    reason: 'user verdict',
    note: userQuote,
  });

  // Cascade if user chose 'complete'.
  if (status === 'complete') {
    try {
      const { checkDependencies } = await import('./pm-agent.js');
      checkDependencies(taskId);
    } catch { /* best-effort */ }
    try {
      checkProjectCompletion(task.project_id, agentId);
    } catch { /* best-effort */ }
  }

  // D-K: a user verdict of 'fallen' can likewise be the transition that
  // empties the project of open tasks; run the fail-open check (idempotent).
  if (status === 'fallen') {
    // RC-17.5: also STOP a live schedule so it cannot keep firing after the
    // user verdict lands it in 'fallen' (mirror of the tool + dashboard paths).
    try {
      terminateLiveScheduleOnFallen(taskId, 'the owner marked the task fallen (given up on)');
    } catch { /* best-effort */ }
    try {
      checkProjectCompletion(task.project_id, agentId);
    } catch { /* best-effort */ }
  }

  logger.info('User verdict applied', { taskId, agentId, status }, agentId);
  return `[OK] user verdict applied on "${task.title}" (${taskId.slice(0, 8)}). Status="${status}". Quote logged. Stalemate cleared.`;
}
