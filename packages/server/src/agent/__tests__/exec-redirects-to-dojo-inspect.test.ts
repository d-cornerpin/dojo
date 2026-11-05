// v3.5 inspect C2, REVISED by field fix 3 (Mac-belongs round). OWNER RULING OR-MAC-BELONGS-TO-THE-AGENT
// (2026-10-31, verbatim): "The dojo should be able to save wherever it needs to save and create whatever
// folders it needs to create anywhere on the Mac. Remember, the Mac belongs to the dojo agent. That's the
// point." On his box the main agent was REFUSED a read-only grep of dojo.log and a `sqlite3 -readonly`
// select he asked for. Now a shell READ of the live database or the platform log runs for every agent;
// a WRITE to the live database stays refused (it corrupts the running Dojo), with the Healer's repair
// statements exempt exactly as before. The clauses below that pinned the old refusals are rewritten to
// the ruling; the write and Healer clauses are unchanged apart from the refusal's wording.
//
// FIELD FIX 3 ALLOWLIST (v35-field-fix-3): the door now fails closed. A line that refers to the live
// database file or the Dojo data folder runs only as `sqlite3 [-readonly] [output flags] <literal path>
// '<one quoted read-only SQL>'` (the full shape is in the header of dojo-redirect.ts); anything else that
// refers to them, a look at the file (ls, stat, du, lsof) and a schema dot-command included, is refused
// with one sentence. The clauses below are revised to that; the new table is the-shell-door-is-an-allowlist.test.ts.
//
// (original header follows)
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

const SHAPE = /^Refused: dojo_inspect answers questions about the Dojo's database, and the shell allows only a plain read-only sqlite3 SELECT of it/;

describe('OR-MAC-BELONGS-TO-THE-AGENT: a shell READ of the Dojo\'s own database or log runs, for every agent', () => {
  const OWNER_COMMAND = (): string => `grep -n "error" ~/.dojo/logs/dojo.log | tail -100; sqlite3 -readonly ~/.dojo/data/dojo.db "SELECT value, updated_at FROM config WHERE key='user_presence';"`;

  it('THE RED: the owner\'s exact command (grep on dojo.log, then sqlite3 -readonly select) runs for the main agent', () => {
    const v = verdict(PRIMARY, 'shell', OWNER_COMMAND());
    expect(v.allowed, JSON.stringify(v)).toBe(true);
  });

  it('every read shape runs: queries, schema looks, log tails, a copy out, both doors, every agent', () => {
    // OR-AUDIT-ANSWERS (a) "Keep secrets hidden": a whole-file read (strings, cp, xxd) would carry the
    // credential tables, so only sqlite3 queries and log reads are in this list (see the next clause).
    const reads = [`sqlite3 ~/.dojo/data/dojo.db "select id, title, state from work order by opened_at desc limit 5"`,
      `sqlite3 ${DB} "SELECT content FROM messages WHERE seq=42"`,
      `sqlite3 ~/.dojo/data/dojo.db "pragma table_info(messages)"`,
      'tail -200 ~/.dojo/logs/dojo.log', "grep -i 'error' ~/.dojo/logs/dojo.log | tail -50", `grep -c WATCHDOG ${HOME}/.dojo/logs/dojo.log.1`];
    // Audit round (#3, owner: "the main agent owns the Mac"): the main agent and the Healer.
    for (const agent of [PRIMARY, HEALER]) {
      for (const script of reads) expect(verdict(agent, 'shell', script).allowed, `${agent}: ${script}`).toBe(true);
    }
    expect(verdict(PRIMARY, 'proc', ['sqlite3', '-readonly', DB, 'select count(*) from deliveries']).allowed).toBe(true);
    expect(verdict(WORKER, 'proc', ['tail', '-n', '50', `${HOME}/.dojo/logs/dojo.log`]).allowed).toBe(true);
  });

  it('OR-AUDIT-ANSWERS (a): the main agent\'s sqlite3 -readonly SELECT of a non-credential table runs; one touching a credential table is refused with a fact', () => {
    expect(verdict(PRIMARY, 'shell', `sqlite3 -readonly ${DB} "SELECT key, value FROM config WHERE key='user_presence'"`).allowed).toBe(true);
    expect(verdict(PRIMARY, 'proc', ['sqlite3', '-readonly', DB, 'select id, name from agents']).allowed).toBe(true);
    for (const script of [`sqlite3 -readonly ${DB} "SELECT * FROM google_accounts"`, `sqlite3 -readonly ${DB} "select a.name, c.* from agents a join agent_credentials c on c.agent_id = a.id"`,
      `sqlite3 -readonly ${DB} "select content from vault_entries limit 3"`]) {
      const msg = refusal(PRIMARY, 'shell', script);
      expect(msg, script).toMatch(/^Refused: the statement reaches \w+, which holds credentials/);
    }
    // Allowlist: anything but the one sqlite3 read shape is refused, a whole-file read included.
    for (const script of ['strings ~/.dojo/data/dojo.db | grep -i garden', 'cp ~/.dojo/data/dojo.db /tmp/copy.db', 'xxd ~/.dojo/data/dojo.db-wal | head', `sqlite3 ${DB} .dump`,
      `sqlite3 ~/.dojo/data/dojo.db '.schema work'`, 'sqlite3 ~/.dojo/data/*.db "select 1"']) {
      expect(refusal(PRIMARY, 'shell', script), script).toMatch(SHAPE);
    }
  });

  it('audit round: a WORKER\'s shell read of the live database stays refused, as a plain fact (its log read is unchanged)', () => {
    for (const script of [`sqlite3 ${DB} "select * from google_accounts"`, 'strings ~/.dojo/data/dojo.db | grep token', 'cp ~/.dojo/data/dojo.db /tmp/copy.db']) {
      expect(refusal(WORKER, 'shell', script), script)
        .toBe("Refused: the Dojo's own database is read through the shell by the main agent and the Healer only; it holds the platform's credential tables.");
    }
    expect(verdict(WORKER, 'shell', 'tail -20 ~/.dojo/logs/dojo.log').allowed).toBe(true);
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

  it('t267 review, kept by the allowlist: a look at the FILE, not its contents (size, WAL growth, who holds it), for the main agent and the Healer', () => {
    const looks = ['ls -la ~/.dojo/data/dojo.db', 'du -sh ~/.dojo/data/dojo.db-wal', 'stat ~/.dojo/data/dojo.db-shm', 'lsof ~/.dojo/data/dojo.db', 'wc -c ~/.dojo/data/dojo.db'];
    for (const agent of [PRIMARY, HEALER, WORKER]) {
      for (const script of ['ls -la ~/.dojo/logs/dojo.log.1', 'wc -c ~/.dojo/logs/dojo.log']) {
        expect(verdict(agent, 'shell', script).allowed, `${agent}: ${script}`).toBe(true);
      }
      // A worker is refused any reference to the database file, a look included.
      for (const script of looks) expect(verdict(agent, 'shell', script).allowed, `${agent}: ${script}`).toBe(agent !== WORKER);
      // A glob is not plain words, and a line count reads the contents.
      for (const script of ['ls -la ~/.dojo/data/*.db', 'wc -l ~/.dojo/data/dojo.db']) expect(verdict(agent, 'shell', script).allowed, `${agent}: ${script}`).toBe(false);
    }
  });

  it('sqlite3 on any other database file, a write included', () => {
    expect(verdict(PRIMARY, 'shell', `sqlite3 ${HOME}/Projects/app.db "UPDATE items SET done = 1 WHERE id = 3"`).allowed).toBe(true);
    // A backup outside the data folder is another file; one inside the data folder is refused.
    expect(verdict(WORKER, 'shell', 'cp /tmp/dojo.db.bak /tmp/old.db').allowed).toBe(true);
    expect(verdict(WORKER, 'shell', 'cp ~/.dojo/data/dojo.db.bak /tmp/old.db').allowed).toBe(false);
  });
});

// ORCHESTRATOR RULING (2026-10-24), concerns 1-2 of the first report.
describe('the shell does not write the Dojo\'s own database — except the Healer, the repair agent', () => {
  const WRITE = SHAPE;   // allowlist: a write gets the same one-sentence fact as any other shape
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
      // A worker is refused any reference to the database at all, with its own sentence.
      expect(refusal(agent, 'shell', script), script).toMatch(agent === WORKER ? /^Refused: the Dojo's own database is read through the shell by the main agent and the Healer only/ : WRITE);
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

describe('the standing line', () => {
  // Mac-belongs round: a fact that the tool exists and is read-only and safe, never a ban on the shell.
  const LINE = 'dojo_inspect answers questions about your Dojo (a task, an agent, a turn, the log, the configuration, your own code). It is read-only and safe: it refuses the credential tables and blanks secrets. The shell can read the same database and log.';
  it('is in the Tools guidance of an agent that holds the tool, and absent otherwise', () => {
    expect(mod.assembler.generateToolsGuidance_v2(PRIMARY)).toContain(LINE);
    expect(mod.assembler.generateToolsGuidance_v2(HEALER)).toContain(LINE);
    expect(mod.assembler.generateToolsGuidance_v2(WORKER)).not.toContain('dojo_inspect');
    expect(mod.assembler.generateToolsGuidance_v2(PRIMARY)).not.toMatch(/the shell is for the outside world/);
  });
});
