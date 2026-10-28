// ════════════════════════════════════════
// WATCHDOG SURVIVES AN UNWRITABLE LOG (S12 F5).
//
// `log()` in `watchdog/src/index.ts` is the watchdog's ONE unguarded write. A
// full disk, or a `~/.dojo` that is a plain file, makes `ensureLogDir()`'s
// mkdirSync (and the appendFileSync after it) throw — and because the FIRST
// statement of every check cycle is a `log()`, the throw kills the daemon at
// startup (before the uncaughtException net is even installed) or inside a cycle,
// on the exact event `checkDiskSpace` exists to report. The daemon's own comment
// on the "last net" says the alternative to a possibly-degraded watchdog is NO
// watchdog, so the file write must never throw.
//
// ── WHY REAL CHILD PROCESSES ──
// "the daemon is still alive" is a process property, not a claim a mocked emitter
// can make. These clauses fork the REAL watchdog source as a node/tsx child
// against a scratch HOME and check that it has not exited after four seconds —
// the window in which the pre-fix build dies at its startup `log()`.
// ════════════════════════════════════════

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const WATCHDOG_SRC = path.join(REPO_ROOT, 'watchdog', 'src', 'index.ts');

let scratch: string;
let child: ChildProcess | null = null;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function scratchHome(): string {
  return fs.mkdtempSync(path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'wd-log-'));
}

/** Start the real watchdog source as a child pointed at the scratch HOME. Port 9
 *  is closed, so the health check fails fast; the scratch HOME has no approved
 *  recipient database, so nothing is ever texted. */
function startChild(): ChildProcess {
  child = spawn(process.execPath, ['--import', 'tsx', WATCHDOG_SRC], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: scratch, DOJO_URL: 'http://127.0.0.1:9' },
    stdio: 'ignore',
  });
  return child;
}

/** SIGKILL the child and wait for its exit so nothing is left running. */
async function stopChild(c: ChildProcess): Promise<void> {
  if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  await new Promise<void>(r => {
    if (c.exitCode !== null || c.signalCode !== null) { r(); return; }
    c.once('exit', r);
  });
}

describe('watchdog survives an unwritable log', () => {
  it('an unwritable log folder does not kill the daemon at startup', async () => {
    scratch = scratchHome();
    // `.dojo` as a plain FILE: `mkdirSync(scratch/.dojo/logs, {recursive:true})`
    // throws ENOTDIR, which is the full-disk / unwritable-log case in miniature.
    fs.writeFileSync(path.join(scratch, '.dojo'), 'x');
    const c = startChild();
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    c.on('exit', (code, signal) => { exited = { code, signal }; });
    try {
      await sleep(4000);
      // The daemon must NOT have exited: on the pre-fix build the startup `log()`
      // throws before the uncaughtException net is even installed, so it crashes.
      expect(c.exitCode, 'the daemon must not exit just because its log folder is unwritable').toBeNull();
      expect(c.signalCode).toBeNull();
    } finally {
      await stopChild(c);
    }
  }, 30_000);

  it('with a writable log the daemon starts, logs, and keeps running (control)', async () => {
    scratch = scratchHome();
    fs.mkdirSync(path.join(scratch, '.dojo', 'logs'), { recursive: true });
    const c = startChild();
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    c.on('exit', (code, signal) => { exited = { code, signal }; });
    try {
      await sleep(4000);
      expect(c.exitCode).toBeNull();
      expect(c.signalCode).toBeNull();
      const logPath = path.join(scratch, '.dojo', 'logs', 'watchdog.log');
      expect(fs.existsSync(logPath), 'the watchdog must have written its startup log line').toBe(true);
      expect(fs.readFileSync(logPath, 'utf-8')).toContain('Dojo Watchdog starting');
    } finally {
      await stopChild(c);
    }
  }, 30_000);
});
