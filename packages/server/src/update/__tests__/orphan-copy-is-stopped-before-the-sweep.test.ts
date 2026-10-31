// D1: a server killed with SIGKILL while it clones node_modules leaves its `cp` running, writing into
// the staging folder. The start-up sweep used to remove the folder with the writer still alive, once;
// the removal lost the race (or the writer filled the folder again) and nothing asked again, so the
// folder stayed beside the live install. The sweep now stops every process that is still writing into a
// dead installer's work dir BEFORE it removes it. A REAL orphan process is used here (a script named
// `cp` that keeps adding files to a staging folder, detached from this test as an orphan would be).
import { describe, it, expect, afterEach, vi } from 'vitest';
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

/**
 * Starts a `cp -Rc <src> <dst>` look-alike that keeps adding files to dst until killed. It is started
 * from a subshell that exits at once, so (like the copy of a killed server) it is re-parented to pid 1.
 */
async function startOrphanCopy(dst: string, bin: string): Promise<number> {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'cp'), `#!/bin/sh\necho $$ > "${bin}/pid"\nn=0\nwhile :; do n=$((n+1)); mkdir "$3/d$n" 2>/dev/null; echo x > "$3/d$n/f" 2>/dev/null; done\n`, { mode: 0o755 });
  await new Promise<void>((resolve) => {
    const c = spawn('/bin/sh', ['-c', `("${path.join(bin, 'cp')}" -Rc "${path.join(box, 'src')}" "${dst}" >/dev/null 2>&1 &)`], { stdio: 'ignore' });
    c.on('close', () => resolve());
  });
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dst, 'd1')); i++) await new Promise((r) => setTimeout(r, 10));
  expect(fs.existsSync(path.join(dst, 'd1'))).toBe(true);
  const pid = Number(fs.readFileSync(path.join(bin, 'pid'), 'utf-8').trim());
  orphans.push(pid);
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

  it('leaves alone a process that merely sits in the folder (not an orphan of the installer)', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'orphan-cp-'));
    const dojo = path.join(box, '.dojo');
    const staging = path.join(dojo, `platform.staging-${DEAD_PID}-1`);
    fs.mkdirSync(staging, { recursive: true });
    // The owner's own shell: a live parent (this test), its current folder inside the dead dir.
    const mine = spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: staging, stdio: 'ignore' });
    orphans.push(mine.pid!);
    await new Promise((r) => setTimeout(r, 100));
    await cleanUpdateLeftovers(dojo);
    expect(pidAlive(mine.pid!)).toBe(true);
  });

  it('a writer whose kill is refused (EPERM) is not waited on: the sweep returns and leaves that folder', async () => {
    box = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'orphan-cp-'));
    const dojo = path.join(box, '.dojo');
    const staging = path.join(dojo, `platform.staging-${DEAD_PID}-1`);
    const other = path.join(dojo, `platform.staging-${DEAD_PID - 1}-1`);
    fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    fs.mkdirSync(path.join(box, 'src'));
    const pid = await startOrphanCopy(path.join(staging, 'node_modules'), path.join(box, 'bin'));
    const realKill = process.kill.bind(process);
    const spy = vi.spyOn(process, 'kill').mockImplementation(((p: number, sig?: string | number) => {
      if (p === pid && sig === 'SIGKILL') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return realKill(p, sig as never);
    }) as typeof process.kill);
    const t0 = Date.now();
    const res = await cleanUpdateLeftovers(dojo);
    spy.mockRestore();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.failed).toEqual([path.basename(staging)]);
    expect(fs.existsSync(staging)).toBe(true);
    expect(fs.existsSync(other)).toBe(false);
    expect(pidAlive(pid)).toBe(true);
  });
});
