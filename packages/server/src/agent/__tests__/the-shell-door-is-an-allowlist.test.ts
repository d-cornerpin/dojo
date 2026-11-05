// ════════════════════════════════════════════════════════════════════════════════════════
// THE SHELL DOOR ON THE DOJO'S DATABASE IS AN ALLOWLIST (field fix 3, v35-field-fix-3).
//
// The owner's rulings: the main agent may read the Dojo's own database and log from the shell;
// password and credential data stays hidden from every agent, the main agent included; helper
// agents keep their limits. A reviewer showed that spotting credential reads inside arbitrary
// shell text cannot be complete, so the door fails closed: a line that refers to the live
// database file or the Dojo data folder runs only in ONE exact shape (sqlite3, the literal path,
// known output flags, one quoted SQL argument of read-only statements that each pass
// refuseDeniedSql). Every other such line is refused. The Healer's fixed repair statements keep
// working, alone on their line.
//
// Each row is a command string and the verdict `redirectDojoQuestion` must return for it. The
// refused shapes are named structurally; nothing here is executed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HEALER = 'agent-healer';
const WORKER = 'agent-worker';

const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'shell-door-allowlist-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../db/connection.js');
const migrations = await import('../../db/migrations.js');
const platform = await import('../../config/platform.js');
const door = await import('../brokers/dojo-redirect.js');
const brokers = await import('../brokers/index.js');

const ABS = `${home}/.dojo/data/dojo.db`;
const DB = '~/.dojo/data/dojo.db';
const LOG = '~/.dojo/logs/dojo.log';

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, ?, 'idle', '{}', ?, ?)");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HEALER, 'healer', 'sensei', JSON.stringify({ exec_allow: ['*'], exec_deny: [], file_read: '*', file_write: '*', file_delete: 'none', network_domains: '*', max_processes: 5, can_spawn_agents: false, can_assign_permissions: false, system_control: [] }));
  add.run(WORKER, 'worker', 'apprentice', null);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?), ('healer_agent_id', ?)").run(MAIN, HEALER);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

type Want = 'allow' | 'refuse';
interface Row { who: string; line: string; want: Want; why: string }

const ALLOWED: Row[] = [
  // ── positive controls (the owner's own commands) ──
  { who: MAIN, line: `sqlite3 -readonly ${DB} "select key, value from config where key like '%presence%';"`, want: 'allow', why: 'the owner\'s read-only select of a non-credential table' },
  { who: MAIN, line: `grep -n "error" ${LOG} | tail -100`, want: 'allow', why: 'a plain grep on the Dojo log' },
  { who: MAIN, line: `tail -200 ${LOG}`, want: 'allow', why: 'a plain tail on the Dojo log' },
  // ── the same shape, varied only within the allowlist ──
  { who: MAIN, line: `sqlite3 -readonly -header -csv ${ABS} "SELECT id, title FROM work LIMIT 5"`, want: 'allow', why: 'the absolute literal path with known output flags' },
  { who: MAIN, line: `sqlite3 ${DB} 'pragma table_info(messages)'`, want: 'allow', why: 'a schema pragma from the read-only list, single-quoted' },
  { who: MAIN, line: `sqlite3 -readonly ${DB} "with t as (select id from agents) select count(*) from t"`, want: 'allow', why: 'WITH ... SELECT' },
  { who: MAIN, line: `sqlite3 -readonly -json ${DB} "select 1; select count(*) from messages;"`, want: 'allow', why: 'two statements, each read-only and passing the credential check' },
  { who: MAIN, line: `sqlite3 -readonly ${DB} "select id from agents" | head -5`, want: 'allow', why: 'the output piped onward to a command that does not refer to the database' },
  { who: MAIN, line: `grep -n "error" ${LOG} | tail -100; sqlite3 -readonly ${DB} "SELECT value, updated_at FROM config WHERE key='user_presence';"`, want: 'allow', why: 'a log read then the allowed select, on one line' },
  { who: HEALER, line: `sqlite3 -readonly ${DB} "select id, status from agents"`, want: 'allow', why: 'the Healer reads the same way' },
  { who: WORKER, line: `tail -20 ${LOG}`, want: 'allow', why: 'a worker keeps its read of the platform log' },
  { who: MAIN, line: 'ls ~/Documents', want: 'allow', why: 'a line that refers to neither the database nor the data folder' },
  { who: MAIN, line: `sqlite3 ${home}/Projects/app.db "UPDATE items SET done = 1 WHERE id = 3"`, want: 'allow', why: 'another database file, a write included' },
];

const REFUSED: Row[] = [
  // ── SQL arriving any way other than a single quoted argument ──
  { who: MAIN, line: `echo "select 1" | sqlite3 ${DB}`, want: 'refuse', why: 'SQL on stdin through a pipe' },
  { who: MAIN, line: `sqlite3 ${DB} < /tmp/q.sql`, want: 'refuse', why: 'SQL from a redirect' },
  { who: MAIN, line: `sqlite3 ${DB} <<EOF\nselect 1;\nEOF`, want: 'refuse', why: 'SQL from a here-doc' },
  { who: MAIN, line: `sqlite3 -cmd "select 1" ${DB} "select 1"`, want: 'refuse', why: 'an option flag that carries SQL' },
  { who: MAIN, line: `sqlite3 -init /tmp/q.sql ${DB} "select 1"`, want: 'refuse', why: 'an option flag that names a file of commands' },
  { who: MAIN, line: `sqlite3 ${DB} ".tables"`, want: 'refuse', why: 'a dot-command' },
  { who: MAIN, line: `sqlite3 ${DB} ".dump"`, want: 'refuse', why: 'a dot-command' },
  { who: MAIN, line: `sqlite3 ${DB} select 1`, want: 'refuse', why: 'SQL as unquoted words' },
  { who: MAIN, line: `sqlite3 ${DB} "select 1" "select 2"`, want: 'refuse', why: 'more than one SQL argument' },
  { who: MAIN, line: `sqlite3 ${DB}`, want: 'refuse', why: 'no SQL argument (an interactive shell)' },
  { who: MAIN, line: `sqlite3 ${DB} "select $(cat /tmp/q)"`, want: 'refuse', why: 'a double-quoted argument the shell expands' },
  // ── the database path given indirectly ──
  { who: MAIN, line: `D=~/.dojo/data; sqlite3 $D/dojo.db "select 1"`, want: 'refuse', why: 'the path through a variable' },
  { who: MAIN, line: `sqlite3 "$HOME/.dojo/data/dojo.db" "select 1"`, want: 'refuse', why: 'the path through an environment variable' },
  { who: MAIN, line: 'sqlite3 ~/.dojo/data/*.db "select 1"', want: 'refuse', why: 'the path through a glob' },
  { who: MAIN, line: 'cd ~/.dojo/data && sqlite3 dojo.db "select 1"', want: 'refuse', why: 'a relative path' },
  { who: MAIN, line: 'sqlite3 ~/.dojo/logs/../data/dojo.db "select 1"', want: 'refuse', why: 'a path that is not the literal one' },
  { who: MAIN, line: `timeout 10 sqlite3 ${DB} "select 1"`, want: 'refuse', why: 'sqlite3 behind a launcher, not the exact shape' },
  { who: MAIN, line: `sqlite3 -readonly ${DB}-wal "select 1"`, want: 'refuse', why: 'a sibling file, not the database path' },
  // ── a SELECT naming a credential table ──
  { who: MAIN, line: `sqlite3 -readonly ${DB} "SELECT * FROM google_accounts"`, want: 'refuse', why: 'a credential table' },
  { who: MAIN, line: `sqlite3 -readonly ${DB} "select a.name, c.* from agents a join agent_credentials c on c.agent_id = a.id"`, want: 'refuse', why: 'a credential table in a join' },
  // ── more than one statement where any one fails ──
  { who: MAIN, line: `sqlite3 -readonly ${DB} "select 1; select * from agent_credentials"`, want: 'refuse', why: 'the second statement names a credential table' },
  { who: MAIN, line: `sqlite3 ${DB} "select 1; delete from messages"`, want: 'refuse', why: 'the second statement writes' },
  { who: MAIN, line: `sqlite3 ${DB} "select ';'; delete from messages"`, want: 'refuse', why: 'a semicolon inside a literal does not hide the second statement' },
  // ── a write statement ──
  { who: MAIN, line: `sqlite3 ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'"`, want: 'refuse', why: 'an UPDATE by the main agent' },
  { who: MAIN, line: `sqlite3 ${DB} "INSERT INTO config (key, value) VALUES ('k', 'v')"`, want: 'refuse', why: 'an INSERT' },
  { who: MAIN, line: `sqlite3 ${DB} "with x as (select 1) delete from messages"`, want: 'refuse', why: 'WITH that ends in a write' },
  { who: MAIN, line: `sqlite3 ${DB} "attach '/tmp/x.db' as x"`, want: 'refuse', why: 'not a SELECT' },
  { who: MAIN, line: `sqlite3 ${DB} "vacuum into '/tmp/c.db'"`, want: 'refuse', why: 'not a SELECT' },
  { who: MAIN, line: `sqlite3 ${DB} "pragma query_only = 0"`, want: 'refuse', why: 'a pragma outside the read-only list' },
  // ── a file-level command, a folder copy or archive ──
  { who: MAIN, line: `cp ${DB} /tmp/c.db`, want: 'refuse', why: 'a file copy of the database' },
  { who: MAIN, line: 'cp -r ~/.dojo/data /tmp/d', want: 'refuse', why: 'a whole-folder copy' },
  { who: MAIN, line: 'tar czf /tmp/d.tgz ~/.dojo/data', want: 'refuse', why: 'a whole-folder archive' },
  { who: MAIN, line: 'zip -r /tmp/d.zip ~/.dojo', want: 'refuse', why: 'an archive of the Dojo folder' },
  { who: MAIN, line: `strings ${DB} | head`, want: 'refuse', why: 'a whole-file read' },
  { who: MAIN, line: `ls -la ${DB}`, want: 'refuse', why: 'any other command that refers to the database file' },
  { who: MAIN, line: `rm ${DB}-wal`, want: 'refuse', why: 'a file-level write' },
  { who: MAIN, line: `echo x >> ${DB}`, want: 'refuse', why: 'a redirect into the file' },
  { who: MAIN, line: `bash -c 'sqlite3 ${DB} "select 1"'`, want: 'refuse', why: 'sqlite3 inside a shell string, not the exact shape' },
  // ── a worker agent's read ──
  { who: WORKER, line: `sqlite3 -readonly ${DB} "select id from agents"`, want: 'refuse', why: 'a worker is refused any reference to the database file' },
  { who: WORKER, line: `ls -la ${DB}`, want: 'refuse', why: 'a worker is refused any reference to the database file' },
  // ── the Healer: its fixed repairs only, alone on the line ──
  { who: HEALER, line: `sqlite3 ${DB} "UPDATE agents SET status = 'idle' WHERE id = 'x'; select 1"`, want: 'refuse', why: 'a repair line holds only the one statement' },
  { who: HEALER, line: `sqlite3 ${DB} "DELETE FROM messages"`, want: 'refuse', why: 'not one of the fixed repairs' },
  { who: HEALER, line: `sqlite3 ${DB} "UPDATE agent_credentials SET agent_id = 'x' WHERE id = 'y'"`, want: 'refuse', why: 'not one of the fixed repairs, and a credential table' },
  { who: HEALER, line: `sqlite3 ${DB} ".restore /tmp/old.db"`, want: 'refuse', why: 'a dot-command' },
  { who: HEALER, line: `rm ${DB}-wal`, want: 'refuse', why: 'a file-level write is not a repair' },
  { who: HEALER, line: 'cp -r ~/.dojo/data /tmp/d', want: 'refuse', why: 'a whole-folder copy' },
];

const REPAIRS: Row[] = [
  `sqlite3 ${DB} "UPDATE agents SET model_id = 'auto' WHERE id = 'x';"`,
  `sqlite3 ${DB} "UPDATE agents SET config = json_set(config, '$.persist', 0) WHERE id = 'x';"`,
  `sqlite3 ${DB} "UPDATE agents SET status = 'terminated' WHERE id = 'x';"`,
  `sqlite3 ${DB} "UPDATE work SET next_run_at = 1725810300000, schedule_status = NULL WHERE id = 'w1';"`,
  `sqlite3 ${DB} "UPDATE work SET state = 'on_deck', next_run_at = 1725810300000 WHERE id = 'w1'"`,
  `sqlite3 ${DB} "UPDATE config SET value = 'v', updated_at = datetime('now') WHERE key = 'k';"`,
  `sqlite3 ${DB} 'PRAGMA wal_checkpoint(TRUNCATE);'`,
].map((line) => ({ who: HEALER, line, want: 'allow' as Want, why: 'one of the Healer\'s fixed repairs' }));

const verdictOf = (who: string, line: string): Want => (door.redirectDojoQuestion(who, line) ? 'refuse' : 'allow');

describe('the shell door on the Dojo database: an allowlist', () => {
  it.each([...ALLOWED, ...REPAIRS, ...REFUSED])('$who: $line', ({ who, line, want, why }) => {
    expect(verdictOf(who, line), why).toBe(want);
  });

  it('the same repairs by the main agent are refused', () => {
    for (const r of REPAIRS) expect(verdictOf(MAIN, r.line), r.line).toBe('refuse');
  });

  it('a credential refusal names the table; any other refusal is the one-sentence fact', () => {
    const credential = door.redirectDojoQuestion(MAIN, `sqlite3 -readonly ${DB} "SELECT * FROM google_accounts"`);
    expect(credential && !credential.allowed ? credential.blockedMessage : '').toMatch(/^Refused: the statement reaches google_accounts, which holds credentials/);
    const other = door.redirectDojoQuestion(MAIN, 'cp -r ~/.dojo/data /tmp/d');
    expect(other && !other.allowed ? other.blockedMessage : '').toMatch(/^Refused: dojo_inspect answers .*only a plain read-only sqlite3 SELECT/);
  });

  it('the argv door gets the same verdicts', () => {
    const run = (who: string, argv: string[]): Want => (brokers.authorizeExecShapedCall(brokers.grantFor(who), 'proc', argv).allowed ? 'allow' : 'refuse');
    expect(run(MAIN, ['sqlite3', '-readonly', ABS, 'select count(*) from deliveries'])).toBe('allow');
    expect(run(HEALER, ['sqlite3', ABS, "UPDATE agents SET config = json_set(config, '$.persist', 1) WHERE id = 'x'"])).toBe('allow');
    expect(run(MAIN, ['sqlite3', ABS])).toBe('refuse');
    expect(run(MAIN, ['sqlite3', ABS, '.dump'])).toBe('refuse');
    expect(run(MAIN, ['sqlite3', '-cmd', 'select 1', ABS, 'select 1'])).toBe('refuse');
    expect(run(MAIN, ['sqlite3', ABS, 'select * from vault_entries'])).toBe('refuse');
    expect(run(MAIN, ['cp', '-r', `${home}/.dojo/data`, '/tmp/d'])).toBe('refuse');
    expect(run(WORKER, ['sqlite3', '-readonly', ABS, 'select 1'])).toBe('refuse');
  });
});
