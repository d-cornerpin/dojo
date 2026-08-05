import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime } from './runtime.js';
import { getAgentPermissions, checkPermission } from './permissions.js';
import { resolveChildScope } from './scope.js';
import { inheritedCreatorKind } from './created-by-kind.js';
import { isPrimaryAgent, getPrimaryAgentId } from '../config/platform.js';
import { sendAgentMessage } from './agent-bus.js';
import { postAgentNotice } from './agent-notice.js';
import { writeAgentStatus } from './agent-status.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';
import {
  setTrackerStatus, patchWork, appendWorkNotes, deliveryForTaskClose,
} from '../work/tracker-store.js';
import { workSettled, noteUnsettled } from '../work/store.js';
import { memoryGrep } from '../memory/retrieval.js';
import { insertMessageIfAbsent, insertEngineEventIfAbsent } from '../memory/message-store.js';
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

// P3 (spawn contract): there is NO default timeout. A timeout is a decision the
// CREATOR owns, so it MUST be set explicitly at spawn (the spawn_agent tool
// requires timeout_minutes for non-ronin spawns; ronin has none). The old 900s
// `defaultTimeout` / `spawn_default_timeout` config is gone: silently defaulting
// a lifetime is exactly the ownership the owner moved to the creator.
const SPAWN_DEFAULTS = {
  maxChildrenPerAgent: 3,
  maxConcurrent: 5,
  maxSpawnDepth: 2,
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
   * this when the parent wants to set up state before the apprentice runs, 
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

  // ── THE AUTHORITATIVE SPAWN GATE (PHASE-5 T5, RULING P5-R2) ──
  // Spawn permission is asked in two places and the ruling required T5 to say
  // which one is the authority rather than leave both standing unexplained.
  //
  // THIS ONE IS IT, for a structural reason: `spawnAgent()` is the function that
  // writes the row, and it has callers that never enter the executor at all
  // (`vault/maintenance.ts` spawns with no model in the loop). A gate that is
  // not on every path cannot be the authority; this one is on every path by
  // construction.
  //
  // The executor's gate (`tools/gates.ts` row 4 → `tools/gate-eval.ts`) is NOT
  // redundant and is NOT dead. It does a different job: it turns this same
  // answer into something a MODEL can read and the audit can count — the
  // ladder's `PERMISSION_DENIED` code, its row-4 wording, an audit row filed as
  // `spawn` — at the tool boundary, before any handler runs. Delete it and the
  // protection still holds here, but the model receives a raw thrown Error
  // instead of a classified refusal.
  //
  // They cannot disagree: both answer from `authorizeSpawn` against the same
  // manifest. This path reaches it through `grantForManifest` (the pure
  // projection), the executor through `grantFor` (the `grant_rule` rows), and
  // `grantFor` re-projects the moment a stored fingerprint stops matching — so
  // the two are equal by construction, not by anybody remembering.
  //
  // Held end to end by `__tests__/spawn-gate-reconciliation.test.ts`, whose
  // refusal clauses were proven load-bearing by removing this block and watching
  // exactly those three go red.
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

  // Validate spawn limits, primary agent is exempt from children and depth limits
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
  // Ronin agents don't get a timeout -- they persist until the user dismisses them.
  // P3: there is no engine default; a non-ronin spawn only gets a timeout when the
  // caller passes one explicitly (the spawn_agent tool enforces this at the surface).
  const timeoutSeconds = classification === 'ronin' ? null : (timeout ?? null);
  const timeoutAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000).toISOString().replace('T', ' ').replace('Z', '') : null;

  // ── THE CHILD'S SCOPE (PHASE-5 T5) ──
  // What stood here was `permissions ?? getAgentPermissions(parentId)`: a child
  // received its parent's manifest VERBATIM, and anything the caller passed was
  // stored unread. Two consequences, both measured on the live body: a child of
  // the primary inherited `system_control:['*']` (two such sub-agents exist), and
  // a malformed `permissions` argument was written to the row as-is, to be
  // silently downgraded to the default by the next reader.
  //
  // `resolveChildScope` answers both. No manifest named → the owner's DECIDED
  // default (parent minus danger, plus the child's own artifact directory). A
  // manifest named → schema-validated and bounded by child ⊆ parent, and a
  // malformed or escalating one REFUSES THE SPAWN rather than downgrading it.
  const scope = resolveChildScope(permissions, getAgentPermissions(parentId), agentId);
  if (!scope.ok) {
    throw new Error(`Spawn denied: ${scope.reason}`);
  }
  const permissionsJson = JSON.stringify(scope.manifest);
  const toolsPolicyJson = JSON.stringify(toolsPolicy ?? {});

  db.prepare(`
    INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                        parent_agent, spawn_depth, agent_type, classification, group_id, max_runtime, timeout_at,
                        permissions, tools_policy, equipped_techniques, task_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'idle', ?, ?, ?,
            ?, ?, 'standard', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    agentId,
    name,
    resolvedModelId,
    JSON.stringify({ persist, shareUserProfile: shareUserProfile || undefined }),
    parentId,
    // T11 Step 1b: a spawned child inherits its parent's kind, so a harness fixture's
    // worker is disposable for the same structural reason its parent is; anything else
    // an agent spawns is 'agent'.
    inheritedCreatorKind(parentId),
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
  insertMessageIfAbsent({ id: uuidv4(), agentId, role: 'system', content: enhancedPrompt });

  // FA-PT6: persist the charter durably so getSoulContent reads it directly
  // (migration 096), instead of sniffing the earliest role='system' row (which
  // false-rejected terse / bracket-prefixed charters). Same content as the
  // system row above.
  try {
    db.prepare('UPDATE agents SET charter = ? WHERE id = ?').run(enhancedPrompt, agentId);
  } catch { /* charter column may not exist on a very old database */ }

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
    permissions: scope.manifest,
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

  // Set timeout timer -- ronin agents never timeout, persist agents get cleared,
  // apprentices reach a CREATOR DECISION (P3): the timer no longer terminates,
  // it fires fireSpawnTimeoutDecision (notify the creator, keep the sub-agent
  // running until an authorized hand extends or ends it).
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
        fireSpawnTimeoutDecision(agentId);
      }, timeoutSeconds * 1000);
      timeoutTimers.set(agentId, timer);
    }
  }

  // Start the agent runtime with an initial task message
  const runtime = getAgentRuntime();
  let taskMessage: string;

  if (params.initialMessage) {
    // Custom initial message provided, use it, but always remind about complete_task
    taskMessage = params.initialMessage;
    if (!params.initialMessage.toLowerCase().includes('complete_task')) {
      taskMessage += '\n\nIMPORTANT: When you are finished, you MUST call complete_task with status="complete" and a summary. Do NOT just stop responding.';
    }
  } else if (systemPrompt.toLowerCase().includes('complete_task')) {
    // System prompt already mentions complete_task, don't inject default instructions
    taskMessage = `Your task: ${systemPrompt}\n\nBegin working immediately.`;
  } else {
    // Default: inject complete_task instructions
    taskMessage = `Your task: ${systemPrompt}

IMPORTANT INSTRUCTIONS:
1. Begin working immediately.
2. Use absolute file paths (e.g., /Users/<your-user>/Desktop/...), do NOT use ~ or relative paths, as they may resolve differently in your context.
3. If you have been assigned a tracker task, call work_update(action="status", task_id=YOUR_TASK_ID, status="complete", notes="what you did") BEFORE calling complete_task.
4. When you have completed the task, you MUST call the complete_task tool with status="complete", a summary of what you did, and any results. Do NOT just stop responding, call complete_task so your parent agent knows you are done.
5. If you get stuck or cannot complete the task, call complete_task with status="blocked" or status="fallen" and explain why.
6. Do not wait for further instructions unless you need clarification, just do the work and report back via complete_task.`;
  }

  // Append task ID context if this agent has an associated tracker task
  if (taskId) {
    taskMessage += `\n\nYour tracker task ID is: ${taskId}, update its status when you finish.`;
  }

  if (autoStart === false) {
    // Caller wants the agent spawned but not poked. Skip both the initial
    // message and the runtime trigger. The agent will run when something
    // else wakes it (an A2A message, a task assignment, send_to_agent, etc.).
    logger.info('Spawned with auto_start=false, agent stays idle until externally poked', { agentId, name });
    return { agentId, name, status: 'idle', persist };
  }

  // ── PHASE-2 T8c item 1 — THE KICKOFF IS THE ENGINE, NOT THE OWNER (T6 §11.4) ──
  //
  // This row was `role='user'` on the owner lane with no channel. Read it: "Your task: …
  // Begin working immediately … you MUST call complete_task". That is the ENGINE composing an
  // instruction, and it is never a person talking — even when a parent agent supplied
  // `initialMessage`, the sender is that agent and the engine appends its own instructions
  // around it. Left as an owner-lane user row it made the spawned agent's very first turn
  // render "You are responding to <owner> … your reply goes back to them on dashboard",
  // which is how a worker ends up chatting at the owner instead of reporting through
  // `complete_task` / `send_to_agent`.
  // requirement preserved: the kickoff still wakes the agent (`handleMessage` ignores its
  // content argument and reads the persisted rows), still carries the identical text, and
  // still broadcasts to the dashboard below.
  const initMsgId = uuidv4();
  insertEngineEventIfAbsent({
    id: initMsgId, agentId, content: taskMessage,
    sourceAgentId: null, originIntent: 'spawn_kickoff',
    work: taskId ? { taskId, runId: null, rootKind: 'task', rootId: taskId } : null,
  });
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

  // Archive conversation for the Dreamer before terminating.
  // force=true: this agent is being torn down, so its final tail (usually the
  // conclusions/deliverables) must be archived even if an earlier unprocessed
  // archive exists, or the Dreamer never sees it (FA-V1). The rowid high-water
  // still bounds the archive to the genuinely-new tail, so no re-copy bloat.
  try {
    archiveAgentConversation(agentId, true);
  } catch (err) {
    logger.warn('Failed to archive agent conversation on termination', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  // Update status
  writeAgentStatus(agentId, 'terminated');

  // v2.5.46 Layer 2, auto-pause in_progress tasks owned by the
  // terminated agent. Without this they sit as zombies (the agent
  // can never close them; PM keeps poking; user sees stale tasks
  // forever). Pause (not complete) so the user can decide whether
  // to reassign or close them.
  try {
    const danglers = db.prepare(`
      SELECT w.id AS id, w.title AS title FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0
    `).all(agentId) as Array<{ id: string; title: string }>;
    if (danglers.length > 0) {
      const note = `[${new Date().toISOString()}] Auto-paused: assigned agent "${agent.name}" was terminated (reason: ${reason ?? 'manual'}). Reassign or close from the dashboard.`;
      // Demolition Phase 1.4 (B-1 follow-up): the pause lands UNVALIDATED
      // (pause_validated stays 0). This engine-initiated pause used to
      // pre-bless itself (pause_validated=1) so the PM sweep could never
      // re-flag it, the same forgery pattern the two-key restoration removes
      // from the loop and scheduler. The assignee was terminated so it can
      // never turn its own key, but the pause is still an engine verdict the PM
      // sweep should SEE (surfaced as UNVALIDATED_PAUSE) and adjudicate
      // (reassign / close / leave), not one the engine forges. The user can
      // also resolve these from the dashboard.
      for (const dt of danglers) {
        // PHASE-2 T8b: through `transition()`. `setTrackerStatus` carries the pause's own
        // side-effects (is_paused, status_before_pause) so they cannot drift apart from the
        // state they describe — the drift the two statements above could produce.
        const r = setTrackerStatus(dt.id, 'paused', {
          by: 'agent', actorId: agentId,
          reason: `assigned agent "${agent.name}" was terminated (${reason ?? 'manual'}); work paused for reassignment`,
        });
        if (r.kind !== 'applied') {
          logger.warn('terminateAgent: auto-pause refused', { taskId: dt.id, result: r });
          continue;
        }
        appendWorkNotes(dt.id, note);
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
  // field, the sensei guard in terminateAgent didn't help because
  // completeAgent does its own raw UPDATE.
  let isPersistent = agent.classification === 'sensei' || agent.agent_type === 'persistent';
  if (!isPersistent) {
    try {
      const config = JSON.parse(agent.config || '{}');
      isPersistent = config.persist === true;
    } catch {}
  }

  // Archive conversation for the Dreamer before changing status.
  // force=!isPersistent (FA-V1): a NON-persistent agent terminates below, so its
  // final tail must be archived even if an earlier unprocessed archive exists.
  // A persistent agent (sensei / agent_type='persistent') stays alive and idle,
  // so keep force=false there to dedup repeated archives for a chatty resident.
  try {
    archiveAgentConversation(agentId, !isPersistent);
  } catch (err) {
    logger.warn('Failed to archive agent conversation on completion', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  if (isPersistent) {
    // Persistent agent: set to idle, keep alive for future messages
    writeAgentStatus(agentId, 'idle');
    logger.info('Persistent agent completed task, remaining idle', { agentId, name: agent.name });
  } else {
    // Non-persistent: terminate immediately
    writeAgentStatus(agentId, 'terminated');
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

    // Notify the parent, but as a BRIEF, first-person, self-attributed note in the
    // parent's awareness lane, NOT the full result dumped into its conversation.
    // Pre-fix this injected the ENTIRE completion summary as a role='system' row, which
    // live compaction then folded into the parent's context summaries, and the parent
    // model read another agent's work out of its own history and narrated it back to the
    // user, repeatedly (the owner's "Dreamer batch" summaries). Now:
    //   • The FULL result stays in the agent bus (sendAgentMessage above), the record /
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

  // Resolve the task this agent owns. The explicit agent.task_id link (set at
  // spawn, required by the spawn contract) is the identity. P6b SHRINK of the
  // fallback: when the link is missing, an assigned task resolves ONLY when it
  // is unambiguous (exactly one candidate). The old newest-first LIMIT 1 was a
  // guess that could close the WRONG task when several were assigned; zero
  // candidates resolves nothing, several logs the ambiguity and resolves
  // nothing (their disposition is handled by the dangler sweep below, which
  // never falsely inherits 'complete').
  let resolvedTaskId: string | null = agent.task_id;
  if (!resolvedTaskId) {
    const candidates = db.prepare(`
      SELECT w.id AS id FROM work w
       WHERE ${taskScope('w')} AND w.agent_id = ?
         AND (w.state IN ('on_deck','claimed')
              OR (w.state = 'done'
                  AND (w.completion_summary IS NULL OR w.completion_summary = '')))
    `).all(agentId) as Array<{ id: string }>;
    if (candidates.length === 1) {
      resolvedTaskId = candidates[0].id;
    } else if (candidates.length > 1) {
      logger.warn('completeAgent: no explicit task link and MULTIPLE assigned candidates; refusing to guess', {
        agentId, candidateCount: candidates.length, sample: candidates.slice(0, 3).map(c => c.id.slice(0, 8)),
      }, agentId);
    }
  }

  // D-K: when this completion fells tasks (status='fallen'), collect the
  // affected project ids so the success-vs-fail-open check can run after all
  // rows have landed. Complete transitions are deliberately NOT collected
  // here: their project check fires downstream when the PM validates
  // (work_validate(action="validate")), fallen has no validation flag so this is its only hook.
  const fallenProjectIds = new Set<string>();

  // If task_id: update task status
  if (resolvedTaskId) {
    const taskStatus = status === 'complete' ? 'complete' : status === 'fallen' ? 'fallen' : 'blocked';
    // Phase B.0: tasks.notes is read-only legacy. Snapshot prior status
    // for the task_log transition entry, then update the row without
    // touching the notes column. completion_summary stays as the
    // canonical "result" home for apprentice flows (also reused by
    // Phase B.1 evidence plumbing).
    const priorRow = db.prepare(`SELECT ${STATE_TO_STATUS_SQL('w.state')} AS status, w.parent_id AS project_id FROM work w WHERE w.id = ?`).get(resolvedTaskId) as { status: string; project_id: string | null } | undefined;
    if (taskStatus === 'fallen' && priorRow?.project_id) fallenProjectIds.add(priorRow.project_id);

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

    // The apprentice's result columns are a patch; the status is a transition. A
    // `complete` close points at the hand-off the apprentice actually made (G7) — for an
    // apprentice that is normally the A2A delivery back to the agent that spawned it.
    noteUnsettled(patchWork(resolvedTaskId, {
      completion_summary: summary,
      ...(taskStatus === 'complete' ? { result: summary, evidence_json: evidenceJson } : {}),
    }), 'completeAgent: completion summary recorded', { taskId: resolvedTaskId });
    const closeRes = setTrackerStatus(resolvedTaskId, taskStatus, {
      by: 'agent', actorId: agentId,
      reason: `apprentice "${agent.name}" called complete_task(status="${status}")`,
      resultDeliveryId: taskStatus === 'complete' ? deliveryForTaskClose(resolvedTaskId) : null,
    });
    if (!workSettled(closeRes)) {
      logger.warn('completeAgent: task close refused by the work gate',
        { agentId, taskId: resolvedTaskId, taskStatus, result: closeRes }, agentId);
    }

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

    // Phase 7 (Part X), fire onTaskComplete hook so the parent agent gets
    // a structured note containing the original ask + completion summary.
    // The existing parent notification at line ~506-536 stays for v1
    // continuity; this hook adds the original-ask context that the v1 note
    // doesn't carry.
    try {
      const { onTaskComplete } = await import('./v2/hooks/task-complete.js');
      await onTaskComplete(resolvedTaskId, agentId);
    } catch (err) {
      logger.warn('onTaskComplete hook threw, non-fatal, parent will only see the legacy notification', {
        agentId,
        taskId: resolvedTaskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Layer 2 dangler sweep, per-task disposition from lineage (P6b) ──
  // The completing agent is being torn down, so its other in_progress tasks
  // cannot progress; leaving them in_progress would violate STATUS-TRUTH.
  // The old sweep blanket-inherited the PRIMARY's status, which could falsely
  // mark a genuinely separate co-assigned task 'complete'. Disposition is now
  // per task, from lineage: a dangler sharing the primary task's work order
  // (same project, or same originating ask via source_message_id) inherits the
  // completing status; a FOREIGN-rooted dangler (or any dangler when no
  // primary resolved) becomes 'blocked' with the reason recorded, never
  // falsely complete. Skips the primary (handled above) and paused tasks
  // (intentionally set aside).
  try {
    const bulkStatus = status === 'complete' ? 'complete' : status === 'fallen' ? 'fallen' : 'blocked';
    const primaryLineage = resolvedTaskId
      ? db.prepare('SELECT parent_id AS project_id, source_message_id FROM work WHERE id = ?')
          .get(resolvedTaskId) as { project_id: string | null; source_message_id: string | null } | undefined
      : undefined;
    const otherDanglers = db.prepare(`
      SELECT w.id AS id, w.title AS title, w.parent_id AS project_id,
             w.source_message_id AS source_message_id FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0
        AND w.id != COALESCE(?, '')
    `).all(agentId, resolvedTaskId ?? null) as Array<{ id: string; title: string; project_id: string | null; source_message_id: string | null }>;
    const danglerLog = await import('../tracker/task-log.js');
    for (const dt of otherDanglers) {
      const sameWork = !!primaryLineage && (
        (dt.project_id !== null && dt.project_id === primaryLineage.project_id) ||
        (dt.source_message_id !== null && dt.source_message_id === primaryLineage.source_message_id)
      );
      const disposition = sameWork ? bulkStatus : 'blocked';
      // PHASE-2 T8T: a `complete` disposition here is INHERITED, not claimed — this row
      // shares the primary task's work order and the primary's close already went through
      // the gate. The engine is the one drawing that inference, so it says so and points at
      // the delivery (G6). A non-complete disposition is not a two-key subject and keeps the
      // actor it always had.
      const inheritedDelivery = disposition === 'complete' ? deliveryForTaskClose(dt.id) : null;
      const dRes = setTrackerStatus(dt.id, disposition, {
        by: disposition === 'complete' ? 'engine' : 'agent', actorId: agentId,
        reason: sameWork
          ? 'shares the primary task\'s work order and inherits its close'
          : 'lineage does not tie it to the completed work; blocked for reassignment',
        evidenceRef: inheritedDelivery,
        resultDeliveryId: inheritedDelivery,
      });
      if (!workSettled(dRes)) {
        logger.warn('completeAgent: dangler disposition refused', { taskId: dt.id, result: dRes });
      }
      if (disposition === 'fallen' && dt.project_id) fallenProjectIds.add(dt.project_id);

      void danglerLog.writeTaskLog({
        taskId: dt.id,
        fromEntity: 'engine',
        entryKind: 'auto_sweep',
        fromStatus: 'in_progress',
        toStatus: disposition,
        actionTaken: 'completeAgent layer-2 dangler sweep (per-task lineage disposition)',
        reason: sameWork
          ? `agent "${agent.name}" called complete_task(status="${status}"); this task shares the primary task's work order (project/ask lineage) and inherits its close`
          : `agent "${agent.name}" called complete_task(status="${status}") and is being torn down; this task's lineage does NOT tie it to the completed work, so it is blocked (not falsely closed) for reassignment`,
      });
    }
    if (otherDanglers.length > 0) {
      logger.info('completeAgent: dispositioned dangling in_progress tasks by lineage', {
        agentId, count: otherDanglers.length, primaryStatus: bulkStatus,
        sample: otherDanglers.slice(0, 3).map((t) => t.id.slice(0, 8)),
      }, agentId);
    }
  } catch (autocloseErr) {
    logger.warn('completeAgent: dangler disposition failed (non-fatal)', {
      agentId, error: autocloseErr instanceof Error ? autocloseErr.message : String(autocloseErr),
    }, agentId);
  }

  // D-K: a complete_task(status="fallen") can be the transition that empties a
  // project of open tasks (fall-last ordering). Run the success-vs-fail-open
  // check per affected project so it gets its needs-attention label + primary
  // notice instead of staying silently active. Idempotent, extra calls are
  // harmless. Dynamic import matches this file's cross-module style and avoids
  // pulling the tracker tool module into the static graph.
  if (fallenProjectIds.size > 0) {
    try {
      const { checkProjectCompletion } = await import('../tracker/tools.js');
      for (const projectId of fallenProjectIds) {
        checkProjectCompletion(projectId, agentId);
      }
    } catch (err) {
      logger.warn('completeAgent: checkProjectCompletion after fallen close failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  // P6b STRIP: the orphaned-completion "you forgot to link a task" nag is
  // gone. The spawn contract requires the task link at spawn, so the unlinked
  // case is structurally closed; when it still happens the ambiguity warning
  // in the resolver above is the engineering signal, and the dangler sweep
  // dispositions any stranded rows. The per-completion parent drip taught
  // nothing at the moment it arrived.

  // If this is the Dreamer ending a batch, advance the dream chain.
  // FA-V4: fire on ANY terminal status, not just 'complete'. On 'complete' the
  // batch's archives are marked processed; on 'blocked'/'fallen' they are NOT
  // (never mark an archive the Dreamer did not distill), instead the archive's
  // bounded attempt counter is bumped and it is poisoned after repeated
  // failures. Either way the cycle continues instead of stalling on a
  // non-complete batch (pre-fix it advanced only on 'complete').
  // Pre-2026-04-30 the catch here swallowed all errors silently, hiding the
  // v1.15.100 json_set bug for who-knows-how-long. Log them instead.
  const { isDreamerAgent } = await import('../config/platform.js');
  if (agent.name === 'Dreamer' || isDreamerAgent(agentId)) {
    try {
      const { markDreamerArchivesProcessed } = await import('../vault/maintenance.js');
      markDreamerArchivesProcessed(agentId, status);
    } catch (err) {
      logger.error('markDreamerArchivesProcessed threw, dream chain may not advance', {
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
    // The queries above are unbounded (WHERE agent_id only), so these are the
    // agent's LIFETIME totals. For a one-shot apprentice that equals the job;
    // for a RESIDENT (the memory-cycle agent completes hundreds of batches)
    // they accumulate across months. Labeled accordingly after a production
    // trace read a resident's lifetime cost as one night's bill (2026-07-18).
    lifetimeStats: {
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

// ── Extend a held agent's timeout (destructive-gate FA-A3) ──
//
// The destructive-gate HOLDS a non-primary worker's call pending the primary's
// approval, then wakes the worker to retry. That wait must not let the reaper
// kill the worker mid-approval. Extending only the DB row (the pre-fix raw
// UPDATE in destructive-gate) was INERT: apprentice reaping is driven by the
// per-agent in-memory setTimeout armed at spawn, which the DB write never
// rescheduled, so the worker still died at its ORIGINAL timeout. This reschedules
// BOTH the in-memory timer AND the DB row, keeping them coherent with the
// checkTimeouts DB sweep.
//
// Preserves normal reaping for everyone else: only stretches the specific held
// worker's life, never shortens a longer timeout, leaves ronin (timeout_at NULL,
// never reaped) untouched, and re-arms with the SAME semantics the worker had at
// spawn (persist agents clear their timeout and stay alive; everyone else is
// terminated).
export function extendAgentTimeout(agentId: string, newTimeoutAtIso: string): void {
  const db = getDb();
  const agent = db.prepare('SELECT id, name, status, config, timeout_at FROM agents WHERE id = ?').get(agentId) as {
    id: string; name: string; status: string; config: string; timeout_at: string | null;
  } | undefined;
  if (!agent) {
    logger.warn('extendAgentTimeout: agent not found', { agentId });
    return;
  }
  if (agent.status === 'terminated') return;
  // Ronin / no-timeout workers are never reaped, so there is nothing to extend.
  if (agent.timeout_at === null) return;

  const newAtMs = new Date(newTimeoutAtIso).getTime();
  if (Number.isNaN(newAtMs)) {
    logger.warn('extendAgentTimeout: invalid timeout ISO', { agentId, newTimeoutAtIso });
    return;
  }

  // Never shorten a longer existing timeout. timeout_at is stored as a SQLite
  // datetime string (space-separated, UTC, no trailing Z), so normalize to ISO.
  const currentMs = new Date(agent.timeout_at.replace(' ', 'T') + (agent.timeout_at.includes('Z') ? '' : 'Z')).getTime();
  if (!Number.isNaN(currentMs) && currentMs >= newAtMs) return;

  // Same shape spawnAgent writes (space-separated, no Z) so the DB sweep compares cleanly.
  // Extending also clears any pending timeout decision: this worker's life was just
  // stretched, so it is no longer waiting on a creator verdict.
  const dbTimeoutAt = newTimeoutAtIso.replace('T', ' ').replace('Z', '');
  db.prepare(`UPDATE agents SET timeout_at = ?, timeout_decision_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(dbTimeoutAt, agentId);

  // Re-arm the in-memory timer.
  const existing = timeoutTimers.get(agentId);
  if (existing) {
    clearTimeout(existing);
    timeoutTimers.delete(agentId);
  }
  let isPersist = false;
  try { isPersist = JSON.parse(agent.config || '{}').persist === true; } catch { /* default false */ }

  const delayMs = Math.max(0, newAtMs - Date.now());
  if (isPersist) {
    const timer = setTimeout(() => {
      logger.info('Persist agent extended-timeout reached -- clearing timeout, agent stays alive', { agentId, name: agent.name }, agentId);
      db.prepare(`UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(agentId);
      timeoutTimers.delete(agentId);
    }, delayMs);
    timeoutTimers.set(agentId, timer);
  } else {
    const timer = setTimeout(() => {
      // P3: reaching the extended timeout is a creator DECISION, not a kill.
      fireSpawnTimeoutDecision(agentId);
    }, delayMs);
    timeoutTimers.set(agentId, timer);
  }

  logger.info('extendAgentTimeout: reap rescheduled for held worker', {
    agentId, name: agent.name, newTimeoutAt: dbTimeoutAt, delayMs,
  }, agentId);
}

// ── Spawn timeout: creator-owned decision (P3) ──
//
// Owner contract: "the timeout MUST be set by the agent who creates the sub
// agent. When the timeout is reached, the creating agent is notified and MUST
// respond with an extension or allow the timeout to kill the sub agent." So
// expiry is a DECISION POINT, never an execution. At timeout_at the engine
// posts an awareness notice to the CREATOR (or the primary if the creator is
// gone) and the sub-agent KEEPS RUNNING until spawn_timeout_decision resolves
// it. timeout_decision_pending (migration 109) makes this reboot-safe:
//   0 = nothing pending   1 = creator notified, awaiting   2 = escalated to
// the primary once (undecided ladder), never notified again.

// If no decision lands within this window after the creator notice, escalate
// once to the primary so the owner hears about it in-voice. Never auto-kill.
const SPAWN_TIMEOUT_UNDECIDED_GRACE_MS = 15 * 60 * 1000;

/**
 * The timeout fired: request the creator's decision. Idempotent (guards on
 * timeout_decision_pending) so the in-memory timer, the 30s DB sweep, and the
 * boot re-arm can all reach it and notify exactly once. The sub-agent stays
 * running; the fired timer slot is re-used for the undecided ladder.
 */
export function fireSpawnTimeoutDecision(agentId: string): void {
  const db = getDb();
  const agent = db.prepare(`
    SELECT id, name, status, classification, config, created_by, parent_agent, task_id,
           timeout_at, max_runtime, created_at, timeout_decision_pending
    FROM agents WHERE id = ?
  `).get(agentId) as {
    id: string; name: string; status: string; classification: string | null;
    config: string; created_by: string | null; parent_agent: string | null;
    task_id: string | null; timeout_at: string | null; max_runtime: number | null;
    created_at: string; timeout_decision_pending: number | null;
  } | undefined;

  if (!agent || agent.status === 'terminated') { timeoutTimers.delete(agentId); return; }
  // Ronin/sensei are never on this flow; persist agents are exempt (their timer
  // clears timeout_at and they stay alive).
  if (agent.classification === 'sensei' || agent.classification === 'ronin') return;
  try { if (JSON.parse(agent.config || '{}').persist === true) return; } catch { /* not persist */ }
  // Already awaiting/decided -- fire once.
  if ((agent.timeout_decision_pending ?? 0) !== 0) return;

  // Stamp pending BEFORE posting so a concurrent sweep/boot re-arm can't double-notify.
  db.prepare(`UPDATE agents SET timeout_decision_pending = 1, updated_at = datetime('now') WHERE id = ?`).run(agentId);

  // The creator owns the decision. Fall back to the primary if the creator is
  // gone so the decision never lands nowhere.
  const primaryId = getPrimaryAgentId();
  const creatorId = agent.created_by ?? agent.parent_agent ?? primaryId;
  const creatorRow = db.prepare(`SELECT id FROM agents WHERE id = ? AND status != 'terminated'`).get(creatorId) as { id: string } | undefined;
  const recipientId = creatorRow ? creatorId : primaryId;

  const chosenMinutes = agent.max_runtime ? Math.round(agent.max_runtime / 60) : null;
  const createdMs = new Date(agent.created_at.replace(' ', 'T') + (agent.created_at.includes('Z') ? '' : 'Z')).getTime();
  const elapsedMinutes = Number.isNaN(createdMs) ? null : Math.max(1, Math.round((Date.now() - createdMs) / 60000));

  let taskLine = 'no tracker task linked';
  if (agent.task_id) {
    const t = db.prepare(`SELECT w.title AS title, ${STATE_TO_STATUS_SQL('w.state')} AS status FROM work w WHERE w.id = ?`).get(agent.task_id) as { title: string; status: string } | undefined;
    if (t) taskLine = `linked task "${t.title}" (status: ${t.status})`;
  }

  const chosenPhrase = chosenMinutes ? `${chosenMinutes}-minute ` : '';
  const elapsedPhrase = elapsedMinutes ? ` after about ${elapsedMinutes} min` : '';
  const brief = `Sub-agent "${agent.name}" (id ${agentId.slice(0, 8)}) reached its ${chosenPhrase}timeout${elapsedPhrase} and is still running; ${taskLine}. You created it, so the call is yours: spawn_timeout_decision(agent_id="${agentId}", action="extend", extend_minutes=<n>) to give it more time, or action="terminate" to let it stop. It keeps running until you decide.`;

  postAgentNotice({
    toAgentId: recipientId,
    fromName: 'Spawn control',
    selfIntro: false,
    intent: 'spawn_timeout_decision',
    brief,
  });

  // One-shot wake so the creator's model sees the notice this turn.
  try {
    getAgentRuntime().handleMessage(recipientId, '[spawn: timeout decision pending]').catch((err) => {
      logger.warn('fireSpawnTimeoutDecision: creator wake failed', { agentId, recipientId, error: err instanceof Error ? err.message : String(err) }, agentId);
    });
  } catch { /* runtime not ready -- notice is stored, read next turn */ }

  // The fired decision timer is spent; re-use its slot for the undecided ladder.
  const existing = timeoutTimers.get(agentId);
  if (existing) clearTimeout(existing);
  timeoutTimers.set(agentId, setTimeout(() => { fireSpawnTimeoutUndecided(agentId); }, SPAWN_TIMEOUT_UNDECIDED_GRACE_MS));

  logger.warn('Spawn timeout reached: creator decision requested (agent still running)', {
    agentId, name: agent.name, recipientId, chosenMinutes, elapsedMinutes, taskId: agent.task_id,
  }, agentId);
}

/**
 * The creator still hasn't decided a grace window after being notified: escalate
 * ONCE to the primary so the owner hears about it in-voice. Never auto-kills,
 * never fires twice (guards on timeout_decision_pending === 1 -> 2).
 */
export function fireSpawnTimeoutUndecided(agentId: string): void {
  const db = getDb();
  const agent = db.prepare(`SELECT id, name, status, timeout_decision_pending FROM agents WHERE id = ?`).get(agentId) as {
    id: string; name: string; status: string; timeout_decision_pending: number | null;
  } | undefined;
  timeoutTimers.delete(agentId);
  if (!agent || agent.status === 'terminated') return;
  if ((agent.timeout_decision_pending ?? 0) !== 1) return; // resolved or already escalated

  db.prepare(`UPDATE agents SET timeout_decision_pending = 2, updated_at = datetime('now') WHERE id = ?`).run(agentId);

  const primaryId = getPrimaryAgentId();
  postAgentNotice({
    toAgentId: primaryId,
    fromName: 'Spawn control',
    selfIntro: false,
    intent: 'spawn_timeout_undecided',
    brief: `Sub-agent "${agent.name}" (id ${agentId.slice(0, 8)}) passed its timeout about 15 minutes ago and its creator still hasn't decided whether to extend or stop it. It's still running. Resolve it with spawn_timeout_decision, or the owner can dismiss it from the dashboard.`,
  });
  try {
    getAgentRuntime().handleMessage(primaryId, '[spawn: timeout still undecided]').catch(() => { /* stored, read next turn */ });
  } catch { /* runtime not ready */ }

  logger.warn('Spawn timeout still undecided after grace: escalated to primary (agent still running)', {
    agentId, name: agent.name,
  }, agentId);
}

export interface SpawnTimeoutDecisionResult { ok: boolean; message: string }

/**
 * Apply the creator's decision. Creator-only (the user path is the dashboard).
 * extend: new timeout_at + re-armed decision timer + decision recorded.
 * terminate: flows through terminateAgent (its danglers land unvalidated for PM).
 */
export async function applySpawnTimeoutDecision(opts: {
  callerAgentId: string;
  agentId: string;
  action: 'extend' | 'terminate';
  extendMinutes?: number;
}): Promise<SpawnTimeoutDecisionResult> {
  const { callerAgentId, agentId, action, extendMinutes } = opts;
  const db = getDb();
  const agent = db.prepare(`
    SELECT id, name, status, classification, created_by, parent_agent, task_id
    FROM agents WHERE id = ?
  `).get(agentId) as {
    id: string; name: string; status: string; classification: string | null;
    created_by: string | null; parent_agent: string | null; task_id: string | null;
  } | undefined;

  if (!agent) return { ok: false, message: `No agent found for id ${agentId}.` };

  // Creator-only. The user path is the dashboard, not this tool.
  const creatorId = agent.created_by ?? agent.parent_agent;
  if (creatorId !== callerAgentId) {
    return { ok: false, message: `Only the agent that created "${agent.name}" can decide its timeout, and you did not create it. If you are the owner, extend or dismiss it from the dashboard instead.` };
  }

  if (agent.status === 'terminated') {
    db.prepare(`UPDATE agents SET timeout_decision_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(agentId);
    const t = timeoutTimers.get(agentId); if (t) { clearTimeout(t); timeoutTimers.delete(agentId); }
    return { ok: true, message: `Sub-agent "${agent.name}" is already stopped. Nothing to decide.` };
  }

  if (action === 'terminate') {
    db.prepare(`UPDATE agents SET timeout_decision_pending = 0, updated_at = datetime('now') WHERE id = ?`).run(agentId);
    terminateAgent(agentId, `Timeout decision: creator chose terminate`);
    await recordTimeoutDecision(agent.task_id, callerAgentId, agentId, agent.name, 'terminate', null);
    return { ok: true, message: `Sub-agent "${agent.name}" (${agentId.slice(0, 8)}) stopped, as you decided. Any in-progress tasks it held were auto-paused for reassignment.` };
  }

  // extend
  const minutes = typeof extendMinutes === 'number' && Number.isFinite(extendMinutes) ? Math.round(extendMinutes) : 0;
  if (minutes <= 0) {
    return { ok: false, message: `To extend "${agent.name}", pass extend_minutes as a positive number of minutes (e.g. extend_minutes=15). To stop it instead, call action="terminate".` };
  }
  const newTimeoutAtIso = new Date(Date.now() + minutes * 60_000).toISOString();
  const dbTimeoutAt = newTimeoutAtIso.replace('T', ' ').replace('Z', '');
  db.prepare(`UPDATE agents SET timeout_at = ?, max_runtime = ?, timeout_decision_pending = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(dbTimeoutAt, minutes * 60, agentId);

  // Re-arm the decision timer for the new window (persist agents never reach here).
  const existing = timeoutTimers.get(agentId);
  if (existing) { clearTimeout(existing); timeoutTimers.delete(agentId); }
  timeoutTimers.set(agentId, setTimeout(() => { fireSpawnTimeoutDecision(agentId); }, minutes * 60_000));

  await recordTimeoutDecision(agent.task_id, callerAgentId, agentId, agent.name, 'extend', minutes);
  logger.info('Spawn timeout extended by creator', { agentId, name: agent.name, callerAgentId, minutes }, callerAgentId);
  return { ok: true, message: `Extended "${agent.name}" (${agentId.slice(0, 8)}) by ${minutes} more minute${minutes === 1 ? '' : 's'}. You'll be asked again if it runs out.` };
}

// Record a timeout decision on the linked task's log (if any), else to the logger.
async function recordTimeoutDecision(
  taskId: string | null,
  callerAgentId: string,
  subAgentId: string,
  subAgentName: string,
  action: 'extend' | 'terminate',
  minutes: number | null,
): Promise<void> {
  if (taskId) {
    try {
      const { writeTaskLog } = await import('../tracker/task-log.js');
      writeTaskLog({
        taskId,
        fromEntity: `agent:${callerAgentId}`,
        entryKind: 'observation',
        actionTaken: `spawn timeout ${action}`,
        reason: action === 'extend'
          ? `creator extended sub-agent "${subAgentName}" (${subAgentId.slice(0, 8)}) by ${minutes} min at its timeout`
          : `creator let sub-agent "${subAgentName}" (${subAgentId.slice(0, 8)}) stop at its timeout`,
      });
      return;
    } catch (err) {
      logger.warn('recordTimeoutDecision: task_log write failed, falling back to logger', {
        taskId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Spawn timeout decision recorded', { subAgentId, subAgentName, action, minutes, callerAgentId });
}

/**
 * Boot re-arm (P3 item 5). In-memory timers vanish on restart. Rebuild them from
 * the DB for live non-ronin spawned agents: overdue-and-undecided fires the
 * decision now; a future timeout re-arms the decision timer; an agent already
 * awaiting a decision (pending===1) re-arms only the undecided ladder; a fully
 * escalated one (pending===2) is left running. Idempotent with the 30s sweep.
 */
export function reArmSpawnTimeouts(): void {
  const db = getDb();
  type ReArmRow = {
    id: string; name: string; classification: string | null; config: string;
    timeout_at: string | null; timeout_decision_pending: number | null;
  };
  let rows: ReArmRow[];
  try {
    rows = db.prepare(`
      SELECT id, name, classification, config, timeout_at, timeout_decision_pending
      FROM agents
      WHERE status NOT IN ('terminated')
        AND timeout_at IS NOT NULL
        AND classification NOT IN ('ronin', 'sensei')
    `).all() as ReArmRow[];
  } catch (err) {
    logger.warn('reArmSpawnTimeouts: query failed (skipping boot re-arm)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let reArmed = 0, firedNow = 0, laddered = 0;
  for (const a of rows) {
    if (timeoutTimers.has(a.id)) continue; // already armed this boot
    try { if (JSON.parse(a.config || '{}').persist === true) continue; } catch { /* not persist */ }

    const pending = a.timeout_decision_pending ?? 0;
    if (pending >= 2) continue; // fully escalated; still running, nothing to do

    if (pending === 1) {
      timeoutTimers.set(a.id, setTimeout(() => { fireSpawnTimeoutUndecided(a.id); }, SPAWN_TIMEOUT_UNDECIDED_GRACE_MS));
      laddered++;
      continue;
    }

    // pending === 0
    if (!a.timeout_at) continue;
    const atMs = new Date(a.timeout_at.replace(' ', 'T') + (a.timeout_at.includes('Z') ? '' : 'Z')).getTime();
    if (Number.isNaN(atMs)) continue;
    const delay = atMs - Date.now();
    if (delay <= 0) {
      fireSpawnTimeoutDecision(a.id);
      firedNow++;
    } else {
      timeoutTimers.set(a.id, setTimeout(() => { fireSpawnTimeoutDecision(a.id); }, delay));
      reArmed++;
    }
  }

  if (reArmed || firedNow || laddered) {
    logger.info('reArmSpawnTimeouts: restored spawn timeout timers on boot', { reArmed, firedNow, laddered, scanned: rows.length });
  }
}

// ── Timeout Checker ──

export function checkTimeouts(): void {
  const db = getDb();

  // Only rows with no decision pending yet (timeout_decision_pending = 0). Once
  // an apprentice's decision notice has fired (>=1) the in-memory ladder (or the
  // boot re-arm) owns it; excluding it here keeps the 30s sweep from re-selecting
  // it every tick and prevents any double-notify.
  const expiredAgents = db.prepare(`
    SELECT id, name, timeout_at, config, classification FROM agents
    WHERE status NOT IN ('terminated')
      AND timeout_at IS NOT NULL
      AND timeout_at <= datetime('now')
      AND COALESCE(timeout_decision_pending, 0) = 0
  `).all() as Array<{ id: string; name: string; timeout_at: string; config: string; classification: string }>;

  for (const agent of expiredAgents) {
    // D14: sensei agents cannot be terminated by the reaper, terminateAgent
    // refuses them (classification==='sensei') and returns WITHOUT clearing
    // timeout_at, so the 30s reaper re-picked the same stray sensei on every
    // tick forever (one orphaned duplicate Dreamer produced 1,713 "Cannot
    // terminate sensei" log lines). Clear its timeout so it is not re-reaped; a
    // genuinely stray/duplicate sensei is cleaned up out-of-band, not here.
    if (agent.classification === 'sensei') {
      db.prepare("UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?").run(agent.id);
      logger.info('Sensei timeout cleared (senseis are not reaped by the timeout checker)', { agentId: agent.id, name: agent.name }, agent.id);
      continue;
    }

    // Skip agents with persist: true, they should stay alive
    try {
      const config = JSON.parse(agent.config || '{}');
      if (config.persist) {
        // Clear the timeout so we don't keep checking it, but keep the agent alive
        db.prepare("UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?").run(agent.id);
        logger.info('Persistent agent timeout cleared (persist=true)', { agentId: agent.id, name: agent.name }, agent.id);
        continue;
      }
    } catch { /* ignore parse errors */ }

    // P3: a non-ronin, non-persist apprentice reaching its timeout is a CREATOR
    // DECISION, not a kill. This is the restart-safe backstop for the in-memory
    // timer (lost on reboot): fire the decision notice; the sub-agent keeps
    // running. Idempotent (guards on timeout_decision_pending), so a concurrent
    // boot re-arm firing the same agent notifies exactly once.
    fireSpawnTimeoutDecision(agent.id);
  }
}
