// proof-fix N — A CALLER THAT WAITS IS GIVEN THE MEASURED TIME OF THE CALL AHEAD OF IT, NOT ONLY ITS OWN.
//
// The H8 run lost the reply-claim answers of almost every reply: every one of them was a waited ask (a question the
// owner put on the model) whose patience was its OWN call's measured time, counted from when it asked, while the one
// queue was serving a background summary check of a 28k-token span that took ~30 s. The ask left the queue unsent
// at its patience every time one was in flight, and was answered (in ~5.3 s) every time it arrived in a gap.
// A waited caller's patience now also covers the measured allowance of what it must wait behind (the call in flight
// and the waited callers ahead of it): still bounded, still derived from the same measured formula, and a call ahead
// that truly fails is cut by its own clock. Every /v1/systemone call is a scripted fetch: no real model is asked.
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
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const db = (): Database.Database => mockDb.current!;
const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
/** How long the scripted model takes for the call AHEAD (the waiter's own call answers at once). */
let aheadTakesMs = 0;
/** The call ahead ignores its own clock (a hung transport): only the waiter's bound can release the waiter. */
let aheadIgnoresItsClock = false;
const sent: string[] = [];
/** Ends a scripted call ahead that is still running, so no test leaves the one queue held for the next. */
let endAhead: () => void = () => undefined;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __forgetResidencyForTests();
  sent.length = 0;
  aheadTakesMs = 0;
  aheadIgnoresItsClock = false;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47142', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const ahead = (init?.body ?? '').includes('ahead');
    sent.push(ahead ? 'ahead' : 'waiter');
    if (ahead) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, aheadTakesMs);
        endAhead = () => { clearTimeout(t); resolve(); };
        if (!aheadIgnoresItsClock) init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    }
    return Response.json({ answers: { yes: { noul: 0.9 } }, usage: { input_tokens: 40 } });
  }));
});
afterEach(() => { endAhead(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WAITER_STATE = { x: 'a reply the turn waits on' };

describe('a waited ask behind a long call in flight', () => {
  it('the call ahead takes about 3x the waiter\'s own measured time: the waiter is answered, not cut', async () => {
    const own = measuredDecideTimeoutMs(WAITER_STATE, 1);
    aheadTakesMs = own * 3;
    const ahead = decide({ ahead: 'a long background check' }, Q, { purpose: 'summary_check', background: true, patienceMs: own * 6, timeoutMs: own * 6 });
    await tick();
    const failures: FailureClass[] = [];
    const started = Date.now();
    const waited = await decide(WAITER_STATE, Q, { purpose: 'reply_claims', agentId: 'agent-x', patienceMs: own, onFailure: (f) => failures.push(f) });
    expect(failures).toEqual([]);
    expect(waited).not.toBeNull();   // the model's answer is kept
    expect(Date.now() - started).toBeGreaterThanOrEqual(own * 3 - 100);   // it really did wait out the call ahead
    expect(sent).toEqual(['ahead', 'waiter']);
    expect(await ahead).not.toBeNull();
  }, 30_000);

  it('a call ahead that truly fails is cut by its own clock, and the waiter is then served', async () => {
    const own = measuredDecideTimeoutMs(WAITER_STATE, 1);
    aheadTakesMs = 60_000;   // the model never answers it
    const aheadFailures: FailureClass[] = [];
    const ahead = decide({ ahead: 'a check that hangs' }, Q, { purpose: 'summary_check', background: true, patienceMs: own * 6, timeoutMs: own * 2, onFailure: (f) => aheadFailures.push(f) });
    await tick();
    const waited = await decide(WAITER_STATE, Q, { purpose: 'reply_claims', agentId: 'agent-x', patienceMs: own });
    expect(await ahead).toBeNull();
    expect(aheadFailures).toEqual(['timeout']);   // the rules decided the model failed THAT call
    expect(waited).not.toBeNull();
  }, 30_000);

  it('never hostage: when the call ahead outlives even its own clock, the waiter leaves at its bound with the rule', async () => {
    const own = measuredDecideTimeoutMs(WAITER_STATE, 1);
    aheadTakesMs = 60_000;
    aheadIgnoresItsClock = true;   // a transport that does not honour the abort
    const aheadClock = own * 2;
    void decide({ ahead: 'a check that hangs' }, Q, { purpose: 'summary_check', background: true, patienceMs: aheadClock, timeoutMs: aheadClock });
    await tick();
    const failures: FailureClass[] = [];
    const started = Date.now();
    const waited = await decide(WAITER_STATE, Q, { purpose: 'reply_claims', agentId: 'agent-x', patienceMs: own, onFailure: (f) => failures.push(f) });
    const took = Date.now() - started;
    expect(waited).toBeNull();
    expect(failures).toEqual(['patience']);
    expect(took).toBeGreaterThanOrEqual(own + aheadClock - 25 - 100);   // its own time plus what remained of the call ahead…
    expect(took).toBeLessThan(own + aheadClock + 1_000);                 // …and no longer
    expect(sent).toEqual(['ahead']);
  }, 30_000);
});
