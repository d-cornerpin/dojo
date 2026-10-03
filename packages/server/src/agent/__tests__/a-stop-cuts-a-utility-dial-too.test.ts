// ⚠ t88 DELIVERABLE 4 — THE STOP-BUTTON PROBE, as a clause rather than a screenshot.
//
// T83 (shipped v3.1.26) claims every provider call is abortable by the agent's stop, and
// `a-stop-stops-and-the-status-tells-the-truth.test.ts` proves that at the REGISTRY level: every
// registered controller is cut, and a census proves the one dial site is the one registration site.
//
// WHAT THAT DID NOT COVER is the surface t88 adds. A utility dial now passes an `abortSignal` of its
// own — the 30-second latency budget — and the question the brief asks is whether a dial in flight
// really stops. Two ways it could be wrong:
//   · the budget signal REPLACES the stop linkage, so the owner's stop no longer reaches this call;
//   · the budget abort surfaces as an agent-level ERROR, which is what `bestEffort` exists to prevent
//     and what a user would read as "something broke" when the engine merely gave up on a title.
//
// ── WHY THIS IS A CLAUSE AND NOT A LIVE RUN ──
// The brief asks for the probe on the dev box with a slow LOCAL system model. That box has NO OLLAMA
// RUNTIME INSTALLED (its system tier is a cloud model), so the staged conditions cannot exist there —
// and a fast cloud dial finishes before a human can press anything. A hanging HTTP stub on the real
// transport reproduces exactly the condition that matters (a dial in flight that will never answer)
// and it reproduces it every time, for every future reader. The report records the live limitation.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import realOs from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const warnSpy = vi.fn();
const errorSpy = vi.fn();
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(),
    warn: (...a: unknown[]) => warnSpy(...a),
    error: (...a: unknown[]) => errorSpy(...a),
  }),
}));
vi.mock('../../gateway/routes/services.js', () => ({
  recordProviderError: vi.fn(), recordProviderSuccess: vi.fn(),
}));
vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-t88-stop-probe');
  return {
    homeDir: (): string => dir,
    dojoDir: (...s: string[]): string => p.join(dir, '.dojo', ...s),
    isTestRun: (): boolean => true,
  };
});
const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const o = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(o.tmpdir(), 'dojo-t88-stop-probe', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { clearSecretsCache } from '../../config/loader.js';
import { callModel, clearClientCache } from '../model.js';
import { activeAbortControllers, stoppedAgents } from '../shared-state.js';

vi.setConfig({ testTimeout: 20_000 });

const FAKE_DOJO = path.join(realOs.tmpdir(), 'dojo-t88-stop-probe', '.dojo');
const AGENT = 'a-fixture';

let server: http.Server;
let stubUrl = '';
/** Held open so the dial is genuinely in flight — the condition a stop has to cut. */
let openResponses: http.ServerResponse[] = [];
let dialsReceived = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/chat')) {
      res.writeHead(404); res.end('{}'); return;
    }
    dialsReceived += 1;
    req.on('data', () => {});
    req.on('end', () => {
      // Headers, then silence: a model that has accepted the request and will never answer. This is
      // the 275-second call, in one line.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      openResponses.push(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const r of openResponses) { try { r.end(); } catch { /* already gone */ } }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  fs.rmSync(FAKE_DOJO, { recursive: true, force: true });
  clearSecretsCache();
  clearClientCache();
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local-ollama', 'Local Ollama', 'ollama', ?, 'none', 1, datetime('now'), datetime('now'))
  `).run(stubUrl);
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m-slow-local', 'local-ollama', 'Slow Local', 'slow-local', '["text"]', 32768, 4096, 1,
            datetime('now'), datetime('now'))
  `).run();
  db.prepare(`
    INSERT INTO agents (id, name, model_id, status, config, created_at, updated_at)
    VALUES (?, 'Fixture Agent', 'm-slow-local', 'idle', '{}', datetime('now'), datetime('now'))
  `).run(AGENT);
  openResponses = [];
  dialsReceived = 0;
  warnSpy.mockClear();
  errorSpy.mockClear();
  stoppedAgents.delete(AGENT);
  activeAbortControllers.delete(AGENT);
});

afterEach(() => {
  for (const r of openResponses) { try { r.end(); } catch { /* already gone */ } }
  stoppedAgents.delete(AGENT);
  activeAbortControllers.delete(AGENT);
  mockDb.current?.close();
  mockDb.current = null;
});

/** A title dial against a model that will never answer. */
const hangingTitleDial = (extra: Record<string, unknown> = {}): Promise<unknown> => callModel({
  agentId: AGENT,
  modelId: 'm-slow-local',
  messages: [{ role: 'user', content: 'Can you look at the invoice I sent earlier?' }],
  systemPrompt: '',
  tools: false,
  purpose: 'ask_title',
  bestEffort: true,
  ...extra,
});

/** Wait until the stub has the dial, so "in flight" is a fact and not a hope. */
const untilInFlight = async (): Promise<void> => {
  for (let i = 0; i < 200 && dialsReceived === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(dialsReceived, 'the stub never received the dial').toBeGreaterThan(0);
};

describe('the stop button reaches a utility dial in flight', () => {
  it('⚠ THE PROBE: a hanging ask-title dial is CUT by the agent\'s stop', async () => {
    const inFlight = hangingTitleDial().catch((e: unknown) => e);
    await untilInFlight();

    // The dial registered itself, which is the mechanism T83 added and the census pins.
    expect(activeAbortControllers.get(AGENT)?.size ?? 0).toBeGreaterThan(0);

    // The stop, as the runtime fires it: mark the agent stopped and abort what it has in flight.
    stoppedAgents.add(AGENT);
    for (const c of activeAbortControllers.get(AGENT) ?? []) c.abort();

    const outcome = await inFlight;
    expect(outcome, 'a stopped dial must not resolve as a successful answer').toBeInstanceOf(Error);
  });

  it('⚠ AND ITS OWN BUDGET CUTS IT TOO, without the stop — and stays a WARN', async () => {
    // The 30-second budget, with the clock turned down to keep this suite fast: the mechanism under
    // test is the signal, not the number (the number is asserted in the dial's own clauses).
    const outcome = await hangingTitleDial({ abortSignal: AbortSignal.timeout(300) })
      .catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(Error);

    // ⚠ THE SEMANTIC THE BRIEF ASKS FOR: an aborted best-effort dial logs a warn and never surfaces as
    // an agent error. `resolveAskTitle` then returns null and the ticket keeps the id it was filed
    // with — a person sees a ticket with a plain title, not an error.
    expect(errorSpy, 'a best-effort abort must not log at error level').not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('the budget signal does NOT replace the stop linkage — both reach the same dial', async () => {
    // This is the way the fix could have been wrong: passing our own signal and thereby taking the
    // call out of the registry the stop button uses.
    const inFlight = hangingTitleDial({ abortSignal: AbortSignal.timeout(15_000) })
      .catch((e: unknown) => e);
    await untilInFlight();
    expect(activeAbortControllers.get(AGENT)?.size ?? 0).toBeGreaterThan(0);

    stoppedAgents.add(AGENT);
    for (const c of activeAbortControllers.get(AGENT) ?? []) c.abort();
    const outcome = await inFlight;
    expect(outcome).toBeInstanceOf(Error);
    // …and it was the stop that cut it, well inside the budget window.
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
