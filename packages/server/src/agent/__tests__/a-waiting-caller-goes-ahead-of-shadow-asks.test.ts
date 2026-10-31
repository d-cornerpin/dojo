// BACKLOG 12a — a caller that WAITS for a decide() answer (model mode) is served ahead of the background shadow asks
// that have not started, so its patience is not spent queueing behind them; and a queued, not yet sent shadow ask is
// dropped once its own signal says a newer reply replaced it (a real signal, never a timer). Every /v1/systemone call
// is a scripted fetch: no real model is asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: () => undefined, getDailySpend: () => 0 }));

import { runMigrations } from '../../db/migrations.js';
import { decide, type Question, type FailureClass } from '../decide.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
const LABELS = ['running', 'shadow-old', 'shadow-new', 'waiter'];
const sent: string[] = [];
let holdRunning: Promise<void>;
let letRunningGo: () => void;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  sent.length = 0;
  holdRunning = new Promise<void>((r) => { letRunningGo = r; });
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47141', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const label = LABELS.find((l) => (init?.body ?? '').includes(`"${l}"`) || (init?.body ?? '').includes(l)) ?? '?';
    sent.push(label);
    if (label === 'running') await holdRunning;
    return Response.json({ answers: { yes: { noul: 0.9 } }, usage: { input_tokens: 40 } });
  }));
});
afterEach(() => { letRunningGo(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

describe('decide() queue: a waiting caller first, a superseded shadow ask dropped', () => {
  it('the waiter is sent before background asks that queued earlier; a shadow ask whose reply was replaced is never sent', async () => {
    let replaced = false;
    const failures: FailureClass[] = [];
    const running = decide({ x: 'running' }, Q, { purpose: 'p', patienceMs: 60_000 });
    await tick();   // the first call is on the wire and holds the one turn
    const old = decide({ x: 'shadow-old' }, Q, { purpose: 'p', patienceMs: 60_000, background: true, staleWhen: () => replaced, onFailure: (f) => failures.push(f) });
    const fresh = decide({ x: 'shadow-new' }, Q, { purpose: 'p', patienceMs: 60_000, background: true });
    await tick();
    const waiter = decide({ x: 'waiter' }, Q, { purpose: 'p', patienceMs: 60_000 });
    await tick();
    replaced = true;   // the agent has a newer reply
    letRunningGo();
    await Promise.all([running, fresh, waiter]);
    expect(await old).toBeNull();
    expect(failures).toEqual(['superseded']);
    expect(sent).toEqual(['running', 'waiter', 'shadow-new']);
  });
});
