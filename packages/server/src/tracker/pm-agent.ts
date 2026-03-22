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
import { sendAlert } from '../services/imessage-bridge.js';
import { getPrimaryAgentId, getPrimaryAgentName, getPMAgentId, getPMAgentName, isPMEnabled, isSetupCompleted, getOwnerName } from '../config/platform.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('pm-agent');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Poke Thresholds (in seconds) ──

const POKE_THRESHOLDS: Record<string, { first: number; second: number; escalate: number }> = {
  high:   { first: 60,   second: 180,  escalate: 600 },
  normal: { first: 120,  second: 300,  escalate: 900 },
  low:    { first: 300,  second: 600,  escalate: 1200 },
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
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status', 'tracker_reassign_task',
        'tracker_add_notes', 'tracker_pause_schedule', 'tracker_resume_schedule',
        'send_to_agent', 'list_agents', 'list_groups', 'get_current_time',
        'imessage_send',
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
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status', 'tracker_reassign_task',
        'tracker_add_notes', 'tracker_pause_schedule', 'tracker_resume_schedule',
        'send_to_agent', 'list_agents', 'list_groups', 'get_current_time',
        'imessage_send',
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
        'tracker_list_active', 'tracker_get_status', 'tracker_update_status', 'tracker_reassign_task',
        'tracker_add_notes', 'tracker_pause_schedule', 'tracker_resume_schedule',
        'send_to_agent', 'list_agents', 'list_groups', 'get_current_time',
        'imessage_send',
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
      INSERT INTO messages (id, agent_id, role, content, created_at)
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

// ── PM LLM Review — runs Samantha's brain periodically ──

let lastLLMReviewAt = 0;
const LLM_REVIEW_INTERVAL_MS = 180_000; // 3 minutes — keeps local LLM costs low

async function runPMReview(): Promise<void> {
  const now = Date.now();
  if (now - lastLLMReviewAt < LLM_REVIEW_INTERVAL_MS) return;

  const db = getDb();
  const pmId = getPMAgentId();
  const pmName = getPMAgentName();
  const primaryName = getPrimaryAgentName();

  // Check if PM agent exists and has a model
  const pmAgent = db.prepare('SELECT id, model_id, status FROM agents WHERE id = ?').get(pmId) as { id: string; model_id: string | null; status: string } | undefined;
  if (!pmAgent || !pmAgent.model_id || pmAgent.status === 'terminated') return;

  // Gather the full tracker state
  const allTasks = listTasks({});
  const activeTasks = allTasks.filter(t => !['complete', 'fallen'].includes(t.status));

  // Don't run if there's nothing to monitor
  if (activeTasks.length === 0) return;

  lastLLMReviewAt = now;

  // Get agent statuses
  const agents = db.prepare(`
    SELECT id, name, status, classification FROM agents WHERE status != 'terminated'
  `).all() as Array<{ id: string; name: string; status: string; classification: string }>;

  // Build situation report
  const taskLines = allTasks.map(t => {
    const agentStatus = t.assignedTo
      ? (agents.find(a => a.id === t.assignedTo)?.status ?? 'UNKNOWN')
      : 'unassigned';
    const schedInfo = t.scheduledStart
      ? ` | scheduled: ${t.scheduleStatus}, runs: ${t.runCount}${t.nextRunAt ? ', next: ' + t.nextRunAt : ''}`
      : '';
    return `- [${t.status.toUpperCase()}] "${t.title}" (${t.id}) → ${t.assignedToName ?? t.assignedTo ?? 'unassigned'} (agent ${agentStatus})${schedInfo}${t.notes ? ' | notes: ' + t.notes.split('\n').pop() : ''}`;
  }).join('\n');

  const agentLines = agents.map(a => `- ${a.name} (${a.id}): ${a.status}`).join('\n');

  const situationReport = `TRACKER STATUS REVIEW — ${new Date().toLocaleString()}

TASKS:
${taskLines || '(no tasks)'}

AGENTS:
${agentLines}

Review the tasks above. Look for:
1. Tasks assigned to terminated or idle agents that should be reassigned
2. Tasks stuck in on_deck that should be in_progress
3. Blocked tasks that need attention
4. Scheduled tasks that missed their run time
5. Completed upstream tasks where downstream tasks should now start
6. Any task that looks stuck or problematic

If you find issues, use your tools to fix them:
- tracker_update_status to change task status
- tracker_reassign_task to move tasks to available agents
- send_to_agent to poke agents or notify ${primaryName}
- If you can't fix something, tell ${primaryName} what's wrong

If everything looks fine, just say "All clear" — don't take action for the sake of it.`;

  // Inject into Samantha's conversation and trigger her runtime
  const msgId = uuidv4();
  db.prepare(`INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, 'user', ?, datetime('now'))`)
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
  const allActiveTasks = listTasks({}).filter(t => !['complete', 'fallen'].includes(t.status));

  logger.info('PM poke loop tick', { activeTasks: allActiveTasks.length });

  // If there are active tasks, trigger the PM's LLM to review (throttled to every 3 min)
  if (allActiveTasks.length > 0) {
    runPMReview().catch(err => {
      logger.error('PM review failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  // ── Engine-level in_progress poke chain (nudge → urgent → escalate) ──
  const inProgressTasks = allActiveTasks.filter(t => t.status === 'in_progress');
  const now = Date.now();

  for (const task of inProgressTasks) {
    if (!task.assignedTo) continue;

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

    if (idleSeconds >= thresholds.escalate && lastPokeNumber < 3) {
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

    // Build poke message with full task context
    const pokeMessage = buildPokeMessage(task, pokeType, pokeNumber, idleSeconds);

    // Determine recipient: escalation goes to primary agent, others go to assigned agent
    const primaryId = getPrimaryAgentId();
    const pmId = getPMAgentId();
    const pmName = getPMAgentName();
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
    db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'user', ?, datetime('now'))
    `).run(pokeMsgId, recipient, `[${pmName} — Project Manager] ${pokeMessage}`);

    // Broadcast so dashboard updates
    broadcast({
      type: 'chat:message',
      agentId: recipient,
      message: {
        id: pokeMsgId,
        agentId: recipient,
        role: 'user' as Message['role'],
        content: `[${pmName} — Project Manager] ${pokeMessage}`,
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

    // Alert owner via iMessage for escalations
    if (pokeType === 'escalate_primary') {
      const idleMinutes = Math.floor(idleSeconds / 60);
      const primaryName = getPrimaryAgentName();
      sendAlert(`Task "${task.title}" stalled — ${task.assignedTo} unresponsive after ${idleMinutes}m. ${primaryName} has been notified.`, 'warning');
    }

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
