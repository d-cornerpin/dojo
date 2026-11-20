// v3.5 inspect — review fix (t267 review, Critical 1): ONLY A HOLDER, OR THE OWNER, GRANTS dojo_inspect.
//
// `tools.allow` naming `dojo_inspect` is a positive grant (`inspect/grant.ts`), while every other
// door reads `allow` as a restriction, so the no-escalation rule never judged it. The reviewer's
// path, reproduced: a sensei that can spawn (categories '*', neither the main agent nor the Healer)
// spawned a child with allow:['dojo_inspect'] and that child ran sql. Refused now at the agent
// doors (spawn, update_agent) unless the granter holds the tool; the owner's dashboard grants it.
// ORCHESTRATOR RULING: the main agent may delegate inspection explicitly. Scratch DOJO_HOME.
// FIX ROUND 4 RULINGS: an agent edit is judged on what it LEAVES, not on the arrays it carries (a
// blanked or partial stored grants object fell back to the derivation, which has no deny); and the
// owner's "Oversight & Admin" switch withdraws dojo_inspect from the main agent and the Healer too.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const MGR = 'agent-sensei-spawner';
const WORKER = 'agent-plain-worker';
const HEALER = 'agent-healer-cfg';
const SPAWNER_MANIFEST = { file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], network_domains: '*', max_processes: 5, can_spawn_agents: true, can_assign_permissions: true, system_control: [] };

// t277: THE ENVIRONMENT AND THE IMPORTS ARE SET UP AT COLLECTION, NOT IN A HOOK. `DOJO_HOME` must be
// in place before the product modules are first loaded (they read it at import), so the home is made
// and the variable stubbed first, then the modules are loaded with top-level awaits. This used to be
// a `beforeAll` with a 120 s bound, which only gave a cold import of ~650 modules a longer timeout;
// collection has no per-test budget at all, and the hook below is left with database setup only.
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-grant-door-'));
vi.stubEnv('DOJO_HOME', home);
const imp_connection = await import('../../db/connection.js');
const imp_migrations = await import('../../db/migrations.js');
const imp_platform = await import('../../config/platform.js');
const imp_spawner = await import('../../agent/spawner.js');
const imp_grant = await import('../grant.js');
const imp_read = await import('../../agent/access/read.js');
const imp_index = await import('../../agent/tools/index.js');
const imp_tool_outcome = await import('../../agent/tool-outcome.js');
const imp_agents = await import('../../gateway/routes/agents.js');
const imp_surface = await import('../../agent/tools/surface.js');

let mod: {
  connection: typeof import('../../db/connection.js');
  spawner: typeof import('../../agent/spawner.js');
  grant: typeof import('../grant.js');
  access: typeof import('../../agent/access/read.js');
  tools: typeof import('../../agent/tools/index.js');
  outcome: typeof import('../../agent/tool-outcome.js');
  agentsRouter: typeof import('../../gateway/routes/agents.js')['agentsRouter'];
  surface: typeof import('../../agent/tools/surface.js');
};

beforeAll(() => {
  const connection = imp_connection;
  imp_migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at) VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text","tools"]', 65536, 8192, 1.0, 0, 1, datetime('now'), datetime('now'))`).run();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 0, 'system')");
  add.run(PRIMARY, 'main', 'sensei', null);
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, 'spawner', 'idle', '{}', 'sensei', ?, 1, ?)").run(MGR, JSON.stringify(SPAWNER_MANIFEST), PRIMARY);
  db.prepare("INSERT INTO agents (id, name, status, config, classification, spawn_depth, created_by) VALUES (?, 'worker', 'idle', '{}', 'apprentice', 1, ?)").run(WORKER, PRIMARY);
  db.prepare("INSERT INTO agents (id, name, status, config, classification, model_id, spawn_depth, created_by) VALUES (?, 'healer', 'idle', '{}', 'sensei', 'mdl', 1, ?)").run(HEALER, PRIMARY);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(PRIMARY, HEALER);
  imp_platform.clearPlatformConfigCache();
  mod = {
    connection,
    spawner: imp_spawner,
    grant: imp_grant,
    access: imp_read,
    tools: imp_index,
    outcome: imp_tool_outcome,
    agentsRouter: imp_agents.agentsRouter,
    surface: imp_surface,
  };
});

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const spawn = (parentId: string, extra: Record<string, unknown>) =>
  mod.spawner.spawnAgent({ parentId, name: `child-${Math.random().toString(36).slice(2, 8)}`, systemPrompt: 'You help.', modelId: 'mdl', ...extra } as Parameters<typeof mod.spawner.spawnAgent>[0]);

describe('an agent that does not hold dojo_inspect cannot grant it', () => {
  it('the reviewer\'s path: a sensei spawner names it in the child\'s grants — refused, no child', async () => {
    expect(mod.grant.holdsDojoInspect(MGR)).toBe(false);
    const before = mod.connection.getDb().prepare('SELECT count(*) FROM agents').pluck().get();
    await expect(spawn(MGR, { grants: { tools: { categories: ['Oversight & Admin', 'Meta'], allow: ['dojo_inspect'] } } }))
      .rejects.toThrow(/cannot grant dojo_inspect/);
    expect(mod.connection.getDb().prepare('SELECT count(*) FROM agents').pluck().get()).toBe(before);
  });

  it('…and through the older tools argument, refused the same way', async () => {
    await expect(spawn(MGR, { toolsPolicy: { allow: ['dojo_inspect', 'file_read'], deny: [] } })).rejects.toThrow(/cannot grant dojo_inspect/);
  });

  it('fix round 2: a main agent the owner withheld it from cannot lift the deny, nor hand the tool on', async () => {
    const db = mod.connection.getDb();
    // The owner's withholding, stored the way the dashboard stores it: a grants object with the deny.
    const owned = structuredClone(mod.access.getAccessGrants(PRIMARY));
    owned.tools.deny = ['dojo_inspect'];
    db.prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: owned }), PRIMARY);
    mod.access.forgetAccessGrants();
    const upd = async (args: Record<string, unknown>) => mod.outcome.toolResultOf(await mod.tools.executeTool(PRIMARY, { id: `call-upd-${Math.random()}`, name: 'update_agent', arguments: args }));
    try {
      expect(mod.grant.holdsDojoInspect(PRIMARY)).toBe(false);
      // Fix round 4: judged on what the edit LEAVES. The grants shape would lift the deny: refused.
      // The `tools` shape writes only the old tools_policy column, which an agent with stored grants
      // does not read — it lifts nothing, so it is not refused, and the deny still holds.
      const lift = await upd({ agent_id: PRIMARY, grants: { tools: { deny: [] } } });
      expect(lift.isError).toBe(true);
      expect(lift.content).toMatch(/the owner withheld it from this agent; only the owner can give it back/);
      await upd({ agent_id: PRIMARY, tools: { deny: [] } });
      mod.access.forgetAccessGrants();
      expect(mod.grant.holdsDojoInspect(PRIMARY)).toBe(false);
      const handOn = await upd({ agent_id: WORKER, tools: { allow: ['dojo_inspect'] } });
      expect(handOn.isError).toBe(true);
      expect(handOn.content).toMatch(/only the owner or the main agent can grant/);
      await expect(spawn(PRIMARY, { toolsPolicy: { allow: ['dojo_inspect'], deny: [] } })).rejects.toThrow(/cannot grant dojo_inspect/);
    } finally {
      db.prepare('UPDATE agents SET permissions = NULL WHERE id = ?').run(PRIMARY);
      mod.access.forgetAccessGrants();
    }
  });

  it('fix round 2 RULING: a delegate that holds it cannot re-delegate — not by name, not by inheritance', async () => {
    const db = mod.connection.getDb();
    db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, tools_policy, spawn_depth, created_by) VALUES ('agent-delegate', 'delegate', 'idle', '{}', 'apprentice', ?, ?, 1, ?)")
      .run(JSON.stringify(SPAWNER_MANIFEST), JSON.stringify({ allow: ['dojo_inspect', 'spawn_agent', 'file_read', 'send_to_agent'], deny: [] }), PRIMARY);
    mod.access.forgetAccessGrants();
    expect(mod.grant.holdsDojoInspect('agent-delegate')).toBe(true);
    await expect(spawn('agent-delegate', { toolsPolicy: { allow: ['dojo_inspect', 'file_read'], deny: [] } })).rejects.toThrow(/cannot grant dojo_inspect/);
    // Naming nothing, the grandchild inherits the delegate's list — without dojo_inspect.
    const grandchild = await spawn('agent-delegate', {});
    mod.access.forgetAccessGrants();
    expect(mod.access.toolGrantsFor(grandchild.agentId).allow).toEqual(['spawn_agent', 'file_read', 'send_to_agent']);
    expect(mod.grant.holdsDojoInspect(grandchild.agentId)).toBe(false);
  });

  it('a spawn that does not name it is unaffected', async () => {
    const child = await spawn(MGR, {});
    expect(mod.grant.holdsDojoInspect(child.agentId)).toBe(false);
  });
});

describe('a holder, or the owner, grants it', () => {
  it('RULING: the main agent may delegate inspection explicitly', async () => {
    const child = await spawn(PRIMARY, { toolsPolicy: { allow: ['dojo_inspect', 'send_to_agent'], deny: [] } });
    mod.access.forgetAccessGrants();
    expect(mod.grant.holdsDojoInspect(child.agentId)).toBe(true);
  });

  it('RULING: naming it IS the grant — offered and callable without the "Oversight & Admin" group; not granted, neither', async () => {
    const call = async (agent: string) => mod.outcome.toolResultOf(await mod.tools.executeTool(agent, { id: `call-g-${Math.random()}`, name: 'dojo_inspect', arguments: { what: 'schema', table: 'agents' } }));
    const granted = await spawn(PRIMARY, { toolsPolicy: { allow: ['dojo_inspect', 'send_to_agent'], deny: [] } });
    const plain = await spawn(PRIMARY, { toolsPolicy: { allow: ['send_to_agent'], deny: [] } });
    mod.access.forgetAccessGrants();
    expect(mod.access.getAccessGrants(granted.agentId).tools.categories).not.toContain('Oversight & Admin');
    const offered = (agent: string) => mod.surface.getFilteredTools(agent).some((t) => t.name === 'dojo_inspect');
    expect(offered(granted.agentId)).toBe(true);
    const ok = await call(granted.agentId);
    expect(ok.isError, ok.content).toBe(false);
    expect(ok.content).toMatch(/^agents\n\nid /);
    expect(offered(plain.agentId)).toBe(false);
    expect((await call(plain.agentId)).isError).toBe(true);
  });

  it('the owner\'s dashboard grants it to an existing worker', async () => {
    const db = mod.connection.getDb();
    expect(mod.grant.holdsDojoInspect(WORKER)).toBe(false);
    try {
      const res = await mod.agentsRouter.request(`/${WORKER}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolsPolicy: { allow: ['dojo_inspect', 'file_read'], deny: [] } }),
      });
      expect(res.status).toBe(200);
      mod.access.forgetAccessGrants();
      expect(mod.grant.holdsDojoInspect(WORKER)).toBe(true);
    } finally {
      // The route writes the folded grants AND the tools_policy column, so the
      // worker is a holder for the rest of the run — and fix round 2's hand-on
      // relies on the worker NOT holding the tool. Restore both; leave the memo
      // clean so the next read re-parses.
      db.prepare('UPDATE agents SET permissions = NULL, tools_policy = NULL WHERE id = ?').run(WORKER);
      mod.access.forgetAccessGrants();
    }
  });
});

describe('fix round 4 RULING: an edit is judged on what it leaves', () => {
  const db = () => mod.connection.getDb();
  const upd = async (args: Record<string, unknown>) => mod.outcome.toolResultOf(await mod.tools.executeTool(PRIMARY, { id: `call-r4-${Math.random()}`, name: 'update_agent', arguments: args }));
  const row = (id: string) => db().prepare('SELECT permissions, tools_policy, model_id FROM agents WHERE id = ?').get(id);
  const forget = () => mod.access.forgetAccessGrants();
  // The owner's withholding, stored the way the dashboard stores it: a whole grants object with the deny.
  function withhold(id: string): void {
    const owned = structuredClone(mod.access.getAccessGrants(id));
    owned.tools.deny = ['dojo_inspect'];
    db().prepare('UPDATE agents SET permissions = ?, model_id = NULL WHERE id = ?').run(JSON.stringify({ grants: owned }), id);
    forget();
    expect(mod.grant.holdsDojoInspect(id)).toBe(false);
  }
  const restore = (id: string) => { db().prepare('UPDATE agents SET permissions = NULL WHERE id = ?').run(id); forget(); };

  it('blanking or replacing the stored grants through permissions cannot lift the owner\'s deny — on the main agent itself or the Healer; nothing changes', async () => {
    for (const target of [PRIMARY, HEALER]) {
      withhold(target);
      try {
        for (const grants of [null, {}, { tools: { allow: [] } }]) {
          const before = row(target);
          const r = await upd({ agent_id: target, permissions: { grants } });
          expect(r.isError, `${target} ${JSON.stringify(grants)}: ${r.content}`).toBe(true);
          expect(r.content).toMatch(/the owner withheld it from this agent; only the owner can give it back/);
          expect(row(target)).toEqual(before);
          forget();
          expect(mod.grant.holdsDojoInspect(target)).toBe(false);
        }
        // "Change nothing": the unrelated half of a refused edit is not written either.
        const both = await upd({ agent_id: target, model_id: 'mdl', permissions: { grants: null } });
        expect(both.isError).toBe(true);
        expect((row(target) as { model_id: string | null }).model_id).toBeNull();
      } finally { restore(target); }
    }
  });

  it('LAST MINORS: the edit is all-or-nothing — a grants half refused for any reason leaves the model unwritten too', async () => {
    const { TOOL_CATEGORIES } = await import('../../tools/categories.js');
    try {
      const narrowed = await mod.agentsRouter.request(`/${PRIMARY}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grants: { tools: { categories: TOOL_CATEGORIES.map((c) => c.label).filter((l) => l !== 'Web') } } }) });
      expect(narrowed.status).toBe(200);
      forget();
      db().prepare('UPDATE agents SET model_id = NULL WHERE id = ?').run(WORKER);
      const r = await upd({ agent_id: WORKER, model_id: 'mdl', grants: { tools: { categories: '*' } } });
      expect(r.isError, r.content).toBe(true);
      expect(r.content).toMatch(/can only grant access it holds itself/);
      expect((row(WORKER) as { model_id: string | null }).model_id).toBeNull();
    } finally { restore(PRIMARY); }
  });

  it('an unrelated edit to a denied agent still works and keeps the deny', async () => {
    withhold(HEALER);
    try {
      const model = await upd({ agent_id: HEALER, model_id: 'mdl' });
      expect(model.isError, model.content).toBe(false);
      const manifest = await upd({ agent_id: HEALER, permissions: { exec_deny: ['rm -rf /'] } });
      expect(manifest.isError, manifest.content).toBe(false);
      const narrower = await upd({ agent_id: HEALER, grants: { tools: { deny: ['dojo_inspect', 'cost_summary'] } } });
      expect(narrower.isError, narrower.content).toBe(false);
      forget();
      expect(mod.access.toolGrantsFor(HEALER).deny).toContain('dojo_inspect');
      expect(mod.grant.holdsDojoInspect(HEALER)).toBe(false);
    } finally { restore(HEALER); }
  });

  it('the owner\'s dashboard edit gives it back', async () => {
    withhold(PRIMARY);
    try {
      const res = await mod.agentsRouter.request(`/${PRIMARY}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grants: { tools: { deny: [] } } }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      forget();
      expect(mod.grant.holdsDojoInspect(PRIMARY)).toBe(true);
    } finally { restore(PRIMARY); }
  });

  it('RULING: the owner switching "Oversight & Admin" off for the main agent or the Healer withdraws dojo_inspect too; on again, it is back', async () => {
    const { TOOL_CATEGORIES } = await import('../../tools/categories.js');
    const put = (id: string, categories: unknown) => mod.agentsRouter.request(`/${id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grants: { tools: { categories } } }),
    });
    const offered = (id: string) => mod.surface.getFilteredTools(id).some((t) => t.name === 'dojo_inspect');
    const call = async (id: string) => mod.outcome.toolResultOf(await mod.tools.executeTool(id, { id: `call-cat-${Math.random()}`, name: 'dojo_inspect', arguments: { what: 'schema', table: 'agents' } }));
    for (const target of [PRIMARY, HEALER]) {
      try {
        const off = await put(target, TOOL_CATEGORIES.map((c) => c.label).filter((l) => l !== 'Oversight & Admin'));
        expect(off.status, await off.clone().text()).toBe(200);
        forget();
        expect(mod.grant.holdsDojoInspect(target), target).toBe(false);
        expect(offered(target), target).toBe(false);
        const refused = await call(target);
        expect(refused.isError, target).toBe(true);
        expect(refused.errorCode).toBe('PERMISSION_DENIED');
        // FIX ROUND 5 RULING: an agent's own edit giving the group back is still refused (no escalation)…
        const byAgent = mod.outcome.toolResultOf(await mod.tools.executeTool(PRIMARY, { id: `call-cat-up-${Math.random()}`, name: 'update_agent', arguments: { agent_id: target, grants: { tools: { categories: TOOL_CATEGORIES.map((c) => c.label) } } } }));
        expect(byAgent.isError, byAgent.content).toBe(true);
        forget();
        expect(mod.grant.holdsDojoInspect(target)).toBe(false);
        // …while the owner's switch on is judged as the OWNER's, never against the main agent's own grants.
        const on = await put(target, TOOL_CATEGORIES.map((c) => c.label));
        expect(on.status, await on.clone().text()).toBe(200);
        forget();
        expect(mod.grant.holdsDojoInspect(target), target).toBe(true);
        expect(offered(target), target).toBe(true);
      } finally { restore(target); }
    }
  });
});

describe('RULED CHANGE (create route): the owner\'s dashboard create is judged as the owner\'s', () => {
  it('the owner narrows the main agent, then creates an agent holding the removed group: created; a spawn naming it: refused', async () => {
    const { TOOL_CATEGORIES } = await import('../../tools/categories.js');
    const json = (method: string, url: string, body: unknown) => mod.agentsRouter.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const narrowed = await json('PUT', `/${PRIMARY}`, { grants: { tools: { categories: TOOL_CATEGORIES.map((c) => c.label).filter((l) => l !== 'Web') } } });
      expect(narrowed.status, await narrowed.clone().text()).toBe(200);
      mod.access.forgetAccessGrants();
      const created = await json('POST', '/', { name: 'owner-made', systemPrompt: 'You help.', grants: { tools: { categories: ['Web'] } } });
      const out = await created.clone().text();
      expect(created.status, out).toBeLessThan(300);
      const id = (JSON.parse(out) as { data: { id: string } }).data.id;
      mod.access.forgetAccessGrants();
      expect(mod.access.getAccessGrants(id).tools.categories).toContain('Web');
      // An agent-initiated create doing the same keeps the no-escalation check.
      await expect(spawn(PRIMARY, { grants: { tools: { categories: ['Web'] } } })).rejects.toThrow(/Web/);
    } finally {
      mod.connection.getDb().prepare('UPDATE agents SET permissions = NULL WHERE id = ?').run(PRIMARY);
      mod.access.forgetAccessGrants();
    }
  });
});
