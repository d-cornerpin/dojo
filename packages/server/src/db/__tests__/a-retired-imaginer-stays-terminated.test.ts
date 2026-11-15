// Migration 215 on a box where the retired Imaginer agent was left live: its row ends `terminated`, its four
// settings are gone, other agents and settings are untouched, and a box with no such row upgrades cleanly.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations } from '../migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const FILE = '215_imaginer_stays_retired.sql';
const KEYS = ['imaginer_agent_id', 'imaginer_agent_name', 'imaginer_brain_model', 'imaginer_image_model'];
const statusOf = (id: string): unknown => (doneDb().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string } | undefined)?.status;
const keysLeft = (): number => (doneDb().prepare(`SELECT COUNT(*) AS n FROM config WHERE key IN (${KEYS.map(() => '?').join(',')})`).get(...KEYS) as { n: number }).n;

/** A box that has every file but 215 applied, then runs 215 as a boot does. */
function boxThenUpgrade(seed: () => void): void {
  freshDoneDb();
  doneDb().exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
  doneDb().prepare('INSERT INTO _migrations (name) VALUES (?)').run(FILE);
  runMigrations();
  doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
  seed();
  runMigrations();
}

describe('migration 215', () => {
  it('ends a live Imaginer row, deletes its settings, and leaves every other agent and setting alone', () => {
    boxThenUpgrade(() => {
      const agent = doneDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'sensei')");
      agent.run('imaginer', 'Imaginer');
      agent.run('helper', 'Helper');
      const cfg = doneDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
      for (const k of KEYS) cfg.run(k, 'x');
      cfg.run('dojo_image_gen_model_id', 'pic-model');
    });
    expect(statusOf('imaginer')).toBe('terminated');
    expect(statusOf('helper')).toBe('idle');
    expect(keysLeft()).toBe(0);
    expect(doneDb().prepare("SELECT value FROM config WHERE key = 'dojo_image_gen_model_id'").get()).toEqual({ value: 'pic-model' });
  });

  it('runs cleanly on a box that never had an Imaginer', () => {
    boxThenUpgrade(() => undefined);
    expect(statusOf('imaginer')).toBeUndefined();
    expect(keysLeft()).toBe(0);
  });
});
