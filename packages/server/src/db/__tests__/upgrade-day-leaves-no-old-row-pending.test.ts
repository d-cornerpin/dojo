// Upgrade day: whatever level a box comes from, the whole chain leaves no old delivery row pending (an older
// version's unfinished send is recorded failed, its words kept), every other row as it was, and the reply columns
// in place. Run on a fresh box, a box at the last Stable (001 to 199 and 900) and one at the last test build
// (001 to 209 and 900), each built from the migration files themselves.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000 });

import { runMigrations, migrationFileNames } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const LEFT = 'left unresolved by an earlier version; whether it reached the person is not known: ';

/** A database at the level a box reached with exactly the files `applied` names, applied in name order. */
function boxAt(applied: (file: string) => boolean): void {
  freshDoneDb();
  doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  const later = migrationFileNames().filter((f) => !applied(f));
  for (const f of later) doneDb().prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
  runMigrations();
  for (const f of later) doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(f);
}

function seedLivedIn(): void {
  const put = doneDb().prepare("INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, detail) VALUES (?, 'agent-main', 7, ?, ?, ?, ?)");
  put.run('old-intent', 'auto-route', 'imessage', 'pending', 'running late, start without me');
  put.run('old-intent-bare', 'imessage_send', 'imessage', 'pending', null);
  put.run('old-delivered', 'auto-route', 'sms', 'delivered', null);
  put.run('old-held', 'auto-route', 'dashboard', 'held', 'held in dashboard');
  put.run('old-failed', 'gmail_reply', 'email', 'failed', 'quota');
}

const rows = (): Array<{ id: string; outcome: string; detail: string | null; attempts: number; payload_json: string | null; next_attempt_at: number | null }> =>
  doneDb().prepare('SELECT id, outcome, detail, attempts, payload_json, next_attempt_at FROM deliveries ORDER BY id').all() as never;
const hasDueIndex = (): boolean => !!doneDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_deliveries_due'").get();

describe('upgrade day leaves no old row pending', () => {
  it('a fresh box gets the reply columns and the due index', () => {
    boxAt(() => true);
    expect(hasDueIndex()).toBe(true);
    doneDb().prepare("INSERT INTO deliveries (id, agent_id, tool, channel, outcome) VALUES ('d1', 'agent-main', 'auto-route', 'imessage', 'pending')").run();
    expect(rows()).toEqual([{ id: 'd1', outcome: 'pending', detail: null, attempts: 0, payload_json: null, next_attempt_at: null }]);
  });

  it.each([
    ['the last Stable (001 to 199 and 900)', (f: string) => f < '200' || f.startsWith('900_')],
    ['the last test build (001 to 209 and 900)', (f: string) => f < '210' || f.startsWith('900_')],
  ])('a box at %s: old pending rows end failed with their words, the rest stand', (_level, applied) => {
    boxAt(applied);
    seedLivedIn();
    runMigrations();

    expect(hasDueIndex()).toBe(true);
    expect(rows().map(({ id, outcome, detail, attempts }) => ({ id, outcome, detail, attempts }))).toEqual([
      { id: 'old-delivered', outcome: 'delivered', detail: null, attempts: 0 },
      { id: 'old-failed', outcome: 'failed', detail: 'quota', attempts: 0 },
      { id: 'old-held', outcome: 'held', detail: 'held in dashboard', attempts: 0 },
      { id: 'old-intent', outcome: 'failed', detail: `${LEFT}running late, start without me`, attempts: 0 },
      { id: 'old-intent-bare', outcome: 'failed', detail: LEFT, attempts: 0 },
    ]);
    expect(doneDb().prepare("SELECT COUNT(*) AS n FROM deliveries WHERE outcome = 'pending'").get()).toEqual({ n: 0 });
  });
});
