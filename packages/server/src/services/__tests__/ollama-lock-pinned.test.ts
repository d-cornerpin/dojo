// v3.5 A3, REVIEW FOCUS 2 — A LONG AGENT TURN HOLDS A LOCAL AGENT MODEL WHEN A DECISION CALL ARRIVES.
// The ENGINE's own calls on the Dojo's two standard models (the caller says so: `pinned`) are resident
// and take no slot of the Ollama lock, so they never queue behind an agent's turn and the lock never
// swaps the agent's model for them. Fix round 1 (I-1): the exemption is the CALL's, never the tag's —
// an agent whose own model carries the writer's tag keeps the normal lock.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

const PROVIDER = 'prov-fixture-pinned';
const AGENT_MODEL = 'fixture-agent-model:7b';

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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('the two standard models take no lock slot', () => {
  it('with the one slot held by an agent model, the decision model and the writer proceed at once', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } = await import('../local-standard.js');
    const lock = getOllamaLock();
    await lock.acquire(PROVIDER, AGENT_MODEL);

    let decided = false;
    let wrote = false;
    void lock.acquire(PROVIDER, STANDARD_DECISION_MODEL.tag, undefined, true).then(() => { decided = true; });
    void lock.acquire(PROVIDER, STANDARD_WRITER_MODEL.tag, undefined, true).then(() => { wrote = true; });
    await settle();
    expect(decided).toBe(true);
    expect(wrote).toBe(true);

    // The agent's model still owns the provider's only slot: the lock did not swap it.
    const status = lock.getStatus();
    expect(status.slots.map((s) => s.modelName)).toEqual([AGENT_MODEL]);
    expect(status.slots[0].activeRequests).toBe(1);
  });

  it('a non-pinned model still queues behind the agent model', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const lock = getOllamaLock();
    await lock.acquire(PROVIDER, AGENT_MODEL);
    let other = false;
    const p = lock.acquire(PROVIDER, 'fixture-other-model:3b', 5_000).then(() => { other = true; });
    await settle();
    expect(other).toBe(false);
    lock.release(PROVIDER, AGENT_MODEL);
    await p;
    expect(other).toBe(true);
  });

  it('releasing a pinned call touches no slot count', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const { STANDARD_DECISION_MODEL } = await import('../local-standard.js');
    const lock = getOllamaLock();
    await lock.acquire(PROVIDER, AGENT_MODEL);
    await lock.acquire(PROVIDER, STANDARD_DECISION_MODEL.tag, undefined, true);
    lock.release(PROVIDER, STANDARD_DECISION_MODEL.tag, true);
    const status = lock.getStatus();
    expect(status.slots).toEqual([{ providerId: PROVIDER, modelName: AGENT_MODEL, activeRequests: 1 }]);
  });

  it('I-1: an AGENT TURN on the writer\'s tag is not pinned — a second one queues behind the first', async () => {
    const { getOllamaLock } = await import('../ollama-lock.js');
    const { STANDARD_WRITER_MODEL } = await import('../local-standard.js');
    const lock = getOllamaLock();
    await lock.acquire(PROVIDER, STANDARD_WRITER_MODEL.tag, 5_000);
    let second = false;
    const p = lock.acquire(PROVIDER, STANDARD_WRITER_MODEL.tag, 5_000).then(() => { second = true; });
    await settle();
    expect(second).toBe(false);
    lock.release(PROVIDER, STANDARD_WRITER_MODEL.tag);
    await p;
    expect(second).toBe(true);
  });
});
