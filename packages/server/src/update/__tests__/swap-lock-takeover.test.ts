// acquireSwapLock (the installer's side of rollback.lock): a dead holder's lock is taken over, a live
// one and one owned by another user (pid 1, EPERM) are respected, no marker is left behind, and a
// takeover marker a crashed run left behind does not block for ever.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireSwapLock } from '../install-tree.js';

const dirs: string[] = [];
function dojo(): string {
  const d = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'swap-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const stale = (d: string, pid: string): void => {
  fs.mkdirSync(path.join(d, 'rollback.lock')); fs.writeFileSync(path.join(d, 'rollback.lock', 'pid'), pid);
};

describe('acquireSwapLock', () => {
  it('takes over a dead holder\'s lock, records its own pid, and leaves no marker', () => {
    const d = dojo(); stale(d, '2147483646');
    const r = acquireSwapLock(d);
    expect(typeof r).toBe('function');
    expect(fs.readFileSync(path.join(d, 'rollback.lock', 'pid'), 'utf-8')).toBe(String(process.pid));
    expect(fs.existsSync(path.join(d, 'rollback.lock.takeover'))).toBe(false);
    (r as () => void)();
    expect(fs.existsSync(path.join(d, 'rollback.lock'))).toBe(false);
  });
  it('a holder owned by another user (pid 1) is alive', () => {
    const d = dojo(); stale(d, '1');
    expect(acquireSwapLock(d)).toEqual({ busy: expect.stringContaining('already running') });
    expect(fs.existsSync(path.join(d, 'rollback.lock'))).toBe(true);
  });
  it('a fresh takeover marker means someone else is taking over: busy', () => {
    const d = dojo(); stale(d, '2147483646'); fs.mkdirSync(path.join(d, 'rollback.lock.takeover'));
    expect(acquireSwapLock(d)).toEqual({ busy: expect.stringContaining('taking over') });
  });
  it('a takeover marker a crashed run left behind (over a minute old) is cleared, and the next try works', () => {
    const d = dojo(); stale(d, '2147483646');
    const marker = path.join(d, 'rollback.lock.takeover'); fs.mkdirSync(marker);
    const old = new Date(Date.now() - 120_000); fs.utimesSync(marker, old, old);
    expect(typeof acquireSwapLock(d)).toBe('object');
    expect(typeof acquireSwapLock(d)).toBe('function');
  });
});
