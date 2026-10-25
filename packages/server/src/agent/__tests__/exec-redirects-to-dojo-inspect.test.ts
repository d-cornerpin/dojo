// v3.5 inspect C2 — THE SHELL SENDS DOJO QUESTIONS TO dojo_inspect.
//
// The owner: "often my main agent reaches for exec shell scripts to try to look at history of
// what happens in its own dojo." Measured on the dev box: hundreds of `exec`/`shell` calls running
// `sqlite3 ~/.dojo/data/dojo.db …` (re-deriving the schema with `pragma table_info` every time)
// and `tail`/`grep` on `~/.dojo/logs/dojo.log`. For an agent that HOLDS dojo_inspect, a shell
// command that reads the Dojo's database or its platform log is refused with the one call that
// answers it, so the habit forms by itself. Driven on a scratch DOJO_HOME, never the live box.
//
// ORCHESTRATOR RULINGS 2026-10-24 (fix rounds 2 and 4): a shell WRITE to the live database is refused
// for every agent except the Healer's repair STATEMENTS (sqlite3 against the live database); a
// file-level write of the database files (rm, mv, cp over, truncate, a redirect) is refused for every
// agent, the Healer included; and a shell READ of it is refused for an agent that does not hold the tool.
// Untouched, each pinned below: any other command or file (another database, a backup, the other
// files under ~/.dojo/logs) and a non-holder's read of the platform log.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

const PRIMARY = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';

// t277: THE ENVIRONMENT AND THE IMPORTS ARE SET UP AT COLLECTION, NOT IN A HOOK. `DOJO_HOME` must be
// in place before the product modules are first loaded (they read it at import), so the home is made
// and the variable stubbed first, then the modules are loaded with top-level awaits. This used to be
// a `beforeAll` with a 120 s bound, which only gave a cold import of ~650 modules a longer timeout;
// collection has no per-test budget at all, and the hook below is left with database setup only.
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-redirect-'));
vi.stubEnv('DOJO_HOME', home);
const imp_connection = await import('../../db/connection.js');
const imp_migrations = await import('../../db/migrations.js');
const imp_platform = await import('../../config/platform.js');
const imp_index = await import('../brokers/index.js');
const imp_index_ = await import('../tools/index.js');
const imp_tool_outcome = await import('../tool-outcome.js');
const imp_assembler = await import('../../prompt/assembler.js');
const imp_home = await import('../../home.js');

let mod: {
  connection: typeof import('../../db/connection.js');
  brokers: typeof import('../brokers/index.js');
  tools: typeof import('../tools/index.js');
  outcome: typeof import('../tool-outcome.js');
  assembler: typeof import('../../prompt/assembler.js');
};

beforeAll(() => {
  const connection = imp_connection;
  imp_migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(PRIMARY, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  add.run(WORKER, 'worker', 'apprentice', null);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(PRIMARY, HEALER);
  imp_platform.clearPlatformConfigCache();
  mod = {
    connection,
    brokers: imp_index,
    tools: imp_index_,
    outcome: imp_tool_outcome,
    assembler: imp_assembler,
  };
  HOME = imp_home.homeDir();
  DB = `${HOME}/.dojo/data/dojo.db`;
});

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
    // The plan's `~/.dojo/data/*.db` form (t267 review, Minor), and a copy of the contents out.
    expect(refusal(PRIMARY, 'shell', 'sqlite3 ~/.dojo/data/*.db "select 1"')).toContain('what="sql"');
    expect(refusal(PRIMARY, 'shell', 'xxd ~/.dojo/data/dojo.db-wal | head')).toContain('what="sql"');
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

  it('an agent that does not hold dojo_inspect keeps its read of the platform log', () => {
    expect(verdict(WORKER, 'shell', 'tail -20 ~/.dojo/logs/dojo.log').allowed).toBe(true);
  });

  it('t267 review: a look at the FILE, not its contents (size, WAL growth, who holds it) — every agent', () => {
    for (const agent of [PRIMARY, HEALER, WORKER]) {
      for (const script of ['ls -la ~/.dojo/data/dojo.db', 'du -sh ~/.dojo/data/dojo.db-wal', 'stat ~/.dojo/data/dojo.db-shm', 'lsof ~/.dojo/data/dojo.db',
        'ls -la ~/.dojo/logs/dojo.log.1', 'wc -c ~/.dojo/logs/dojo.log', 'ls -la ~/.dojo/data/*.db']) {
        expect(verdict(agent, 'shell', script).allowed, `${agent}: ${script}`).toBe(true);
      }
    }
  });

  it('sqlite3 on any other database file, a write included', () => {
    expect(verdict(PRIMARY, 'shell', `sqlite3 ${HOME}/Projects/app.db "UPDATE items SET done = 1 WHERE id = 3"`).allowed).toBe(true);
    expect(verdict(WORKER, 'shell', 'cp ~/.dojo/data/dojo.db.bak /tmp/old.db').allowed).toBe(true);
  });
});

// ORCHESTRATOR RULING (2026-10-24), concerns 1-2 of the first report.
describe('the shell does not write the Dojo\'s own database — except the Healer, the repair agent', () => {
  const WRITE = /^Refused: the shell does not change the Dojo's own database \(dojo\.db and its -wal and -shm files\)\./;
  const REPAIRS = (): string[] => [`sqlite3 ${DB} "UPDATE agents SET model_id = 'auto' WHERE id = 'x'"`, `sqlite3 ${DB} "UPDATE agents SET status = 'terminated' WHERE id = 'x'"`,
    `sqlite3 ${DB} "UPDATE work SET state = 'on_deck', next_run_at = 1725810300000 WHERE id = 'w1'"`, `sqlite3 ${DB} "pragma wal_checkpoint(TRUNCATE)"`];

  it('REVISED RULING (fix round 2): the Healer\'s repairs pass, exactly as before v3.5', () => {
    for (const script of REPAIRS()) expect(verdict(HEALER, 'shell', script).allowed, script).toBe(true);
    expect(verdict(HEALER, 'proc', ['sqlite3', DB, "UPDATE agents SET config = json_set(config, '$.persist', 1) WHERE id = 'x'"]).allowed).toBe(true);
  });

  it('the same writes by the main agent are refused, plainly', () => {
    for (const script of REPAIRS()) expect(refusal(PRIMARY, 'shell', script), script).toMatch(WRITE);
    expect(refusal(PRIMARY, 'proc', ['sqlite3', DB, "INSERT INTO config (key, value) VALUES ('k', 'v')"])).toMatch(WRITE);
  });

  it('a write into the files themselves is refused, for the main agent and a worker alike', () => {
    for (const [agent, script] of [[PRIMARY, 'echo x >> ~/.dojo/data/dojo.db-wal'], [PRIMARY, 'cp /tmp/restore.db ~/.dojo/data/dojo.db'],
      [WORKER, 'mv /tmp/x ~/.dojo/data/dojo.db'], [WORKER, 'rm ~/.dojo/data/dojo.db-shm'], [PRIMARY, `dd if=/dev/zero of=${DB} count=1`],
      [WORKER, 'cat /tmp/x | tee ~/.dojo/data/dojo.db']] as const) {
      expect(refusal(agent, 'shell', script), script).toMatch(WRITE);
    }
  });

  it('fix round 4 RULING: the Healer\'s exemption is its repair statements only — a file-level write of the database files is refused for it too', () => {
    for (const script of ['rm ~/.dojo/data/dojo.db-wal', `rm -f ${DB}-shm`, 'mv /tmp/x ~/.dojo/data/dojo.db', 'cp /tmp/x ~/.dojo/data/dojo.db',
      'truncate -s 0 ~/.dojo/data/dojo.db-wal', 'echo x > ~/.dojo/data/dojo.db', 'echo x >> ~/.dojo/data/dojo.db', `dd if=/dev/zero of=${DB}-wal count=1`,
      `sqlite3 ${DB} ".restore /tmp/old.db"`, `sqlite3 ${DB} "UPDATE agents SET model_id = 'auto' WHERE id = 'x'" && rm ${DB}-wal`,
      // Last minors: sqlite3's own shell-escape and reopen dot-commands beside a repair statement.
      `sqlite3 ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'" ".shell rm ${DB}-wal"`, `sqlite3 -cmd ".shell rm ${DB}-wal" ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'"`,
      `sqlite3 ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'" ".system rm ${DB}-shm"`, `sqlite3 ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'" ".open --new ${DB}"`]) {
      expect(refusal(HEALER, 'shell', script), script).toMatch(WRITE);
    }
    expect(refusal(HEALER, 'proc', ['rm', `${DB}-wal`])).toMatch(WRITE);
  });
});

describe('a shell read of the database by an agent that does not hold dojo_inspect is refused', () => {
  it('names why, plainly, and points at the main agent', () => {
    for (const script of [`sqlite3 ${DB} "select * from google_accounts"`, 'strings ~/.dojo/data/dojo.db | grep token', 'cp ~/.dojo/data/dojo.db /tmp/copy.db']) {
      expect(refusal(WORKER, 'shell', script), script)
        .toBe('Refused: the Dojo\'s own database is not read through the shell: it holds the platform\'s internals and its credentials. Ask the main agent if you need something looked up in it.');
    }
  });

  it('a holder\'s read is still redirected to dojo_inspect, not refused flatly', () => {
    expect(refusal(PRIMARY, 'shell', 'cp ~/.dojo/data/dojo.db /tmp/copy.db')).toContain('dojo_inspect(what="sql"');
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
