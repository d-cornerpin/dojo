import { v4 as uuidv4 } from 'uuid';
import { resolveAgentTaskId } from './agent-task.js';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import { getAgentRuntime, stopAgent } from './runtime.js';
import { runIsLive } from './ended-mid-run.js';
import { getAgentPermissions, checkPermission } from './permissions.js';
import { resolveChildScope } from './scope.js';
import { resolveSpawnGrants, GrantRefusedError } from './access/authorize.js';
import { inspectGrantRefusal, withoutInheritedInspect } from '../inspect/grant.js';
import { getAccessGrants } from './access/read.js';
import { caseVariantClash, caseVariantClashMessage } from './tool-helpers.js';
import { inheritedCreatorKind } from './created-by-kind.js';
import { validateAlwaysLoadedTools } from './always-loaded-tools.js';
import { isPrimaryAgent, getPrimaryAgentId } from '../config/platform.js';
import { postAgentNotice } from './agent-notice.js';
import { writeAgentStatus } from './agent-status.js';
import { taskScope, STATE_TO_STATUS_SQL } from '../work/tracker-view.js';
import { setHold, heldExpr, workingExpr } from '../work/done/hold.js';
import { moveAssignee } from '../work/row-authority.js';
import { memoryGrep } from '../memory/retrieval.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { canSpawnAgent } from '../services/resource-monitor.js';
import { archiveAgentConversation } from '../vault/archive.js';
import type { PermissionManifest, Agent } from '@dojo/shared';

const logger = createLogger('spawner');

// Config (reads from the DB config table, falls back to defaults)

// There is NO default timeout: a lifetime is the creator's decision, so a non-ronin spawn MUST
// carry an explicit one (the spawn_agent tool requires it at the surface; ronin has none).
const SPAWN_DEFAULTS = {
  maxChildrenPerAgent: 3,
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
      maxSpawnDepth: get('spawn_max_depth', SPAWN_DEFAULTS.maxSpawnDepth),
    };
  } catch {
    return SPAWN_DEFAULTS;
  }
}

const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();


export interface SpawnParams {
  parentId: string;
  name: string;
  systemPrompt: string;
  modelId?: string;
  permissions?: PermissionManifest;
  toolsPolicy?: { allow: string[]; deny: string[] };
  /**
   * The ACCESS grants this spawn asks for (categories, integrations, credentials, channels).
   * Unvalidated on purpose: `resolveSpawnGrants` is the one place it is judged, so every caller
   * gets the same schema check and the same no-escalation rule.
   */
  grants?: unknown;
  timeout?: number;
  taskId?: string;
  contextHints?: string[];
  persist?: boolean;
  classification?: 'ronin' | 'apprentice' | 'sensei';
  shareUserProfile?: boolean;
  groupId?: string;
  /** Technique IDs to equip on this agent (pre-loaded into context) */
  equippedTechniques?: string[];
  /** Custom always-loaded tools for this agent (overrides role defaults); the floor validates. */
  alwaysLoadedTools?: unknown;
}

export async function spawnAgent(params: SpawnParams): Promise<{ agentId: string; name: string; status: string; persist: boolean; warnings: string[] }> {
  const {
    parentId,
    name,
    systemPrompt,
    modelId,
    permissions,
    toolsPolicy,
    grants,
    timeout,
    taskId,
    contextHints,
    persist = false,
    classification = 'apprentice',
    shareUserProfile = false,
    groupId,
    equippedTechniques = [],
    alwaysLoadedTools,
  } = params;

  // Validate the contract up front so the failure names the field that was missed: the schema
  // marks these required but the dispatcher does not enforce it.
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('spawn_agent: `name` is required (a non-empty string).');
  }
  if (!systemPrompt || typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error('spawn_agent: `system_prompt` is required (a non-empty string describing the agent\'s role and instructions).');
  }

  const db = getDb();

  // A name differing from a live agent's only by letter case would mint a second agent the
  // case-insensitive lookup cannot tell apart (the newest silently wins), so refuse it at
  // the row-writing door, before any permission or resource work.
  const clash = caseVariantClash(name);
  if (clash) throw new Error(caseVariantClashMessage(clash.name));

  // THE AUTHORITATIVE SPAWN GATE: spawnAgent writes the row, and callers that never enter the
  // executor exist, so this gate is on every path by construction. The executor's gate is NOT
  // redundant: it turns the same `authorizeSpawn` answer into a model-readable classified refusal
  // plus an audit row at the tool boundary. Both answer from one manifest; they cannot disagree.
  const spawnCheck = checkPermission(parentId, { type: 'spawn' });
  if (!spawnCheck.allowed) {
    throw new Error(`Spawn denied: ${spawnCheck.reason}`);
  }

  // Low memory refuses any other parent; the main agent's spawn proceeds with a warning.
  const parentIsPrimary = isPrimaryAgent(parentId);
  const warnings: string[] = [];
  const resourceCheck = canSpawnAgent();
  if (!resourceCheck.allowed) {
    if (!parentIsPrimary) throw new Error(`Spawn denied: ${resourceCheck.reason}`);
    warnings.push(resourceCheck.reason ?? 'Insufficient memory');
  }

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

  const resolvedModelId = modelId === 'auto' ? 'auto' : (modelId ?? parent.model_id);
  // A model that is not a chat model, or is under the size floor, refuses any parent's child; a named model too big for memory warns the main agent. Loaded on demand.
  const refusedModel = resolvedModelId ? await import('./main-model-floor.js').then((f) => f.refuseNonChatModel(resolvedModelId) ?? f.refuseSmallMainModel(resolvedModelId)) : null;
  if (refusedModel) throw new Error(`Spawn denied: ${refusedModel}`);
  const unfit = modelId && modelId !== 'auto' ? await import('./local-model-fit.js').then((f) => f.refuseUnfitLocalModel(modelId, parent.model_id, 'agent')) : null;
  if (unfit && !parentIsPrimary) throw new Error(`Spawn denied: ${unfit}`);
  if (unfit) warnings.push(unfit);
  if (!resolvedModelId) {
    throw new Error('No model specified and parent has no model configured');
  }

  let enhancedPrompt = systemPrompt;

  if (contextHints && contextHints.length > 0) {
    const contextParts: string[] = [];
    for (const hint of contextHints) {
      try {
        const grepResult = await memoryGrep(parentId, {
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

  const agentId = uuidv4();
  // Ronin agents persist until the user dismisses them, so no timeout; there is no engine default,
  // a non-ronin spawn has one only when the caller passes it (the tool enforces at the surface).
  const timeoutSeconds = classification === 'ronin' ? null : (timeout ?? null);
  const timeoutAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000).toISOString().replace('T', ' ').replace('Z', '') : null;

  // THE CHILD'S SCOPE: no manifest named, the child gets the one helper default (plus its own artifact
  // directory). A named manifest is schema-validated and bounded by the parent; a malformed or escalating
  // one REFUSES the spawn, never a silent downgrade.
  const scope = resolveChildScope(permissions, getAgentPermissions(parentId), agentId);
  if (!scope.ok) {
    throw new Error(`Spawn denied: ${scope.reason}`);
  }

  // THE CHILD'S ACCESS: the manifest says what the child may do to the BOX; this says what it may
  // REACH (categories, integrations, credentials, channels). A spawn naming no grants gets
  // MOST_RESTRICTIVE_GRANTS. Prospective, never retrospective: no living agent is re-scoped here.
  // Here, not at the tool, for the same structural reason as the spawn gate: every path writes here.
  const grantResolution = resolveSpawnGrants(
    grants,
    getAccessGrants(parentId),
    isPrimaryAgent(parentId),
    toolsPolicy,
  );
  if (!grantResolution.ok) {
    throw new GrantRefusedError(grantResolution.reason);
  }
  // dojo_inspect is granted by the owner or the main agent only, never inherited (inspect/grant.ts).
  const inspectRefused = inspectGrantRefusal(parentId, (grants as { tools?: { allow?: unknown } } | undefined)?.tools?.allow, toolsPolicy?.allow);
  const childAllow = withoutInheritedInspect(parentId, grantResolution.grants.tools.allow);
  if (inspectRefused || !childAllow) throw new GrantRefusedError(inspectRefused ?? 'tools.allow: this child would inherit only dojo_inspect, which only the owner or the main agent can grant; name the tools it needs.');
  grantResolution.grants.tools.allow = childAllow;

  const permissionsJson = JSON.stringify({ ...scope.manifest, grants: grantResolution.grants });
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
    // A spawned child inherits its parent's creator kind, so a harness fixture's worker is
    // disposable for the same structural reason its parent is; anything else is 'agent'.
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

  // THE FLOOR for all three callers: the handler owns the good message and refuses before any row.
  const declared = validateAlwaysLoadedTools(alwaysLoadedTools);
  if (!declared.ok) throw new Error(declared.error);
  if (declared.names.length > 0) db.prepare('UPDATE agents SET always_loaded_tools = ? WHERE id = ?').run(JSON.stringify(declared.names), agentId);

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

  // Persist the charter durably so getSoulContent reads it directly, not by sniffing the earliest
  // role='system' row (which false-rejected terse or bracket-prefixed charters). Same content.
  try {
    db.prepare('UPDATE agents SET charter = ? WHERE id = ?').run(enhancedPrompt, agentId);
  } catch { /* charter column may not exist on a very old database */ }

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

  // Set timeout timer: ronin never timeouts, persist agents get their timeout cleared, and an
  // apprentice's expiry is a CREATOR DECISION: the timer does not terminate, it fires
  // fireSpawnTimeoutDecision (notify the creator; it runs until an authorized hand extends or ends).
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

  return { agentId, name, status: 'idle', persist, warnings };
}


/** The working rules a new helper's job carries in its ASSIGN: the caller's own first message, else the default. */
export function jobBrief({ systemPrompt, initialMessage }: { systemPrompt: string; initialMessage?: string }): string {
  if (initialMessage) {
    // A custom first message is used as written, with a reminder of how to finish when it names none.
    if (initialMessage.toLowerCase().includes('complete_task')) return initialMessage;
    return `${initialMessage}\n\nIMPORTANT: When you are finished, reply on this thread with send_to_agent(intent="COMPLETE") carrying your full result (that hands your task in), then call complete_task with status="complete" and a summary. Do NOT just stop responding.`;
  }
  // A system prompt that already says how to finish gets no default instructions.
  if (systemPrompt.toLowerCase().includes('complete_task')) return `Your task: ${systemPrompt}\n\nBegin working immediately.`;
  const steps = [
    'Begin working immediately.',
    'Use absolute file paths (e.g., /Users/<your-user>/Desktop/...), do NOT use ~ or relative paths, as they may resolve differently in your context.',
    'When the work is done, reply on this thread with send_to_agent(intent="COMPLETE", thread_id=<the thread_id named at the end of this message>, payload=<your full result>). That reply hands your task in. If it cannot be done, send intent="FAIL" with the reason instead.',
    'After that reply, you MUST call the complete_task tool with status="complete", a summary of what you did, and any results. Do NOT just stop responding, call complete_task so your parent agent knows you are done.',
    'If you get stuck or cannot complete the task, call complete_task with status="blocked" or status="fallen" and explain why.',
    'Do not wait for further instructions unless you need clarification, just do the work and report back via complete_task.',
  ];
  return `Your task: ${systemPrompt}\n\nIMPORTANT INSTRUCTIONS:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
}

export function terminateAgent(agentId: string, reason?: string): void {
  const db = getDb();

  const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?').get(agentId) as {
    id: string;
    name: string;
    status: string;
  } | undefined;

  if (!agent) {
    logger.warn('Cannot terminate: agent not found', { agentId });
    return;
  }

  if (agent.status === 'terminated') {
    logger.debug('Agent already terminated', { agentId });
    return;
  }

  // Ending an agent stops its run in flight, through the owner's own Stop; BEFORE the status write.
  if (runIsLive(agentId)) stopAgent(agentId);

  // Archive conversation for the Dreamer before terminating. force=true: a torn-down agent's final
  // tail must be archived even if an earlier unprocessed archive exists, or the Dreamer never sees
  // it; the rowid high-water still bounds the archive to the genuinely-new tail, so no re-copy bloat.
  try {
    archiveAgentConversation(agentId, true);
  } catch (err) {
    logger.warn('Failed to archive agent conversation on termination', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  writeAgentStatus(agentId, 'terminated');

  // The steps it held go back to the agent that made it; its other Working tasks stay with it, held paused (never closed).
  try {
    returnHeldSteps(agentId, 'helper ended (terminated)');
    const danglers = db.prepare(`
      SELECT w.id AS id FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND NOT ${heldExpr('w')}
    `).all(agentId) as Array<{ id: string }>;
    const why = `assigned agent "${agent.name}" was terminated (${reason ?? 'manual'}); reassign or close it from the dashboard`;
    for (const dt of danglers) {
      const r = setHold(dt.id, 'paused', why, 'engine');
      if (!r.ok) logger.warn('terminateAgent: auto-pause refused', { taskId: dt.id, why: r.why });
    }
    if (danglers.length > 0) logger.info('terminateAgent: auto-paused in_progress tasks', { agentId, count: danglers.length }, agentId);
  } catch (autopauseErr) {
    logger.warn('terminateAgent: task auto-pause failed (non-fatal)', {
      agentId, error: autopauseErr instanceof Error ? autopauseErr.message : String(autopauseErr),
    }, agentId);
  }

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

  import('./browser.js').then(({ closeSession }) => {
    closeSession(agentId).catch(() => {});
  }).catch(() => {});

  endApprentices(agentId);
}

/** An ending agent ends its apprentice helpers; sensei and ronin survive. */
function endApprentices(agentId: string): void {
  const children = getDb().prepare(
    "SELECT id FROM agents WHERE parent_agent = ? AND status != 'terminated' AND classification = 'apprentice'",
  ).all(agentId) as Array<{ id: string }>;
  for (const child of children) terminateAgent(child.id, `Parent ${agentId} terminated`);
}


export async function completeAgent(
  agentId: string,
  status: 'complete' | 'fallen' | 'blocked',
  summary: string,
): Promise<void> {
  const db = getDb();

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as {
    id: string;
    name: string;
    parent_agent: string | null;
    task_id: string | null;
    config: string;
    classification: string | null;
    agent_type: string | null;
  } | undefined;

  if (!agent) {
    logger.warn('Cannot complete: agent not found', { agentId });
    return;
  }

  // Sensei agents and anything marked `agent_type='persistent'` are persistent regardless of the
  // config JSON: completeAgent does its own raw status write, so the terminateAgent guard cannot help.
  let isPersistent = agent.classification === 'sensei' || agent.agent_type === 'persistent';
  if (!isPersistent) {
    try {
      const config = JSON.parse(agent.config || '{}');
      isPersistent = config.persist === true;
    } catch {}
  }

  // Archive before changing status. force=!isPersistent: a NON-persistent agent terminates below, so
  // its final tail must survive an earlier unprocessed archive; a resident stays alive and idle, so
  // force=false there dedups repeated archives for a chatty resident.
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
    // Non-persistent: terminate immediately, with its own helpers
    writeAgentStatus(agentId, 'terminated');
    endApprentices(agentId);

    // Close browser session if open (same fire-and-forget as terminateAgent)
    import('./browser.js').then(({ closeSession }) => {
      closeSession(agentId).catch(() => {});
    }).catch(() => {});
  }

  const timer = timeoutTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timeoutTimers.delete(agentId);
  }

  // The explicit agent.task_id link (set at spawn) is the identity. Without it, an assigned task
  // resolves ONLY when unambiguous (exactly one candidate): several must not guess the wrong task.
  const resolvedTaskId = resolveAgentTaskId(agentId, agent.task_id);   // `agent/agent-task.ts`

  // The task was handed in by complete_task before this ran (`completeTaskHandIn`); a block holds it.
  if (resolvedTaskId) {
    if (status === 'blocked') {
      const held = setHold(resolvedTaskId, 'blocked', summary.split('\n')[0] || `apprentice "${agent.name}" is blocked`, agentId);
      if (!held.ok) logger.warn('completeAgent: block refused', { agentId, taskId: resolvedTaskId, why: held.why }, agentId);
    }
  }

  // The ending agent's other working tasks cannot progress ("complete" is refused while any is open):
  // each is handed in as can't be done on the termination record. Held tasks go back to its creator.
  try {
    const { engineHandIn } = await import('../work/done/hand-in.js');
    const primary = resolvedTaskId
      ? db.prepare('SELECT parent_id AS project_id, source_message_id FROM work WHERE id = ?').get(resolvedTaskId) as { project_id: string | null; source_message_id: string | null } | undefined
      : undefined;
    const danglers = db.prepare(`
      SELECT w.id AS id, w.parent_id AS project_id, w.source_message_id AS source_message_id FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND NOT ${heldExpr('w')} AND w.id != COALESCE(?, '')
    `).all(agentId, resolvedTaskId ?? null) as Array<{ id: string; project_id: string | null; source_message_id: string | null }>;
    for (const dt of danglers) {
      const sameWork = !!primary && ((dt.project_id !== null && dt.project_id === primary.project_id)
        || (dt.source_message_id !== null && dt.source_message_id === primary.source_message_id));
      engineHandIn(dt.id, sameWork
        ? `agent "${agent.name}" ended (complete_task ${status}); this task shares its work order`
        : `agent "${agent.name}" ended (complete_task ${status}) and this task is not part of its work`,
      { outcome: 'cant_be_done' });
    }
    if (!isPersistent) returnHeldSteps(agentId, `helper ended (complete_task ${status})`);
  } catch (err) {
    logger.warn('completeAgent: dangler hand-in failed (non-fatal)', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
  }

  // If this is the Dreamer ending a batch, advance the dream chain on ANY terminal status. On
  // 'complete' the batch's archives are marked processed; on 'blocked'/'fallen' they are NOT (never
  // mark an archive the Dreamer did not distill), the attempt counter is bumped, poisoned after
  // repeated failures; either way the cycle continues instead of stalling on a non-complete batch.
  const { isDreamerAgent } = await import('../config/platform.js');
  if (isDreamerAgent(agentId)) {   // identity by agent id, never by display name
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
  }, agentId);

  // Broadcast the agent's new status
  broadcast({
    type: 'agent:status',
    agentId,
    status: isPersistent ? 'idle' : 'terminated',
  });

}

// ── Extend a held agent's timeout ──
// The destructive gate HOLDS a non-primary worker's call pending the primary's approval, then wakes
// it to retry; the reaper must not kill the worker mid-approval. Extending only the DB row is INERT:
// reaping is driven by the per-agent in-memory setTimeout armed at spawn, which the DB write never
// rescheduled. This reschedules BOTH the timer AND the row, as checkTimeouts' DB sweep expects.
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

  // Same shape spawnAgent writes (space-separated, no Z) so the DB sweep compares cleanly. The
  // stretched life is no longer waiting on a verdict, so a pending decision is cleared too.
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
      // Reaching the extended timeout is a creator DECISION, not a kill.
      fireSpawnTimeoutDecision(agentId);
    }, delayMs);
    timeoutTimers.set(agentId, timer);
  }

  logger.info('extendAgentTimeout: reap rescheduled for held worker', {
    agentId, name: agent.name, newTimeoutAt: dbTimeoutAt, delayMs,
  }, agentId);
}

// ── Spawn timeout: creator-owned decision ──
// The timeout is set by the creating agent, and reaching it is a DECISION POINT, never an execution:
// the engine posts an awareness notice to the CREATOR (or the primary if the creator is gone) and
// the sub-agent KEEPS RUNNING until spawn_timeout_decision resolves it. timeout_decision_pending is
// the reboot-safe ledger: 0 nothing pending, 1 creator notified, 2 escalated to the primary once.

// If no decision lands within this window after the creator notice, escalate
// once to the primary so the owner hears about it in-voice. Never auto-kill.
const SPAWN_TIMEOUT_UNDECIDED_GRACE_MS = 15 * 60 * 1000;

/**
 * The timeout fired: request the creator's decision. Idempotent (guards on
 * timeout_decision_pending) so the in-memory timer, the 30s DB sweep, and the boot re-arm all reach
 * it and notify exactly once; the sub-agent stays running. */
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

/** The grace passed with no decision: escalate ONCE to the primary so the owner hears it in-voice.
 *  Never auto-kills, never fires twice (guards on timeout_decision_pending === 1 -> 2). */
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

/** Apply the creator's or the main agent's decision (the owner's path is the dashboard). extend: new
 *  timeout_at + re-armed decision timer. terminate: flows through terminateAgent. */
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

  // Its creator or the main agent decides; the owner's path is the dashboard.
  const creatorId = agent.created_by ?? agent.parent_agent;
  if (creatorId !== callerAgentId && !isPrimaryAgent(callerAgentId)) {
    return { ok: false, message: `Only the agent that created "${agent.name}" or the main agent can decide its timeout, and you are neither. If you are the owner, extend or dismiss it from the dashboard instead.` };
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

/** Boot re-arm: in-memory timers vanish on restart, so rebuild them from the DB for live non-ronin
 *  agents: overdue-and-undecided fires the decision now; a future timeout re-arms it; pending 1
 *  re-arms only the undecided ladder; a fully escalated one (pending 2) is left running. */
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
    // Sensei agents cannot be terminated by the reaper; terminateAgent refuses them and returns
    // WITHOUT clearing timeout_at, so the 30s sweep would re-pick the same stray sensei every tick
    // forever. Clear its timeout so it is not re-reaped; a genuinely stray sensei is cleaned up
    // out-of-band, not here.
    if (agent.classification === 'sensei') {
      db.prepare("UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?").run(agent.id);
      logger.info('Sensei timeout cleared (senseis are not reaped by the timeout checker)', { agentId: agent.id, name: agent.name }, agent.id);
      continue;
    }

    try {
      const config = JSON.parse(agent.config || '{}');
      if (config.persist) {
        // Clear the timeout so we don't keep checking it, but keep the agent alive
        db.prepare("UPDATE agents SET timeout_at = NULL, updated_at = datetime('now') WHERE id = ?").run(agent.id);
        logger.info('Persistent agent timeout cleared (persist=true)', { agentId: agent.id, name: agent.name }, agent.id);
        continue;
      }
    } catch { /* ignore parse errors */ }

    // A non-ronin, non-persist apprentice reaching its timeout is a CREATOR
    // DECISION, not a kill. This is the restart-safe backstop for the in-memory
    // timer (lost on reboot): fire the decision notice; the sub-agent keeps
    // running. Idempotent (guards on timeout_decision_pending), so a concurrent
    // boot re-arm firing the same agent notifies exactly once.
    fireSpawnTimeoutDecision(agent.id);
  }
}

function returnHeldSteps(agentId: string, door: string): void {
  const parentId = (getDb().prepare('SELECT parent_agent AS p FROM agents WHERE id = ?').get(agentId) as { p: string | null } | undefined)?.p;
  const held = parentId ? getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND ${heldExpr('w')}`).all(agentId) as Array<{ id: string }> : [];
  for (const { id } of held) {
    const moved = moveAssignee({ taskId: id, by: 'engine', actorId: agentId, cause: 'assignee_gone', to: { agentId: parentId! }, door });
    if (!moved.ok) logger.warn('a held step stays with its ended helper', { agentId, taskId: id, why: moved.text }, agentId);
  }
}
