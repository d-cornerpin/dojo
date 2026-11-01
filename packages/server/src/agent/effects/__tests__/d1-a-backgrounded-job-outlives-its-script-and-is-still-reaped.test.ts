// D1 (item 350) with REAL processes: a one-shot script backgrounds a job and exits, leaving no living
// leader. The boot reap must still end the job, and the ledger must live in the Dojo folder (D2).
// Only the group this test starts is ever signalled.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordToolboxGroups, reapLeftoverToolboxGroups } from '../toolbox-ledger.js';
import { identityOfPid } from '../../../process-identity.js';
import { dojoDir, homeDir } from '../../../home.js';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms = 8_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return f();
};

let dir: string;
let pgid = 0;
afterEach(() => {
  if (pgid > 1) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a job the script backgrounded survives its leader', () => {
  it('is ended at the next boot although the recorded leader is gone', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-real-'));
    const child = spawn('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 & sleep 1'], { detached: true, stdio: 'ignore' });
    child.unref();
    pgid = child.pid as number;
    const identity = identityOfPid(pgid) ?? '';   // read while the leader still runs
    expect(identity).not.toBe('');
    recordToolboxGroups(dir, [{ pgid, identity }]);
    expect(await until(() => identityOfPid(pgid) === null)).toBe(true);   // leader exited
    expect(groupAlive(pgid)).toBe(true);                                   // the sleep lives on
    const out = reapLeftoverToolboxGroups({ dir, graceMs: 0 });
    expect(out.ended).toEqual([pgid]);
    expect(await until(() => !groupAlive(pgid))).toBe(true);
    expect(alive(pgid)).toBe(false);
  });
});

describe('the ledger folder', () => {
  it('is the Dojo data folder, not a folder in the user home', () => {
    expect(dojoDir('data')).toBe(path.join(homeDir(), '.dojo', 'data'));
  });
});
