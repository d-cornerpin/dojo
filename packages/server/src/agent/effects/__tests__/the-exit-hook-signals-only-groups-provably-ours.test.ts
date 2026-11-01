// A-3 — the graceful-exit hook used to SIGTERM every remembered group id with no check. After days of
// quiet the id can belong to an unrelated program. It now uses the boot reap's test: the leader is the
// identical process, or a member the toolbox noted is still in the group.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';

const fake = vi.hoisted(() => ({ identity: null as null | ((pid: number) => string | null) }));
vi.mock('../../../process-identity.js', async (orig) => {
  const real = await orig<typeof import('../../../process-identity.js')>();
  return { ...real, identityOfPid: (pid: number) => (fake.identity ? fake.identity(pid) : real.identityOfPid(pid)) };
});
import { endsWithTheStop, endToolboxGroups } from '../proc-tree.js';
import { groupIsOurs } from '../toolbox-ledger.js';

const pids: number[] = [];
afterEach(() => { fake.identity = null; for (const p of pids.splice(0)) { try { process.kill(-p, 'SIGKILL'); } catch { /* gone */ } } });
const alive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean): Promise<boolean> => {
  const end = Date.now() + 5_000;
  while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return f();
};
const start = (): number => {
  const c = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' });
  c.unref();
  pids.push(c.pid as number);
  endsWithTheStop('a3', c);
  return c.pid as number;
};

describe('the exit hook', () => {
  it('ends a group whose leader is the very process recorded', async () => {
    const g = start();
    endToolboxGroups();
    expect(await until(() => !alive(g))).toBe(true);
  });
  it('never signals a group whose id now belongs to a different process', async () => {
    const g = start();
    fake.identity = () => 'Tue Oct 27 09:00:00 2026 /Applications/Some.app/run';   // the id was reused
    endToolboxGroups();
    await new Promise((r) => setTimeout(r, 400));
    expect(alive(g)).toBe(true);
  });
});

describe('groupIsOurs', () => {
  const rec = 'Mon Oct 26 06:00:00 2026 sleep 600';
  const none = (): string[] => [];
  it('leader alive: only the identical identity counts', () => {
    expect(groupIsOurs(9, rec, undefined, () => rec, none)).toBe(true);
    expect(groupIsOurs(9, rec, ['1 a'], () => 'x', () => ['1 a'])).toBe(false);
  });
  it('leader gone: only a noted member still in the group counts', () => {
    expect(groupIsOurs(9, rec, ['1 a'], () => null, () => ['1 a'])).toBe(true);
    expect(groupIsOurs(9, rec, ['1 a'], () => null, () => ['2 b'])).toBe(false);
    expect(groupIsOurs(9, rec, undefined, () => null, () => ['1 a'])).toBe(false);
  });
});
