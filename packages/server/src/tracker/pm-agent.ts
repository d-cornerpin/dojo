import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { listTasks, getTask, getLastPoke, logPoke } from './schema.js';
import { getAgentRuntime } from '../agent/runtime.js';
import { getRecentObservations, getRecentTransitions, formatEntryLine } from './task-log.js';
import { getPrimaryAgentId, getPrimaryAgentName, getPMAgentId, getPMAgentName, isPMEnabled, isSetupCompleted, getOwnerName } from '../config/platform.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('pm-agent');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Poke Thresholds (in seconds) ──

const POKE_THRESHOLDS: Record<string, { first: number; second: number; escalate: number; autoReset: number }> = {
  high:   { first: 180,  second: 600,   escalate: 1200, autoReset: 2400 },
  normal: { first: 300,  second: 900,   escalate: 1800, autoReset: 3600 },
  low:    { first: 600,  second: 1200,  escalate: 2400, autoReset: 4800 },
};

const POKE_INTERVAL_MS = 60_000; // 60 seconds

const SCHEDULER_INTERVAL_MS = 30_000; // 30 seconds, scheduler checks run separately

let pokeLoopTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

// ── PM Agent System Prompt ──

function loadPMSoulPrompt(): string {
  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();
  const ownerName = getOwnerName();

  // Try loading from templates directory
  const templatePaths = [
    path.resolve(__dirname, '../../../../templates/PM-SOUL.md'),
    path.resolve(__dirname, '../../../templates/PM-SOUL.md'),
    // RICK-SOUL.md removed, only PM-SOUL.md is used
  ];

  for (const templatePath of templatePaths) {
    try {
      if (fs.existsSync(templatePath)) {
        let content = fs.readFileSync(templatePath, 'utf-8');
        // Replace template variables
        content = content.replace(/\{\{pm_agent_name\}\}/g, pmName);
        content = content.replace(/\{\{primary_agent_name\}\}/g, primaryName);
        content = content.replace(/\{\{owner_name\}\}/g, ownerName);
        return content;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback default
  return `# Identity

You are ${pmName}, the project manager for this agent platform. Your only job is to track tasks, poke agents that stall, and escalate when needed.

# Rules

- You do NOT execute tasks. You track them.
- Check the project tracker on your poke schedule.
- When poking an agent, include full task context so they can resume immediately.
- Escalation chain: poke once -> poke with urgency -> escalate to ${primaryName} -> escalate to ${ownerName} via iMessage.
- After a restart, check the poke_log to resume where you left off. Never re-send a poke.
- Keep messages short. You're a PM, not a novelist.`;
}

// ── Ensure PM Agent Running ──

export function ensurePMAgentRunning(): void {
  if (!isPMEnabled()) {
    logger.info('PM agent is disabled, skipping auto-spawn');
    return;
  }

  if (!isSetupCompleted()) {
    logger.info('Setup not completed, deferring PM agent creation to setup wizard');
    return;
  }

  const db = getDb();
  const pmId = getPMAgentId();
  const pmName = getPMAgentName();
  const primaryId = getPrimaryAgentId();

  logger.info('PM agent auto-spawn check triggered', { pmId, pmName });

  // Ensure the primary agent exists before creating PM (parent_agent FK constraint)
  const primaryExists = db.prepare('SELECT id FROM agents WHERE id = ?').get(primaryId);
  if (!primaryExists) {
    logger.warn('Primary agent not yet created, deferring PM agent spawn', { primaryId });
    // Retry after a short delay
    setTimeout(() => ensurePMAgentRunning(), 5000);
    return;
  }

  const pm = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(pmId) as { id: string; status: string } | undefined;

  if (pm && pm.status !== 'terminated') {
    logger.info('PM agent already running', { status: pm.status });
    // Ensure permissions are up to date on every boot
    const syncToolsPolicy = JSON.stringify({
      allow: [
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status',
        'tracker_add_notes', 'tracker_complete_step',
        'tracker_pause_schedule', 'tracker_resume_schedule',
        'tracker_validate',
        'tracker_override', 'tracker_request_override',
        'tracker_apply_user_verdict',
        'tracker_edit_task', 'tracker_edit_project', 'tracker_close_project',
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'history_search', 'history_get',
        'load_tool_docs', 'get_current_time',
      ],
    });
    db.prepare("UPDATE agents SET tools_policy = ?, updated_at = datetime('now') WHERE id = ?").run(syncToolsPolicy, pmId);
    // Phase B.1: also keep the PM-SOUL system message in sync with the
    // template on every boot. Without this, the skepticism block (and any
    // other prompt updates) never reach an already-running PM. We INSERT
    // a fresh system message rather than mutating the original so the
    // history audit trail is preserved; the runtime message-assembly path
    // reads the LATEST system message for context.
    try {
      const freshPrompt = loadPMSoulPrompt();
      const existing = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'system'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(pmId) as { content: string } | undefined;
      if (!existing || existing.content !== freshPrompt) {
        db.prepare(`
          INSERT INTO messages (id, agent_id, role, content, created_at)
          VALUES (?, ?, 'system', ?, datetime('now'))
        `).run(uuidv4(), pmId, freshPrompt);
        logger.info('PM system prompt refreshed from template', { pmId });
      }
    } catch (err) {
      logger.warn('PM system prompt refresh failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    }
    startPokeLoop();
    return;
  }

  const systemPrompt = loadPMSoulPrompt();

  // Get PM model: check saved setting first, fall back to primary agent's model
  const pmModelSetting = db.prepare("SELECT value FROM config WHERE key = 'pm_agent_model'").get() as { value: string } | undefined;
  let modelId: string | null = pmModelSetting?.value ?? null;
  if (!modelId) {
    const primary = db.prepare('SELECT model_id FROM agents WHERE id = ?').get(primaryId) as { model_id: string | null } | undefined;
    modelId = primary?.model_id ?? null;
  }

  if (pm) {
    // PM exists but was terminated, reactivate with correct name, model, and permissions
    const reactivatePermissions = JSON.stringify({
      file_read: 'none',
      file_write: 'none',
      file_delete: 'none',
      exec_allow: [],
      exec_deny: ['*'],
      network_domains: 'none',
      can_spawn_agents: false,
      can_assign_permissions: false,
    });
    const reactivateToolsPolicy = JSON.stringify({
      allow: [
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status',
        'tracker_add_notes', 'tracker_complete_step',
        'tracker_pause_schedule', 'tracker_resume_schedule',
        'tracker_validate',
        'tracker_override', 'tracker_request_override',
        'tracker_apply_user_verdict',
        'tracker_edit_task', 'tracker_edit_project', 'tracker_close_project',
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'history_search', 'history_get',
        'load_tool_docs', 'get_current_time',
      ],
    });
    db.prepare(`
      UPDATE agents SET
        name = ?,
        model_id = ?,
        status = 'idle',
        agent_type = 'persistent',
        parent_agent = ?,
        spawn_depth = 1,
        max_runtime = NULL,
        timeout_at = NULL,
        permissions = ?,
        tools_policy = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(pmName, modelId, primaryId, reactivatePermissions, reactivateToolsPolicy, pmId);

    logger.info('PM agent reactivated', { pmId, pmName });
  } else {
    // Create PM agent with permissions for tracker, messaging, and monitoring
    const pmPermissions = JSON.stringify({
      file_read: 'none',
      file_write: 'none',
      file_delete: 'none',
      exec_allow: [],
      exec_deny: ['*'],
      network_domains: 'none',
      can_spawn_agents: false,
      can_assign_permissions: false,
    });
    // Allow only the tools the PM needs
    const pmToolsPolicy = JSON.stringify({
      allow: [
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status',
        'tracker_add_notes', 'tracker_complete_step',
        'tracker_pause_schedule', 'tracker_resume_schedule',
        'tracker_validate',
        'tracker_override', 'tracker_request_override',
        'tracker_apply_user_verdict',
        'tracker_edit_task', 'tracker_edit_project', 'tracker_close_project',
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'history_search', 'history_get',
        'load_tool_docs', 'get_current_time',
      ],
    });
    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                          parent_agent, spawn_depth, agent_type, classification, max_runtime, timeout_at,
                          permissions, tools_policy, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', '{"shareUserProfile":true}', ?,
              ?, 1, 'persistent', 'sensei', NULL, NULL,
              ?, ?, NULL, datetime('now'), datetime('now'))
    `).run(pmId, pmName, modelId, primaryId, primaryId, pmPermissions, pmToolsPolicy);

    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(uuidv4(), pmId, systemPrompt);

    logger.info('PM agent created', { pmId, pmName });
  }

  startPokeLoop();
}

// ── Poke Loop ──

export function startPokeLoop(): void {
  if (pokeLoopTimer) {
    logger.info('PM poke loop already running');
    return;
  }

  logger.info(`PM poke loop started, checking every ${POKE_INTERVAL_MS / 1000}s`);

  // Run an immediate first check (fire-and-forget; errors are logged inside).
  runPokeCheck().catch((err) => {
    logger.error('PM poke loop initial check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  pokeLoopTimer = setInterval(() => {
    runPokeCheck().catch((err) => {
      logger.error('PM poke loop tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, POKE_INTERVAL_MS);

  // Start separate scheduler check at 30s interval
  if (!schedulerTimer) {
    // Immediate first check
    import('../scheduler/runner.js').then(({ checkScheduledTasks }) => {
      checkScheduledTasks().catch(err => logger.error('Scheduler initial check failed', { error: err instanceof Error ? err.message : String(err) }));
    });

    schedulerTimer = setInterval(() => {
      import('../scheduler/runner.js').then(({ checkScheduledTasks }) => {
        checkScheduledTasks().catch(err => logger.error('Scheduler tick failed', { error: err instanceof Error ? err.message : String(err) }));
      });
    }, SCHEDULER_INTERVAL_MS);

    logger.info(`Scheduler started, checking every ${SCHEDULER_INTERVAL_MS / 1000}s`);
  }
}

export function stopPokeLoop(): void {
  if (pokeLoopTimer) {
    clearInterval(pokeLoopTimer);
    pokeLoopTimer = null;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  logger.info('Poke loop and scheduler stopped');
}

// ── Phase B.1: event-driven PM wake on transitions ──
// When trackerUpdateStatus flips a task into paused/complete/blocked the
// engine buffers the task id, debounces 10 seconds (so a burst of
// transitions becomes one PM review), then fires a fresh review that
// bypasses the polled 10-minute throttle. The polled review still runs
// as a safety-net heartbeat. The smell-pattern detector runs inline on
// transition and writes any signals into task_log + tasks.last_smell_flag.

const TRANSITION_DEBOUNCE_MS = 10_000;
const SMELL_POKE_WINDOW_SEC = 60;
const SMELL_PAUSE_THRASH_CYCLES = 3;
const SMELL_PAUSE_THRASH_WINDOW_MIN = 30;
const transitionBuffer = new Set<string>();
let transitionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Called by trackerUpdateStatus / completeAgent / closeProjectAndOpenTasks
 * whenever a task transitions into paused, complete, or blocked. Buffers
 * the task id and schedules a debounced PM review. The review runs as a
 * fresh LLM call regardless of the polled throttle.
 */
export function noteTransitionForReview(taskId: string, toStatus: string): void {
  if (!['paused', 'complete', 'blocked'].includes(toStatus)) return;
  // Smell detection happens here so the flag lands BEFORE PM reviews.
  try {
    runSmellDetector(taskId, toStatus);
  } catch (err) {
    logger.warn('runSmellDetector threw (non-fatal)', { taskId, toStatus, error: err instanceof Error ? err.message : String(err) });
  }
  const wasEmpty = transitionBuffer.size === 0;
  transitionBuffer.add(taskId);
  if (transitionDebounceTimer) {
    logger.info('PM event wake: transition buffered (timer already running)', { taskId, toStatus, bufferSize: transitionBuffer.size });
    return;
  }
  logger.info('PM event wake: armed debounce timer', { taskId, toStatus, debounceMs: TRANSITION_DEBOUNCE_MS, freshBuffer: wasEmpty });
  transitionDebounceTimer = setTimeout(() => {
    transitionDebounceTimer = null;
    const fired = Array.from(transitionBuffer);
    transitionBuffer.clear();
    // Phase C cost guard: when PM has already burned its hourly budget,
    // drop the event wake and let the polled 10-minute review pick this
    // up later. Keeps a runaway transition burst from dragging cost up.
    if (pmCapReached()) {
      logger.warn('PM event wake dropped: hourly LLM cap reached', {
        cap: PM_LLM_CALLS_PER_HOUR_CAP,
        callsLastHour: pmLlmCallsInLastHour(),
        droppedTasks: fired,
      });
      return;
    }
    // Reset the throttle so the next runPMReview fires immediately (responsive to a
    // genuine transition). Do NOT clear lastSituationReportHash here: a transition that
    // does not change the actionable issue-set must still dedup-skip, or we reintroduce
    // the "re-notify the same board on every task churn" firehose. runPMReview recomputes
    // the issue-set and re-runs only if it actually changed.
    lastLLMReviewAt = 0;
    logger.info('PM event wake: firing runPMReview', { batchedTasks: fired });
    runPMReview().catch((err) => {
      logger.error('Event-driven PM review failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }, TRANSITION_DEBOUNCE_MS);
}

/**
 * Engine-to-PM escalation for close-out misses.
 *
 * When the engine's close-out gate or idle-with-in_progress hardcap
 * fires, the danglers are still auto-paused (existing behavior) BUT we
 * additionally:
 *   - write a `closeout_miss` entry into task_log per affected task
 *   - send a direct A2A message to the PM with the suppressed text,
 *     the task goals, and the explicit verb menu
 *     (validate_pause / retask / override-complete)
 *
 * Before this, the PM only learned about close-out misses indirectly
 * via the periodic situation report, which surfaced the pause as
 * "UNVALIDATED_PAUSE" with no context about what the agent actually
 * said or what they should have done. PM had no real basis to do
 * anything except validate the pause, which is exactly the rubber-
 * stamp behavior the user called out.
 *
 * Fire-and-forget: PM acting takes a real LLM call; if PM is offline
 * or capped the task stays paused and the user can resolve from the
 * dashboard.
 */
export async function escalateCloseoutMissToPM(ctx: {
  agentId: string;
  pausedTaskIds: string[];
  suppressedText: string;
  source: 'idle-hardcap' | 'pre-turn-gate';
}): Promise<void> {
  if (!ctx.pausedTaskIds || ctx.pausedTaskIds.length === 0) return;

  const pmId = getPMAgentId();
  if (!pmId) {
    logger.info('Closeout-miss escalation skipped: no PM configured', { source: ctx.source, taskCount: ctx.pausedTaskIds.length });
    return;
  }
  if (pmId === ctx.agentId) {
    logger.info('Closeout-miss escalation skipped: dangler agent IS the PM', { agentId: ctx.agentId, source: ctx.source });
    return;
  }

  const db = getDb();
  const rows = ctx.pausedTaskIds
    .map((id) => db.prepare(`SELECT id, title, goal FROM tasks WHERE id = ?`).get(id) as { id: string; title: string; goal: string | null } | undefined)
    .filter((r): r is { id: string; title: string; goal: string | null } => Boolean(r));
  if (rows.length === 0) return;

  const sourceLabel = ctx.source === 'idle-hardcap' ? 'idle-with-in_progress hardcap' : 'pre-turn close-out gate';

  try {
    const { writeTaskLog } = await import('./task-log.js');
    for (const r of rows) {
      writeTaskLog({
        taskId: r.id,
        fromEntity: 'engine',
        entryKind: 'closeout_miss',
        actionTaken: `escalated to PM via ${sourceLabel}`,
        reason: 'agent produced user-facing text without calling tracker_update_status; bubble suppressed and task auto-paused pending PM review',
        note: ctx.suppressedText.slice(0, 4000),
      });
    }
  } catch (err) {
    logger.warn('Failed to write closeout_miss task_log entries', {
      error: err instanceof Error ? err.message : String(err), taskCount: rows.length,
    });
  }

  const taskLines = rows
    .map((r) => `  - ${r.id.slice(0, 8)} "${r.title}" (goal: ${r.goal ?? '(none recorded)'})`)
    .join('\n');
  const truncatedSaid = ctx.suppressedText.length > 1500
    ? ctx.suppressedText.slice(0, 1500) + '...'
    : ctx.suppressedText;

  // v2.10.2, receipts in the A2A body. Pre-fix, PM only saw the
  // agent's suppressed text ("08 done"), not the tool-call rows from
  // task_log. That made it easy for PM to conclude "no evidence,
  // re-run" when the audit log actually had the [SENT] success row.
  // Pull the last few tool_use audit entries for each paused task
  // and embed them inline so PM has the receipts in the same
  // message as the question.
  let receiptsBlock = '';
  try {
    const receiptLines: string[] = [];
    for (const r of rows) {
      const auditRows = db.prepare(`
        SELECT action_taken, reason, note, created_at
        FROM task_log
        WHERE task_id = ?
          AND entry_kind IN ('tool_use', 'transition', 'observation')
        ORDER BY created_at DESC, rowid DESC
        LIMIT 6
      `).all(r.id) as Array<{ action_taken: string | null; reason: string | null; note: string | null; created_at: string }>;
      if (auditRows.length === 0) continue;
      receiptLines.push(`  ${r.id.slice(0, 8)} recent audit (newest first):`);
      for (const a of auditRows) {
        const action = a.action_taken ?? '(no action recorded)';
        const detail = [a.reason, a.note].filter(Boolean).join(' / ').slice(0, 180);
        receiptLines.push(`    [${a.created_at}] ${action}${detail ? `, ${detail}` : ''}`);
      }
    }
    // C26: engine-written verification receipts. These are machine facts (the
    // provider's own id / a read-only re-fetch), not the agent's prose, so PM
    // can tell a real send from an invented "sent it." Render per-task rows
    // (stamped when the complete gate consumed them) plus the assignee's recent
    // rows in the window (a turn that did NOT close through the gate leaves them
    // unstamped). Read-only.
    const fmtReceipt = (vr: { tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }): string =>
      `    [${vr.created_at}] ${vr.tool} ${vr.verified ? 'VERIFIED' : 'unverified'} (${vr.basis})${vr.provider_id ? `, id ${vr.provider_id}` : ''}`;
    for (const r of rows) {
      const taskReceipts = db.prepare(`
        SELECT tool, verified, basis, provider_id, created_at
        FROM tool_receipts WHERE task_id = ?
        ORDER BY created_at DESC LIMIT 10
      `).all(r.id) as Array<{ tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }>;
      if (taskReceipts.length === 0) continue;
      receiptLines.push(`  ${r.id.slice(0, 8)} engine receipts:`);
      for (const vr of taskReceipts) receiptLines.push(fmtReceipt(vr));
    }
    const assigneeReceipts = db.prepare(`
      SELECT tool, verified, basis, provider_id, created_at
      FROM tool_receipts
      WHERE agent_id = ? AND task_id IS NULL AND created_at >= datetime('now', '-2 hours')
      ORDER BY created_at DESC LIMIT 10
    `).all(ctx.agentId) as Array<{ tool: string; verified: number; basis: string; provider_id: string | null; created_at: string }>;
    if (assigneeReceipts.length > 0) {
      receiptLines.push(`  ${ctx.agentId} recent engine receipts (unstamped, last 2h):`);
      for (const vr of assigneeReceipts) receiptLines.push(fmtReceipt(vr));
    }
    if (receiptLines.length > 0) {
      receiptsBlock = `Audit log excerpts (the actual receipts, read these BEFORE deciding):\n${receiptLines.join('\n')}\n\n`;
    }
  } catch (err) {
    logger.warn('Failed to assemble audit-log receipts for closeout-miss A2A (non-fatal)', {
      error: err instanceof Error ? err.message : String(err), taskCount: rows.length,
    });
  }

  const payload =
    `[Engine notice - CLOSEOUT MISS]\n\n` +
    `Agent "${ctx.agentId}" finished a turn without calling tracker_update_status / tracker_complete_step. The engine ` +
    `auto-paused the one-shot dangling task(s) below as a temporary measure. Your job: don't rubber-stamp. Decide per task.\n\n` +
    `Paused task(s):\n${taskLines}\n\n` +
    `What the agent said (suppressed from the user, they did NOT see this):\n` +
    `> ${truncatedSaid.split('\n').join('\n> ')}\n\n` +
    receiptsBlock +
    `Trigger: ${sourceLabel}\n\n` +
    `Your verbs:\n` +
    `  (a) tracker_retask(task_id, directive), push the agent back at it with concrete corrective guidance ` +
    `(e.g. "you wrote the brief in chat but the task spec is email; call send_email with this same content to <recipient>"). USE THIS WHEN the agent did the wrong thing and you can name what they should do instead.\n` +
    `  (b) tracker_validate(kind="pause", task_id, valid=true), confirm the pause stands. USE THIS WHEN the work genuinely can't proceed without user input you can name, or when the task is no longer relevant.\n` +
    `  (c) tracker_override(...) or tracker_validate(kind="complete", ...), accept as complete. USE THIS WHEN you can verify (via the audit-log excerpts above + the suppressed text + a quick tracker_get_status / file check / etc.) that the work actually got done and the agent just forgot to close the tracker.\n\n` +
    `**Non-idempotent tools demand option (c), not (a).** If the audit log shows a successful call to gmail_send, outlook_send, ` +
    `imessage_send, sms_send, teams_send_message, voice_call, calendar_create, drive_upload, docs_create, sheets_create, share_publicly, ` +
    `or an exec that hit a live external API, the action already happened. Re-running it would duplicate the side effect (double email, ` +
    `double text, double charge). Accept as complete via tracker_override / tracker_validate, citing the audit row as evidence. ` +
    `Do NOT use tracker_retask on these; that produces duplicates.\n\n` +
    `For everything else, inspect the goal against what the agent said. If they delivered the wrong artifact OR in the wrong channel, retask. ` +
    `Rubber-stamping the pause means the recurring task / user-promised work dies silently. Be a PM, not a status forwarder.`;

  try {
    const { deliverA2AMessage } = await import('../agent/a2a-transport.js');
    await deliverA2AMessage({
      intent: 'QUESTION',
      threadId: uuidv4(),
      requiresResponse: true,
      payload,
      toAgent: pmId,
      fromAgent: 'system',
    });
    logger.info('Closeout-miss escalated to PM', {
      pmId, agentId: ctx.agentId, taskCount: rows.length, source: ctx.source,
    });
  } catch (err) {
    logger.warn('Failed to deliver closeout-miss escalation to PM', {
      error: err instanceof Error ? err.message : String(err),
      pmId, taskCount: rows.length,
    });
  }
}

/**
 * Smell-pattern detector. Writes signal entries into task_log and sets
 * tasks.last_smell_flag for PM to read as context. Never blocks the
 * transition (that's the engine hard-gate's job), this is purely an
 * advisory signal.
 */
function runSmellDetector(taskId: string, toStatus: string): void {
  const db = getDb();
  if (toStatus === 'complete') {
    const lastPoke = db.prepare(`
      SELECT sent_at FROM poke_log WHERE task_id = ?
      ORDER BY sent_at DESC LIMIT 1
    `).get(taskId) as { sent_at: string } | undefined;
    if (lastPoke) {
      const pokeTs = new Date(lastPoke.sent_at.includes('Z') ? lastPoke.sent_at : lastPoke.sent_at + 'Z').getTime();
      const elapsedSec = Math.floor((Date.now() - pokeTs) / 1000);
      if (elapsedSec <= SMELL_POKE_WINDOW_SEC) {
        const taskAgent = db.prepare(`SELECT assigned_to FROM tasks WHERE id = ?`).get(taskId) as { assigned_to: string | null } | undefined;
        if (taskAgent?.assigned_to) {
          const nonTrackerTool = db.prepare(`
            SELECT 1 FROM audit_log
            WHERE agent_id = ?
              AND action_type = 'tool_call'
              AND target NOT LIKE 'tracker_%'
              AND created_at > ?
            LIMIT 1
          `).get(taskAgent.assigned_to, lastPoke.sent_at) as { 1: number } | undefined;
          if (!nonTrackerTool) {
            const flag = `closed within ${elapsedSec}s of last poke with no non-tracker tool calls in between`;
            db.prepare(`UPDATE tasks SET last_smell_flag = ? WHERE id = ?`).run(flag, taskId);
            void import('./task-log.js').then(({ writeTaskLog }) => writeTaskLog({
              taskId,
              fromEntity: 'engine',
              entryKind: 'smell_flag',
              reason: flag,
            }));
            logger.info('Smell flag set: complete dodging poke', { taskId, elapsedSec });
          }
        }
      }
    }
  } else if (toStatus === 'paused' || toStatus === 'in_progress') {
    // Pause-resume thrash: count transitions in/out of paused for this task
    // within the last 30 minutes.
    const cycles = db.prepare(`
      SELECT COUNT(*) as c FROM task_log
      WHERE task_id = ?
        AND entry_kind = 'transition'
        AND (to_status = 'paused' OR (from_status = 'paused' AND to_status != 'paused'))
        AND datetime(created_at) > datetime('now', '-${SMELL_PAUSE_THRASH_WINDOW_MIN} minutes')
    `).get(taskId) as { c: number } | undefined;
    if (cycles && cycles.c >= SMELL_PAUSE_THRASH_CYCLES) {
      const flag = `pause-resume thrash: ${cycles.c} transitions in last ${SMELL_PAUSE_THRASH_WINDOW_MIN} min`;
      db.prepare(`UPDATE tasks SET last_smell_flag = ? WHERE id = ?`).run(flag, taskId);
      void import('./task-log.js').then(({ writeTaskLog }) => writeTaskLog({
        taskId,
        fromEntity: 'engine',
        entryKind: 'smell_flag',
        reason: flag,
      }));
      logger.info('Smell flag set: pause-resume thrash', { taskId, cycles: cycles.c });
    }
  }
}

// ── PM LLM Review, runs the PM agent's brain periodically ──

let lastLLMReviewAt = 0;
let lastSituationReportHash = '';
const LLM_REVIEW_INTERVAL_MS = 600_000; // 10 minutes, gives tasks time to settle before reviewing

// How many recent messages to keep for the PM. Bumped from 10 to 30 in
// v2.7.27, at 10 the pair-aware cutoff + downstream orphan sanitizer
// were trimming the PM down to 1-2 effective messages on bad turns,
// leaving it with no context to judge anything. 30 gives the sanitizer
// more pair-completeness to work with while still keeping the PM's
// window small. PM is still stateless conceptually (tracker is its
// memory), this is just enough scratch space.
const PM_MAX_MESSAGES = 30;

// ── Phase C: per-hour PM LLM call cap (cost guard) ──
//
// Even with debounced event wakes, a chaotic spell of agent transitions
// can wake PM dozens of times in an hour. Each wake is a real DeepSeek
// call. We hard-cap PM LLM invocations per rolling 60-minute window:
// once the cap is hit, runPMReview falls back to "polled-only" mode
// (event wakes are dropped, the 10-min polled review still runs as the
// safety net heartbeat) until the window rolls forward.
const PM_LLM_CALLS_PER_HOUR_CAP = 30;
const pmLlmCallTimestamps: number[] = [];
function recordPmLlmCall(): void {
  const now = Date.now();
  pmLlmCallTimestamps.push(now);
  const cutoff = now - 60 * 60 * 1000;
  while (pmLlmCallTimestamps.length > 0 && pmLlmCallTimestamps[0] < cutoff) {
    pmLlmCallTimestamps.shift();
  }
}
function pmLlmCallsInLastHour(): number {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return pmLlmCallTimestamps.filter((t) => t >= cutoff).length;
}
function pmCapReached(): boolean {
  return pmLlmCallsInLastHour() >= PM_LLM_CALLS_PER_HOUR_CAP;
}

/**
 * Prune old PM messages to keep the context window small.
 * The PM doesn't need history, the tracker is its memory.
 */
function pruneOldPMMessages(pmId: string): void {
  const db = getDb();
  try {
    // Count total messages
    const countRow = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id = ?').get(pmId) as { c: number };
    if (countRow.c <= PM_MAX_MESSAGES) return;

    // Get the ID of the Nth most recent message (our initial cutoff candidate)
    const initialCutoff = db.prepare(`
      SELECT id FROM messages WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1 OFFSET ?
    `).get(pmId, PM_MAX_MESSAGES) as { id: string } | undefined;

    if (!initialCutoff) return;

    // v2.7.27: tool_call_pair-aware cutoff. If the initial cutoff lands on a
    // 'tool' role message, the resulting kept window starts with an orphaned
    // tool result (no preceding assistant with tool_calls). DeepSeek and most
    // other providers 400 with "Messages with role 'tool' must be a response
    // to a preceding message with 'tool_calls'", which then triggered the
    // injury-recovery loop and made the PM perpetually broken. The fix walks
    // forward from the initial cutoff to find the first non-tool message,
    // using that as the safe cutoff. We may keep fewer than PM_MAX_MESSAGES
    // when this fires; that's fine, PM is stateless and tracker is its memory.
    const cutoff = db.prepare(`
      SELECT id FROM messages
      WHERE agent_id = ?
        AND rowid >= (SELECT rowid FROM messages WHERE id = ?)
        AND role != 'tool'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(pmId, initialCutoff.id) as { id: string } | undefined;

    if (!cutoff) return;

    // Cascade delete in a transaction. summary_messages.message_id has a
    // foreign-key reference to messages(id) without ON DELETE CASCADE, so a
    // raw DELETE on a compacted PM message throws and the prune fails
    // forever (pm-agent log spam observed in production: "Failed to prune PM
    // messages" every 10 min for hours). The PM doesn't need its archived
    // summaries anyway, the tracker is its memory, so wipe the link rows
    // first, then the messages themselves.
    const txn = db.transaction(() => {
      db.prepare(`
        DELETE FROM summary_messages
        WHERE message_id IN (
          SELECT id FROM messages
          WHERE agent_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
        )
      `).run(pmId, cutoff.id);
      return db.prepare(`
        DELETE FROM messages WHERE agent_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
      `).run(pmId, cutoff.id);
    });
    const deleted = txn();

    if (deleted.changes > 0) {
      logger.debug('Pruned old PM messages', { pmId, deleted: deleted.changes, kept: PM_MAX_MESSAGES });
    }
  } catch (err) {
    logger.warn('Failed to prune PM messages', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runPMReview(): Promise<void> {
  const now = Date.now();
  const db = getDb();

  // The 10-minute time gate avoids spamming the LLM when nothing meaningful
  // is happening. But unvalidated-complete / blocked / paused tasks and
  // pending override requests are time-sensitive, the engine escalates to
  // the user at 5 minutes, so PM needs a chance well before that. Bypass
  // the gate when validation work is queued. The per-hour PM LLM cap
  // (PM_LLM_CALLS_PER_HOUR_CAP) still bounds cost.
  const pendingValidationCount = (() => {
    try {
      return (db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE status = 'complete' AND complete_validated = 0 AND awaiting_user_verdict = 0) +
          (SELECT COUNT(*) FROM tasks WHERE status = 'blocked' AND blocked_validated = 0 AND awaiting_user_verdict = 0) +
          (SELECT COUNT(*) FROM tasks WHERE status = 'paused' AND pause_validated = 0) +
          (SELECT COUNT(*) FROM task_override_requests WHERE status = 'pending')
        AS c
      `).get() as { c: number }).c;
    } catch {
      return 0;
    }
  })();
  if (pendingValidationCount === 0 && now - lastLLMReviewAt < LLM_REVIEW_INTERVAL_MS) return;

  // D7: enforce the per-hour PM LLM cap on the POLLED path too, not only the
  // event-wake path. Before this, a stuck complete-but-unvalidated task bypassed
  // the 10-min gate (pendingValidationCount > 0) and drove a full LLM review on
  // every 60s poll, ~900 calls/day at idle. The cap bounds that; validation
  // work is still handled well before the 5-min user escalation.
  if (pmCapReached()) {
    logger.debug('PM review skipped, hourly LLM cap reached', { cap: PM_LLM_CALLS_PER_HOUR_CAP });
    return;
  }

  const pmId = getPMAgentId();

  // Prune old messages before each review to keep context tight
  pruneOldPMMessages(pmId);

  // ── Validation-review context wipe ──
  // When there's pending validation work, the PM agent's previous turns
  // left assistant tool_calls + tool_results in its history. The OpenAI
  // Pass 1 sanitizer can strip orphan tool_results (e.g., when a prior
  // assistant got pruned away or compacted out), leaving the PM's view
  // of its own past work inconsistent, and it responds with [no-reply]
  // because it can't reconcile what it sees with what it's being asked
  // to do. The codebase's design intent is that PM is stateless and the
  // tracker is its memory. Honor that: wipe the PM's conversation
  // history before each validation review so it starts fresh. We keep
  // system messages (system prompt, session boundary) so identity /
  // instructions persist.
  if (pendingValidationCount > 0) {
    try {
      const wiped = db.prepare(`
        DELETE FROM messages
        WHERE agent_id = ? AND role != 'system'
      `).run(pmId);
      if (wiped.changes > 0) {
        // D7: do NOT reset the dedup hash here. The dedup key is the actionable
        // issue-SET (stableIssuesKey), so keeping the hash means a re-review fires
        // only when the set of tasks needing validation actually CHANGES, not on
        // every 60s poll of an unchanged board. Resetting it forced a fresh LLM
        // review each poll while any task sat unvalidated, the ~900-calls/day loop.
        logger.info('Wiped PM conversation history before validation review', {
          pmId, deletedMessages: wiped.changes, pendingValidation: pendingValidationCount,
        });
      }
    } catch (err) {
      logger.warn('Failed to wipe PM conversation before validation review (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();

  // Check if PM agent exists and has a model
  const pmAgent = db.prepare('SELECT id, model_id, status FROM agents WHERE id = ?').get(pmId) as { id: string; model_id: string | null; status: string } | undefined;
  if (!pmAgent || !pmAgent.model_id || pmAgent.status === 'terminated') return;

  // ── Engine-level checks (fast, deterministic, no LLM needed) ──
  const allTasks = listTasks({});
  const activeTasks = allTasks.filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  // Phase B.1: even when no tasks are "active" (in_progress / on_deck /
  // blocked), there may still be unvalidated-complete or override-request
  // rows that need PM judgment. Only return early when truly nothing
  // requires PM attention. Cheap COUNT queries before deciding.
  if (activeTasks.length === 0) {
    const pendingCount = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE status = 'complete' AND complete_validated = 0 AND awaiting_user_verdict = 0) +
        (SELECT COUNT(*) FROM tasks WHERE status = 'blocked' AND blocked_validated = 0 AND awaiting_user_verdict = 0) +
        (SELECT COUNT(*) FROM tasks WHERE status = 'paused' AND pause_validated = 0) +
        (SELECT COUNT(*) FROM task_override_requests WHERE status = 'pending')
      AS c
    `).get() as { c: number };
    if (pendingCount.c === 0) return;
  }

  lastLLMReviewAt = now;

  const agents = db.prepare(`
    SELECT id, name, status, classification, updated_at FROM agents WHERE status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; classification: string; updated_at: string }>;

  // Build a set of dormant agent IDs (no activity in 7+ days) so the PM
  // doesn't raise false alarms about agents from old test groups or paused projects.
  const DORMANT_THRESHOLD_MS = 7 * 86400000;
  const dormantAgentIds = new Set<string>();
  const nowMs = Date.now();
  for (const agent of agents) {
    const lastMsg = db.prepare(
      'SELECT created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ).get(agent.id) as { created_at: string } | undefined;
    if (lastMsg) {
      const lastTs = lastMsg.created_at.includes('Z') ? lastMsg.created_at : lastMsg.created_at + 'Z';
      if (nowMs - new Date(lastTs).getTime() >= DORMANT_THRESHOLD_MS) {
        dormantAgentIds.add(agent.id);
      }
    } else {
      dormantAgentIds.add(agent.id);
    }
  }

  // Issues collected as { stableId, text }. The stableId, keyed on task
  // id + issue type, is what feeds the dedup hash. The free-form text
  // (with "X minutes" counters) is what the LLM sees. Without this split,
  // every minute of elapsed time changed the hash and the dedup at line
  // 510 never fired (v2.3.7).
  const issues: Array<{ stableId: string; text: string }> = [];
  const nowDate = new Date();

  for (const task of activeTasks) {
    // Skip tasks assigned to dormant agents, they belong to old test groups
    // or paused projects and should not trigger false alarms.
    // EXCEPTION: in_progress tasks are never skipped, if someone manually
    // activated a task on a dormant agent, the PM should still monitor it.
    if (task.assignedTo && dormantAgentIds.has(task.assignedTo) && task.status !== 'in_progress') continue;

    // 1. Orphaned tasks: assigned to terminated agents
    if (task.assignedTo) {
      const agent = agents.find(a => a.id === task.assignedTo);
      if (!agent) {
        issues.push({
          stableId: `${task.id}|ORPHANED`,
          text: `ORPHANED: "${task.title}" is assigned to a terminated agent. Notify ${primaryName}.`,
        });
      }
    }

    // 2. Overdue scheduled tasks
    if (task.nextRunAt) {
      const nextRunTime = new Date(task.nextRunAt.includes('Z') ? task.nextRunAt : task.nextRunAt + 'Z');
      if (nextRunTime < nowDate && task.scheduleStatus === 'waiting') {
        const overdueMin = Math.floor((nowDate.getTime() - nextRunTime.getTime()) / 60000);
        if (overdueMin > 5) {
          issues.push({
            stableId: `${task.id}|OVERDUE`,
            text: `OVERDUE: "${task.title}" was due ${overdueMin} minutes ago but hasn't fired.`,
          });
        }
      }
    }

    // 3. Blocked tasks sitting too long
    if (task.status === 'blocked') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const blockedMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (blockedMin > 30) {
        issues.push({
          stableId: `${task.id}|BLOCKED`,
          text: `BLOCKED: "${task.title}" has been blocked for ${blockedMin} minutes. May need ${primaryName}'s attention.`,
        });
      }
    }

    const GRACE_PERIOD_MINUTES = 30;
    const taskUpdatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
    const timeSinceUpdateMin = Math.floor((nowDate.getTime() - taskUpdatedTime.getTime()) / 60000);

    // 4. Non-scheduled tasks stuck in on_deck with no activity.
    if (task.status === 'on_deck' && !task.scheduledStart && task.assignedTo && task.scheduleStatus !== 'waiting') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const staleMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (staleMin > GRACE_PERIOD_MINUTES && timeSinceUpdateMin > GRACE_PERIOD_MINUTES) {
        const agentName = task.assignedToName ?? task.assignedTo;
        issues.push({
          stableId: `${task.id}|STALE`,
          text: `STALE: "${task.title}" has been on_deck for ${staleMin} minutes, assigned to ${agentName} but not started.`,
        });
      }
    }

    // 5. In-progress tasks where the assigned agent has been sitting idle.
    // v2.7.17 - tightened from "no message in 30 min" to "agent.status='idle'
    // AND agents.updated_at older than 2 min." Two reasons:
    //   (a) status='idle' on the agents row means the agent has actually
    //       ended a turn and is NOT mid-tool-call. Don't poke during slow
    //       legitimate work.
    //   (b) agents.updated_at gets bumped when status flips - so it's an
    //       exact "agent went idle at" timestamp, not a sloppy proxy.
    // The agent's end-of-turn nudge teaches it to mark waiting-on-user
    // tasks as 'paused' (PM ignores) and escalation cases as 'blocked' (PM
    // surfaces but doesn't poke). An IDLE issue here means the agent
    // genuinely stalled out without transitioning, and the PM should poke.
    //
    // Exempts recurring tasks with a future nextRunAt - those are stuck-
    // between-runs from a previous fire that didn't close cleanly. The
    // scheduler's cleanupStaleRuns is responsible for those (v2.3.7);
    // PM nagging only adds noise on top.
    const IN_PROGRESS_IDLE_THRESHOLD_MIN = 2;
    if (task.status === 'in_progress' && task.assignedTo) {
      let waitingForFutureFire = false;
      if (task.nextRunAt) {
        const nextRunMs = new Date(task.nextRunAt.includes('Z') ? task.nextRunAt : task.nextRunAt + 'Z').getTime();
        if (nextRunMs - nowDate.getTime() > IN_PROGRESS_IDLE_THRESHOLD_MIN * 60_000) {
          waitingForFutureFire = true;
        }
      }
      if (!waitingForFutureFire) {
        const agent = agents.find(a => a.id === task.assignedTo);
        if (agent && agent.status === 'idle') {
          const agentUpdatedAt = new Date(agent.updated_at.includes('Z') ? agent.updated_at : agent.updated_at + 'Z');
          const idleMin = Math.floor((nowDate.getTime() - agentUpdatedAt.getTime()) / 60000);
          if (idleMin >= IN_PROGRESS_IDLE_THRESHOLD_MIN) {
            const agentName = task.assignedToName ?? task.assignedTo;
            issues.push({
              stableId: `${task.id}|IDLE`,
              text: `IDLE: "${task.title}" is in_progress but ${agentName} has been sitting idle for ${idleMin} minute(s) without transitioning the task. POKE THEM: send_to_agent(${agentName}, intent="QUESTION", thread_id=new, message="You have task '${task.title}' (${task.id.slice(0, 8)}) still in_progress but you appear to have gone idle. Pick exactly one and act:\\n\\n1. STILL WORKING: if you're in the middle of this task (file read, batch operation, multi-step process, etc.), CONTINUE from EXACTLY where you stopped. Do NOT restart from the beginning. Do NOT re-read or re-process content you've already covered. Just call your next tool on the next item / next line / next step in your sequence.\\n2. WAITING ON THE USER (you already asked them): mark it paused with tracker_update_status(status='paused', notes='waiting for X').\\n3. BLOCKED (you cannot proceed, need attention): mark it blocked with tracker_update_status(status='blocked', notes='specific obstacle').\\n4. DONE: mark complete with tracker_update_status(status='complete', result='...', evidence=[...]).\\n\\nThis poke is a check-in, not a restart signal. Long-running work is fine, just keep going from where you were."). The agent's expected to have already self-marked paused/blocked - if they didn't, this poke straightens them out. Emphasize option 1 if the work looks like a long read/batch in progress.`,
            });
          }
        }
      }
    }
  }

  // ── v2.7.18: unvalidated-pause detection ──
  // Every task with status='paused' AND pause_validated=0 needs a PM
  // judgment call before it's "trusted." Catches the gaming pattern
  // where agents mark tasks paused just to silence PM pokes.
  //
  // Wait at least 1 minute after the pause to give the agent a beat to
  // also resolve / unpause / get woken up by an inbound user message.
  // Include the agent's last user-facing assistant message (so PM can
  // judge whether the pause notes match a real request) and the task
  // notes themselves (the pause reason the agent supplied).
  const unvalidatedPauseRows = db.prepare(`
    SELECT id, title, assigned_to, updated_at
    FROM tasks
    WHERE status = 'paused'
      AND pause_validated = 0
      AND datetime(updated_at) < datetime('now', '-1 minute')
    ORDER BY updated_at ASC
    LIMIT 10
  `).all() as Array<{ id: string; title: string; assigned_to: string | null; updated_at: string }>;

  // Phase B.0: read the pause reason from the most recent observation entry
  // attached to this task in task_log, with fallback to the legacy notes
  // column for tasks that pre-date the migration backfill. Once the
  // backfill has run on this DB the legacy fallback should rarely hit.
  //
  // v2.9.22, also accept 'auto_sweep' entries so engine-initiated pauses
  // surface a real reason. Pre-fix, engine auto-pauses wrote auto_sweep
  // entries that this filter missed, so PM saw "(EMPTY)" and rejected
  // every engine-paused task as gaming. The primary fix (engine auto-pause
  // setting pause_validated=1) makes this filter irrelevant for engine
  // pauses going forward, but if any other code path leaves an
  // unvalidated auto-pause in the world, PM at least sees the reason.
  const recentObservation = db.prepare(`
    SELECT note FROM task_log
    WHERE task_id = ? AND entry_kind IN ('observation', 'legacy_note', 'auto_sweep')
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `);
  const legacyNotesStmt = db.prepare(`SELECT notes FROM tasks WHERE id = ?`);

  for (const pTask of unvalidatedPauseRows) {
    const agentName = pTask.assigned_to
      ? agents.find(a => a.id === pTask.assigned_to)?.name ?? pTask.assigned_to
      : 'unassigned';
    let lastAssistantSnippet = '(no recent assistant message)';
    if (pTask.assigned_to) {
      const lastMsg = db.prepare(`
        SELECT content FROM messages
        WHERE agent_id = ? AND role = 'assistant'
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(pTask.assigned_to) as { content: string } | undefined;
      if (lastMsg?.content) {
        lastAssistantSnippet = lastMsg.content.length > 220
          ? lastMsg.content.slice(0, 220) + '...'
          : lastMsg.content;
      }
    }
    const logRow = recentObservation.get(pTask.id) as { note: string | null } | undefined;
    const legacyRow = legacyNotesStmt.get(pTask.id) as { notes: string | null } | undefined;
    const rawReason = logRow?.note ?? legacyRow?.notes ?? null;
    const pauseReason = rawReason && rawReason.trim()
      ? rawReason.replace(/\s+/g, ' ').trim()
      : '(EMPTY)';
    issues.push({
      stableId: `${pTask.id}|UNVALIDATED_PAUSE`,
      text:
        `UNVALIDATED_PAUSE: "${pTask.title}" (${pTask.id.slice(0, 8)}) was paused by ${agentName} but has not been validated yet.\n` +
        `  Pause reason notes: "${pauseReason}"\n` +
        `  Agent's last user-facing message: "${lastAssistantSnippet}"\n` +
        `  Decide: valid pause (names a specific external trigger that matches a real request) or gaming (vague / no matching request / sounds like 'blocked' instead). ` +
        `Call tracker_validate(kind="pause", task_id="${pTask.id}", valid=true) if real. ` +
        `Call tracker_validate(kind="pause", task_id="${pTask.id}", valid=false, reject_reason="...one sentence...") if gaming. ` +
        `Rejection auto-reverts the task to in_progress (or pass target_status to pick on_deck/blocked) and notifies the agent.`,
    });
  }

  // ── Phase B.1: UNVALIDATED_COMPLETE ──
  // Every task with status='complete' AND complete_validated=0 needs a PM
  // judgment. Read the goal, result, evidence, and any smell_flag context;
  // open files / pull audit log entries when evidence points there.
  const unvalidatedCompleteRows = db.prepare(`
    SELECT id, title, assigned_to, goal, result, evidence_json, last_smell_flag,
           created_by, project_id, repeat_interval, next_run_at, priority,
           updated_at, revert_count
    FROM tasks
    WHERE status = 'complete'
      AND complete_validated = 0
      AND awaiting_user_verdict = 0
      AND datetime(updated_at) < datetime('now', '-15 seconds')
    ORDER BY updated_at ASC
    LIMIT 10
  `).all() as Array<{
    id: string; title: string; assigned_to: string | null; goal: string | null;
    result: string | null; evidence_json: string | null; last_smell_flag: string | null;
    created_by: string; project_id: string | null;
    repeat_interval: number | null; next_run_at: string | null;
    priority: string; updated_at: string; revert_count: number;
  }>;

  // Phase B.1: per-task lookup for goal-edit history. If the goal was
  // edited AFTER the task moved to in_progress, the assigned agent may have
  // moved the goalposts; PM needs to know.
  const goalEditStmt = db.prepare(`
    SELECT note, datetime(created_at) as edited_at
    FROM task_log
    WHERE task_id = ?
      AND entry_kind = 'observation'
      AND action_taken = 'goal_edited'
    ORDER BY created_at DESC
    LIMIT 3
  `);

  for (const cTask of unvalidatedCompleteRows) {
    const agentName = cTask.assigned_to
      ? agents.find(a => a.id === cTask.assigned_to)?.name ?? cTask.assigned_to
      : 'unassigned';
    const isRecurringRun = cTask.repeat_interval !== null && cTask.next_run_at !== null;
    const tierHint = cTask.assigned_to === cTask.created_by
      ? '  Trust hint: this is a SELF-ASSIGNED task. Bias toward validate unless something concretely smells off.'
      : '';
    const smellLine = cTask.last_smell_flag
      ? `\n  ⚠ SMELL_FLAG: ${cTask.last_smell_flag}`
      : '';
    const runLine = isRecurringRun
      ? `\n  Per-run completion (recurring task, next fire at ${cTask.next_run_at}). On valid=true the engine archives result/evidence to task_log and resets to on_deck for next fire.`
      : '';
    const goalEdits = goalEditStmt.all(cTask.id) as Array<{ note: string | null; edited_at: string }>;
    const goalEditLine = goalEdits.length > 0
      ? `\n  ⚠ GOAL EDITED ${goalEdits.length} time(s). Most recent: ${goalEdits[0].edited_at}. ` +
        `Compare result against the ORIGINAL goal, not the rewritten one. Diffs:\n` +
        goalEdits.map((e) => `    - ${e.note ?? '(no diff captured)'}`).join('\n')
      : '';
    let evidenceLines = '(no evidence array)';
    try {
      if (cTask.evidence_json) {
        const parsed = JSON.parse(cTask.evidence_json) as Array<{ kind?: string; claim?: string; pointer?: string }>;
        evidenceLines = parsed.map((e, i) => `    ${i + 1}. [${e.kind ?? '?'}] ${e.claim ?? ''}${e.pointer ? ` @ ${e.pointer}` : ''}`).join('\n');
      }
    } catch { /* leave as default */ }
    issues.push({
      stableId: `${cTask.id}|UNVALIDATED_COMPLETE|${cTask.revert_count}`,
      text:
        `UNVALIDATED_COMPLETE: "${cTask.title}" (${cTask.id.slice(0, 8)}) closed by ${agentName}, awaiting your validation.${smellLine}${runLine}${goalEditLine}\n` +
        `  Goal: ${cTask.goal ?? '(no goal recorded, pre-migration row)'}\n` +
        `  Result: ${cTask.result ?? '(none)'}\n` +
        `  Evidence:\n${evidenceLines}\n` +
        `  Priority=${cTask.priority}, revert_count=${cTask.revert_count}.${tierHint}\n` +
        `  Read the file/audit log/output referenced in evidence BEFORE validating (skepticism rule). ` +
        `Call tracker_validate(kind="complete", task_id="${cTask.id}", valid=true) when the work demonstrably matches the goal. ` +
        `Call tracker_validate(kind="complete", task_id="${cTask.id}", valid=false, reject_reason="...", target_status="in_progress") when it does not.`,
    });
  }

  // ── Phase B.1: UNVALIDATED_BLOCK ──
  const unvalidatedBlockRows = db.prepare(`
    SELECT id, title, assigned_to, goal, priority, updated_at, revert_count
    FROM tasks
    WHERE status = 'blocked'
      AND blocked_validated = 0
      AND awaiting_user_verdict = 0
      AND datetime(updated_at) < datetime('now', '-1 minute')
    ORDER BY updated_at ASC
    LIMIT 10
  `).all() as Array<{
    id: string; title: string; assigned_to: string | null; goal: string | null;
    priority: string; updated_at: string; revert_count: number;
  }>;

  for (const bTask of unvalidatedBlockRows) {
    const agentName = bTask.assigned_to
      ? agents.find(a => a.id === bTask.assigned_to)?.name ?? bTask.assigned_to
      : 'unassigned';
    const obsRow = recentObservation.get(bTask.id) as { note: string | null } | undefined;
    const blockReason = obsRow?.note?.trim() || '(no recent observation)';
    issues.push({
      stableId: `${bTask.id}|UNVALIDATED_BLOCK|${bTask.revert_count}`,
      text:
        `UNVALIDATED_BLOCK: "${bTask.title}" (${bTask.id.slice(0, 8)}) marked blocked by ${agentName}, awaiting validation.\n` +
        `  Goal: ${bTask.goal ?? '(no goal recorded)'}\n` +
        `  Block reason: ${blockReason}\n` +
        `  Priority=${bTask.priority}, revert_count=${bTask.revert_count}.\n` +
        `  Real block (genuine external obstacle, no workaround) -> tracker_validate(kind="blocked", task_id="${bTask.id}", valid=true). ` +
        `Not really blocked (agent hasn't asked the user, or has a workaround they haven't tried) -> tracker_validate(kind="blocked", task_id="${bTask.id}", valid=false, reject_reason="...").`,
    });
  }

  // ── Phase B.1: OVERRIDE_REQUEST ──
  const overrideRows = db.prepare(`
    SELECT r.id, r.task_id, r.requested_by, r.requested_status, r.justification, r.last_engine_error, r.attempts_attached, r.created_at,
           t.title as task_title, t.goal as task_goal
    FROM task_override_requests r
    LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at ASC
    LIMIT 10
  `).all() as Array<{
    id: string; task_id: string; requested_by: string;
    requested_status: string; justification: string; last_engine_error: string | null;
    attempts_attached: number; created_at: string;
    task_title: string | null; task_goal: string | null;
  }>;

  for (const oRow of overrideRows) {
    const agentName = oRow.requested_by === 'engine'
      ? 'engine (circuit-breaker)'
      : agents.find(a => a.id === oRow.requested_by)?.name ?? oRow.requested_by;
    issues.push({
      stableId: `override|${oRow.id}`,
      text:
        `OVERRIDE_REQUEST (id=${oRow.id.slice(0, 8)}): ${agentName} wants task "${oRow.task_title ?? '?'}" (${oRow.task_id.slice(0, 8)}) forced to "${oRow.requested_status}".\n` +
        `  Goal: ${oRow.task_goal ?? '(no goal recorded)'}\n` +
        `  Justification: ${oRow.justification}\n` +
        (oRow.last_engine_error ? `  Last engine error: ${oRow.last_engine_error}\n` : '') +
        (oRow.attempts_attached > 1 ? `  Engine-auto-fired after ${oRow.attempts_attached} hard-gate rejections, the agent was thrashing on shape.\n` : '') +
        `  Approve: tracker_override(override_request_id="${oRow.id}", approve=true, reason="..."). ` +
        `Deny: tracker_override(override_request_id="${oRow.id}", approve=false, reason="...").`,
    });
  }

  // Build a compact summary of active tasks for the LLM to review
  // Only include active tasks -- skip completed/fallen to keep the prompt small
  const taskSummary = activeTasks.map(t => {
    let line = `- [${t.status.toUpperCase()}] "${t.title}" -> ${t.assignedToName ?? 'unassigned'}`;
    if (t.repeatInterval) line += ` (repeats every ${t.repeatInterval} ${t.repeatUnit})`;
    if (t.scheduledStart) {
      const nextRun = t.nextRunAt ? new Date(t.nextRunAt.includes('Z') ? t.nextRunAt : t.nextRunAt + 'Z') : null;
      if (nextRun && nextRun > nowDate) {
        line += ` [next run: ${t.nextRunAt}]`;
      }
    }
    if (t.status === 'blocked') line += ' [BLOCKED]';
    // Include task description so PM can make informed decisions
    if (t.description) {
      const desc = t.description.length > 150 ? t.description.slice(0, 150) + '...' : t.description;
      line += `\n  Instructions: ${desc}`;
    }
    // Remediation 4e: ledger evidence inline, the PM judges from what the
    // agent actually DID (rejects, observations, transitions), not from
    // timestamps plus its own wiped history. Same durable record the agent
    // itself sees via the attempt-ledger context block.
    try {
      const evidence = [
        ...getRecentObservations(t.id, 2),
        ...getRecentTransitions(t.id, 2),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-3);
      if (evidence.length > 0) {
        line += `\n  Ledger: ${evidence.map((e) => formatEntryLine(e)).join(' | ').slice(0, 400)}`;
      }
    } catch { /* ledger optional */ }
    return line;
  }).join('\n');

  // Pre-digested issues the engine already detected
  const engineIssues = issues.length > 0
    ? `\nENGINE-DETECTED ISSUES (act on these):\n${issues.map((issue, i) => `${i + 1}. ${issue.text}`).join('\n')}`
    : '';

  const situationReport = `Tracker review -- ${activeTasks.length} active tasks:

${taskSummary}
${engineIssues}

IMPORTANT: Always deliver your findings to ${primaryName} using send_to_agent. Do not just write your analysis in chat -- ${primaryName} cannot see your chat. The ONLY way ${primaryName} receives your report is if you call send_to_agent.

If you spot issues, call send_to_agent to tell ${primaryName}. You can also message agents directly to ask about stalled tasks.
For engine-detected issues, act on them: call send_to_agent to notify ${primaryName} or poke the relevant agent.

DO NOT contact ${primaryName} when:
- Everything looks fine ("all clear" is noise, end silently).
- You investigated an engine flag and concluded it's a false positive (e.g., recurring task waiting for its next fire). End silently; ${primaryName} does not need to hear what you ruled out.
- You have nothing actionable to add beyond what the engine already detected.

Only contact ${primaryName} when there is something they need to do. Keep it brief.`;

  // No engine-detected issues and nothing looks unusual, don't burn tokens
  // for the PM to say "all clear."
  if (issues.length === 0) {
    // AUDIT-FIX: clear the dedup hash on an empty set. Without this, the sequence
    // {A} -> {} -> {A} (the same issue-set recurring after being fully resolved)
    // compared equal to the stale hash and was skipped until a restart.
    lastSituationReportHash = '';
    logger.debug('PM review: no issues detected, skipping LLM call');
    return;
  }

  // Stable dedup hash, keyed ONLY on the actionable issue-set (taskId, issueType).
  // This is the engine-level "don't firehose the primary" gate: the PM brain (and
  // therefore any PM→primary send it produces) re-runs ONLY when the set of genuinely
  // actionable issues changes, a new/changed/resolved (task, issue-type). It must NOT
  // re-run on board CHURN: the full `taskSummary` (ledger lines, notes, status text,
  // next_run_at timestamps) shifts constantly, so including it here made every minor
  // tracker change bust the dedup and re-review/re-notify the same board every few
  // minutes (the owner's "PM keeps sending everything" firehose). The stableId strips the
  // "X minutes ago" drift that defeated the older text hash (v2.3.7). A genuinely large
  // report is still fine when the issue-set DID change, this gates frequency/necessity,
  // never length.
  const stableIssuesKey = issues.map(i => i.stableId).sort().join(',');
  const reportHash = stableIssuesKey;
  if (reportHash === lastSituationReportHash) {
    logger.debug('PM review: actionable issue-set unchanged since last review, skipping (no re-notify)');
    return;
  }
  lastSituationReportHash = reportHash;

  const msgId = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))`)
    .run(msgId, pmId, situationReport);

  broadcast({
    type: 'chat:message',
    agentId: pmId,
    message: { id: msgId, agentId: pmId, role: 'user' as const, content: situationReport, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
  });

  const runtime = getAgentRuntime();
  try {
    recordPmLlmCall();
    await runtime.handleMessage(pmId, situationReport);
  } catch (err) {
    logger.error('PM LLM review failed', { error: err instanceof Error ? err.message : String(err) });
    // Engine-guaranteed delivery (remediation Phase 4, 4a): a failed PM
    // review must not swallow engine-detected issues. Pre-fix, the dedup
    // hash was already consumed above, so the SAME issue-set was skipped as
    // "unchanged" on every later cycle and nobody ever heard about it.
    // Reset the hash so the next cycle retries, and deliver the engine's
    // own issue list straight to the primary (system sender: wakes, and is
    // dedup-exempt). The PM's judgment layer is unchanged on the success
    // path; this only guarantees the failure path. ('' never matches a real
    // hash, so the next cycle retries this exact issue-set.)
    lastSituationReportHash = '';
    // comms-audit rank 8: on a PM-LLM failure this used to splice the FULL engine issue
    // list, issues.map(i => i.text), which is engine-internal directive prose written FOR
    // the PM, including literal "POKE THEM: send_to_agent(...)" restart scripts, straight
    // into a [A2A:QUESTION from:system] to the primary, where it reached the model as
    // re-narration bait. The PM retries next cycle (hash reset above) and the issues are
    // already on the tracker board, so the primary only needs a brief heads-up, not the raw
    // engine directives. Post a brief PM awareness note; never forward issue.text.
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'PM',
      intent: 'pm_review_failed',
      brief: `My review couldn't run this cycle, ${issues.length} tracker item${issues.length === 1 ? '' : 's'} still need${issues.length === 1 ? 's' : ''} a look (they're on the board). I'll retry next cycle; handle anything urgent directly.`,
    });
  }
}

async function runPokeCheck(): Promise<void> {
  const db = getDb();

  // ── A2A auto-task sweeper ──
  // Closes stale on_deck tasks that were auto-created by the engine
  // when an agent sent intent=ASSIGN (autoCreateAssignTask in
  // tracker/schema.ts). The receiver was already woken via A2A and
  // typically handles the work in their reply rather than by updating
  // the tracker row, so without this sweep, every A2A assignment that
  // doesn't get an explicit close leaves an on_deck task forever.
  //
  // Conservative criteria, only touches tasks where ALL of:
  //   - a2a_thread_id IS NOT NULL (engine-injected, not user/agent-made)
  //   - status = 'on_deck'  (not in_progress / not yet handled)
  //   - no schedule (scheduled tasks legitimately wait on_deck)
  //   - updated_at older than 30 min  (give the receiver time to act)
  //   - the receiver has SENT a message since the task was created
  //     (proves they were active, they just didn't update the tracker)
  //
  // Marks 'fallen' with an audit note so the row stays queryable but
  // drops off the active kanban. Never touches agent-created or user-
  // created tasks.
  try {
    const STALE_A2A_GRACE_MS = 30 * 60 * 1000;
    const sweepCutoff = new Date(Date.now() - STALE_A2A_GRACE_MS).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const candidates = db.prepare(`
      SELECT t.id, t.title, t.assigned_to, t.created_at
      FROM tasks t
      WHERE t.status = 'on_deck'
        AND t.a2a_thread_id IS NOT NULL
        AND (t.scheduled_start IS NULL OR t.schedule_status = 'unscheduled')
        AND t.is_paused = 0
        AND datetime(t.updated_at) < ?
      LIMIT 50
    `).all(sweepCutoff) as Array<{ id: string; title: string; assigned_to: string; created_at: string }>;

    if (candidates.length > 0) {
      // Phase B.0: tasks.notes is read-only legacy. Audit trail lives in task_log.
      const closeStmt = db.prepare(`
        UPDATE tasks
        SET status = 'fallen', completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `);
      const activeCheck = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'assistant' AND created_at > ?
        LIMIT 1
      `);
      let swept = 0;
      const { writeTaskLog } = await import('./task-log.js');
      for (const t of candidates) {
        // Only close if the receiver was active (sent any assistant
        // message) after the task was created. If they were silent the
        // whole time, the proper failure path is the in_progress poke
        // chain, leave it for that, don't sweep silently.
        const wasActive = activeCheck.get(t.assigned_to, t.created_at) as { 1: number } | undefined;
        if (!wasActive) continue;
        closeStmt.run(t.id);
        writeTaskLog({
          taskId: t.id,
          fromEntity: 'engine',
          entryKind: 'auto_sweep',
          fromStatus: 'on_deck',
          toStatus: 'fallen',
          actionTaken: 'A2A auto-task sweeper',
          reason: `A2A-assigned on_deck task untouched for >= 30 min while receiver ("${t.assigned_to}") was otherwise active. Handled via reply not via tracker.`,
        });
        swept++;
      }
      if (swept > 0) {
        logger.info('A2A auto-task sweeper closed stale on_deck rows', {
          swept, candidates: candidates.length,
          sample: candidates.slice(0, 3).map(t => `${t.id.slice(0, 8)}:${t.title.slice(0, 40)}`),
        });
      }
    }
  } catch (err) {
    logger.warn('A2A auto-task sweeper failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Engine-level quick checks (still needed for immediate alerts) ──
  const allActiveTasks = listTasks({}).filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  // 2026-06-02 bug fix: also count tasks that need PM judgment but are not
  // "active" (complete-but-unvalidated, blocked-but-unvalidated, paused-but-
  // unvalidated, pending override requests). Without this, a completed task
  // sits with complete_validated=0 forever because activeTasks is 0, the
  // polled review never fires, and the event-driven debounce is the only
  // path that could wake the PM. Belt-and-suspenders.
  const pendingValidation = (() => {
    try {
      const row = getDb().prepare(`
        SELECT
          (SELECT COUNT(*) FROM tasks WHERE status = 'complete' AND complete_validated = 0 AND awaiting_user_verdict = 0) +
          (SELECT COUNT(*) FROM tasks WHERE status = 'blocked' AND blocked_validated = 0 AND awaiting_user_verdict = 0) +
          (SELECT COUNT(*) FROM tasks WHERE status = 'paused' AND pause_validated = 0) +
          (SELECT COUNT(*) FROM task_override_requests WHERE status = 'pending')
        AS c
      `).get() as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  })();

  logger.info('PM poke loop tick', { activeTasks: allActiveTasks.length, pendingValidation });

  // Trigger PM review if there's any active or pending-validation work.
  if (allActiveTasks.length > 0 || pendingValidation > 0) {
    runPMReview().catch(err => {
      logger.error('PM review failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  // ── Engine-level in_progress poke chain (nudge → urgent → escalate) ──
  const inProgressTasks = allActiveTasks.filter(t => t.status === 'in_progress');
  const now = Date.now();

  const POKE_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes

  for (const task of inProgressTasks) {
    if (!task.assignedTo) continue;

    // Grace period: don't poke tasks that were just created. Give agents
    // time to actually start working before flagging them.
    // Use updatedAt so auto-resumed and recently-changed tasks also get the grace period
    const taskUpdated = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z').getTime();
    if (now - taskUpdated < POKE_GRACE_PERIOD_MS) continue;

    // Skip tasks with a future scheduled_start -- they're waiting for the scheduler, not stale
    if (task.scheduledStart) {
      const scheduledMs = new Date(task.scheduledStart.includes('Z') ? task.scheduledStart : task.scheduledStart + 'Z').getTime();
      if (scheduledMs > now) continue;
    }
    // Skip tasks in a waiting schedule state
    if (task.scheduleStatus === 'waiting') continue;

    const thresholds = POKE_THRESHOLDS[task.priority] ?? POKE_THRESHOLDS.normal;

    // ── Idle detection (v2.3.6) ──
    // Use the OLDER of two signals so a busy-but-stalled task can still
    // be detected:
    //   1. Per-task idle (task.updated_at), captures finished-but-not-
    //      closed tasks. The bug we're fixing in v2.3.6: if the agent is
    //      busy on Task B, per-agent idle never triggers and Task A sits
    //      open forever. task.updated_at is reliable as "last assignee-
    //      driven change" because pokes log to poke_log, not the task row.
    //   2. Per-agent idle (last message anywhere), preserves the
    //      original "agent crashed entirely / went silent" coverage.
    //
    // Whichever signal is older drives the idleSeconds. If the agent is
    // active globally but the task hasn't moved, per-task wins → poke.
    // If both are old, both agree → poke.
    const pokeDb = getDb();
    const lastAgentMsg = pokeDb.prepare(`
      SELECT created_at FROM messages
      WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(task.assignedTo) as { created_at: string } | undefined;

    const taskUpdatedMs = taskUpdated;
    const agentLastMsgStr = lastAgentMsg?.created_at;
    const agentLastMsgMs = agentLastMsgStr
      ? new Date(agentLastMsgStr.includes('Z') ? agentLastMsgStr : agentLastMsgStr + 'Z').getTime()
      : taskUpdatedMs;

    const idleSeconds = Math.max(
      0,
      Math.floor((now - Math.min(taskUpdatedMs, agentLastMsgMs)) / 1000),
    );

    // Get the last poke for this task
    const lastPoke = getLastPoke(task.id);
    const lastPokeNumber = lastPoke?.pokeNumber ?? 0;

    // Determine what poke to send based on idle time and previous pokes
    let pokeType: string | null = null;
    let pokeNumber = 0;

    if (idleSeconds >= thresholds.autoReset && lastPokeNumber < 4) {
      pokeType = 'auto_reset';
      pokeNumber = 4;
    } else if (idleSeconds >= thresholds.escalate && lastPokeNumber < 3) {
      pokeType = 'escalate_primary';
      pokeNumber = 3;
    } else if (idleSeconds >= thresholds.second && lastPokeNumber < 2) {
      pokeType = 'urgent';
      pokeNumber = 2;
    } else if (idleSeconds >= thresholds.first && lastPokeNumber < 1) {
      pokeType = 'nudge';
      pokeNumber = 1;
    }

    if (!pokeType) continue;

    const primaryId = getPrimaryAgentId();
    const pmId = getPMAgentId();
    const pmName = getPMAgentName();

    // ── Auto-reset: escalation failed, take direct action ──
    if (pokeType === 'auto_reset') {
      const db = getDb();
      const idleMinutes = Math.floor(idleSeconds / 60);

      // Move task back to on_deck so it can be retried
      db.prepare("UPDATE tasks SET status = 'on_deck', updated_at = datetime('now') WHERE id = ?").run(task.id);

      // If this is a scheduled task, also reset schedule_status so the scheduler retries
      if (task.scheduleStatus === 'running') {
        // Fail the current run and let onTaskRunComplete reset to waiting
        import('../scheduler/runner.js').then(({ onTaskRunComplete }) => {
          onTaskRunComplete(task.id, 'failed', `Auto-failed: agent idle for ${idleMinutes} minutes after full escalation chain`).catch(() => {});
        });
      }

      // Notify primary agent via A2A transport
      const resetMsg = `AUTO-RESET: Task "${task.title}" (${task.id}) was moved back to on_deck after ${idleMinutes} minutes idle. The assigned agent (${task.assignedToName ?? task.assignedTo}) did not respond after 3 pokes and escalation. The task needs to be reassigned or investigated.`;

      // Auto-reset only fires after the full escalation chain has already
      // failed (2 pokes + 1 escalation), by definition something needs the
      // primary's attention NOW. Use ASSIGN so primary actually wakes and
      // reassigns/investigates, not FYI which would let the task sit
      // unassigned until the primary is woken by something else.
      import('../agent/a2a-transport.js').then(({ deliverA2AMessage: deliverReset }) => {
        deliverReset({
          intent: 'ASSIGN',
          threadId: '',
          requiresResponse: true,
          payload: resetMsg,
          toAgent: primaryId,
          fromAgent: pmId,
        }).catch(err => {
          logger.error('PM auto-reset: A2A delivery failed', { error: err instanceof Error ? err.message : String(err) });
        });
      });

      logPoke(task.id, task.assignedTo, pokeNumber, pokeType);
      logger.warn('PM auto-reset: task moved to on_deck', { taskId: task.id, title: task.title, idleMinutes, assignedTo: task.assignedTo });

      broadcast({ type: 'tracker:poke', data: { taskId: task.id, agentId: task.assignedTo!, pokeType } });
      continue;
    }

    // ── Normal poke (nudge / urgent / escalate) ──
    const pokeMessage = buildPokeMessage(task, pokeType, pokeNumber, idleSeconds);
    const recipient = pokeType === 'escalate_primary' ? primaryId : task.assignedTo;

    // Deliver poke via A2A transport. Pokes use QUESTION intent (we want
    // a response) with a thread seeded by task ID + poke stage so each
    // escalation level gets its own thread and hop counter.
    import('../agent/a2a-transport.js').then(({ deliverA2AMessage, makeThreadId }) => {
      const pokeThreadId = makeThreadId(`poke-${task.id}-${pokeType}`);
      deliverA2AMessage({
        intent: pokeType === 'escalate_primary' ? 'ASSIGN' : 'QUESTION',
        threadId: pokeThreadId,
        requiresResponse: true, // All pokes expect a response, even escalations to primary
        payload: pokeMessage,
        toAgent: recipient,
        fromAgent: pmId,
      }).catch(err => {
        logger.error('PM poke: A2A delivery failed', {
          recipient,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }); // close .then()

    // Log the poke
    logPoke(task.id, task.assignedTo, pokeNumber, pokeType);

    logger.info('PM poke sent via A2A transport', {
      taskId: task.id,
      taskTitle: task.title,
      recipient,
      pokeType,
      pokeNumber,
      idleSeconds,
    });
  }
}

function buildPokeMessage(
  task: ReturnType<typeof getTask> & object,
  pokeType: string,
  pokeNumber: number,
  idleSeconds: number,
): string {
  if (!task) return '';

  const idleMinutes = Math.floor(idleSeconds / 60);
  const taskInfo = [
    `Task: ${task.title}`,
    `ID: ${task.id}`,
    `Priority: ${task.priority}`,
    `Status: ${task.status}`,
    task.description ? `Description: ${task.description}` : null,
    task.projectId ? `Project: ${task.projectId}` : null,
    task.stepNumber !== null ? `Step: ${task.stepNumber}${task.totalSteps ? ` of ${task.totalSteps}` : ''}` : null,
    task.notes ? `\nLatest notes:\n${task.notes.split('\n').slice(-3).join('\n')}` : null,
  ].filter(Boolean).join('\n');

  switch (pokeType) {
    case 'nudge':
      return `Checking in, task "${task.title}" has been idle for ${idleMinutes} minutes.\n\n${taskInfo}\n\nIf you've finished this work, call tracker_update_status with task_id="${task.id}" and status="complete" with notes on what you did.\nIf still working, no action needed.\nIf blocked, call tracker_update_status with status="blocked" and explain why.`;

    case 'urgent':
      return `URGENT: Task "${task.title}" has been idle for ${idleMinutes} minutes. This is poke #${pokeNumber}.\n\n${taskInfo}\n\nYou MUST do one of:\n1. Call tracker_update_status(task_id="${task.id}", status="complete", notes="...") if the work is done\n2. Call tracker_update_status(task_id="${task.id}", status="blocked", notes="...") if you're stuck\n3. Continue working on the task`;

    case 'escalate_primary':
      return `ESCALATION: Task "${task.title}" (${task.id}) assigned to ${task.assignedTo} has been idle for ${idleMinutes} minutes with no response after 2 pokes.\n\n${taskInfo}\n\nPlease intervene:\n- Call tracker_update_status(task_id="${task.id}", status="complete") if the work was already done\n- Reassign or unblock the task\n- Or cancel/fail it if it's no longer needed`;

    default:
      return `Poke #${pokeNumber} for task: ${task.title} (idle ${idleMinutes}m)\n\n${taskInfo}\n\nCall tracker_update_status(task_id="${task.id}", status="complete") if done.`;
  }
}

// ── Dependency Checker ──

export function checkDependencies(completedTaskId: string): void {
  const db = getDb();

  // Find tasks that depend on the completed task
  const dependentTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ('on_deck', 'blocked')
      AND depends_on LIKE ?
  `).all(`%${completedTaskId}%`) as Array<{
    id: string;
    title: string;
    status: string;
    assigned_to: string | null;
    depends_on: string;
  }>;

  for (const row of dependentTasks) {
    let dependsOn: string[];
    try {
      dependsOn = JSON.parse(row.depends_on) as string[];
    } catch {
      continue;
    }

    // Check if this task actually depends on the completed task
    if (!dependsOn.includes(completedTaskId)) continue;

    // Check if ALL dependencies are now complete
    const allDepsComplete = dependsOn.every(depId => {
      const depTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(depId) as { status: string } | undefined;
      return depTask?.status === 'complete';
    });

    if (allDepsComplete) {
      // Unblock the task. v2.8.x rule: tasks without a future schedule
      // land in 'in_progress' so they stay visible. 'on_deck' is reserved
      // for scheduled-for-later. A previously-blocked task whose deps just
      // cleared is ready to be worked on now, not parked.
      db.prepare(`
        UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?
      `).run(row.id);

      logger.info('Task unblocked by dependency completion', {
        taskId: row.id,
        taskTitle: row.title,
        completedDep: completedTaskId,
      });

      // Notify primary agent or the assigned agent
      const recipient = row.assigned_to ?? getPrimaryAgentId();
      const task = getTask(row.id);

      if (task) {
        const message = `Task "${task.title}" (${task.id}) is now unblocked. All dependencies are complete.\n\n` +
          `Priority: ${task.priority}\n` +
          (task.description ? `Description: ${task.description}\n` : '') +
          `Previously blocked on: ${dependsOn.join(', ')}`;

        sendAgentMessage(getPMAgentId(), recipient, 'status', message, {
          taskId: task.id,
          event: 'unblocked',
          completedDependency: completedTaskId,
        });
      }
    }
  }
}
