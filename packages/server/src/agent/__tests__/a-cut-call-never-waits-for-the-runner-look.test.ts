// proof-fix T review — THE REAL WIRING OF THE RUNNER LOOK, over a throwaway local HTTP stub (never the real Ollama).
//
// A stub on an ephemeral 127.0.0.1 port plays Ollama (`/api/ps`, `/v1/systemone`) AND the model's runner (`/slots`); the
// process list is stubbed to name that port as the runner. Covers the /api/ps -> ps -> /slots chain, the look's timing,
// its abort, and that a call cut by its own clock never waits for a look still running.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../costs/tracker.js', () => ({ recordCost: () => undefined, getDailySpend: () => 0 }));
/** The stubbed process list: what `ps` shows, and how long it takes to show it. */
const procs = { port: 0, delayMs: 0, extraRunner: false, asked: 0 };
vi.mock('../../process-identity.js', async (orig) => ({
  ...(await orig<typeof import('../../process-identity.js')>()),
  processCommandsAsync: async (signal: AbortSignal) => {
    procs.asked++;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, procs.delayMs);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (signal.aborted) return '';
    const line = (port: number): string => `/x/llama-server --model /m/b --port ${port} --host 127.0.0.1 --no-webui -c ${CTX} -np 1`;
    return [line(procs.port), ...(procs.extraRunner ? [line(procs.port + 1)] : [])].join('\n');
  },
}));

import { runMigrations } from '../../db/migrations.js';
import { decide, measuredDecideTimeoutMs, __forgetResidencyForTests, type Question, type FailureClass } from '../decide.js';
import { decidePace, PRIOR_PACE } from '../decide-pace.js';
import { runnerIsWorking, watchRunner } from '../../services/ollama-runner-progress.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const CTX = 28_672;
const MODEL = STANDARD_DECISION_MODEL.tag;
const Q: Record<string, Question> = { yes: { type: 'noul', instructions: 'Is `x` yes?' } };
const STATE = { x: 'a reply the turn waits on' };
const stub = { server: null as http.Server | null, hits: [] as string[], working: true, slotsDelayMs: 0 };
const base = (): string => `http://127.0.0.1:${(stub.server!.address() as AddressInfo).port}`;

beforeEach(async () => {
  stub.hits = []; stub.working = true; stub.slotsDelayMs = 0; procs.delayMs = 0; procs.extraRunner = false; procs.asked = 0;
  stub.server = http.createServer((req, res) => {
    stub.hits.push(req.url ?? '');
    if (req.url === '/api/ps') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: MODEL, context_length: CTX }] })); return; }
    if (req.url === '/slots') {
      setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ is_processing: stub.working, n_prompt_tokens_processed: stub.working ? 512 : 0 }])); }, stub.slotsDelayMs);
      return;
    }
    // /v1/systemone: the model never answers
  });
  await new Promise<void>((r) => stub.server!.listen(0, '127.0.0.1', r));
  procs.port = (stub.server.address() as AddressInfo).port;
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __forgetResidencyForTests();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(base());
  mockDb.current.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(MODEL, MODEL);
});
afterEach(async () => {
  stub.server!.closeAllConnections();
  await new Promise<void>((r) => stub.server!.close(() => r()));
  mockDb.current?.close(); mockDb.current = null;
});

describe('the chain: /api/ps -> the process list -> /slots', () => {
  it('a runner taking in the prompt is a sign of life; an idle one is not', async () => {
    expect(await runnerIsWorking(base(), MODEL, 2_000)).toBe(true);
    expect(stub.hits).toEqual(['/api/ps', '/slots']);   // in that order, and nothing else
    stub.working = false;
    expect(await runnerIsWorking(base(), MODEL, 2_000)).toBe(false);
  });
  it('two runners with the model\'s context cannot be told apart: no sign of life, and /slots is never read', async () => {
    procs.extraRunner = true;
    expect(await runnerIsWorking(base(), MODEL, 2_000)).toBe(false);
    expect(stub.hits).toEqual(['/api/ps']);
  });
  it('a look is bounded by its own time and by stop(): a slow runner answer is not waited for', async () => {
    stub.slotsDelayMs = 5_000;
    const t = Date.now();
    expect(await runnerIsWorking(base(), MODEL, 300)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1_500);
    const w = watchRunner(base(), MODEL, 400, 300);   // looks at 100 ms... but stop() ends it
    w.stop();
    await new Promise((r) => setTimeout(r, 250));
    expect(stub.hits.filter((h) => h === '/api/ps')).toHaveLength(1);   // only the first look above: the stopped one never started
    expect(w.working()).toBe(false);
  });
});

describe('a call cut by its own clock', () => {
  it('whose look is still running when it is cut fails on time and teaches nothing', async () => {
    procs.delayMs = 10_000;   // the look is slow: it cannot finish before the cut
    const failures: FailureClass[] = [];
    const clock = measuredDecideTimeoutMs(STATE, 1);   // cold: the load time is in it
    const t = Date.now();
    const r = await decide(STATE, Q, { purpose: 'probe', patienceMs: 60_000, onFailure: (f) => failures.push(f) });
    const took = Date.now() - t;
    expect(r).toBeNull();
    expect(failures).toEqual(['timeout']);
    expect(procs.asked).toBe(1);                       // the look did start (it was real, and slow)...
    expect(took).toBeLessThan(clock + 400);            // ...and the failure did not wait for it
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
  }, 30_000);

  it('whose look finished and saw work teaches slowness, through the whole real chain', async () => {
    const failures: FailureClass[] = [];
    const r = await decide(STATE, Q, { purpose: 'probe', patienceMs: 60_000, onFailure: (f) => failures.push(f) });
    expect(r).toBeNull();
    expect(failures).toEqual(['timeout']);
    expect(stub.hits).toContain('/slots');
    expect(decidePace('m-decision')).toBeGreaterThan(PRIOR_PACE);
  }, 30_000);

  it('whose runner shows no work teaches nothing', async () => {
    stub.working = false;
    await decide(STATE, Q, { purpose: 'probe', patienceMs: 60_000 });
    expect(decidePace('m-decision')).toBe(PRIOR_PACE);
  }, 30_000);
});
