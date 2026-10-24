// v3.5 inspect C1 — dojo_inspect through the REAL tool door, on a scratch DOJO_HOME (never the
// live box) over the real migration chain.
//
// THE GRANT (a security requirement): the main agent and the Healer hold the tool by default; any
// other agent holds it only when its own tool grant names it; a deny that names it wins for
// everyone. Held at both layers — the advertised list (advice) and the executor (the wall).
//
// THE PROCESS DECLARATION, end to end: a `sql` call by the main agent runs its query in the child
// process and comes back with rows. Without the declared node program AND its carried-programs
// entry, the process door refuses every query.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';
const GRANTED = 'agent-granted';
const DENIED_PRIMARY_HOME = { deny: ['dojo_inspect'] };

let home: string;
let mod: {
  connection: typeof import('../../db/connection.js');
  config: typeof import('../../config/platform.js');
  surface: typeof import('../../agent/tools/surface.js');
  docs: typeof import('../../tools/tool-docs.js');
  tools: typeof import('../../agent/tools/index.js');
  outcome: typeof import('../../agent/tool-outcome.js');
  access: typeof import('../../agent/access/read.js');
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-wire-'));
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
  const connection = await import('../../db/connection.js');
  (await import('../../db/migrations.js')).runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, tools_policy) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(PRIMARY, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', JSON.stringify({ allow: [], deny: ['sms_send'] }));
  add.run(WORKER, 'worker', 'apprentice', null);
  add.run(GRANTED, 'granted', 'apprentice', JSON.stringify({ allow: ['dojo_inspect', 'file_read', 'send_to_agent'], deny: [] }));
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(PRIMARY, HEALER);
  const config = await import('../../config/platform.js');
  config.clearPlatformConfigCache();
  mod = {
    connection, config,
    surface: await import('../../agent/tools/surface.js'),
    docs: await import('../../tools/tool-docs.js'),
    tools: await import('../../agent/tools/index.js'),
    outcome: await import('../../agent/tool-outcome.js'),
    access: await import('../../agent/access/read.js'),
  };
}, 120_000);

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const holds = (agent: string): boolean => mod.surface.getFilteredTools(agent).some((t) => t.name === 'dojo_inspect');
async function call(agent: string, args: Record<string, unknown>) {
  return mod.outcome.toolResultOf(await mod.tools.executeTool(agent, { id: `call-${agent}-${Math.random().toString(36).slice(2)}`, name: 'dojo_inspect', arguments: args }));
}

describe('the grant: the main agent and the Healer by default, anyone else only by explicit grant', () => {
  it('is advertised to the main agent and the Healer, one call away (always loaded)', () => {
    expect(holds(PRIMARY)).toBe(true);
    expect(holds(HEALER)).toBe(true);
    for (const agent of [PRIMARY, HEALER]) {
      const head = mod.docs.partitionToolsForApiCall(agent, mod.surface.getFilteredTools(agent), mod.docs.getAgentAlwaysLoadedTools(agent)).alwaysLoaded;
      expect(head.map((t) => t.name), agent).toContain('dojo_inspect');
    }
  });

  it('is NOT advertised to a worker agent by default, and the executor refuses it if the name is emitted anyway', async () => {
    expect(holds(WORKER)).toBe(false);
    const r = await call(WORKER, { what: 'state' });
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('PERMISSION_DENIED');
    expect(r.content).toMatch(/dojo_inspect is reserved for the main agent and the Healer/);
  });

  it('a worker whose own tool grant names it holds it, at both layers', async () => {
    expect(holds(GRANTED)).toBe(true);
    const r = await call(GRANTED, { what: 'schema', table: 'agents' });
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^agents — /);
  });

  it('a deny that names it wins, even for the main agent', async () => {
    // The grants memo is keyed on the stored grant object; this row has none, so its policy column is read fresh after a forget.
    const setPolicy = (v: string | null): void => { mod.connection.getDb().prepare('UPDATE agents SET tools_policy = ? WHERE id = ?').run(v, PRIMARY); mod.access.forgetAccessGrants(PRIMARY); };
    setPolicy(JSON.stringify(DENIED_PRIMARY_HOME));
    try {
      expect(holds(PRIMARY)).toBe(false);
      expect((await call(PRIMARY, { what: 'state' })).isError).toBe(true);
    } finally {
      setPolicy(null);
    }
    expect(holds(PRIMARY)).toBe(true);
  });
});

describe('the declared node program, end to end', () => {
  it('a sql call by the main agent runs in its child process and answers with rows', async () => {
    const r = await call(PRIMARY, { what: 'sql', query: "select 'inspect-ok' as answer" });
    expect(r.content).not.toMatch(/not authorized for program|Effect refused/);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/^1 row\./);
    expect(r.content).toMatch(/^inspect-ok$/m);
  });

  it('the Healer\'s sql call is served the same way', async () => {
    const r = await call(HEALER, { what: 'sql', query: 'select count(*) as n from agents' });
    expect(r.content).toMatch(/^4$/m);
  });
});
