// v3.5 inspect — review fix (t267 review, Critical 1): ONLY A HOLDER, OR THE OWNER, GRANTS dojo_inspect.
//
// `tools.allow` naming `dojo_inspect` is a positive grant (`inspect/grant.ts`), while every other
// door reads `allow` as a restriction, so the no-escalation rule never judged it. The reviewer's
// path, reproduced: a sensei that can spawn (categories '*', neither the main agent nor the Healer)
// spawned a child with allow:['dojo_inspect'] and that child ran sql. Refused now at the agent
// doors (spawn, update_agent) unless the granter holds the tool; the owner's dashboard grants it.
// ORCHESTRATOR RULING: the main agent may delegate inspection explicitly. Scratch DOJO_HOME.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const MGR = 'agent-sensei-spawner';
const WORKER = 'agent-plain-worker';
const SPAWNER_MANIFEST = { file_read: '*', file_write: '*', file_delete: 'none', exec_allow: ['*'], exec_deny: [], network_domains: '*', max_processes: 5, can_spawn_agents: true, can_assign_permissions: true, system_control: [] };

let home: string;
let mod: {
  connection: typeof import('../../db/connection.js');
  spawner: typeof import('../../agent/spawner.js');
  grant: typeof import('../grant.js');
  access: typeof import('../../agent/access/read.js');
  tools: typeof import('../../agent/tools/index.js');
  outcome: typeof import('../../agent/tool-outcome.js');
  agentsRouter: typeof import('../../gateway/routes/agents.js')['agentsRouter'];
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-grant-door-'));
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
  const connection = await import('../../db/connection.js');
  (await import('../../db/migrations.js')).runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at) VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, input_cost_per_m, output_cost_per_m, is_enabled, created_at, updated_at)
    VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text","tools"]', 65536, 8192, 1.0, 0, 1, datetime('now'), datetime('now'))`).run();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 0, 'system')");
  add.run(PRIMARY, 'main', 'sensei', null);
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, 'spawner', 'idle', '{}', 'sensei', ?, 1, ?)").run(MGR, JSON.stringify(SPAWNER_MANIFEST), PRIMARY);
  db.prepare("INSERT INTO agents (id, name, status, config, classification, spawn_depth, created_by) VALUES (?, 'worker', 'idle', '{}', 'apprentice', 1, ?)").run(WORKER, PRIMARY);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(PRIMARY);
  (await import('../../config/platform.js')).clearPlatformConfigCache();
  mod = {
    connection,
    spawner: await import('../../agent/spawner.js'),
    grant: await import('../grant.js'),
    access: await import('../../agent/access/read.js'),
    tools: await import('../../agent/tools/index.js'),
    outcome: await import('../../agent/tool-outcome.js'),
    agentsRouter: (await import('../../gateway/routes/agents.js')).agentsRouter,
  };
}, 120_000);

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const spawn = (parentId: string, extra: Record<string, unknown>) =>
  mod.spawner.spawnAgent({ parentId, name: `child-${Math.random().toString(36).slice(2, 8)}`, systemPrompt: 'You help.', modelId: 'mdl', autoStart: false, ...extra } as Parameters<typeof mod.spawner.spawnAgent>[0]);

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
      for (const args of [{ agent_id: PRIMARY, tools: { deny: [] } }, { agent_id: PRIMARY, grants: { tools: { deny: [] } } }]) {
        const r = await upd(args);
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(r.content).toMatch(/cannot lift the deny on dojo_inspect/);
        mod.access.forgetAccessGrants();
        expect(mod.grant.holdsDojoInspect(PRIMARY)).toBe(false);
      }
      const handOn = await upd({ agent_id: WORKER, tools: { allow: ['dojo_inspect'] } });
      expect(handOn.isError).toBe(true);
      expect(handOn.content).toMatch(/cannot grant dojo_inspect/);
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

  it('the owner\'s dashboard grants it to an existing worker', async () => {
    expect(mod.grant.holdsDojoInspect(WORKER)).toBe(false);
    const res = await mod.agentsRouter.request(`/${WORKER}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolsPolicy: { allow: ['dojo_inspect', 'file_read'], deny: [] } }),
    });
    expect(res.status).toBe(200);
    mod.access.forgetAccessGrants();
    expect(mod.grant.holdsDojoInspect(WORKER)).toBe(true);
  });
});
