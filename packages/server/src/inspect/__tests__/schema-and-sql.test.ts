// v3.5 inspect B2 — the schema with its meanings, and a read-only query.
//
// Driven against the REAL connection module on a scratch DOJO_HOME (never the live box), over
// the real migration chain, so `schema` reads the notes the migrations actually carry and `sql`
// runs on the real read-only connection.
//
// REVIEW FOCUS 1: a long SELECT over 100K messages returns whole (the tool layer keeps it and
//   shows the head and a pointer) and does NOT hold the engine's writer: a worker thread writes
//   to the same file while the query runs, and every one of its writes lands inside the busy
//   timeout.
// REVIEW FOCUS 2: no token-shaped string leaves any output, whether the credential is read
//   from its own table, from an allowed table's credential column, or was pasted into an
//   allowed table's text.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { toolResultView } from '../../memory/tool-result-view.js';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const ACCESS = 'ya29.synthetic-google-access-value-0001';
const APPROVAL = 'approval-synthetic-value-0002';
const PASTED = `ghp_${'Zq9'.repeat(12)}`;
const ROWS = 100_000;

let home: string;
let main: Database.Database;
let mod: {
  connection: typeof import('../../db/connection.js');
  schema: typeof import('../schema.js').schema;
  sql: typeof import('../sql.js').sql;
};

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-sql-'));
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
  const connection = await import('../../db/connection.js');
  const { runMigrations } = await import('../../db/migrations.js');
  runMigrations();
  main = connection.getDb();
  main.prepare("INSERT INTO agents (id, name) VALUES ('agent-primary', 'primary')").run();
  main.prepare("INSERT INTO google_accounts (id, kind, position, email, access_token, refresh_token) VALUES ('g1', 'user', 0, 'owner@example.invalid', ?, 'r-synthetic-value-0003')").run(ACCESS);
  main.prepare("INSERT INTO destructive_approvals (token, agent_id, tool_name, signature, request_text) VALUES (?, 'agent-primary', 'file_delete', 'sig', 'delete one file')").run(APPROVAL);
  const ins = main.prepare("INSERT INTO messages (id, agent_id, role, content, created_at, sent_at) VALUES (?, 'agent-primary', 'assistant', ?, ?, ?)");
  main.transaction(() => {
    for (let i = 0; i < ROWS; i++) ins.run(`m-${i}`, i === 7 ? `the key is ${PASTED}` : `row ${i}`, 1792651631000 + i, 1792651631000 + i);
  })();
  mod = { connection, schema: (await import('../schema.js')).schema, sql: (await import('../sql.js')).sql };
}, 120_000);

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('schema', () => {
  it('lists every table with its row count and the meaning its migration gives it', () => {
    const out = mod.schema({});
    expect(out).toMatch(/^kept_tool_results \(0 rows\) — Now the stored `tool` row carries what the agent sees .* and THIS table carries the whole, which `tool_result_read` reads by line range or search\.$/m);
    expect(out).toMatch(/^agent_tool_outcomes \(0 rows\) — This table is the per-\(agent, tool\) truth, written on every tool result\.$/m);
    // Fix round 1: no migration describes `work` in a whole sentence, so it says so instead of quoting a heading.
    expect(out).toMatch(/^work \(0 rows\) — \(no description\)$/m);
    expect(out).toMatch(new RegExp(`^messages \\(${ROWS.toLocaleString('en-US')} rows\\)`, 'm'));
    expect(out).toMatch(/^google_accounts — not readable through dojo_inspect/m);
  });

  it('fix round 1: a meaning is a whole sentence about the table, or "(no description)" — never a cut heading', () => {
    const out = mod.schema({});
    for (const t of ['messages', 'turns', 'agents', 'audit_log', 'deliveries']) {
      const line = out.split('\n').find((l) => l.startsWith(`${t} (`)) ?? '';
      const meaning = line.replace(/^[^—]*— /, '');
      expect(meaning === '(no description)' || /[.!?]$/.test(meaning), `${t}: ${meaning}`).toBe(true);
    }
    // An inline label on the CREATE TABLE line is the author's own, whole, and is kept as written.
    expect(out).toMatch(/^work_events \(0 rows\) — absorbs task_log, poke_log, override requests$/m);
    expect(out).not.toContain('the old message system leaves the');
    expect(out).not.toContain('TWO WORDS THAT NAME EVENTS THAT');
    expect(out).toMatch(/^messages \([\d,]+ rows\) — \(no description\)$/m);
    expect(out).toMatch(/^turns \(0 rows\) — \(no description\)$/m);
  });

  it('lists a table\'s columns with type, nullability and the meaning, or "(no description)"', () => {
    const kept = mod.schema({ table: 'kept_tool_results' });
    expect(kept).toMatch(/message_id\s+TEXT NOT NULL PRIMARY KEY\s+the `tool` row that shows the pointer\. Its foreign key is the lifetime rule/);
    expect(kept).toMatch(/content\s+TEXT NOT NULL\s+the whole result, after credential redaction/);
    const work = mod.schema({ table: 'work' });
    expect(work).toMatch(/intent\s+TEXT NOT NULL\s+no default: the writer must say\. The old `FYI` default silently killed wake-needing work\./);
    expect(work).toMatch(/wakes\s+INTEGER NOT NULL\s+INDEPENDENT columns: conflating them stalled multi-step workflows \(v2\.5\.32\)/);
    expect(work).toMatch(/remaining_children\s+INTEGER\s+fan-out countdown \(atomic decrement\)/);
    expect(work).toMatch(/\(no description\)/);
    expect(mod.schema({ table: 'destructive_approvals' })).toMatch(/token\s+TEXT.*credential: not readable through dojo_inspect/);
    expect(mod.schema({ table: 'nope' })).toMatch(/No table named nope/);
  });
});

describe('sql', () => {
  it('runs a read and renders an aligned table with a header and the row count', async () => {
    const out = await mod.sql({ query: "select id, role, content from messages where id in ('m-1', 'm-2') order by id" });
    expect(out).toMatch(/^id {2}role {6}content$/m);
    expect(out).toMatch(/^m-1 assistant row 1$/m);
    expect(out).toMatch(/2 rows\./);
  });

  it('refuses a write with the sentence, before it reaches the connection — and the connection refuses it again', async () => {
    for (const q of ['update work set title = 1', "delete from messages where id = 'm-1'", 'drop table work', "with x as (select 1) delete from messages where id = 'm-1'", 'pragma query_only = 0', "vacuum into '/tmp/x.db'"]) {
      expect(await mod.sql({ query: q }), q).toMatch(/^Refused: only a read runs here/);
    }
    expect(main.prepare("SELECT count(*) FROM messages WHERE id = 'm-1'").pluck().get()).toBe(1);
    expect(() => mod.connection.getReadOnlyDb().prepare("DELETE FROM messages WHERE id = 'm-1'").run()).toThrow(/read-only connection/);
  });

  it('allows EXPLAIN, and the extension loader is not reachable', async () => {
    expect(await mod.sql({ query: "explain query plan select * from messages where id = 'm-1'" })).toMatch(/rows?\./);
    expect(await mod.sql({ query: "select load_extension('x')" })).toMatch(/SQLite (refused the statement|stopped the query): not authorized/);
  });

  it('REVIEW FOCUS 2: no credential leaves, however the statement reaches for it', async () => {
    const outs = await Promise.all([
      'select * from google_accounts',
      "select m.id, g.access_token from messages m join google_accounts g on 1 where m.id = 'm-7'",
      'select * from destructive_approvals',
      "select m.id, d.token from messages m join destructive_approvals d on 1 where m.id = 'm-7'",
      "select content from messages where id = 'm-7'",
      "select content as note from messages where id = 'm-7'",
      // Fix round 1: the reviewer's probes, verbatim, and the alias that used to defeat the blanking.
      "select access_token as a, refresh_token as b, 1 as explain from 'google_accounts'",
      'select token as t, 0 as explain from destructive_approvals',
      "select rawtok as x from (select access_token as rawtok from 'google_accounts') t, (select 1 as explain) e",
      'explain select token from destructive_approvals',
    ].map((query) => mod.sql({ query })));
    expect(outs[0]).toMatch(/Refused: the statement reaches google_accounts/);
    expect(outs[2]).toMatch(/Refused: the statement reads destructive_approvals\.token/);
    expect(outs[4]).toContain('<redacted-credential>');
    for (const out of outs) for (const secret of [ACCESS, APPROVAL, PASTED, 'r-synthetic-value-0003']) expect(out).not.toContain(secret);
    for (const out of outs.slice(6)) expect(out).toMatch(/^Refused/);
    expect(await mod.sql({ query: 'select agent_id, tool_name, status from destructive_approvals' })).toMatch(/1 row\./);
  });

  it('REVIEW FOCUS 1: 100K rows come back whole, the view shows the head and a pointer, and the writer is never held', async () => {
    const file = mod.connection.getDbPath();
    const sqlitePath = createRequire(import.meta.url).resolve('better-sqlite3');
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.sqlitePath);
      const db = new Database(workerData.file);
      db.pragma('busy_timeout = 10000');
      const ins = db.prepare("INSERT INTO config (key, value) VALUES (?, 'w')");
      const writes = []; let n = 0; let stop = false;
      parentPort.on('message', () => { stop = true; });
      const tick = () => {
        if (stop) { db.close(); parentPort.postMessage(writes); return; }
        const t0 = Date.now(); ins.run('probe-' + (n++)); writes.push([t0, Date.now() - t0]);
        if (n === 1) parentPort.postMessage('ready');
        setImmediate(tick);
      };
      tick();`, { eval: true, workerData: { file, sqlitePath } });
    await new Promise<void>((resolve) => worker.once('message', () => resolve()));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const t0 = Date.now();
    const out = await mod.sql({ query: 'select id, content, created_at from messages order by seq' });
    const t1 = Date.now();
    clearInterval(timer);
    // Fix round 1: the engine's own thread kept running while the query ran.
    expect(ticks).toBeGreaterThan(0);
    const writes = await new Promise<Array<[number, number]>>((resolve) => { worker.once('message', resolve); worker.postMessage('stop'); });
    await worker.terminate();

    expect(out).toContain(`${ROWS.toLocaleString('en-US')} rows.`);
    expect(out).toMatch(/^m-99999 /m);
    const during = writes.filter(([start]) => start >= t0 && start <= t1);
    expect(during.length).toBeGreaterThan(0);
    expect(Math.max(...writes.map(([, ms]) => ms))).toBeLessThan(2000);

    const view = toolResultView(out, 'call-inspect-1');
    expect(view.length).toBeLessThan(out.length);
    expect(view).toContain('KEPT WHOLE, NOT ALL SHOWN');
    expect(view).toContain('tool_result_read({"id":"call-inspect-1"');
    expect(view.startsWith(out.slice(0, 200))).toBe(true);
  }, 120_000);

  it('fix round 1 (B2-CRITICAL): a runaway query does not hold the engine thread, and the stop button ends it', async () => {
    const { abortInFlight } = await import('../../agent/shared-state.js');
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    const run = mod.sql({ query: 'with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c' }, { agentId: 'agent-sql-stop' });
    await new Promise((r) => setTimeout(r, 300));
    const during = ticks;
    abortInFlight('agent-sql-stop', 'user-stop', { scope: 'all' });
    const out = await run;
    clearInterval(timer);
    expect(during).toBeGreaterThan(10);
    expect(out).toMatch(/^Stopped: you pressed stop/);
  }, 60_000);
});
