// v3.5 P6(c) — a process an agent backgrounded must not outlive a HARD kill of the server.
// The graceful exit already signals the groups the toolbox started (`process.once('exit')`);
// a SIGKILL runs no exit hook, so the groups are written to a ledger and the next boot ends
// what the ledger still names. Stand-in signal sender only: no real process is signalled.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordToolboxGroups, reapLeftoverToolboxGroups } from '../toolbox-ledger.js';

let dir: string;
let sent: Array<[number, string | number]>;
const alive = new Set<number>();
const send = (pgid: number, sig: NodeJS.Signals | 0): void => {
  if (sig === 0) { if (!alive.has(pgid)) throw new Error('ESRCH'); return; }
  sent.push([pgid, sig]);
};
const NOW_BOOT = 1_700_000_000_000;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); sent = []; alive.clear(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('toolbox group ledger', () => {
  it('a group recorded before a hard kill is ended at the next boot', () => {
    recordToolboxGroups(dir, [4242], NOW_BOOT);
    alive.add(-4242);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT + 1000, send, graceMs: 0 });
    expect(out.ended).toEqual([4242]);
    expect(sent).toContainEqual([-4242, 'SIGTERM']);
  });
  it('a group that already ended is not signalled', () => {
    recordToolboxGroups(dir, [4242], NOW_BOOT);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0 });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('after a machine reboot the ledger is stale: nothing is signalled', () => {
    recordToolboxGroups(dir, [4242], NOW_BOOT);
    alive.add(-4242);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT + 3_600_000, send, graceMs: 0 });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('the ledger is emptied after a reap, and an empty list clears it', () => {
    recordToolboxGroups(dir, [4242], NOW_BOOT);
    reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0 });
    alive.add(-4242);
    expect(reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0 }).ended).toEqual([]);
    recordToolboxGroups(dir, [], NOW_BOOT);
    expect(fs.existsSync(path.join(dir, 'toolbox-groups.json'))).toBe(false);
  });
  it('never signals group 0, 1 or a negative number, and survives a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'toolbox-groups.json'), JSON.stringify({ boot: NOW_BOOT, groups: [0, 1, -5, 'x'] }));
    alive.add(0); alive.add(-1);
    expect(reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0 }).ended).toEqual([]);
    fs.writeFileSync(path.join(dir, 'toolbox-groups.json'), '{nope');
    expect(() => reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0 })).not.toThrow();
    expect(sent).toEqual([]);
  });
});
