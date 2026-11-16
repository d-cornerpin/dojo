// A resident that is asked to start many times while the primary agent is missing keeps one retry
// pending, not one per ask: the asks come from every work_open, and each extra retry would loop forever.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const db = new Database(':memory:');
db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)');
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));

import { primaryReady } from '../primary-ready.js';

describe('a resident waiting for the primary', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { db.exec('DELETE FROM agents'); vi.useRealTimers(); });

  it('keeps one retry pending however often it is asked', () => {
    const retry = vi.fn();
    for (let i = 0; i < 3; i++) expect(primaryReady('Resident', 'primary', retry)).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('arms a fresh retry once the pending one has fired', () => {
    const retry = vi.fn(() => primaryReady('Resident', 'primary', retry));
    primaryReady('Resident', 'primary', retry);
    vi.advanceTimersByTime(5_000);
    db.prepare("INSERT INTO agents (id) VALUES ('primary')").run();
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(primaryReady('Resident', 'primary', retry)).toBe(true);
  });
});
