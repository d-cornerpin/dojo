// A send an earlier version began and never finished is a pending row with nothing to send. The boot sweep
// closes it as failed once it is past the boot window; a queued reply and a fresh row are left alone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current!, closeDb: vi.fn(), getDbPath: () => ':memory:' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const { runMigrations } = await import('../../db/migrations.js');
const { sweepBootStaleness } = await import('../work-reaper.js');

const AGENT = randomUUID();
const row = (id: string, age: string, payload: string | null): void => {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, payload_json, created_at)
     VALUES (?, ?, 'imessage_send', 'imessage', 'pending', ?, datetime('now', ?))`,
  ).run(id, AGENT, payload, age);
};
const stateOf = (id: string): { outcome: string; detail: string | null } =>
  mockDb.current!.prepare('SELECT outcome, detail FROM deliveries WHERE id = ?').get(id) as { outcome: string; detail: string | null };

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the boot sweep and unfinished sends', () => {
  it('closes an old pending row with nothing to send as failed, reach unknown', () => {
    row('old', '-2 hours', null);
    sweepBootStaleness();
    expect(stateOf('old').outcome).toBe('failed');
    expect(stateOf('old').detail).toContain('whether it reached the person is not known');
  });

  it('leaves a queued reply pending', () => {
    row('queued', '-2 hours', JSON.stringify({ text: 'hello' }));
    sweepBootStaleness();
    expect(stateOf('queued').outcome).toBe('pending');
  });

  it('leaves a row written inside the boot window pending', () => {
    row('fresh', '-5 minutes', null);
    sweepBootStaleness();
    expect(stateOf('fresh').outcome).toBe('pending');
  });
});
