// v3.5 inspect C2 — THE SHELL SENDS DOJO QUESTIONS TO dojo_inspect.
//
// The owner: "often my main agent reaches for exec shell scripts to try to look at history of
// what happens in its own dojo." Measured on the dev box: hundreds of `exec`/`shell` calls running
// `sqlite3 ~/.dojo/data/dojo.db …` (re-deriving the schema with `pragma table_info` every time)
// and `tail`/`grep` on `~/.dojo/logs/dojo.log`. For an agent that HOLDS dojo_inspect, a shell
// command that reads the Dojo's database or its platform log is refused with the one call that
// answers it, so the habit forms by itself. Driven on a scratch DOJO_HOME, never the live box.
//
// What it does NOT touch, each pinned below: any other command; other files under ~/.dojo/logs
// (dojo_inspect does not read them, so refusing would remove a capability); a write statement
// (not a question — handed up, unchanged); and an agent that does not hold the tool (pointing it
// at a tool it cannot call would be a dead end — handed up, unchanged).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';

let home: string;
let mod: {
  connection: typeof import('../../db/connection.js');
  brokers: typeof import('../brokers/index.js');
  tools: typeof import('../tools/index.js');
  outcome: typeof import('../tool-outcome.js');
  assembler: typeof import('../../prompt/assembler.js');
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-redirect-'));
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
  const connection = await import('../../db/connection.js');
  (await import('../../db/migrations.js')).runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(PRIMARY, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  add.run(WORKER, 'worker', 'apprentice', null);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(PRIMARY, HEALER);
  (await import('../../config/platform.js')).clearPlatformConfigCache();
  mod = {
    connection,
    brokers: await import('../brokers/index.js'),
    tools: await import('../tools/index.js'),
    outcome: await import('../tool-outcome.js'),
    assembler: await import('../../prompt/assembler.js'),
  };
  HOME = (await import('../../home.js')).homeDir();
  DB = `${HOME}/.dojo/data/dojo.db`;
}, 120_000);

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

// The platform's own home (DOJO_HOME here), the one the brokers expand `~` to.
let HOME = '';
let DB = '';
const verdict = (agent: string, door: 'proc' | 'shell', raw: unknown) => mod.brokers.authorizeExecShapedCall(mod.brokers.grantFor(agent), door, raw);
function refusal(agent: string, door: 'proc' | 'shell', raw: unknown): string {
  const v = verdict(agent, door, raw);
  expect(v.allowed, `${JSON.stringify(raw)} was not refused`).toBe(false);
  return v.allowed ? '' : (v.blockedMessage ?? '');
}

describe('a Dojo question asked of the shell is refused with the dojo_inspect call that answers it', () => {
  it('a query on the database names the sql view', () => {
    for (const script of [`sqlite3 ~/.dojo/data/dojo.db "select id, title, state from work order by opened_at desc limit 5"`,
      `sqlite3 ${DB} "SELECT content FROM messages WHERE seq=42"`, `strings ~/.dojo/data/dojo.db | grep -i garden`]) {
      const msg = refusal(PRIMARY, 'shell', script);
      expect(msg).toMatch(/^Refused: the Dojo's database and logs are read through dojo_inspect, not the shell\./);
      expect(msg).toContain('dojo_inspect(what="sql", query="…")');
      expect(msg).toContain('Call load_tool_docs("dojo_inspect") for the arguments.');
    }
    // The argv door too, and the Healer as well as the main agent.
    expect(refusal(HEALER, 'proc', ['sqlite3', DB, 'select count(*) from deliveries'])).toContain('what="sql"');
  });

  it('a look at the schema names the schema view', () => {
    for (const script of [`sqlite3 ~/.dojo/data/dojo.db "pragma table_info(messages)"`, `sqlite3 ~/.dojo/data/dojo.db '.schema work'`,
      `sqlite3 $HOME/.dojo/data/dojo.db .tables`, `sqlite3 ${DB} "select name from pragma_table_info('turns')"`]) {
      expect(refusal(PRIMARY, 'shell', script), script).toContain('dojo_inspect(what="schema", table="…")');
    }
  });

  it('a read of the platform log names the logs view', () => {
    for (const script of ['tail -200 ~/.dojo/logs/dojo.log', "grep -i 'error' ~/.dojo/logs/dojo.log | tail -50", `grep -c WATCHDOG ${HOME}/.dojo/logs/dojo.log.1`]) {
      expect(refusal(PRIMARY, 'shell', script), script).toContain('dojo_inspect(what="logs", pattern="…")');
    }
    expect(refusal(PRIMARY, 'proc', ['tail', '-n', '50', `${HOME}/.dojo/logs/dojo.log`])).toContain('what="logs"');
  });

  it('through the real tool door: refused before anything runs, as a permission refusal', async () => {
    const r = mod.outcome.toolResultOf(await mod.tools.executeTool(PRIMARY, { id: 'call-redirect-1', name: 'shell', arguments: { script: `sqlite3 ${DB} "pragma table_info(messages)"` } }));
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('PERMISSION_DENIED');
    expect(r.content).toMatch(/^Refused: the Dojo's database and logs are read through dojo_inspect/);
  });
});

describe('what the redirect leaves exactly as it was', () => {
  it('an unrelated command', () => {
    expect(verdict(PRIMARY, 'shell', 'ls ~/Documents').allowed).toBe(true);
    expect(verdict(PRIMARY, 'proc', ['ls', `${HOME}/Documents`]).allowed).toBe(true);
  });

  it('another file under ~/.dojo/logs, which dojo_inspect does not read', () => {
    expect(verdict(PRIMARY, 'shell', 'wc -l ~/.dojo/logs/assembly-validation.jsonl').allowed).toBe(true);
  });

  it('a write statement: it is not a question (handed up, unchanged)', () => {
    expect(verdict(HEALER, 'shell', `sqlite3 ${DB} "UPDATE agents SET model_id = 'auto' WHERE id = 'x'"`).allowed).toBe(true);
  });

  it('an agent that does not hold dojo_inspect is not pointed at it (handed up, unchanged)', () => {
    expect(verdict(WORKER, 'shell', 'tail -20 ~/.dojo/logs/dojo.log').allowed).toBe(true);
  });
});

describe('the standing line', () => {
  const LINE = 'To learn what happened in your Dojo — a task, an agent, a turn, the log, the configuration, your own code — use dojo_inspect first; the shell is for the outside world.';
  it('is in the Tools guidance of an agent that holds the tool, and absent otherwise', () => {
    expect(mod.assembler.generateToolsGuidance_v2(PRIMARY)).toContain(LINE);
    expect(mod.assembler.generateToolsGuidance_v2(HEALER)).toContain(LINE);
    expect(mod.assembler.generateToolsGuidance_v2(WORKER)).not.toContain('dojo_inspect');
  });
});
