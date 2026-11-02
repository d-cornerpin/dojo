// proof-fix T — THE DECISION MODEL'S PATIENCE COMES FROM THIS BOX'S OWN MEASURED CALLS.
//
// `decideTimeoutMs` is B5's fit from one fast Mac (observed ÷ fitted p99 = 2.05). On a slower box the same figure
// cuts calls that would have answered, and a call cut by its own clock records no latency — so the pace learns
// from cut calls too (a censored sample: the true time is at least what was given). A fast box keeps today's
// figure exactly; a missing or corrupt store is the formula. Every /v1/systemone call is a scripted fetch.
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
import { decide, measuredDecideTimeoutMs, __forgetResidencyForTests, type Question, type FailureClass } from '../decide.js';
import { decideFitMs, decideTimeoutMs, fencedState, MODEL_LOAD_MS } from '../decide-sizing.js';
import { PRIOR_PACE, decidePace } from '../decide-pace.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { B5_MEASURED_CHARS_PER_TOKEN } from '../../services/token-density.js';

const db = (): Database.Database => mockDb.current!;
const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
const STATE = { x: 'a reply the turn waits on, long enough to be a real call '.repeat(20) };
const tokens = Math.ceil(JSON.stringify(fencedState(STATE)).length / B5_MEASURED_CHARS_PER_TOKEN);
const FIT = decideFitMs(tokens, 1);
/** How long the scripted box takes for a call, as a multiple of B5's fitted time for its size. */
let boxRatio = 1;
/** The model is loaded after it answers and unloaded after a cut (B5: loading adds about 1.3 s). */
let loaded = false;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __forgetResidencyForTests();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47143', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  loaded = false;
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => { loaded = true; resolve(Response.json({ answers: { yes: { noul: 0.9 } }, usage: { input_tokens: 40 } })); }, boxRatio * FIT + (loaded ? 0 : MODEL_LOAD_MS));
    init?.signal?.addEventListener('abort', () => { clearTimeout(t); loaded = false; reject(new Error('aborted')); }, { once: true });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const call = async (): Promise<{ answered: boolean; failures: FailureClass[] }> => {
  const failures: FailureClass[] = [];
  const r = await decide(STATE, Q, { purpose: 'probe', patienceMs: 60_000, onFailure: (f) => failures.push(f) });
  return { answered: r !== null, failures };
};
const warm = async (): Promise<void> => { boxRatio = 0.2; await call(); };

describe('a slow box: calls take 2x the formula\'s own time', () => {
  it('today every call is cut; here a few cuts teach the patience until calls answer', async () => {
    await warm();
    boxRatio = 2 * PRIOR_PACE;   // twice what the formula allows
    const formula = decideTimeoutMs(tokens, 1, true);
    expect(boxRatio * FIT).toBeGreaterThan(formula);
    const first = await call();
    expect(first.failures).toEqual(['timeout']);   // the first call is cut exactly as before
    const cut: boolean[] = [!first.answered];
    for (let i = 0; i < 6 && cut[cut.length - 1]; i++) { cut.push(!(await call()).answered) }
    expect(cut[cut.length - 1]).toBe(false);       // patience grew until the box answered
    expect(cut.filter(Boolean).length).toBeLessThan(5);   // after a FEW cut calls, not forever
    expect(measuredDecideTimeoutMs(STATE, 1)).toBeGreaterThan(formula);
    expect((await call()).answered).toBe(true);    // and it stays answering
  }, 60_000);

  it('the longer patience is what a waited ask is given too', async () => {
    await warm();
    boxRatio = 2 * PRIOR_PACE;
    await call();   // cut: the model is unloaded again, so the formula's own figure is the cold one
    expect(measuredDecideTimeoutMs(STATE, 1)).toBeGreaterThan(decideTimeoutMs(tokens, 1, false));
  }, 30_000);
});

describe('a fast box keeps at least today\'s behaviour', () => {
  it('answers fast: the pace stays at the prior and the patience is exactly the formula\'s', async () => {
    await warm();
    for (let i = 0; i < 5; i++) { boxRatio = 0.4; expect((await call()).answered).toBe(true); }
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
    expect(measuredDecideTimeoutMs(STATE, 1)).toBe(decideTimeoutMs(tokens, 1, true));
  }, 30_000);

  it('a cold box starts at the formula', () => {
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
    expect(measuredDecideTimeoutMs(STATE, 1)).toBe(decideTimeoutMs(tokens, 1, false));
  });

  it('one cut that a later answer proves was merely slow does not keep the patience raised forever', async () => {
    await warm();
    boxRatio = 2 * PRIOR_PACE; await call();            // cut at 2.05x
    boxRatio = 2.5; expect((await call()).answered).toBe(true);   // answered, at 2.5x: the cut was only a slow call
    expect(decidePace('m-decision')).toBeCloseTo(1.25 * 2.5, 1);   // set by what the box DID, not the cut's guess past it
  }, 30_000);
});

describe('a missing or corrupt store is the formula', () => {
  it.each([['not json {'], ['{"a":1}'], ['[[1,"x",0],null,[1,-3,0],[2,5]]'], ['"text"']])('stored %s → the prior, and the call still goes', async (raw) => {
    db().prepare("INSERT INTO config (key, value, updated_at) VALUES ('decide_pace.m-decision', ?, datetime('now'))").run(raw);
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
    boxRatio = 0.2;
    expect((await call()).answered).toBe(true);
  });

  it('no table at all (the store cannot be read or written) → the prior, the call still answers', async () => {
    boxRatio = 0.2;
    db().exec('DROP TABLE config');
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
    expect((await call()).answered).toBe(true);
  });

  it('a corrupt store is replaced by the next sample, not kept broken', async () => {
    db().prepare("INSERT INTO config (key, value, updated_at) VALUES ('decide_pace.m-decision', 'garbage', datetime('now'))").run();
    boxRatio = 0.2;
    await call();
    const raw = (db().prepare("SELECT value FROM config WHERE key = 'decide_pace.m-decision'").get() as { value: string }).value;
    expect(Array.isArray(JSON.parse(raw))).toBe(true);
  });
});
