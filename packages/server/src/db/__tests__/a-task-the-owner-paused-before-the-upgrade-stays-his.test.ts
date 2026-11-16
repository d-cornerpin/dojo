// A hold the owner put on a task before the one-path upgrade reads as his after it (3.4.1 recorded his
// moves with actor `user` or `by: 'owner'`); a worker's old hold stays the worker's; a second run adds nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { holdSetBySql, heldByOwnerSql } from '../../work/tracker-view.js';
import { boxBefore901, seedRow, event, upgrade, HELPER, MAIN, DAY } from './helpers/a-box-before-901.js';

const STEP = migrationFileNames().find((f) => f.includes('owner_pause_author'))!;
const owed = (): void => { doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(STEP); };
const who = (id: string): { by: string | null; owner: number } => doneDb().prepare(
  `SELECT ${holdSetBySql('w')} AS by, ${heldByOwnerSql('w')} AS owner FROM work w WHERE w.id = ?`,
).get(id) as { by: string | null; owner: number };
const entries = (): number => (doneDb().prepare(
  "SELECT COUNT(*) AS c FROM work_events WHERE kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'hold_set'",
).get() as { c: number }).c;

beforeEach(() => {
  boxBefore901();
  const t = Date.now() - DAY;
  const move = (id: string, to: string, by: string, actor: string): number =>
    event(id, 'transition', { from: 'claimed', to, by, reason: 'held' }, t, actor);
  for (const [id, state] of [['t-owner-paused', 'paused'], ['t-owner-blocked', 'blocked'], ['t-worker-paused', 'paused'],
    ['t-owner-then-worker', 'paused'], ['t-held-bare', 'paused'], ['t-not-held', 'claimed']]) seedRow({ id, state });
  move('t-owner-paused', 'paused', 'owner', 'user');
  move('t-owner-blocked', 'blocked', 'owner', MAIN);
  move('t-worker-paused', 'paused', 'agent', HELPER);
  move('t-owner-then-worker', 'paused', 'owner', 'user');
  move('t-owner-then-worker', 'paused', 'agent', HELPER);
  owed();
  upgrade();
});

describe('a task the owner paused before the upgrade stays his', () => {
  it('his holds read as his', () => {
    expect(who('t-owner-paused')).toEqual({ by: 'owner', owner: 1 });
    expect(who('t-owner-blocked')).toEqual({ by: 'owner', owner: 1 });
  });

  it("a worker's hold, a later worker move and a hold with no record stay off his name", () => {
    for (const id of ['t-worker-paused', 't-owner-then-worker', 't-held-bare', 't-not-held']) {
      expect(who(id).by, id).toBeNull();
    }
  });

  it('a second run appends nothing', () => {
    const before = entries();
    owed();
    runMigrations();
    expect(entries()).toBe(before);
  });
});
