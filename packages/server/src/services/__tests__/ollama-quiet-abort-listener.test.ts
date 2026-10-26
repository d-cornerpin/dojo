// v3.5 fix round 6 — ABORT-LISTENER LEFTOVER: `waitOutHold` adds an abort listener with `{ once: true }`,
// which only removes it when the abort FIRES. A wait that settles normally (the hold released, the wait
// resolves) leaves the listener on the signal for the signal's whole life — a slow leak, one dead listener
// per wait on a long-lived signal. The wait removes it when it ends in ANY way, and abort still rejects.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { getEventListeners } from 'node:events';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);');
  mockDb.current = db;
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('waitOutHold leaves no abort listener on a settled wait', () => {
  it('many waits on ONE signal that each settle normally leave zero abort listeners', async () => {
    const { holdWhenQuiet, waitOutHold } = await import('../ollama-quiet.js');
    const signal = new AbortController().signal;
    for (let i = 0; i < 3; i++) {
      const release = await holdWhenQuiet('prov');
      const waiting = waitOutHold('prov', { signal });
      expect(waiting).not.toBeNull();
      release();
      await waiting;
    }
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('abort during a wait still rejects with the signal\'s reason', async () => {
    const { holdWhenQuiet, waitOutHold } = await import('../ollama-quiet.js');
    const release = await holdWhenQuiet('prov');
    const ctl = new AbortController();
    const reason = new Error('stop');
    const waiting = waitOutHold('prov', { signal: ctl.signal });
    expect(waiting).not.toBeNull();
    ctl.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    release();
  });
});
