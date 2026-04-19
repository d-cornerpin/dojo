import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { sendAgentMessage } from '../agent/agent-bus.js';
import { listTasks, getTask, getLastPoke, logPoke } from './schema.js';
import { getAgentRuntime } from '../agent/runtime.js';
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

const SCHEDULER_INTERVAL_MS = 30_000; // 30 seconds — scheduler checks run separately

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
    // RICK-SOUL.md removed — only PM-SOUL.md is used
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
    logger.warn('Primary agent not yet created — deferring PM agent spawn', { primaryId });
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
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'memory_grep',
        'load_tool_docs', 'get_current_time',
      ],
    });
    db.prepare("UPDATE agents SET tools_policy = ?, updated_at = datetime('now') WHERE id = ?").run(syncToolsPolicy, pmId);
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
    // PM exists but was terminated — reactivate with correct name, model, and permissions
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
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'memory_grep',
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
        'send_to_agent', 'broadcast_to_group', 'list_agents', 'list_groups',
        'vault_search', 'vault_remember', 'memory_grep',
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

  // Run an immediate first check
  try {
    runPokeCheck();
  } catch (err) {
    logger.error('PM poke loop initial check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  pokeLoopTimer = setInterval(() => {
    try {
      runPokeCheck();
    } catch (err) {
      logger.error('PM poke loop tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

// ── PM LLM Review — runs the PM agent's brain periodically ──

let lastLLMReviewAt = 0;
let lastSituationReportHash = '';
const LLM_REVIEW_INTERVAL_MS = 600_000; // 10 minutes — gives tasks time to settle before reviewing

// How many recent messages to keep for the PM. The PM is a stateless checker —
// it only needs enough context for a short back-and-forth about a stalled task.
const PM_MAX_MESSAGES = 10;

/**
 * Prune old PM messages to keep the context window small.
 * The PM doesn't need history — the tracker is its memory.
 */
function pruneOldPMMessages(pmId: string): void {
  const db = getDb();
  try {
    // Count total messages
    const countRow = db.prepare('SELECT COUNT(*) as c FROM messages WHERE agent_id = ?').get(pmId) as { c: number };
    if (countRow.c <= PM_MAX_MESSAGES) return;

    // Get the ID of the Nth most recent message (our cutoff)
    const cutoff = db.prepare(`
      SELECT id FROM messages WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1 OFFSET ?
    `).get(pmId, PM_MAX_MESSAGES) as { id: string } | undefined;

    if (!cutoff) return;

    // Delete everything older than the cutoff
    const deleted = db.prepare(`
      DELETE FROM messages WHERE agent_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
    `).run(pmId, cutoff.id);

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
  if (now - lastLLMReviewAt < LLM_REVIEW_INTERVAL_MS) return;

  const db = getDb();
  const pmId = getPMAgentId();

  // Prune old messages before each review to keep context tight
  pruneOldPMMessages(pmId);
  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();

  // Check if PM agent exists and has a model
  const pmAgent = db.prepare('SELECT id, model_id, status FROM agents WHERE id = ?').get(pmId) as { id: string; model_id: string | null; status: string } | undefined;
  if (!pmAgent || !pmAgent.model_id || pmAgent.status === 'terminated') return;

  // ── Engine-level checks (fast, deterministic, no LLM needed) ──
  const allTasks = listTasks({});
  const activeTasks = allTasks.filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  if (activeTasks.length === 0) return;

  lastLLMReviewAt = now;

  const agents = db.prepare(`
    SELECT id, name, status, classification FROM agents WHERE status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; classification: string }>;

  const issues: string[] = [];
  const nowDate = new Date();

  for (const task of activeTasks) {
    // 1. Orphaned tasks: assigned to terminated agents
    if (task.assignedTo) {
      const agent = agents.find(a => a.id === task.assignedTo);
      if (!agent) {
        // Agent is terminated or doesn't exist
        issues.push(`ORPHANED: "${task.title}" is assigned to a terminated agent. Notify ${primaryName}.`);
      }
    }

    // 2. Overdue scheduled tasks
    if (task.nextRunAt) {
      const nextRunTime = new Date(task.nextRunAt.includes('Z') ? task.nextRunAt : task.nextRunAt + 'Z');
      if (nextRunTime < nowDate && task.scheduleStatus === 'waiting') {
        const overdueMin = Math.floor((nowDate.getTime() - nextRunTime.getTime()) / 60000);
        if (overdueMin > 5) { // Give 5 min grace period
          issues.push(`OVERDUE: "${task.title}" was due ${overdueMin} minutes ago but hasn't fired.`);
        }
      }
    }

    // 3. Blocked tasks sitting too long
    if (task.status === 'blocked') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const blockedMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (blockedMin > 30) {
        issues.push(`BLOCKED: "${task.title}" has been blocked for ${blockedMin} minutes. May need ${primaryName}'s attention.`);
      }
    }

    // Grace period: don't flag tasks that were just created or recently changed status.
    // A brand-new task is not stale — give agents time to start working.
    const GRACE_PERIOD_MINUTES = 30;
    const taskCreatedTime = new Date(task.createdAt.includes('Z') ? task.createdAt : task.createdAt + 'Z');
    const taskAgeMin = Math.floor((nowDate.getTime() - taskCreatedTime.getTime()) / 60000);

    // 4. Non-scheduled tasks stuck in on_deck with no activity.
    // Skip scheduled tasks waiting for their next run (schedule_status='waiting') —
    // they sit in on_deck between runs and that's normal, not stale.
    if (task.status === 'on_deck' && !task.scheduledStart && task.assignedTo && task.scheduleStatus !== 'waiting') {
      const updatedTime = new Date(task.updatedAt.includes('Z') ? task.updatedAt : task.updatedAt + 'Z');
      const staleMin = Math.floor((nowDate.getTime() - updatedTime.getTime()) / 60000);
      if (staleMin > GRACE_PERIOD_MINUTES && taskAgeMin > GRACE_PERIOD_MINUTES) {
        const agentName = task.assignedToName ?? task.assignedTo;
        issues.push(`STALE: "${task.title}" has been on_deck for ${staleMin} minutes, assigned to ${agentName} but not started.`);
      }
    }

    // 5. In-progress tasks where the assigned agent has gone silent.
    // Grace period: don't flag tasks less than GRACE_PERIOD_MINUTES old.
    if (task.status === 'in_progress' && task.assignedTo && taskAgeMin > GRACE_PERIOD_MINUTES) {
      const agent = agents.find(a => a.id === task.assignedTo);
      if (agent && agent.status !== 'terminated') {
        // Check agent's last message activity
        const lastMsg = db.prepare(`
          SELECT created_at FROM messages WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(task.assignedTo) as { created_at: string } | undefined;
        if (lastMsg) {
          const lastMsgTs = lastMsg.created_at.includes('Z') ? lastMsg.created_at : lastMsg.created_at + 'Z';
          const idleMin = Math.floor((nowDate.getTime() - new Date(lastMsgTs).getTime()) / 60000);
          if (idleMin >= 30) {
            const agentName = task.assignedToName ?? task.assignedTo;
            issues.push(`IDLE: "${task.title}" is in_progress but ${agentName} has had no activity for ${idleMin} minutes. Move to on_deck with tracker_update_status if the agent is not responsive.`);
          }
        }
      }
    }
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
    return line;
  }).join('\n');

  // Pre-digested issues the engine already detected
  const engineIssues = issues.length > 0
    ? `\nENGINE-DETECTED ISSUES (act on these):\n${issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}`
    : '';

  const situationReport = `Tracker review -- ${activeTasks.length} active tasks:

${taskSummary}
${engineIssues}

IMPORTANT: Always deliver your findings to ${primaryName} using send_to_agent. Do not just write your analysis in chat -- ${primaryName} cannot see your chat. The ONLY way ${primaryName} receives your report is if you call send_to_agent.

If you spot issues, call send_to_agent to tell ${primaryName}. You can also message agents directly to ask about stalled tasks.
For engine-detected issues, act on them: call send_to_agent to notify ${primaryName} or poke the relevant agent.
If everything looks fine, DO NOT call send_to_agent. Just end your turn silently — ${primaryName} does not need to hear "all clear" every check cycle. Only contact ${primaryName} when there is something actionable.
Keep it brief.`;

  // No engine-detected issues and nothing looks unusual — don't burn tokens
  // for the PM to say "all clear."
  if (issues.length === 0) {
    logger.debug('PM review: no issues detected, skipping LLM call');
    return;
  }

  // Skip if the situation hasn't changed since the last review — prevents the PM
  // from generating identical tool calls and getting stopped for repetition.
  const reportHash = taskSummary + engineIssues;
  if (reportHash === lastSituationReportHash) {
    logger.debug('PM review: situation unchanged since last review, skipping LLM call');
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
    await runtime.handleMessage(pmId, situationReport);
  } catch (err) {
    logger.error('PM LLM review failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function runPokeCheck(): void {
  const db = getDb();

  // ── Engine-level quick checks (still needed for immediate alerts) ──
  const allActiveTasks = listTasks({}).filter(t => !['complete', 'fallen', 'paused'].includes(t.status));

  logger.info('PM poke loop tick', { activeTasks: allActiveTasks.length });

  // If there are active tasks, trigger the PM's LLM to review (throttled to every 10 min)
  if (allActiveTasks.length > 0) {
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
    const taskCreated = new Date(task.createdAt.includes('Z') ? task.createdAt : task.createdAt + 'Z').getTime();
    if (now - taskCreated < POKE_GRACE_PERIOD_MS) continue;

    // Skip tasks with a future scheduled_start -- they're waiting for the scheduler, not stale
    if (task.scheduledStart) {
      const scheduledMs = new Date(task.scheduledStart.includes('Z') ? task.scheduledStart : task.scheduledStart + 'Z').getTime();
      if (scheduledMs > now) continue;
    }
    // Skip tasks in a waiting schedule state
    if (task.scheduleStatus === 'waiting') continue;

    const thresholds = POKE_THRESHOLDS[task.priority] ?? POKE_THRESHOLDS.normal;

    // Check the assigned agent's LAST ACTIVITY (most recent message), not the task's updatedAt.
    // This avoids false pokes when the primary agent is actively working but hasn't updated the task status yet.
    const pokeDb = getDb();
    const lastActivity = pokeDb.prepare(`
      SELECT created_at FROM messages
      WHERE agent_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(task.assignedTo) as { created_at: string } | undefined;

    const lastActivityStr = lastActivity?.created_at ?? task.updatedAt;
    const normalizedTs = lastActivityStr.includes('Z') ? lastActivityStr : lastActivityStr + 'Z';
    const lastActivityMs = new Date(normalizedTs).getTime();
    const idleSeconds = Math.max(0, Math.floor((now - lastActivityMs) / 1000));

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

      // Notify primary agent
      const resetMsg = `AUTO-RESET: Task "${task.title}" (${task.id}) was moved back to on_deck after ${idleMinutes} minutes idle. The assigned agent (${task.assignedToName ?? task.assignedTo}) did not respond after 3 pokes and escalation. The task needs to be reassigned or investigated.`;
      sendAgentMessage(pmId, primaryId, 'status', resetMsg, {
        taskId: task.id,
        pokeType: 'auto_reset',
        idleSeconds,
      });

      // Inject into primary agent's conversation
      const resetMsgId = uuidv4();
      db.prepare(`INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, created_at) VALUES (?, ?, 'user', ?, ?, datetime('now'))`)
        .run(resetMsgId, primaryId, `[SOURCE: PM AGENT AUTO-RESET — task pulled from stalled agent] ${resetMsg}`, pmId);
      broadcast({ type: 'chat:message', agentId: primaryId, message: { id: resetMsgId, agentId: primaryId, role: 'user' as Message['role'], content: `[SOURCE: PM AGENT AUTO-RESET] ${resetMsg}`, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });

      // Trigger primary agent to process
      const runtime = getAgentRuntime();
      runtime.handleMessage(primaryId, `[${pmName} — Project Manager] ${resetMsg}`).catch(err => {
        logger.error('PM auto-reset: failed to notify primary agent', { error: err instanceof Error ? err.message : String(err) });
      });

      logPoke(task.id, task.assignedTo, pokeNumber, pokeType);
      logger.warn('PM auto-reset: task moved to on_deck', { taskId: task.id, title: task.title, idleMinutes, assignedTo: task.assignedTo });

      broadcast({ type: 'tracker:poke', data: { taskId: task.id, agentId: task.assignedTo!, pokeType } });
      continue;
    }

    // ── Normal poke (nudge / urgent / escalate) ──
    const pokeMessage = buildPokeMessage(task, pokeType, pokeNumber, idleSeconds);
    const recipient = pokeType === 'escalate_primary' ? primaryId : task.assignedTo;

    // Send poke via agent bus
    sendAgentMessage(pmId, recipient, 'poke', pokeMessage, {
      taskId: task.id,
      pokeType,
      pokeNumber,
      idleSeconds,
    });

    // Also inject into the recipient's conversation so the LLM sees it on the next turn
    const db = getDb();
    const pokeMsgId = uuidv4();
    const fullPokeContent = `[SOURCE: PM AGENT POKE FROM ${pmName.toUpperCase()} — this is NOT a message from the user, it's an automated poke from the PM agent checking on your progress] ${pokeMessage}`;
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, agent_id, role, content, source_agent_id, created_at)
      VALUES (?, ?, 'user', ?, ?, datetime('now'))
    `).run(pokeMsgId, recipient, fullPokeContent, pmId);

    // Broadcast same content to dashboard (consistent with what the agent sees)
    broadcast({
      type: 'chat:message',
      agentId: recipient,
      message: {
        id: pokeMsgId,
        agentId: recipient,
        role: 'user' as Message['role'],
        content: fullPokeContent,
        tokenCount: null,
        modelId: null,
        cost: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    broadcast({
      type: 'tracker:poke',
      data: { taskId: task.id, agentId: task.assignedTo!, pokeType },
    });

    // Trigger the recipient's agent runtime so they actually process the poke
    const pokeContent = `[${pmName} — Project Manager] ${pokeMessage}`;
    const runtime = getAgentRuntime();
    runtime.handleMessage(recipient, pokeContent).catch(err => {
      logger.error('PM poke: failed to trigger agent runtime', {
        recipient,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Log the poke
    logPoke(task.id, task.assignedTo, pokeNumber, pokeType);

    logger.info('PM poke sent and agent runtime triggered', {
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
      return `Checking in — task "${task.title}" has been idle for ${idleMinutes} minutes.\n\n${taskInfo}\n\nIf you've finished this work, call tracker_update_status with task_id="${task.id}" and status="complete" with notes on what you did.\nIf still working, no action needed.\nIf blocked, call tracker_update_status with status="blocked" and explain why.`;

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
      // Unblock the task
      db.prepare(`
        UPDATE tasks SET status = 'on_deck', updated_at = datetime('now') WHERE id = ?
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
