// D1: a server killed with SIGKILL while it clones node_modules leaves its `cp` running, writing into
// the staging folder. The start-up sweep used to remove the folder with the writer still alive, once;
// the removal lost the race (or the writer filled the folder again) and nothing asked again, so the
// folder stayed beside the live install. The sweep now stops every process that is still writing into a
// dead installer's work dir BEFORE it removes it. A REAL orphan process is used here (a script named
// `cp` that keeps adding files to a staging folder, detached from this test as an orphan would be).
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanUpdateLeftovers } from '../leftovers.js';
import { pidAlive } from '../install-tree.js';

const DEAD_PID = 2147483646;
let box = '';
const orphans: number[] = [];
afterEach(async () => {
  for (const p of orphans.splice(0)) {
    try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    for (let i = 0; i < 500 && pidAlive(p); i++) await new Promise((r) => setTimeout(r, 10));
  }
  if (box) fs.rmSync(box, { recursive: true, force: true });
  box = '';
});

/** Starts a `cp -Rc <src> <dst>` look-alike that keeps adding files to dst until killed. */
async function startOrphanCopy(dst: string, bin: string): Promise<number> {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'cp'), `#!/bin/sh\nn=0\nwhile :; do n=$((n+1)); mkdir "$3/d$n" 2>/dev/null; echo x > "$3/d$n/f" 2>/dev/null; done\n`, { mode: 0o755 });
  const child = spawn(path.join(bin, 'cp'), ['-Rc', path.join(box, 'src'), dst], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  orphans.push(pid);
  // Wait until it is really writing.
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dst, 'd1')); i++) await new Promise((r) => setTimeout(r, 10));
  expect(fs.existsSync(path.join(dst, 'd1'))).toBe(true);
  return pid;
}

describe('the start-up sweep and an orphaned copy', () => {
  it('stops the copy that is still writing into a dead installer\'s work dir, then removes the dir', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'orphan-cp-'));
    const dojo = path.join(box, '.dojo');
    const staging = path.join(dojo, `platform.staging-${DEAD_PID}-1793475362835`);
    fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(box, 'src'));
    const pid = await startOrphanCopy(path.join(staging, 'node_modules'), path.join(box, 'bin'));

    const res = await cleanUpdateLeftovers(dojo);

    expect(res.failed).toEqual([]);
    expect(fs.existsSync(staging)).toBe(false);
    // The writer is gone (a killed process is reaped by init; allow the kernel a moment via the pid check).
    for (let i = 0; i < 200 && pidAlive(pid); i++) await new Promise((r) => setTimeout(r, 10));
    expect(pidAlive(pid)).toBe(false);
  });

  it('never touches a process that is writing somewhere else', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'orphan-cp-'));
    const dojo = path.join(box, '.dojo');
    fs.mkdirSync(path.join(dojo, `platform.staging-${DEAD_PID}-1`), { recursive: true });
    const elsewhere = path.join(box, 'elsewhere'); fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(box, 'src'));
    const pid = await startOrphanCopy(elsewhere, path.join(box, 'bin'));
    await cleanUpdateLeftovers(dojo);
    expect(pidAlive(pid)).toBe(true);
  });
});
