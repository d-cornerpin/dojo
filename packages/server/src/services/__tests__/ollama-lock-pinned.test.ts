// v3.5 A3, REVIEW FOCUS 2 — A LONG AGENT TURN HOLDS A LOCAL AGENT MODEL WHEN A DECISION CALL ARRIVES.
// The Dojo's two standard models are resident (keep_alive -1) and take no slot of the Ollama lock, so a
// decision call or a writer call never queues behind an agent's turn and never swaps its model out.
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
    void lock.acquire(PROVIDER, STANDARD_DECISION_MODEL.tag).then(() => { decided = true; });
    void lock.acquire(PROVIDER, STANDARD_WRITER_MODEL.tag).then(() => { wrote = true; });
    await settle();
    expect(decided).toBe(true);
    expect(wrote).toBe(true);

    // The agent's model still owns the provider's only slot: it was not swapped out.
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
    await lock.acquire(PROVIDER, STANDARD_DECISION_MODEL.tag);
    lock.release(PROVIDER, STANDARD_DECISION_MODEL.tag);
    const status = lock.getStatus();
    expect(status.slots).toEqual([{ providerId: PROVIDER, modelName: AGENT_MODEL, activeRequests: 1 }]);
  });
});
