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
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

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
  readInChild: typeof import('../sql-child.js').readInChild;
  turnState: typeof import('../../agent/turn-state.js');
  cap: typeof import('../../agent/effects/capability.js');
  runtime: typeof import('../../agent/runtime.js');
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
  mod = {
    connection, schema: (await import('../schema.js')).schema, sql: (await import('../sql.js')).sql,
    readInChild: (await import('../sql-child.js')).readInChild,
    turnState: await import('../../agent/turn-state.js'), cap: await import('../../agent/effects/capability.js'),
    runtime: await import('../../agent/runtime.js'),
  };
}, 120_000);

afterAll(() => {
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const AGENT = 'agent-sql-test';
/** Inside a dojo_inspect call whose capability names the node executable, as Part C will declare. */
function asInspect<T>(body: () => Promise<T>, agent = AGENT): Promise<T> {
  return mod.turnState.runWithToolCallId(agent, `call-${agent}`, async () => {
    mod.cap.attachCallCapability(mod.cap.mintCallCapability({
      agentId: agent, tool: 'dojo_inspect', callId: `call-${agent}`,
      grants: [{ kind: 'proc', program: process.execPath, display: 'node' }],
    }));
    return body();
  });
}
const q = (query: string, agent?: string): Promise<string> => asInspect(() => mod.sql({ query }), agent);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('schema', () => {
  it('lists every table with its row count and the meaning its migration gives it', () => {
    const out = mod.schema({});
    expect(out).toMatch(/^kept_tool_results \(0 rows\) — Now the stored `tool` row carries what the agent sees .* and THIS table carries the whole, which `tool_result_read` reads by line range or search\.$/m);
    expect(out).toMatch(/^agent_tool_outcomes \(0 rows\) — This table is the per-\(agent, tool\) truth, written on every tool result\.$/m);
    // Part C (t267): no migration describes `work` in a whole sentence, so its meaning is hand-written (`table-notes.ts`).
    expect(out).toMatch(/^work \(0 rows\) — The tracker: every request, task, project, commitment and run of a recurring job is one row \(kind\)/m);
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
    // Part C (t267): the ten-odd tables an agent queries most carry a hand-written meaning, which wins
    // over a migration's label ("absorbs task_log, poke_log, override requests" said what it replaced).
    expect(out).toMatch(/^work_events \(0 rows\) — The history of each tracker row/m);
    expect(out).not.toContain('the old message system leaves the');
    expect(out).not.toContain('TWO WORDS THAT NAME EVENTS THAT');
    expect(out).toMatch(/^messages \([\d,]+ rows\) — Every message of every agent's conversation, in order \(seq\)/m);
    expect(out).toMatch(/^turns \(0 rows\) — One row per agent turn/m);
    // Fix round 2: whole sentences that do not say what the table holds are not meanings.
    expect(out).toMatch(/^destructive_approvals \(1 row\) — \(no description\)$/m);
    expect(out).toMatch(/^dojo_reports \(0 rows\) — \(no description\)$/m);
    expect(out).toMatch(/^tool_receipts \(0 rows\) — The engine's proof that a send happened/m);
  });

  it('Part C (t267): the most-queried tables carry a hand-written meaning, a whole sentence each, also on the one-table view', () => {
    const out = mod.schema({});
    for (const t of ['agents', 'work', 'work_events', 'messages', 'turns', 'audit_log', 'deliveries', 'tool_receipts', 'agent_tool_failures', 'adjudications', 'a2a_threads', 'config']) {
      const line = out.split('\n').find((l) => l.startsWith(`${t} (`)) ?? '';
      expect(line, t).not.toMatch(/\(no description\)$/);
      expect(line, t).toMatch(/\.$/);
    }
    expect(mod.schema({ table: 'audit_log' })).toMatch(/^audit_log — One row per model call, tool call, file access and command/);
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
    const out = await q("select id, role, content from messages where id in ('m-1', 'm-2') order by id");
    expect(out).toMatch(/^id {2}role {6}content$/m);
    expect(out).toMatch(/^m-1 assistant row 1$/m);
    expect(out).toMatch(/2 rows\./);
  });

  it('refuses a write with the sentence, before it reaches the connection — and the connection refuses it again', async () => {
    for (const stmt of ['update work set title = 1', "delete from messages where id = 'm-1'", 'drop table work', "with x as (select 1) delete from messages where id = 'm-1'", 'pragma query_only = 0', "vacuum into '/tmp/x.db'"]) {
      expect(await q(stmt), stmt).toMatch(/^Refused: only a read runs here/);
    }
    expect(main.prepare("SELECT count(*) FROM messages WHERE id = 'm-1'").pluck().get()).toBe(1);
    expect(() => mod.connection.getReadOnlyDb().prepare("DELETE FROM messages WHERE id = 'm-1'").run()).toThrow(/read-only connection/);
  });

  it('allows EXPLAIN, and the extension loader is not reachable', async () => {
    expect(await q("explain query plan select * from messages where id = 'm-1'")).toMatch(/rows?\./);
    expect(await q("select load_extension('x')")).toMatch(/SQLite (refused the statement|stopped the query): not authorized/);
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
    ].map((query) => q(query)));
    expect(outs[0]).toMatch(/Refused: the statement reaches google_accounts/);
    expect(outs[2]).toMatch(/Refused: the statement reads destructive_approvals\.token/);
    expect(outs[4]).toContain('<redacted-credential>');
    for (const out of outs) for (const secret of [ACCESS, APPROVAL, PASTED, 'r-synthetic-value-0003']) expect(out).not.toContain(secret);
    for (const out of outs.slice(6)) expect(out).toMatch(/^Refused/);
    // Fix round 2: a credential table's schema is readable, its values are not.
    const cols = await q("select name, type from pragma_table_info('google_accounts')");
    expect(cols).toMatch(/^access_token +TEXT$/m);
    expect(cols).not.toContain(ACCESS);
    expect(await q('select agent_id, tool_name, status from destructive_approvals')).toMatch(/1 row\./);
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
    const out = await q('select id, content, created_at from messages order by seq');
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

  it('fix round 2 (B2-CRITICAL): Stop KILLS a runaway query — the process is gone, its snapshot released, the engine never held', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    let pid = 0;
    const agent = 'agent-sql-stop';
    const run = asInspect(() => mod.readInChild('select count(*) from messages a, messages b, messages c', (p) => { pid = p; }), agent);
    await new Promise((r) => setTimeout(r, 400));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    // While it runs it holds a read snapshot: a full checkpoint cannot finish.
    for (let i = 0; i < 20; i++) main.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, 'x')").run(`probe-a-${i}`);
    expect((main.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>)[0].busy).toBe(1);
    const during = ticks;
    const stoppedAt = Date.now();
    mod.runtime.stopAgent(agent);
    const out = await run;
    const goneAfter = Date.now() - stoppedAt;
    clearInterval(timer);
    expect(during).toBeGreaterThan(10);
    expect(out).toEqual({ ended: expect.stringMatching(/^Stopped: you pressed stop/) });
    expect(alive(pid)).toBe(false);
    expect(goneAfter).toBeLessThan(2000);
    for (let i = 0; i < 20; i++) main.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, 'x')").run(`probe-b-${i}`);
    expect((main.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>)[0].busy).toBe(0);
    const shared = await import('../../agent/shared-state.js');
    shared.stoppedAgents.delete(agent); shared.stopFencedRuns.delete(agent);
  }, 60_000);

  it('fix round 2: a normal query still returns its rows through the child, and outside a dojo_inspect call nothing runs', async () => {
    expect(await q("select id from messages where id = 'm-3'")).toMatch(/^m-3$/m);
    expect(await mod.sql({ query: "select id from messages where id = 'm-3'" })).toMatch(/outside any authorized tool call/);
  });

  it("fix round 2: the child applies the read-only door's rules itself, whatever it is sent", async () => {
    const copy = path.join(home, 'child-copy.db');
    for (const stmt of ['pragma query_only = 0', `vacuum into '${copy}'`, `attach '${path.join(home, 'o.db')}' as o`,
      "with x as (select 1) delete from config where key = 'platform_name'", '/* select */ delete from config']) {
      const out = await asInspect(() => mod.readInChild(stmt));
      expect(out, stmt).toEqual({ error: expect.stringMatching(/only a read runs here|readonly|read-only/) });
    }
    expect(fs.existsSync(copy)).toBe(false);
  });

});
