// A-1 — noting what a leaving leader left behind must not stall the server's event loop. A group that
// died with its leader needs no process listing at all, and a group that did survive is listed
// without blocking.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';

const listing = vi.hoisted(() => ({ sync: vi.fn((): string[] => []), async: vi.fn(async (): Promise<string[]> => ['1 x']) }));
vi.mock('../../../process-identity.js', async (orig) => ({
  ...(await orig<typeof import('../../../process-identity.js')>()),
  membersOfGroup: listing.sync,
  membersOfGroupAsync: listing.async,
}));
import { endsWithTheStop } from '../proc-tree.js';

let pgid = 0;
afterEach(() => { if (pgid > 1) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } } listing.sync.mockClear(); listing.async.mockClear(); });
const exited = (c: ReturnType<typeof spawn>): Promise<void> => new Promise((r) => c.once('exit', () => r()));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));

describe('the survivor note on a leader exit', () => {
  it('lists no processes at all when the whole group died with its leader', async () => {
    const c = spawn('/bin/sh', ['-c', 'true'], { detached: true, stdio: 'ignore' });
    pgid = c.pid as number;
    endsWithTheStop('a1-empty', c);
    await exited(c);
    await settle();
    expect(listing.sync).not.toHaveBeenCalled();
    expect(listing.async).not.toHaveBeenCalled();
  });
  it('lists a surviving group without blocking the event loop', async () => {
    const c = spawn('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 & sleep 0.3'], { detached: true, stdio: 'ignore' });
    pgid = c.pid as number;
    endsWithTheStop('a1-alive', c);
    await exited(c);
    await settle();
    expect(listing.async).toHaveBeenCalledWith(pgid);
    expect(listing.sync).not.toHaveBeenCalled();
  });
});
