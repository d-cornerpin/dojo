// t268 fix round 4 (N-A, orchestrator ruling) — A SHADOW CHECK WAITING FOR THE AGENTS TO GO IDLE HOLDS NO OTHER
// decide() CALL UP. The background wait happens BEFORE the call joins the one decide() queue, never inside it: a
// rule-path call made while a shadow check waits behind an agent's turn is answered at once. A queue slot is always
// released, even by a call that throws, and every queued call's clock starts when it is sent.
// Every /v1/systemone call is a scripted fetch: no real model is asked.
import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../costs/tracker.js', () => ({
  recordCost: (c: { callPurpose?: string }) => { if (c.callPurpose === 'ledger_breaks') throw new Error('the cost ledger write failed'); },
  getDailySpend: () => 0,
}));

import { runMigrations } from '../../db/migrations.js';
import { decide, type Question } from '../decide.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { getOllamaLock } from '../../services/ollama-lock.js';

const db = (): Database.Database => mockDb.current!;
const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
const sent: string[] = [];

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  sent.length = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47141', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = init?.body ?? '';   // the state's text arrives fenced: the case's label is found inside it
    sent.push(['rule-path', 'shadow', 'first', 'second'].find((l) => body.includes(l)) ?? '?');
    return Response.json({ answers: { yes: { noul: 0.9 } }, usage: { input_tokens: 40 } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> =>
  Promise.race([p, new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))]);

describe('a shadow check waiting for idle holds no other decide() call up', () => {
  it('while a shadow check waits behind an agent\'s turn, a rule-path call is answered at once; the shadow check goes when the turn ends', async () => {
    const lock = getOllamaLock();
    await lock.acquire('ollama-local', 'agent-local:8b');   // an agent's own turn is running on the local Ollama
    let released = false;
    const release = (): void => { if (!released) { released = true; lock.release('ollama-local', 'agent-local:8b'); } };
    onTestFinished(release);   // the lock is the process's own: never left held for the next case
    let shadowDone = false;
    const shadow = decide({ x: 'shadow' }, Q, { purpose: 'summary_check', patienceMs: 60_000, background: true }).then((a) => { shadowDone = true; return a; });
    await new Promise((r) => setTimeout(r, 20));
    const rulePath = await within(decide({ x: 'rule-path' }, Q, { purpose: 'reply_floor', patienceMs: 60_000 }), 3_000);
    expect(rulePath).toMatchObject({ yes: { noul: 0.9 } });
    expect(sent).toEqual(['rule-path']);
    expect(shadowDone).toBe(false);   // still waiting for the agent's turn to end
    release();
    expect(await shadow).toMatchObject({ yes: { noul: 0.9 } });
    expect(sent).toEqual(['rule-path', 'shadow']);
  });

  it('a call that throws releases its queue slot: the next call is still sent and answered', async () => {
    await expect(decide({ x: 'first' }, Q, { purpose: 'ledger_breaks', patienceMs: 60_000 })).rejects.toThrow('the cost ledger write failed');
    expect(await within(decide({ x: 'second' }, Q, { purpose: 'reply_floor', patienceMs: 60_000 }), 3_000)).toMatchObject({ yes: { noul: 0.9 } });
    expect(sent.filter((x) => x === 'first' || x === 'second')).toEqual(['first', 'second']);
  });
});
