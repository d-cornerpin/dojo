// A resident that is asked to start many times while the primary agent is missing keeps one retry
// pending, not one per ask: the asks come from every work_open, and each extra retry would loop forever.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({ getDb: () => mockDb.current! }));
vi.mock('../../config/platform.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isSetupCompleted: () => true, getPrimaryAgentId: () => 'primary', getPMAgentId: () => 'pm', getPMAgentName: () => 'PM',
}));

import { runMigrations } from '../../db/migrations.js';
import { primaryReady } from '../primary-ready.js';
import { ensurePMAgentRunning } from '../../tracker/pm-agent.js';

const db = (): Database.Database => mockDb.current!;
const addPrimary = (): void => { db().prepare("INSERT INTO agents (id, name, status) VALUES ('primary', 'Primary', 'idle')").run(); };

describe('a resident waiting for the primary', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); mockDb.current?.close(); mockDb.current = null; });

  it('keeps one retry pending however often it is asked', () => {
    const retry = vi.fn();
    for (let i = 0; i < 3; i++) expect(primaryReady('Resident', 'primary', retry)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps one retry for EACH resident, and each starts once when the primary appears', () => {
    const started = { A: 0, B: 0 };
    const ask = (who: 'A' | 'B'): void => { if (primaryReady(who, 'primary', () => ask(who))) started[who] += 1; };
    ask('A'); ask('B'); ask('A'); ask('B');
    vi.advanceTimersByTime(5_000);   // each retried once, found no primary, re-armed once
    addPrimary();
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);   // nothing left armed
    expect(started).toEqual({ A: 1, B: 1 });
  });

  it('the PM, asked on every work_open, is created once the primary appears', () => {
    for (let i = 0; i < 3; i++) ensurePMAgentRunning();
    expect(db().prepare("SELECT COUNT(*) AS n FROM agents WHERE id = 'pm'").get()).toEqual({ n: 0 });
    addPrimary();
    vi.advanceTimersByTime(5_000);
    expect(db().prepare("SELECT status FROM agents WHERE id = 'pm'").get()).toEqual({ status: 'idle' });
  });
});
