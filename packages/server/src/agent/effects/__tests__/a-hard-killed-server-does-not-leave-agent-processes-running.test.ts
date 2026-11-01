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
const E = { pgid: 4242, identity: 'Mon Oct 26 06:00:00 2026 sleep 600' };
const same = (): string | null => E.identity;
const NOW_BOOT = 1_700_000_000_000;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')); sent = []; alive.clear(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('toolbox group ledger', () => {
  it('a group recorded before a hard kill is ended at the next boot', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    alive.add(-4242);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT + 1000, send, graceMs: 0, identityOf: same });
    expect(out.ended).toEqual([4242]);
    expect(sent).toContainEqual([-4242, 'SIGTERM']);
  });
  it('a group that already ended is not signalled', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: same });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a reused pid with a different start time or command is never signalled', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    alive.add(-4242);
    for (const other of ['Tue Oct 27 09:00:00 2026 sleep 600', 'Mon Oct 26 06:00:00 2026 /Applications/Some.app/run', null]) {
      recordToolboxGroups(dir, [E], NOW_BOOT);
      const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: () => other });
      expect(out.ended).toEqual([]);
    }
    expect(sent).toEqual([]);
  });
  it('after a machine reboot the ledger is stale: nothing is signalled', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    alive.add(-4242);
    const out = reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT + 3_600_000, send, graceMs: 0, identityOf: same });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('the ledger is emptied after a reap, and an empty list clears it', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: same });
    alive.add(-4242);
    expect(reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: same }).ended).toEqual([]);
    recordToolboxGroups(dir, [], NOW_BOOT);
    expect(fs.existsSync(path.join(dir, 'toolbox-groups.json'))).toBe(false);
  });
  it('never signals group 0, 1 or a negative number, and survives a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'toolbox-groups.json'), JSON.stringify({ boot: NOW_BOOT, groups: [{ pgid: 0, identity: 'a' }, { pgid: 1, identity: 'a' }, { pgid: -5, identity: 'a' }, 'x'] }));
    alive.add(0); alive.add(-1);
    expect(reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: same }).ended).toEqual([]);
    fs.writeFileSync(path.join(dir, 'toolbox-groups.json'), '{nope');
    expect(() => reapLeftoverToolboxGroups({ dir, bootMs: NOW_BOOT, send, graceMs: 0, identityOf: same })).not.toThrow();
    expect(sent).toEqual([]);
  });
  // D1 (item 350): a one-shot script backgrounds a job and exits, so the recorded leader is gone
  // while its children live on in the group. The group is ours only if one of the members the
  // toolbox saw there (pid + start time, noted when the leader exited) is still alive in it.
  const M = '5151 Mon Oct 26 06:00:01 2026';
  const E2 = { ...E, members: [M] };
  const gone = (): string | null => null;
  const reap = (extra: Partial<Parameters<typeof reapLeftoverToolboxGroups>[0]>) =>
    reapLeftoverToolboxGroups({ bootMs: NOW_BOOT, send, graceMs: 0, ...extra, dir });
  it('a group whose leader exited but whose noted child lives on is still ended', () => {
    recordToolboxGroups(dir, [E2], NOW_BOOT);
    alive.add(-4242);
    const out = reap({ identityOf: gone, membersOf: () => [M] });
    expect(out.ended).toEqual([4242]);
    expect(sent).toContainEqual([-4242, 'SIGTERM']);
  });
  it('a leaderless group with no marker of ours is never signalled: members nobody noted', () => {
    // The original group died and its id was reused by an unrelated daemon whose leader exited.
    recordToolboxGroups(dir, [E2], NOW_BOOT);
    alive.add(-4242);
    const out = reap({ identityOf: gone, membersOf: () => ['9999 Tue Oct 27 09:00:00 2026', '5151 Tue Oct 27 09:00:00 2026'] });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a group recorded with no noted members cannot be recognised once its leader is gone', () => {
    recordToolboxGroups(dir, [E], NOW_BOOT);
    alive.add(-4242);
    const out = reap({ identityOf: gone, membersOf: () => [M] });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a leaderless group with no living member is dropped', () => {
    recordToolboxGroups(dir, [E2], NOW_BOOT);
    alive.add(-4242);
    expect(reap({ identityOf: gone, membersOf: () => [] }).ended).toEqual([]);
    expect(sent).toEqual([]);
  });
  it('a live process now holding the id with another identity is a reused id: dropped even if a noted member matches', () => {
    recordToolboxGroups(dir, [E2], NOW_BOOT);
    alive.add(-4242);
    const out = reap({ identityOf: () => 'Tue Oct 27 09:00:00 2026 other', membersOf: () => [M] });
    expect(out.ended).toEqual([]);
    expect(sent).toEqual([]);
  });
});
