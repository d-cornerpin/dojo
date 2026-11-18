import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { getAgentRuntime } from '../../agent/runtime.js';
import { liveWork, hasLiveWork, announceLiveWork } from '../../agent/live-work.js';
// The third fact the stop door asks: a run still unwinding, when neither other fact can answer.
import { isRunUnwinding } from '../../agent/shared-state.js';
import { terminateAgent } from '../../agent/spawner.js';
import { stopByOwner } from '../../agent/runtime.js';
import { noteOwnerStop } from '../../migration/import-agents.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { refuseStaleWholeDocument } from './whole-document-guard.js';
import { readAgentPromptSurface, writeAgentPromptSurface } from '../../prompt/agent-prompt-surface.js';
import { createLogger } from '../../logger.js';
import { broadcast } from '../ws.js';
import { isPrimaryAgent, getPrimaryAgentId, getHealerAgentId, getDreamerAgentId } from '../../config/platform.js';
import { sanitizeMessagesOnModelChange } from '../../agent/model-switch.js';
import type { AccessGrants, AgentDetail, Model } from '@dojo/shared';
import { cloneGrants, NEW_SESSION_DIVIDER } from '@dojo/shared';
import { noteRouteFailure } from './route-failure.js';
import { resolveChildScope, validateManifest } from '../../agent/scope.js';
import { caseVariantClash, caseVariantClashMessage } from '../../agent/tool-helpers.js';
import { purgeAgentRows } from '../../agent/purge.js';
import { getAgentPermissions } from '../../agent/permissions.js';
import { renameAgent } from '../../prompt/agent-rename.js';
// Owner-side half of the grant door: same resolver, schema and merge as `spawn_agent` / `update_agent`.
import { resolveSpawnGrants, resolveUpdateGrants, grantsDelta } from '../../agent/access/authorize.js';
// This door's default grants: the floor plus Conversation Recall. The module records why the shared
// floor did not move and that agents that already exist are not backfilled.
import { DASHBOARD_CREATE_DEFAULT_GRANTS } from '../../agent/access/create-defaults.js';
import { getAccessGrants } from '../../agent/access/read.js';
import { withWebGroupFor } from '../../agent/access/tools-policy.js';
import { writeGrants } from '../../agent/access/materialize.js';
import { auditLog } from '../../agent/tools/util.js';
import { parkedCauseOf } from '../../agent/v2/honest-stop-lock.js';
import { SilentWindowMinutesSchema } from '../../config/schema.js';
import { refuseAgentModel } from '../../agent/main-model-floor.js';

const logger = createLogger('agents-routes');

/** The main agent's dreaming cannot be switched off. Returns null when the change is allowed. */
export function dreamerIgnoreRefusal(agentId: string, ignore: boolean): string | null {
  return ignore && agentId === getPrimaryAgentId() ? 'The main agent always dreams: the Dreamer reads its conversations, and that cannot be switched off.' : null;
}

const agentsRouter = new Hono();

// GET / - live agents with detail; ?all=1 adds the ended ones (the Agents page's history)
agentsRouter.get('/', (c) => {
  const db = getDb();
  const live = c.req.query('all') === '1' ? '' : "WHERE status != 'terminated' ";
  const rows = db.prepare(`SELECT * FROM agents ${live}ORDER BY created_at ASC`).all() as Array<Record<string, unknown>>;

  const facts = rosterFacts(rows);
  const agents: AgentDetail[] = rows.map(row => rowToAgentDetail(row, facts));
  return c.json({ ok: true, data: agents });
});

// GET /:id - single agent detail
agentsRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (!row) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  const agent = rowToAgentDetail(row);
  // `effectiveScope` is what getAgentPermissions returns (defaults, identity rules and the artifact dir
  // applied); `permissions` stays the stored blob. `effectiveGrants` is what the agent may reach.
  return c.json({
    ok: true,
    data: { ...agent, effectiveScope: getAgentPermissions(id), effectiveGrants: getAccessGrants(id) },
  });
});

// PATCH /:id/model - set agent's model
agentsRouter.patch('/:id/model', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.prepare('SELECT id, model_id FROM agents WHERE id = ?').get(id) as { id: string; model_id: string | null } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.modelId !== 'string') {
    return c.json({ ok: false, error: 'modelId string is required' }, 400);
  }

  const { modelId } = body;

  const refused = await refuseAgentModel(modelId, agent.model_id);
  if (refused) return c.json({ ok: false, error: refused }, 400);

  if (modelId === 'auto') {
    db.prepare("UPDATE agents SET model_id = 'auto', updated_at = datetime('now') WHERE id = ?").run(id);
    logger.info('Agent model set to auto-router', { agentId: id });
  } else {
    const model = db.prepare('SELECT id, name FROM models WHERE id = ? AND is_enabled = 1').get(modelId) as { id: string; name: string } | undefined;
    if (!model) {
      return c.json({ ok: false, error: 'Model not found or not enabled' }, 400);
    }
    db.prepare("UPDATE agents SET model_id = ?, updated_at = datetime('now') WHERE id = ?").run(modelId, id);
    logger.info('Agent model updated', { agentId: id, modelId, modelName: model.name });
  }

  // Sanitize tool call messages so the new model doesn't choke on tool_use IDs generated by the previous model
  sanitizeMessagesOnModelChange(id);
  await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged(id);   // a no-fit lock gets another look
  // Keep config-table model keys in sync for persistent agents whose runtime reads from config rather than agents.model_id
  const upsert = db.prepare(`
    INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  if (id === getHealerAgentId()) {
    upsert.run('healer_model_id', modelId);
    logger.info('Synced healer_model_id config key', { modelId });
  } else if (id === getDreamerAgentId()) {
    upsert.run('dreaming_model_id', modelId);
    logger.info('Synced dreaming_model_id config key', { modelId });
  }

  // Return updated agent
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ ok: true, data: rowToAgentDetail(row) });
});

// POST /: create standalone agent from dashboard
agentsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body.name !== 'string' || typeof body.systemPrompt !== 'string') {
    return c.json({ ok: false, error: 'name (string) and systemPrompt (string) are required' }, 400);
  }

  if (body.name.trim() === '') {
    return c.json({ ok: false, error: 'name must not be blank' }, 400);
  }

  const refused = typeof body.modelId === 'string' ? await refuseAgentModel(body.modelId) : null;   // before any write
  if (refused) return c.json({ ok: false, error: refused }, 400);
  try {
    const db = getDb();
    const agentId = uuidv4();

    // A name that differs from a live agent's only by capitals would mint a second agent the
    // case-insensitive lookup cannot tell apart. Refuse before any write.
    const clash = caseVariantClash(body.name);
    if (clash) return c.json({ ok: false, error: caseVariantClashMessage(clash.name) }, 400);

    // Same validation path as the spawner. The parent scope is the primary agent's, the ceiling for a
    // dashboard-created agent; a body naming no manifest gets the default.
    const scope = resolveChildScope(
      body.permissions,
      getAgentPermissions(getPrimaryAgentId()),
      agentId,
    );
    if (!scope.ok) {
      // A refusal, not a downgrade: 400 with the field named.
      logger.warn('Dashboard agent creation refused an invalid manifest', { reason: scope.reason });
      return c.json({ ok: false, error: `Agent not created, ${scope.reason}` }, 400);
    }

    // Grants resolve through the same resolver as spawns, from this door's default. The route is the owner
    // acting (null granter, granterIsPrimary), so access is not capped at the main agent's own grants and
    // the owner can switch a new agent's human-channel master on. Agent spawns keep the no-escalation check.
    const grantScope = resolveSpawnGrants(
      body.grants,
      null,
      true,
      body.toolsPolicy,
      DASHBOARD_CREATE_DEFAULT_GRANTS,
    );
    if (!grantScope.ok) {
      logger.warn('Dashboard agent creation refused invalid grants', { reason: grantScope.reason });
      return c.json({ ok: false, error: `Agent not created, ${grantScope.reason}` }, 400);
    }

    const resolvedModelId = body.modelId || null;
    const config = JSON.stringify({
      shareUserProfile: body.shareUserProfile || undefined,
    });
    // A present timeout must be a positive finite number: a negative one would expire the agent at the
    // next reap, and a non-numeric one would store nothing.
    if (body.timeout !== undefined && body.timeout !== null && body.timeout !== '') {
      const seconds = Number(body.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return c.json({ ok: false, error: 'timeout must be a positive number of seconds' }, 400);
      }
    }
    const timeoutSeconds = body.timeout ? Number(body.timeout) : null;
    // The space form the spawner writes and the reaper's `datetime('now')` compares against; a bare
    // `toISOString()` 'T' sorts after the space and delays the reap.
    const timeoutAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000).toISOString().replace('T', ' ').replace('Z', '') : null;

    const classification = body.classification === 'ronin' ? 'ronin' : 'apprentice';

    const groupId = body.groupId ?? null;

    db.prepare(`
      INSERT INTO agents (id, name, model_id, system_prompt_path, status, config, created_by, created_by_kind,
                          parent_agent, spawn_depth, agent_type, classification, group_id, max_runtime, timeout_at,
                          permissions, tools_policy, equipped_techniques, task_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, 'idle', ?, 'dashboard', 'user',
              NULL, 0, 'standard', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      agentId,
      body.name,
      resolvedModelId,
      config,
      classification,
      groupId,
      timeoutSeconds,
      timeoutAt,
      JSON.stringify({ ...scope.manifest, grants: withWebGroupFor(grantScope.grants, body.toolsPolicy, body.grants) }),
      JSON.stringify(body.toolsPolicy ?? {}),
      JSON.stringify(body.equippedTechniques ?? []),
      body.taskId ?? null,
    );

    // Store system prompt as first message (no spawn injection)
    insertMessageIfAbsent({ id: uuidv4(), agentId, role: 'system', content: body.systemPrompt });

    // Persist the charter durably so getSoulContent reads it directly.
    try {
      db.prepare('UPDATE agents SET charter = ? WHERE id = ?').run(body.systemPrompt, agentId);
    } catch { /* charter column may not exist on a very old database */ }

    // Store initial user message (just the task)
    const initMsgId = uuidv4();
    insertMessageIfAbsent({ id: initMsgId, agentId, role: 'user', content: body.systemPrompt });
    // Broadcast the owner-lane user row so the agent's first message shows without a reload; the
    // agent:created event below says nothing about it.
    broadcast({
      type: 'chat:message',
      agentId,
      message: {
        id: initMsgId, agentId, role: 'user' as const, content: body.systemPrompt,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: new Date().toISOString(),
      },
    });

    // Start the agent runtime
    const runtime = getAgentRuntime();
    runtime.handleMessage(agentId, body.systemPrompt).catch(err => {
      logger.error('Dashboard agent initial run failed', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Dashboard agent created', { agentId, name: body.name });

    broadcast({
      type: 'agent:created',
      data: {
        id: agentId,
        name: body.name,
        modelId: resolvedModelId,
        systemPromptPath: null,
        status: 'idle' as const,
        config: JSON.parse(config),
        createdBy: 'dashboard',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        parentAgent: null,
        spawnDepth: 0,
        agentType: 'standard' as const,
        classification: classification as 'ronin' | 'apprentice',
        groupId: null,
        maxRuntime: timeoutSeconds,
        timeoutAt,
        permissions: scope.manifest,
        toolsPolicy: body.toolsPolicy ?? {},
        equippedTechniques: body.equippedTechniques ?? [],
        taskId: body.taskId ?? null,
      },
    });

    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as Record<string, unknown>;
    return c.json({ ok: true, data: rowToAgentDetail(row) }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create agent', { error: msg });
    return c.json({ ok: false, error: msg }, 500);
  }
});

// GET /:id/system-prompt: get agent's system prompt
agentsRouter.get('/:id/system-prompt', (c) => {
  const id = c.req.param('id');

  // One surface: the prompt the model is actually given, not the oldest role='system' row.
  try {
    return c.json({ ok: true, data: { content: readAgentPromptSurface(id) } });
  } catch (err) {
    noteRouteFailure(c, logger, err);
    return c.json({ ok: false, error: 'Could not read this agent’s prompt.' }, 500);   // never a blank a page could save over
  }
});

// PUT /:id: update agent config (model, system prompt, permissions, tools policy)
agentsRouter.put('/:id', async (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.prepare('SELECT id, model_id FROM agents WHERE id = ?').get(id) as { id: string; model_id: string | null } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ ok: false, error: 'Request body required' }, 400);
  }

  const refused = typeof body.modelId === 'string' ? await refuseAgentModel(body.modelId, agent.model_id) : null;   // before the rename
  if (refused) return c.json({ ok: false, error: refused }, 400);

  // A new name that differs from another live agent's only by capitals is refused with the other 400
  // doors, so a refused Save writes nothing.
  const nameClash = typeof body.name === 'string' && body.name.trim() ? caseVariantClash(body.name.trim(), id) : null;
  if (nameClash) return c.json({ ok: false, error: caseVariantClashMessage(nameClash.name) }, 400);

  // `permissions` and `toolsPolicy` replace a whole stored object. A save that names the value it was built on
  // (`basePermissions` / `baseToolsPolicy`, what the page read) is refused, writing nothing, if the stored
  // value is no longer that one. Compared by value, not by `updated_at`, which moves on every status change
  // and heartbeat. (The grants half is a patch of moved fields and needs no such check.)
  {
    const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : 1))) : x);
    const cur = db.prepare('SELECT permissions, tools_policy FROM agents WHERE id = ?').get(id) as { permissions: string | null; tools_policy: string | null } | undefined;
    const stale = (sent: boolean, base: unknown, stored: string | null): boolean => {
      if (!sent || base === undefined || !cur) return false;
      try { return stable(JSON.parse(stored || '{}')) !== stable(base ?? {}); } catch { return true; }
    };
    if (stale(body.permissions !== undefined, body.basePermissions, cur?.permissions ?? null)
      || stale(body.toolsPolicy !== undefined, body.baseToolsPolicy, cur?.tools_policy ?? null)) {
      return c.json({ ok: false, error: 'This agent\u2019s access settings changed since you loaded them, so your change was not saved. Reload and make it again.' }, 409);
    }
  }

  // The prompt is saved WHOLE (for the primary agent it is SOUL.md). A save must name the prompt it was
  // built on (`systemPromptBase`, the text the page read); if the stored one has moved the save is refused
  // and nothing is written. A caller that names no base may not replace a saved prompt with a blank one.
  if (typeof body.systemPrompt === 'string') {
    let storedPrompt: string;
    try { storedPrompt = readAgentPromptSurface(id); }
    catch (err) { noteRouteFailure(c, logger, err); return c.json({ ok: false, error: 'The saved prompt could not be read, so nothing was changed. Try again.' }, 500); }
    const refusal = refuseStaleWholeDocument('prompt', body.systemPrompt, body.systemPromptBase, storedPrompt);
    if (refusal) return c.json({ ok: false, error: refusal.error }, refusal.status);
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (typeof body.modelId === 'string') {
    if (body.modelId === 'auto') {
      updates.push("model_id = 'auto'");
    } else {
      const model = db.prepare('SELECT id FROM models WHERE id = ? AND is_enabled = 1').get(body.modelId);
      if (!model) {
        return c.json({ ok: false, error: 'Model not found or not enabled' }, 400);
      }
      updates.push('model_id = ?');
      params.push(body.modelId);
    }
  }

  if (body.permissions !== undefined) {
    // `permissions` is a JSON document carrying the manifest AND the grants. The permissions editor knows
    // nothing about grants, so carry the stored grants forward unless the caller sent its own (that wins).
    const incoming = (body.permissions ?? {}) as Record<string, unknown>;
    const { grants: _sentGrants, ...manifest } = incoming;
    const checked = validateManifest(manifest);
    if (!checked.ok) return c.json({ ok: false, error: `Access not saved, invalid permission manifest: ${checked.reason}` }, 400);
    if (incoming.grants === undefined) {
      const prior = db.prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as { permissions: string | null } | undefined;
      try {
        const priorGrants = (JSON.parse(prior?.permissions || '{}') as { grants?: unknown }).grants;
        if (priorGrants !== undefined) incoming.grants = priorGrants;
      } catch { /* an unparseable prior blob carries nothing forward */ }
    }
    updates.push('permissions = ?');
    params.push(JSON.stringify(incoming));
  }

  // Owner-side parity with `update_agent({grants})`: same schema, merge-over-current and audit row. A bad
  // body is a 400, and there is no no-escalation check: the owner is judged as the owner (null granter).
  // Top-level `grants` wins over `permissions.grants`: this is the validated door, that one a passthrough.
  // The WRITE is deferred past the column batch below, which re-writes `permissions` from an earlier read
  // and would revert the grant half; validation and its 400 stay here.
  let pendingGrants: { grants: AccessGrants; source: string } | null = null;
  if (body.grants !== undefined) {
    const resolution = resolveUpdateGrants(body.grants, getAccessGrants(id), null, true);
    if (!resolution.ok) {
      logger.warn('Agent grant update refused', { agentId: id, reason: resolution.reason });
      return c.json({ ok: false, error: resolution.reason }, 400);
    }
    pendingGrants = { grants: resolution.grants, source: 'grants set by owner (dashboard)' };
  }

  if (body.classification !== undefined && ['ronin', 'apprentice'].includes(body.classification)) {
    updates.push('classification = ?');
    params.push(body.classification);
  }

  if (body.config !== undefined && typeof body.config === 'object') {
    // Merge with existing config
    const existingCfg = db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as { config: string } | undefined;
    const merged = { ...JSON.parse(existingCfg?.config || '{}'), ...body.config };
    updates.push('config = ?');
    params.push(JSON.stringify(merged));
  }

  if (body.toolsPolicy !== undefined) {
    updates.push('tools_policy = ?');
    params.push(JSON.stringify(body.toolsPolicy));
    // Fold the allow/deny into the grants too: tool filtering and the executor re-check read the grants
    // object, not this column. The column keeps its value as the legacy record other readers display.
    const tp = body.toolsPolicy as { allow?: unknown; deny?: unknown } | null;
    const base = pendingGrants?.grants ?? getAccessGrants(id);
    const folded = cloneGrants(base);
    if (Array.isArray(tp?.allow)) folded.tools.allow = (tp!.allow as unknown[]).filter((t): t is string => typeof t === 'string');
    if (Array.isArray(tp?.deny)) folded.tools.deny = (tp!.deny as unknown[]).filter((t): t is string => typeof t === 'string');
    pendingGrants = {
      grants: withWebGroupFor(folded, tp, body.grants),
      source: pendingGrants ? pendingGrants.source : 'tools policy set by owner (dashboard)',
    };
  }

  if (body.equippedTechniques !== undefined) {
    updates.push('equipped_techniques = ?');
    params.push(JSON.stringify(body.equippedTechniques));
  }

  if (body.silentWindowMinutes !== undefined) { // the per-agent silent window
    const w = SilentWindowMinutesSchema.safeParse(body.silentWindowMinutes);
    if (!w.success) return c.json({ ok: false, error: `silentWindowMinutes: ${w.error.issues[0]?.message ?? 'invalid'} (or null for the 2-hour default)` }, 400);
    updates.push('silent_window_minutes = ?'); params.push(w.data);
  }

  if (body.dreamerIgnore !== undefined) {
    const refused = dreamerIgnoreRefusal(id, body.dreamerIgnore === true);
    if (refused) return c.json({ ok: false, error: refused }, 400);
    // When true, the vault archive layer skips this agent's conversations; the Dreamer never sees them.
    updates.push('dreamer_ignore = ?');
    params.push(body.dreamerIgnore ? 1 : 0);
  }

  // The rename and the prompt write run after every 400 door, so a refused Save writes nothing.
  if (typeof body.name === 'string' && body.name.trim()) {
    // One rename door: `renameAgent` writes the row and the platform role name, and re-fills the souls
    // that named the agent.
    renameAgent(id, body.name.trim());
  }
  if (typeof body.systemPrompt === 'string') {
    // Write through the door the card reads, so the edit reaches the prompt the model is given.
    writeAgentPromptSurface(id, body.systemPrompt);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // The access write comes last, after the column batch, so nothing above re-writes `permissions` from a
  // stale read. The delta is computed against the object as it stands now: no delta, no write, no audit row.
  if (pendingGrants) {
    const current = getAccessGrants(id);
    const delta = grantsDelta(current, pendingGrants.grants);
    if (delta) {
      writeGrants(id, pendingGrants.grants);
      // `audit_log.agent_id` references `agents` and the owner has no agent row, so the row is filed on
      // the agent whose access moved; the actor is named in the detail.
      auditLog(id, 'update_agent', id, 'success', `${pendingGrants.source}: ${delta}`);
    }
  }

  logger.info('Agent config updated', { agentId: id, fields: Object.keys(body) });
  if (body.modelId !== undefined || body.toolsPolicy !== undefined || pendingGrants) await (await import('../../agent/v2/honest-stop-lock.js')).noteModelsChanged(id);   // a no-fit lock gets another look

  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({ ok: true, data: rowToAgentDetail(row) });
});

// DELETE /:id: terminate agent (cascade)
agentsRouter.delete('/:id', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.prepare('SELECT id, status, classification FROM agents WHERE id = ?').get(id) as { id: string; status: string; classification: string } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  if (agent.classification === 'sensei') {
    return c.json({ ok: false, error: 'Cannot terminate a sensei agent' }, 403);
  }

  if (agent.status === 'terminated') {
    return c.json({ ok: false, error: 'Agent is already terminated' }, 400);
  }

  terminateAgent(id, 'Terminated via dashboard');
  return c.json({ ok: true, data: { agentId: id, status: 'terminated' } });
});

// POST /:id/stop: halt a working agent and set to idle
agentsRouter.post('/:id/stop', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  // Stop applies to anything the agent is doing: a working turn, live background work, or a run still
  // unwinding (teardown writes `idle` before the turn record is finalized, and the abort registration is
  // released early). Refuse only an agent with none of the three, so a stop marker is never left pending
  // on a turn that never happened.
  const live = liveWork(id);
  if (agent.status !== 'working' && !hasLiveWork(live) && !isRunUnwinding(id)) {
    return c.json({ ok: false, error: 'Agent is not currently working and has no background jobs running' }, 400);
  }

  const { repliesNotSent } = stopByOwner(id);
  noteOwnerStop(id);   // a failed import in flight must not lift the owner's own stop

  // Report what actually happened rather than asserting an outcome: `stopAgent` writes idle only when no
  // run is in flight, otherwise the row stays `working` and it broadcasts `stopping: true`. The zero is
  // announced here, not waited for: a job's own exit edge can land a tick later, and this frame is the one
  // that takes the stop control away.
  announceLiveWork(id);

  const after = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string };
  logger.info('Agent stopped via dashboard', {
    agentId: id, statusAfter: after.status, cutTurn: live.turn, cutBackground: live.background,
  });
  // The counts were read before the stop (what it was asked to cut); the payload reports what is left.
  return c.json({ ok: true, data: {
    agentId: id, status: after.status, stopping: after.status === 'working', inFlight: liveWork(id), repliesNotSent,
  } });
});

// POST /:id/reset-session: mirrors the agent's reset_session tool (divider, broadcast, vault archive,
// reorientation prompt).
agentsRouter.post('/:id/reset-session', async (c) => {
  const id = c.req.param('id');
  const db = getDb();
  const agent = db.prepare('SELECT id, name, status FROM agents WHERE id = ?')
    .get(id) as { id: string; name: string; status: string } | undefined;
  if (!agent) return c.json({ ok: false, error: 'Agent not found' }, 404);
  if (agent.status === 'terminated') {
    return c.json({ ok: false, error: 'Agent is terminated, no live session to reset' }, 400);
  }

  try {
    // 1. Archive current conversation to vault (best-effort).
    const { archiveAgentConversation } = await import('../../vault/archive.js');
    try { archiveAgentConversation(id, true); } catch { /* */ }

    // 1b. Clear stale runtime signals so the post-reset agent starts clean (a stale stop flag would make
    //     the next user message bail). `stopFencedRuns` is deliberately NOT cleared: that fence belongs to
    //     the stopped run and is retired by its own exit path in `runtime.ts`, so a reset cannot un-stop it.
    try {
      const { stoppedAgents, preemptedAgents, pendingWakeups } = await import('../../agent/shared-state.js');
      stoppedAgents.delete(id);
      preemptedAgents.delete(id);
      pendingWakeups.delete(id); (await import('../../work/task-freshness.js')).endJobCarry(id); // a reset session has no job to continue
    } catch { /* best-effort */ }

    // 2. Set session boundary + clear scratchpad (session-scoped, not relevant after a reset).
    const boundary = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    db.prepare(
      "UPDATE agents SET session_started_at = ?, updated_at = ?, " +
      "config = json_remove(COALESCE(config, '{}'), '$.scratchpad') WHERE id = ?",
    ).run(boundary, boundary, id);
    // Carry a fired-but-undelivered reminder/scheduler event across the reset
    // boundary so it survives (engine-event queries gate created_at >=
    // session_started_at). Unclaimed deliverable engine rows only.
    try {
      const { rehomeUnclaimedEngineEvents } = await import('../../agent/v2/counterparty.js');
      rehomeUnclaimedEngineEvents(id, boundary);
    } catch { /* best-effort carry-over, never block the reset */ }
    // Forget the per-session scratch, including session-loaded tool docs (see `agent/session-forget.ts`).
    await (await import('../../agent/session-forget.js')).forgetSessionScratch(id);

    // 3. Insert UI divider + broadcast.
    const dividerId = uuidv4();
    // The divider's created_at is stamped by the writer at insert time rather than
    // pinned to `boundary` (computed a few lines up). Every session query is
    // `created_at >= session_started_at`, so at-or-after the boundary keeps the row
    // inside the new session; the broadcast still quotes `boundary` for the UI.
    insertMessageIfAbsent({ id: dividerId, agentId: id, role: 'system', content: NEW_SESSION_DIVIDER });
    broadcast({
      type: 'chat:message',
      agentId: id,
      message: {
        id: dividerId, agentId: id, role: 'system', content: NEW_SESSION_DIVIDER,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: boundary,
      },
    });

    // 4. Insert reorientation prompt + broadcast.
    const { buildSessionResetMessage } = await import('../../agent/session-reset.js');
    const reorientId = uuidv4();
    const reorientContent = buildSessionResetMessage(id);
    insertMessageIfAbsent({ id: reorientId, agentId: id, role: 'system', content: reorientContent });
    broadcast({
      type: 'chat:message',
      agentId: id,
      message: {
        id: reorientId, agentId: id, role: 'system', content: reorientContent,
        tokenCount: null, modelId: null, cost: null, latencyMs: null,
        createdAt: boundary,
      },
    });

    // 5. Heal error/paused status. A reset clears the corrupted context
    // that's often the root cause.
    if (agent.status === 'error' || agent.status === 'paused') {
      db.prepare(
        "UPDATE agents SET status = 'idle', last_error = NULL, last_error_at = NULL, updated_at = datetime('now') WHERE id = ?",
      ).run(id);
      broadcast({ type: 'agent:status', agentId: id, status: 'idle' });
    }

    logger.info('Agent session reset via API', { agentId: id, agentName: agent.name });
    return c.json({ ok: true, data: { agentId: id, name: agent.name, boundary } });
  } catch (err) {
    logger.error('Failed to reset agent session', {
      agentId: id, error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Reset failed' }, 500);
  }
});

// POST /:id/purge: permanently delete a terminated agent and all its data
agentsRouter.post('/:id/purge', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  // Prevent deleting primary agent
  if (isPrimaryAgent(id)) {
    return c.json({ ok: false, error: 'Cannot delete the primary agent' }, 400);
  }

  const agent = db.prepare('SELECT id, status FROM agents WHERE id = ?').get(id) as { id: string; status: string } | undefined;
  if (!agent) {
    return c.json({ ok: false, error: 'Agent not found' }, 404);
  }

  if (agent.status !== 'terminated') {
    return c.json({ ok: false, error: 'Agent must be terminated before it can be deleted' }, 400);
  }

  // Every table that references this agent, in ONE unit, with the FK order that makes the
  // sequence safe. The list and its ordering live with the rows in `agent/purge.ts`; this door
  // owns the gates above and nothing else.
  const swept = purgeAgentRows(id);

  logger.info('Agent permanently deleted', { agentId: id, ...swept });
  return c.json({ ok: true, data: { agentId: id, deleted: true } });
});

/** Message counts and model rows for a set of agent rows: two queries, whatever the number of rows. */
interface RosterFacts { counts: Map<string, number>; models: Map<string, Record<string, unknown>> }
function rosterFacts(rows: Array<Record<string, unknown>>): RosterFacts {
  const db = getDb();
  const ids = JSON.stringify(rows.map((r) => r.id));
  const counts = new Map((db.prepare(
    'SELECT agent_id AS id, COUNT(*) AS n FROM messages WHERE agent_id IN (SELECT value FROM json_each(?)) GROUP BY agent_id',
  ).all(ids) as Array<{ id: string; n: number }>).map((r) => [r.id, r.n] as const));
  const modelIds = JSON.stringify([...new Set(rows.map((r) => r.model_id).filter((m): m is string => typeof m === 'string'))]);
  const models = new Map((db.prepare('SELECT * FROM models WHERE id IN (SELECT value FROM json_each(?))')
    .all(modelIds) as Array<Record<string, unknown>>).map((m) => [m.id as string, m] as const));
  return { counts, models };
}

function rowToAgentDetail(row: Record<string, unknown>, facts: RosterFacts = rosterFacts([row])): AgentDetail {
  const agentId = row.id as string;
  const modelId = row.model_id as string | null;

  const msgCount = facts.counts.get(agentId) ?? 0;

  // Get model if set
  let model: Model | null = null;
  if (modelId) {
    const modelRow = facts.models.get(modelId);
    if (modelRow) {
      model = {
        id: modelRow.id as string,
        providerId: modelRow.provider_id as string,
        name: modelRow.name as string,
        apiModelId: modelRow.api_model_id as string,
        capabilities: JSON.parse(modelRow.capabilities as string),
        contextWindow: modelRow.context_window as number | null,
        maxOutputTokens: modelRow.max_output_tokens as number | null,
        inputCostPerM: modelRow.input_cost_per_m as number | null,
        outputCostPerM: modelRow.output_cost_per_m as number | null,
        isEnabled: Boolean(modelRow.is_enabled),
        thinkingEnabled: modelRow.thinking_enabled === null || modelRow.thinking_enabled === undefined
          ? true
          : Boolean(modelRow.thinking_enabled),
        numCtxOverride: typeof modelRow.num_ctx_override === 'number'
          ? modelRow.num_ctx_override
          : null,
        numCtxRecommended: typeof modelRow.num_ctx_recommended === 'number'
          ? modelRow.num_ctx_recommended
          : null,
        pricingUnit: (modelRow.pricing_unit === 'megapixel' || modelRow.pricing_unit === 'second' ||
                      modelRow.pricing_unit === 'character' || modelRow.pricing_unit === 'minute')
          ? modelRow.pricing_unit as 'megapixel' | 'second' | 'character' | 'minute'
          : 'token',
        costPerUnit: typeof modelRow.cost_per_unit === 'number'
          ? modelRow.cost_per_unit
          : (modelRow.pricing_unit === 'megapixel' && typeof modelRow.cost_per_megapixel === 'number'
            ? modelRow.cost_per_megapixel
            : null),
        costPerMegapixel: modelRow.pricing_unit === 'megapixel' && typeof modelRow.cost_per_megapixel === 'number'
          ? modelRow.cost_per_megapixel
          : null,
        // priceUnknown (derived, no column): the applicable rate is NULL rather than an explicit 0 (an
        // unknown rate bills as $0), so the unknown-price state stays visible.
        priceUnknown: (modelRow.pricing_unit === 'megapixel' || modelRow.pricing_unit === 'second' ||
                       modelRow.pricing_unit === 'character' || modelRow.pricing_unit === 'minute')
          ? !(typeof modelRow.cost_per_unit === 'number' ||
              (modelRow.pricing_unit === 'megapixel' && typeof modelRow.cost_per_megapixel === 'number'))
          : (modelRow.input_cost_per_m === null || modelRow.input_cost_per_m === undefined ||
             modelRow.output_cost_per_m === null || modelRow.output_cost_per_m === undefined),
        generationParams: (() => {
          if (typeof modelRow.generation_params !== 'string' || !modelRow.generation_params) return null;
          try { return JSON.parse(modelRow.generation_params) as Model['generationParams']; }
          catch { return null; }
        })(),
        voiceCatalog: (() => {
          if (typeof modelRow.voice_catalog !== 'string' || !modelRow.voice_catalog) return null;
          try {
            const parsed = JSON.parse(modelRow.voice_catalog);
            return Array.isArray(parsed) ? (parsed as Model['voiceCatalog']) : null;
          } catch { return null; }
        })(),
        createdAt: modelRow.created_at as string,
        updatedAt: modelRow.updated_at as string,
      };
    }
  }

  // Get uptime from runtime
  const runtime = getAgentRuntime();
  const uptime = runtime.getAgentUptime(agentId);

  return {
    id: agentId,
    name: row.name as string,
    modelId: modelId,
    systemPromptPath: row.system_prompt_path as string | null,
    status: row.status as AgentDetail['status'], parkedCause: parkedCauseOf(row.status, row.last_error),
    config: JSON.parse((row.config as string) || '{}'),
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    parentAgent: (row.parent_agent as string) ?? null,
    spawnDepth: (row.spawn_depth as number) ?? 0,
    agentType: ((row.agent_type as string) ?? 'standard') as 'standard' | 'persistent' | 'system',
    classification: ((row.classification as string) ?? 'apprentice') as 'sensei' | 'ronin' | 'apprentice',
    groupId: (row.group_id as string) ?? null,
    maxRuntime: (row.max_runtime as number) ?? null,
    timeoutAt: (row.timeout_at as string) ?? null,
    permissions: JSON.parse((row.permissions as string) || '{}'),
    toolsPolicy: JSON.parse((row.tools_policy as string) || '{}'),
    equippedTechniques: JSON.parse((row.equipped_techniques as string) || '[]'),
    taskId: (row.task_id as string) ?? null,
    messageCount: msgCount,
    uptime,
    model,
    dreamerIgnore: row.dreamer_ignore === 1,
    silentWindowMinutes: (row.silent_window_minutes as number | null) ?? null,
    // A read, never a writer: the live-work registry and open job rows, through `agent/live-work.ts`,
    // the one predicate the card and the stop route share.
    inFlight: liveWork(agentId),
  };
}

// POST /archive: hide terminated agents older than N days (default 7)
agentsRouter.post('/archive', (c) => {
  const db = getDb();
  const days = 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Mark old terminated agents as archived by setting agent_type to 'archived'
  const result = db.prepare(`
    UPDATE agents SET agent_type = 'archived', updated_at = datetime('now')
    WHERE status = 'terminated' AND updated_at < ? AND classification != 'sensei' AND agent_type != 'archived'
  `).run(cutoff);

  logger.info('Archived old terminated agents', { count: result.changes, cutoffDays: days });
  return c.json({ ok: true, data: { archived: result.changes } });
});

export { agentsRouter };
