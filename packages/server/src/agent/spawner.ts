import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import { getAgentPermissions, checkPermission } from './permissions.js';
import { isPrimaryAgent } from '../config/platform.js';
import { sendAgentMessage } from './agent-bus.js';
import { postAgentNotice } from './agent-notice.js';
import { memoryGrep } from '../memory/retrieval.js';
import { canSpawnAgent } from '../services/resource-monitor.js';
import { archiveAgentConversation } from '../vault/archive.js';
import type { PermissionManifest, Agent, Message } from '@dojo/shared';

const logger = createLogger('spawner');

function broadcastMessage(agentId: string, msg: { id: string; role: string; content: string }) {
  broadcast({
    type: 'chat:message',
    agentId,
    message: {
      id: msg.id,
      agentId,
      role: msg.role as Message['role'],
      content: msg.content,
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    },
  });
}

// ── Config (reads from DB config table, falls back to defaults) ──

const SPAWN_DEFAULTS = {
  maxChildrenPerAgent: 3,
  maxConcurrent: 5,
  maxSpawnDepth: 2,
  defaultTimeout: 900, // 15 minutes
};

function getSpawnConfig() {
  try {
    const db = getDb();
    const get = (key: string, fallback: number): number => {
      const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
      if (row) {
        const n = parseInt(row.value, 10);
        if (!isNaN(n) && n > 0) return n;
      }
      return fallback;
    };
    return {
      maxChildrenPerAgent: get('spawn_max_children', SPAWN_DEFAULTS.maxChildrenPerAgent),
      maxConcurrent: get('spawn_max_concurrent', SPAWN_DEFAULTS.maxConcurrent),
      maxSpawnDepth: get('spawn_max_depth', SPAWN_DEFAULTS.maxSpawnDepth),
      defaultTimeout: get('spawn_default_timeout', SPAWN_DEFAULTS.defaultTimeout),
    };
  } catch {
    return SPAWN_DEFAULTS;
  }
}

// Track active timeout timers
const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Spawn Agent ──

export interface SpawnParams {
  parentId: string;
  name: string;
  systemPrompt: string;
  modelId?: string;
  permissions?: PermissionManifest;
  toolsPolicy?: { allow: string[]; deny: string[] };
  timeout?: number;
  taskId?: string;
  contextHints?: string[];
  persist?: boolean;
  classification?: 'ronin' | 'apprentice' | 'sensei';
  shareUserProfile?: boolean;
  groupId?: string;
  /** Custom initial message to send instead of the default. If set, replaces the entire task message including complete_task instructions. */
  initialMessage?: string;
  /** Technique IDs to equip on this agent (pre-loaded into context) */
  equippedTechniques?: string[];
  /** Custom always-loaded tools for this agent (overrides role defaults) */
  alwaysLoadedTools?: string[];
  /**
   * If false, skip the initial wakeup. The agent is spawned but stays idle
   * until it gets a real message (a task assignment, an A2A poke, etc.). Use
   * this when the parent wants to set up state before the apprentice runs —
   * for example, building a squad and customising each member before any of
   * them start working.
   *
   * Default: true (preserves the existing auto-start behaviour, including the
   * initial task message that injects complete_task instructions).
   */
  autoStart?: boolean;
}

export async function spawnAgent(params: SpawnParams): Promise<{ agentId: string; name: string; status: string; persist: boolean }> {
  const {
    parentId,
    name,
    systemPrompt,
    modelId,
    permissions,
    toolsPolicy,
    timeout,
    taskId,
    contextHints,
    persist = false,
    classification = 'apprentice',
    shareUserProfile = false,
    groupId,
    equippedTechniques = [],
    alwaysLoadedTools,
    autoStart = true,
  } = params;

  // Validate the contract early so the failure message tells the caller what
  // they actually got wrong. The tool schema marks both fields as required
  // but the dispatcher doesn't enforce that, so a missing systemPrompt used
  // to crash deep inside the prompt-assembly path (line ~318:
  // `systemPrompt.toLowerCase()`) with the cryptic "Cannot read properties
  // of undefined (reading 'toLowerCase')".
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('spawn_agent: `name` is required (a non-empty string).');
  }
  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('spawn_agent: `system_prompt` is required (a non-empty string describing the agent\'s role and instructions).');
  }

  const db = getDb();

  // Check parent's permission to spawn
  const spawnCheck = checkPermission(parentId, { type: 'spawn' });
  if (!spawnCheck.allowed) {
    throw new Error(`Spawn denied: ${spawnCheck.reason}`);
  }

  // Resource gating: check if we have enough memory to spawn
  const resourceCheck = canSpawnAgent();
  if (!resourceCheck.allowed) {
    throw new Error(`Spawn denied: ${resourceCheck.reason}`);
  }

  // Get parent agent info
  const parent = db.prepare('SELECT * FROM agents WHERE id = ?').get(parentId) as {
    id: string;
    name: string;
    model_id: string | null;
    spawn_depth: number;
    status: string;
  } | undefined;

  if (!parent) {
    throw new Error(`Parent agent not found: ${parentId}`);
  }

  const newDepth = (parent.spawn_depth ?? 0) + 1;
  const spawnConfig = getSpawnConfig();
  const parentIsPrimary = isPrimaryAgent(parentId);

  // Validate spawn limits — primary agent is exempt from children and depth limits
  if (!parentIsPrimary && newDepth > spawnConfig.maxSpawnDepth) {
    throw new Error(`Spawn depth limit reached: max depth is ${spawnConfig.maxSpawnDepth}, would be ${newDepth}`);
  }

  if (!parentIsPrimary) {
    const childCount = db.prepare(`
      SELECT COUNT(*) as count FROM agents
      WHERE parent_agent = ? AND status NOT IN ('terminated')
    `).get(parentId) as { count: number };

    if (childCount.count >= spawnConfig.maxChildrenPerAgent) {
      throw new Error(`Child limit reached: ${parentId} already has ${childCount.count} active children (max ${spawnConfig.maxChildrenPerAgent})`);
    }
  }

  // Resolve model: "auto" means use the router
  const resolvedModelId = modelId === 'auto' ? 'auto' : (modelId ?? parent.model_id);
  if (!resolvedModelId) {
    throw new Error('No model specified and parent has no model configured');
  }

  // Build enhanced system prompt with context hints
  let enhancedPrompt = systemPrompt;

  if (contextHints && contextHints.length > 0) {
    const contextParts: string[] = [];
    for (const hint of contextHints) {
      try {
        const grepResult = memoryGrep(parentId, {
          pattern: hint,
          mode: 'full_text',
          scope: 'both',
          limit: 5,
        });
        if (!grepResult.includes('No results found')) {
          contextParts.push(`--- Context for "${hint}" ---\n${grepResult}`);
        }
      } catch (err) {
        logger.warn('Context hint grep failed', {
          hint,
          error: err instanceof Error ? err.message : String(err),
        }, parentId);
      }
    }

    if (contextParts.length > 0) {
      enhancedPrompt = systemPrompt + '\n\n# Context from Parent Memory\n\n' + contextParts.join('\n\n');
    }
  }

  // Create agent record
  const agentId = uuidv4();
  // Ronin agents don't get a timeout -- they persist until the user dismisses them
  const timeoutSeconds = classification === 'ronin' ? null : (timeout ?? spawnConfig.defaultTimeout);
  const timeoutAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000).toISOString().replace('T', ' ').replace('Z', '') : null;

  const permissionsJson = JSON.stringify(permissions ?? getAgentPermissions(parentId));
  const toolsPolicyJson = JSON.stringify(toolsPolicy ?? {});

  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by,
                        parent_agent, spawn_depth, agent_type, classification, group_id, max_runtime, timeout_at,
                        permissions, tools_policy, equipped_techniques, task_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', ?, ?,
            ?, ?, 'standard', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    agentId,
    name,
    resolvedModelId,
    JSON.stringify({ persist, shareUserProfile: shareUserProfile || undefined }),
    parentId,
    parentId,
    newDepth,
    classification,
    groupId ?? null,
    timeoutSeconds,
    timeoutAt,
    permissionsJson,
    toolsPolicyJson,
    JSON.stringify(equippedTechniques),
    taskId ?? null,
  );

  // Set custom always_loaded_tools if provided by the parent
  if (alwaysLoadedTools && alwaysLoadedTools.length > 0) {
    try {
      db.prepare('UPDATE agents SET always_loaded_tools = ? WHERE id = ?').run(JSON.stringify(alwaysLoadedTools), agentId);
    } catch { /* column may not exist on very old databases */ }
  }

  logger.info('Agent spawned', {
    agentId,
    name,
    parentId,
    depth: newDepth,
    modelId: resolvedModelId,
    timeout: timeoutSeconds,
    taskId,
  }, parentId);

  // Store the system prompt as the first system message
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'system', ?, datetime('now'))
  `).run(uuidv4(), agentId, enhancedPrompt);

  // Build the Agent data for broadcast
  const agentData: Agent = {
    id: agentId,
    name,
    modelId: resolvedModelId,
    systemPromptPath: null,
    status: 'idle',
    config: {},
    createdBy: parentId,
    parentAgent: parentId,
    spawnDepth: newDepth,
    agentType: 'standard',
    classification,
    groupId: groupId ?? null,
    maxRuntime: timeoutSeconds,
    timeoutAt,
    permissions: permissions ?? null,
    toolsPolicy: toolsPolicy ?? null,
    equippedTechniques: equippedTechniques ?? [],
    taskId: taskId ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  broadcast({
    type: 'agent:created',
    data: agentData,
  });

  // Set timeout timer -- ronin agents never timeout, persist agents get cleared, apprentices get terminated
  if (timeoutSeconds && classification !== 'ronin') {
    if (persist) {
      const timer = setTimeout(() => {
        logger.info('Persist agent timeout reached -- clearing timeout, agent stays alive', { agentId, name, timeout: timeoutSeconds }, agentId);
        db.prepare(`UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(agentId);
        timeoutTimers.delete(agentId);
      }, timeoutSeconds * 1000);
      timeoutTimers.set(agentId, timer);
    } else {
      const timer = setTimeout(() => {
        logger.warn('Agent timed out', { agentId, name, timeout: timeoutSeconds }, agentId);
        terminateAgent(agentId, 'Timeout reached');
      }, timeoutSeconds * 1000);
      timeoutTimers.set(agentId, timer);
    }
  }

  // Start the agent runtime with an initial task message
  const runtime = getAgentRuntime();
  let taskMessage: string;

  if (params.initialMessage) {
    // Custom initial message provided — use it, but always remind about complete_task
    taskMessage = params.initialMessage;
    if (!params.initialMessage.toLowerCase().includes('complete_task')) {
      taskMessage += '\n\nIMPORTANT: When you are finished, you MUST call complete_task with status="complete" and a summary. Do NOT just stop responding.';
    }
  } else if (systemPrompt.toLowerCase().includes('complete_task')) {
    // System prompt already mentions complete_task — don't inject default instructions
    taskMessage = `Your task: ${systemPrompt}\n\nBegin working immediately.`;
  } else {
    // Default: inject complete_task instructions
    taskMessage = `Your task: ${systemPrompt}

IMPORTANT INSTRUCTIONS:
1. Begin working immediately.
2. Use absolute file paths (e.g., /Users/<your-user>/Desktop/...) — do NOT use ~ or relative paths, as they may resolve differently in your context.
3. If you have been assigned a tracker task, call tracker_update_status(task_id=YOUR_TASK_ID, status="complete", notes="what you did") BEFORE calling complete_task.
4. When you have completed the task, you MUST call the complete_task tool with status="complete", a summary of what you did, and any results. Do NOT just stop responding — call complete_task so your parent agent knows you are done.
5. If you get stuck or cannot complete the task, call complete_task with status="blocked" or status="fallen" and explain why.
6. Do not wait for further instructions unless you need clarification — just do the work and report back via complete_task.`;
  }

  // Append task ID context if this agent has an associated tracker task
  if (taskId) {
    taskMessage += `\n\nYour tracker task ID is: ${taskId} — update its status when you finish.`;
  }

  if (autoStart === false) {
    // Caller wants the agent spawned but not poked. Skip both the initial
    // message and the runtime trigger. The agent will run when something
    // else wakes it (an A2A message, a task assignment, send_to_agent, etc.).
    logger.info('Spawned with auto_start=false — agent stays idle until externally poked', { agentId, name });
    return { agentId, name, status: 'idle', persist };
  }

  // Insert initial user message to kick off the agent loop
  const initMsgId = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO messages (id, agent_id, role, content, created_at)
    VALUES (?, ?, 'user', ?, datetime('now'))
  `).run(initMsgId, agentId, taskMessage);
  broadcastMessage(agentId, { id: initMsgId, role: 'user', content: taskMessage });

  // Start the agent loop asynchronously
  runtime.handleMessage(agentId, taskMessage).catch(err => {
    logger.error('Spawned agent initial run failed', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  });

  return { agentId, name, status: 'idle', persist };
}

// ── Terminate Agent ──

export function terminateAgent(agentId: string, reason?: string): void {
  const db = getDb();

  const agent = db.prepare('SELECT id, name, status, classification FROM agents WHERE id = ?').get(agentId) as {
    id: string;
    name: string;
    status: string;
    classification: string;
  } | undefined;

  if (!agent) {
    logger.warn('Cannot terminate: agent not found', { agentId });
    return;
  }

  if (agent.status === 'terminated') {
    logger.debug('Agent already terminated', { agentId });
    return;
  }

  // Sensei and ronin agents cannot be terminated by other agents (cascade)
  // Dashboard DELETE route handles its own check; this blocks agent-initiated termination
  if (agent.classification === 'sensei') {
    logger.warn('Cannot terminate sensei agent', { agentId, name: agent.name });
    return;
  }

  // Archive conversation for the Dreamer before terminating
  try {
    archiveAgentConversation(agentId);
  } catch (err) {
    logger.warn('Failed to archive agent conversation on termination', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // Update status
  db.prepare(`
    UPDATE agents SET status = 'terminated', updated_at = datetime('now') WHERE id = ?
  `).run(agentId);

  // v2.5.46 Layer 2 — auto-pause in_progress tasks owned by the
  // terminated agent. Without this they sit as zombies (the agent
  // can never close them; PM keeps poking; user sees stale tasks
  // forever). Pause (not complete) so the user can decide whether
  // to reassign or close them.
  try {
    const danglers = db.prepare(`
      SELECT id, title FROM tasks
      WHERE assigned_to = ? AND status = 'in_progress' AND is_paused = 0
    `).all(agentId) as Array<{ id: string; title: string }>;
    if (danglers.length > 0) {
      const note = `[${new Date().toISOString()}] Auto-paused: assigned agent "${agent.name}" was terminated (reason: ${reason ?? 'manual'}). Reassign or close from the dashboard.`;
      // v2.9.22 — pause_validated=1 because the engine, not the agent,
      // initiated the pause (agent termination). PM doesn't need to
      // re-validate; the user resolves these from the dashboard.
      // Same loop-prevention as the v2 close-out paths.
      for (const dt of danglers) {
        db.prepare(`
          UPDATE tasks
          SET status = 'paused', is_paused = 1, status_before_pause = 'in_progress',
              pause_validated = 1,
              notes = COALESCE(notes, '') || ? || char(10),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(note, dt.id);
      }
      logger.info('terminateAgent: auto-paused in_progress tasks', {
        agentId, count: danglers.length,
        sample: danglers.slice(0, 3).map((t) => t.id.slice(0, 8)),
      }, agentId);
    }
  } catch (autopauseErr) {
    logger.warn('terminateAgent: task auto-pause failed (non-fatal)', {
      agentId, error: autopauseErr instanceof Error ? autopauseErr.message : String(autopauseErr),
    }, agentId);
  }

  // Clear timeout timer
  const timer = timeoutTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(agentId);
  }

  logger.info('Agent terminated', {
    agentId,
    name: agent.name,
    reason: reason ?? 'manual',
  }, agentId);

  broadcast({
    type: 'agent:terminated',
    agentId,
    reason: reason ?? 'manual termination',
  });

  // Close browser session if open
  import('./browser.js').then(({ closeSession }) => {
    closeSession(agentId).catch(() => {});
  }).catch(() => {});

  // Cascade: terminate only apprentice children (sensei and ronin survive)
  const children = db.prepare(`
    SELECT id FROM agents WHERE parent_agent = ? AND status != 'terminated' AND classification = 'apprentice'
  `).all(agentId) as Array<{ id: string }>;

  for (const child of children) {
    terminateAgent(child.id, `Parent ${agentId} terminated`);
  }
}

// ── Complete Agent ──

export async function completeAgent(
  agentId: string,
  status: 'complete' | 'fallen' | 'blocked',
  summary: string,
  results?: string,
): Promise<void> {
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as {
    id: string;
    name: string;
    parent_agent: string | null;
    task_id: string | null;
    config: string;
    created_at: string;
    classification: string | null;
    agent_type: string | null;
  } | undefined;

  if (!agent) {
    logger.warn('Cannot complete: agent not found', { agentId });
    return;
  }

  // Gather stats
  const messageStats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as total_tokens
    FROM messages WHERE agent_id = ?
  `).get(agentId) as { count: number; total_tokens: number };

  const costStats = db.prepare(`
    SELECT COALESCE(SUM(cost), 0) as total_cost
    FROM audit_log WHERE agent_id = ? AND action_type = 'model_call'
  `).get(agentId) as { total_cost: number };

  const toolStats = db.prepare(`
    SELECT COUNT(*) as count FROM audit_log
    WHERE agent_id = ? AND action_type IN ('tool_call', 'file_read', 'file_write', 'exec')
  `).get(agentId) as { count: number };

  const durationSeconds = Math.floor(
    (Date.now() - new Date(agent.created_at).getTime()) / 1000,
  );

  // Sensei agents and anything explicitly marked `agent_type='persistent'`
  // are treated as persistent regardless of the config JSON. Pre-fix,
  // this branch only honored `config.persist`, which silently terminated
  // sensei agents (e.g. the Trainer) whose config row didn't carry that
  // field — the sensei guard in terminateAgent didn't help because
  // completeAgent does its own raw UPDATE.
  let isPersistent = agent.classification === 'sensei' || agent.agent_type === 'persistent';
  if (!isPersistent) {
    try {
      const config = JSON.parse(agent.config || '{}');
      isPersistent = config.persist === true;
    } catch {}
  }

  // Archive conversation for the Dreamer before changing status
  try {
    archiveAgentConversation(agentId);
  } catch (err) {
    logger.warn('Failed to archive agent conversation on completion', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  if (isPersistent) {
    // Persistent agent: set to idle, keep alive for future messages
    db.prepare(`
      UPDATE agents SET status = 'idle', updated_at = datetime('now') WHERE id = ?
    `).run(agentId);
    logger.info('Persistent agent completed task, remaining idle', { agentId, name: agent.name });
  } else {
    // Non-persistent: terminate immediately
    db.prepare(`
      UPDATE agents SET status = 'terminated', updated_at = datetime('now') WHERE id = ?
    `).run(agentId);
  }

  // Clear timeout timer
  const timer = timeoutTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(agentId);
  }

  // Send result message to parent via agent bus
  if (agent.parent_agent) {
    const completionText = [
      `Agent "${agent.name}" completed with status: ${status}`,
      '',
      `Summary: ${summary}`,
      results ? `\nResults:\n${results}` : '',
      '',
      `Stats: ${messageStats.count} messages, ${messageStats.total_tokens} tokens, $${costStats.total_cost.toFixed(4)} cost, ${durationSeconds}s runtime, ${toolStats.count} tool calls`,
    ].filter(Boolean).join('\n');

    sendAgentMessage(agentId, agent.parent_agent, 'result', completionText, {
      status,
      summary,
      results,
      stats: {
        tokensUsed: messageStats.total_tokens,
        cost: costStats.total_cost,
        durationSeconds,
        toolCallsCount: toolStats.count,
      },
    });

    // Notify the parent — but as a BRIEF, first-person, self-attributed note in the
    // parent's awareness lane, NOT the full result dumped into its conversation.
    // Pre-fix this injected the ENTIRE completion summary as a role='system' row, which
    // live compaction then folded into the parent's context summaries, and the parent
    // model read another agent's work out of its own history and narrated it back to the
    // user — repeatedly (the owner's "Dreamer batch" summaries). Now:
    //   • The FULL result stays in the agent bus (sendAgentMessage above) — the record /
    //     lane the parent can pull from deliberately if it needs the detail.
    //   • The parent sees only a brief self-attributed one-liner, structurally tagged
    //     origin_kind='engine' so it lands in the EVENTS/awareness lane (never the live
    //     user conversation), and marked platform-noise so compaction never folds it into
    //     a summary. The parent may CHOOSE to surface it to the user in its own voice; the
    //     raw exchange never enters the user's chat.
    const firstSentence = (summary ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
    const brief = firstSentence.length > 180 ? `${firstSentence.slice(0, 177)}...` : firstSentence;
    // The Dreamer is a persistent PER-BATCH agent: it calls complete_task once per batch,
    // so notifying the parent here would drip N notices per nightly cycle. It posts ONE
    // consolidated notice at cycle END instead (spawnNextDreamerBatch). Skip the per-batch
    // note for it; every other agent still gets its normal per-completion note.
    const { isDreamerAgent: isDreamer } = await import('../config/platform.js');
    if (!(agent.name === 'Dreamer' || isDreamer(agentId))) {
      postAgentNotice({
        toAgentId: agent.parent_agent,
        fromName: agent.name ?? 'sub-agent',
        brief: brief || `Finished my work (${status}).`,
      });
    }
  }

  // Resolve the task this agent owns. Prefer the explicit agent.task_id link
  // (set at spawn time when task_id is passed). Fall back to "any open task
  // assigned to this agent" — covers the case where a task was created or
  // reassigned to the agent after spawn (assigned_to does NOT auto-sync to
  // agents.task_id, so without this fallback completeAgent would silently
  // leave the task in_progress and break dependency chains).
  let resolvedTaskId: string | null = agent.task_id;
  if (!resolvedTaskId) {
    // Match either an in-flight assigned task OR a just-completed assigned task
    // with no summary yet (covers the case where the apprentice called
    // tracker_update_status first and complete_task second — we still want to
    // write the summary onto the already-completed task).
    const fallbackTask = db.prepare(`
      SELECT id FROM tasks
       WHERE assigned_to = ?
         AND (status IN ('on_deck','in_progress')
              OR (status = 'complete'
                  AND (completion_summary IS NULL OR completion_summary = '')))
       ORDER BY created_at DESC LIMIT 1
    `).get(agentId) as { id: string } | undefined;
    if (fallbackTask) resolvedTaskId = fallbackTask.id;
  }

  // If task_id: update task status
  if (resolvedTaskId) {
    const taskStatus = status === 'complete' ? 'complete' : status === 'fallen' ? 'fallen' : 'blocked';
    // Phase B.0: tasks.notes is read-only legacy. Snapshot prior status
    // for the task_log transition entry, then update the row without
    // touching the notes column. completion_summary stays as the
    // canonical "result" home for apprentice flows (also reused by
    // Phase B.1 evidence plumbing).
    const priorRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(resolvedTaskId) as { status: string } | undefined;

    // Phase B.1: plumb result + evidence_json from the apprentice's summary
    // so PM has structured input to validate against (instead of just prose).
    // The 'tool_call_ref' evidence kind points PM at the audit log window
    // for this apprentice; the 'claim' kind carries the summary text itself.
    let evidenceJson: string | null = null;
    if (taskStatus === 'complete') {
      try {
        const evidence: Array<{ kind: string; claim: string; pointer?: string }> = [
          {
            kind: 'tool_call_ref',
            claim: `Apprentice "${agent.name}" completed ${toolStats.count} tool calls over ${durationSeconds}s runtime, see audit log.`,
            pointer: `audit_log WHERE agent_id="${agentId}" AND created_at BETWEEN "${agent.created_at}" AND now`,
          },
          { kind: 'claim', claim: summary },
        ];
        if (results) {
          evidence.push({ kind: 'output_paste', claim: 'Apprentice provided detailed results text.', pointer: 'see task.completion_summary' });
        }
        evidenceJson = JSON.stringify(evidence);
      } catch { /* leave null on failure */ }
    }

    db.prepare(`
      UPDATE tasks SET status = ?, updated_at = datetime('now'),
        completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE completed_at END,
        completion_summary = ?,
        result = CASE WHEN ? = 'complete' THEN ? ELSE result END,
        evidence_json = CASE WHEN ? = 'complete' THEN ? ELSE evidence_json END
      WHERE id = ?
    `).run(taskStatus, taskStatus, summary, taskStatus, summary, taskStatus, evidenceJson, resolvedTaskId);

    void (await import('../tracker/task-log.js')).writeTaskLog({
      taskId: resolvedTaskId,
      fromEntity: `agent:${agentId}`,
      entryKind: 'transition',
      fromStatus: priorRow?.status ?? null,
      toStatus: taskStatus,
      actionTaken: 'complete_task',
      note: summary,
      evidenceJson,
    });

    // Phase B.1: event-driven PM wake on terminal transitions.
    try {
      const { noteTransitionForReview } = await import('../tracker/pm-agent.js');
      noteTransitionForReview(resolvedTaskId, taskStatus);
    } catch (err) {
      logger.warn('noteTransitionForReview hookup failed (non-fatal)', { taskId: resolvedTaskId, error: err instanceof Error ? err.message : String(err) });
    }

    // Phase 7 (Part X) — fire onTaskComplete hook so the parent agent gets
    // a structured note containing the original ask + completion summary.
    // The existing parent notification at line ~506-536 stays for v1
    // continuity; this hook adds the original-ask context that the v1 note
    // doesn't carry.
    try {
      const { onTaskComplete } = await import('./v2/hooks/task-complete.js');
      await onTaskComplete(resolvedTaskId, agentId);
    } catch (err) {
      logger.warn('onTaskComplete hook threw — non-fatal, parent will only see the legacy notification', {
        agentId,
        taskId: resolvedTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── v2.5.46 Layer 2: auto-close any OTHER in_progress tasks ──
  // The agent may have had multiple tasks assigned (parent created
  // several, or agent edited their plan mid-run). complete_task means
  // "I'm done as an agent" — any other in_progress tasks owned by them
  // would otherwise be orphaned. Auto-close all of them with the same
  // final status as the primary, plus a clear audit note.
  //
  // Skips the primary task (resolvedTaskId) — it was just handled above.
  // Skips paused tasks — those were intentionally set aside.
  try {
    const bulkStatus = status === 'complete' ? 'complete' : status === 'fallen' ? 'fallen' : 'blocked';
    const otherDanglers = db.prepare(`
      SELECT id, title FROM tasks
      WHERE assigned_to = ?
        AND status = 'in_progress'
        AND is_paused = 0
        AND id != COALESCE(?, '')
    `).all(agentId, resolvedTaskId ?? null) as Array<{ id: string; title: string }>;
    const danglerLog = await import('../tracker/task-log.js');
    for (const dt of otherDanglers) {
      db.prepare(`
        UPDATE tasks SET status = ?, updated_at = datetime('now'),
          completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE completed_at END
        WHERE id = ?
      `).run(bulkStatus, bulkStatus, dt.id);

      void danglerLog.writeTaskLog({
        taskId: dt.id,
        fromEntity: 'engine',
        entryKind: 'auto_sweep',
        fromStatus: 'in_progress',
        toStatus: bulkStatus,
        actionTaken: 'completeAgent layer-2 dangler sweep',
        reason: `agent "${agent.name}" called complete_task(status="${status}") but did not explicitly close this co-assigned task`,
      });
    }
    if (otherDanglers.length > 0) {
      logger.info('completeAgent: auto-closed dangling in_progress tasks', {
        agentId, count: otherDanglers.length, status: bulkStatus,
        sample: otherDanglers.slice(0, 3).map((t) => t.id.slice(0, 8)),
      }, agentId);
    }
  } catch (autocloseErr) {
    logger.warn('completeAgent: bulk auto-close failed (non-fatal)', {
      agentId, error: autocloseErr instanceof Error ? autocloseErr.message : String(autocloseErr),
    }, agentId);
  }

  // The Dreamer never links its batches to tracker tasks, so this "you forgot to link a
  // task" nag would fire on EVERY batch — another per-batch drip. Suppress it for the
  // Dreamer; its single per-cycle notice (spawnNextDreamerBatch) is the only message it
  // sends the primary. Every normal sub-agent still gets the orphaned-completion heads-up.
  const { isDreamerAgent: isDreamerForOrphan } = await import('../config/platform.js');
  const isDreamerCompletion = agent.name === 'Dreamer' || isDreamerForOrphan(agentId);
  if (!resolvedTaskId && agent.parent_agent && status === 'complete' && !isDreamerCompletion) {
    // Apprentice completed but no task was linked. Common pattern: parent
    // spawned the apprentice and created tasks separately, but defaulted
    // assigned_to to themselves. The work happened, but no tracker row got
    // updated. Surface this loudly to the parent so they notice and fix the
    // setup next time, instead of staring at a "stuck" task that's actually
    // done.
    //
    // Only fires for clean completions (status='complete'); failures and
    // blocks have their own signal already.
    // comms-audit rank 10: this used to inject a 5-sentence engine TUTORIAL as a
    // role='system' row + dashboard broadcast (and its "[SOURCE: ORPHANED COMPLETION"
    // prefix was NOT in platform-noise, so compaction could fold it into a summary and
    // re-narrate it — the one role='system' dump with a live re-narration vector). It
    // also referenced a "completion summary above" that no longer exists after the brief-
    // note fix. Replace with a brief, self-attributed awareness note; the how-to-link-a-
    // task guidance belongs in the tracker tool docs the parent reads WHEN it acts, not
    // dumped into the conversation.
    postAgentNotice({
      toAgentId: agent.parent_agent,
      fromName: agent.name ?? 'sub-agent',
      brief: `Heads up — I finished, but my work wasn't linked to a tracker task, so no task row updated. If you want it tracked, mark the matching task complete or pass task_id next time.`,
      intent: 'orphaned_completion',
    });
  }

  // If this is the Dreamer completing, mark its archives as processed.
  // Pre-2026-04-30 the catch here swallowed all errors silently, hiding
  // the v1.15.100 json_set bug for who-knows-how-long. Log them instead.
  const { isDreamerAgent } = await import('../config/platform.js');
  if ((agent.name === 'Dreamer' || isDreamerAgent(agentId)) && status === 'complete') {
    try {
      const { markDreamerArchivesProcessed } = await import('../vault/maintenance.js');
      markDreamerArchivesProcessed(agentId);
    } catch (err) {
      logger.error('markDreamerArchivesProcessed threw — archives may not be marked processed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Agent completed', {
    agentId,
    name: agent.name,
    status,
    summary: summary.slice(0, 200),
    stats: {
      messages: messageStats.count,
      tokens: messageStats.total_tokens,
      cost: costStats.total_cost,
      duration: durationSeconds,
      toolCalls: toolStats.count,
    },
  }, agentId);

  // Broadcast the agent's new status
  broadcast({
    type: 'agent:status',
    agentId,
    status: isPersistent ? 'idle' : 'terminated',
  });

  broadcast({
    type: 'agent:completed',
    data: {
      agentId,
      agentName: agent.name,
      taskId: agent.task_id,
      status,
      summary,
      stats: {
        tokensUsed: messageStats.total_tokens,
        cost: costStats.total_cost,
        durationSeconds,
        toolCallsCount: toolStats.count,
      },
    },
  });
}

// ── Timeout Checker ──

export function checkTimeouts(): void {
  const db = getDb();

  const expiredAgents = db.prepare(`
    SELECT id, name, timeout_at, config FROM agents
    WHERE status NOT IN ('terminated')
      AND timeout_at IS NOT NULL
      AND timeout_at <= datetime('now')
  `).all() as Array<{ id: string; name: string; timeout_at: string; config: string }>;

  for (const agent of expiredAgents) {
    // Skip agents with persist: true — they should stay alive
    try {
      const config = JSON.parse(agent.config || '{}');
      if (config.persist) {
        // Clear the timeout so we don't keep checking it, but keep the agent alive
        db.prepare("UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?").run(agent.id);
        logger.info('Persistent agent timeout cleared (persist=true)', { agentId: agent.id, name: agent.name }, agent.id);
        continue;
      }
    } catch { /* ignore parse errors */ }

    logger.warn('Agent timeout — terminating', {
      agentId: agent.id,
      name: agent.name,
      timeoutAt: agent.timeout_at,
    }, agent.id);
    terminateAgent(agent.id, 'Timeout reached');
  }
}
