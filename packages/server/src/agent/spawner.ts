import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import { getAgentPermissions, checkPermission } from './permissions.js';
import { isPrimaryAgent } from '../config/platform.js';
import { sendAgentMessage } from './agent-bus.js';
import { memoryGrep } from '../memory/retrieval.js';
import { canSpawnAgent } from '../services/resource-monitor.js';
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
  classification?: 'ronin' | 'apprentice';
  shareUserProfile?: boolean;
  groupId?: string;
  /** Custom initial message to send instead of the default. If set, replaces the entire task message including complete_task instructions. */
  initialMessage?: string;
  /** Technique IDs to equip on this agent (pre-loaded into context) */
  equippedTechniques?: string[];
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
  } = params;

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

  // Resolve model: "auto" means use the router (store null in DB)
  const isAutoRouted = modelId === 'auto';
  const resolvedModelId = isAutoRouted ? null : (modelId ?? parent.model_id);
  if (!resolvedModelId && !isAutoRouted) {
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
  const timeoutSeconds = timeout ?? spawnConfig.defaultTimeout;
  const timeoutAt = new Date(Date.now() + timeoutSeconds * 1000).toISOString().replace('T', ' ').replace('Z', '');

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
    JSON.stringify({ persist, autoRouted: isAutoRouted, shareUserProfile: shareUserProfile || undefined }),
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
    INSERT INTO messages (id, agent_id, role, content, created_at)
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

  // Set timeout timer (persist agents get their timeout cleared instead of terminated)
  if (persist) {
    const timer = setTimeout(() => {
      logger.info('Persist agent timeout reached — clearing timeout, agent stays alive', { agentId, name, timeout: timeoutSeconds }, agentId);
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
2. Use absolute file paths (e.g., /Users/dcliff9/Desktop/...) — do NOT use ~ or relative paths, as they may resolve differently in your context.
3. If you have been assigned a tracker task, call tracker_update_status(task_id=YOUR_TASK_ID, status="complete", notes="what you did") BEFORE calling complete_task.
4. When you have completed the task, you MUST call the complete_task tool with status="complete", a summary of what you did, and any results. Do NOT just stop responding — call complete_task so your parent agent knows you are done.
5. If you get stuck or cannot complete the task, call complete_task with status="blocked" or status="fallen" and explain why.
6. Do not wait for further instructions unless you need clarification — just do the work and report back via complete_task.`;
  }

  // Append task ID context if this agent has an associated tracker task
  if (taskId) {
    taskMessage += `\n\nYour tracker task ID is: ${taskId} — update its status when you finish.`;
  }

  // Insert initial user message to kick off the agent loop
  const initMsgId = uuidv4();
  db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, created_at)
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

  // Update status
  db.prepare(`
    UPDATE agents SET status = 'terminated', updated_at = datetime('now') WHERE id = ?
  `).run(agentId);

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

  // Check persist flag
  let isPersistent = false;
  try {
    const config = JSON.parse(agent.config || '{}');
    isPersistent = config.persist === true;
  } catch {}

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

    // Also insert as a system message into parent's messages for context assembly
    const completionMsgId = uuidv4();
    const completionContent = `[Sub-agent "${agent.name}" completed: ${status}] ${summary}`;
    db.prepare(`
      INSERT INTO messages (id, agent_id, role, content, created_at)
      VALUES (?, ?, 'system', ?, datetime('now'))
    `).run(completionMsgId, agent.parent_agent, completionContent);
    broadcastMessage(agent.parent_agent as string, { id: completionMsgId, role: 'system', content: completionContent });
  }

  // If task_id: update task status
  if (agent.task_id) {
    const taskStatus = status === 'complete' ? 'complete' : status === 'fallen' ? 'fallen' : 'blocked';
    db.prepare(`
      UPDATE tasks SET status = ?, updated_at = datetime('now'),
        completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE completed_at END,
        notes = COALESCE(notes, '') || ? || char(10)
      WHERE id = ?
    `).run(taskStatus, taskStatus, `[${new Date().toISOString()}] Agent completed: ${summary}`, agent.task_id);
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
