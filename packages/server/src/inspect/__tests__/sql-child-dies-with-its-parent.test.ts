// t278 — A dojo_inspect QUERY'S PROCESS DIES WITH THE PROCESS THAT STARTED IT.
//
// The defect: the query's child process (`sql-child.ts`) is the leader of its own process group
// (so the owner's Stop can end it), which also means it does not die with the server. A server
// that crashed, restarted or was SIGKILLed while an agent's query ran left that query running
// forever at full CPU, holding its read snapshot, with nobody left who could Stop it (seen on the
// build box: four orphaned query children, parent pid 1, 25-32 minutes at ~40% CPU each).
//
// The test puts a short-lived INTERMEDIARY between `readInChild` and the query's process, exactly
// where the server sits in production: the door the query is spawned through is replaced by one
// that starts the intermediary, and the intermediary starts the real program with the real argv
// (same `detached` group as the real door) and relays its stdin. SIGKILLing the intermediary is a
// server crash: no exit hook, no shutdown path, nothing runs on the parent side.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const H = vi.hoisted(() => ({
  pidFiles: [] as string[],
  // argv[1] = where to write the query process's pid; argv[2] = the real door's [file, ...argv].
  INTERMEDIARY: `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const [file, ...argv] = JSON.parse(process.argv[2]);
    const c = spawn(file, argv, { detached: true, stdio: ['pipe', 'inherit', 'inherit'] });
    fs.writeFileSync(process.argv[1], String(c.pid));
    process.stdin.pipe(c.stdin);
    c.on('exit', (code) => process.exit(code ?? 1));
  `,
}));

vi.mock('../../agent/effects/proc.js', async () => {
  const { spawn } = await import('node:child_process');
  const pathMod = await import('node:path');
  const osMod = await import('node:os');
  return {
    spawnAuthorized: (file: string, argv: readonly string[]) => {
      const pidFile = pathMod.join(osMod.tmpdir(), `t278-query-pid-${process.pid}-${H.pidFiles.length}`);
      H.pidFiles.push(pidFile);
      return spawn(process.execPath, ['-e', H.INTERMEDIARY, pidFile, JSON.stringify([file, ...argv])]);
    },
  };
});

const ENDLESS = 'with recursive r(n) as (select 1 union all select n + 1 from r) select count(*) from r';

// THE BOUND, FROM THE WATCH MECHANISM. The query's process watches its stdin: the parent holds the
// only write end, so the kernel closes it the moment the parent dies, and the child's main thread
// (idle; the query runs on a worker thread) gets 'end' on its next event-loop turn and SIGKILLs
// its own process. There is no timer anywhere in that chain, so the real latency is milliseconds.
// 10 s is pure headroom for a heavily loaded build box. On the base the child never ends at all.
const BOUND_MS = 10_000;

let home: string;
let mod: { connection: typeof import('../../db/connection.js'); readInChild: typeof import('../sql-child.js').readInChild };
const started: number[] = [];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function queryPid(i: number): Promise<number> {
  for (let waited = 0; waited < BOUND_MS; waited += 25) {
    const f = H.pidFiles[i];
    if (f && fs.existsSync(f)) {
      const pid = Number(fs.readFileSync(f, 'utf-8'));
      if (pid > 0) { started.push(pid); return pid; }
    }
    await sleep(25);
  }
  throw new Error('the intermediary never started the query process');
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'inspect-orphan-'));
  vi.stubEnv('DOJO_HOME', home);
  vi.resetModules();
  const connection = await import('../../db/connection.js');
  connection.getDb(); // the file the child opens read-only must exist
  mod = { connection, readInChild: (await import('../sql-child.js')).readInChild };
}, 60_000);

afterEach(() => {
  // Leave nothing running, whatever the assertions said: the base's orphan is killed here.
  for (const pid of started.splice(0)) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
});

afterAll(() => {
  for (const f of H.pidFiles) fs.rmSync(f, { force: true });
  mod.connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a dojo_inspect query outlives nothing', () => {
  it('t278: the parent is SIGKILLed mid-query (a server crash) and the endless query process is gone within the bound', async () => {
    let parentPid = 0;
    // The mocked door appends a pid file for EVERY spawn in the file, and the other test may have
    // run first and taken the earlier slots: ours is the one our own spawn adds, not [0].
    const at = H.pidFiles.length;
    const run = mod.readInChild(ENDLESS, (p) => { parentPid = p; });
    const pid = await queryPid(at);
    expect(parentPid).toBeGreaterThan(0);
    // It is really running the endless read (an error would have ended it at once).
    await sleep(500);
    expect(alive(pid), 'the query process should be running the endless read').toBe(true);

    process.kill(parentPid, 'SIGKILL');
    const killedAt = Date.now();
    while (alive(pid) && Date.now() - killedAt < BOUND_MS) await sleep(25);
    const goneAfter = Date.now() - killedAt;
    expect(alive(pid), `the query process (pid ${pid}) outlived its parent by ${goneAfter} ms`).toBe(false);
    expect(goneAfter).toBeLessThan(BOUND_MS);
    await run; // the parent side settles once the query process is gone
  }, 60_000);

  it('t278: a parent that stays alive still gets its answer (the watch never cuts a healthy query)', async () => {
    const out = await mod.readInChild('select 41 + 1 as answer');
    expect(out).toEqual({ columns: [{ name: 'answer', column: null, table: null }], rows: [[42]] });
  }, 60_000);
});
