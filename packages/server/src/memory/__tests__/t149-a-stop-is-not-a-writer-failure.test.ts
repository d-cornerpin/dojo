// t149 F3 — THE OWNER'S STOP DURING A BACKGROUND SUMMARY IS NOT A SUMMARY WRITER'S FAILURE.
//
// Live (walk, L140-10/L140-18): Stop pressed while a placeholder replacement was mid-call. Stop
// reaches every provider call the agent has in flight through the registry (T83 — owner ruling 9,
// "stop stops everything"), so the summary's call was cut, correctly. But the summary code knew only
// the CALLER's signal, which Stop never touches, so it read the cut as the writer failing: it marked
// that writer "not answering", walked on to the next, which the stop fence refused at the door, marked
// that one too — every enabled model, a dozen log lines — and then filed a "compaction is failing"
// defect. After the stop nothing could write a summary until a person happened to speak.
//
// THE DOORS: the real `stopAgent`, the real `callModel` (registry, fence, ollama transport) against
// a stub endpoint that hangs the first writer, the real placeholder replacement.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
const owner = vi.hoisted(() => ({ cards: [] as Array<{ type?: string; code?: string }> }));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: { type?: string; code?: string }) => { owner.cards.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));
// The REAL callModel, only watched: which writers were actually asked.
const dialed = vi.hoisted(() => ({ models: [] as string[] }));
vi.mock('../../agent/model.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/model.js')>('../../agent/model.js');
  return {
    ...actual,
    callModel: (p: Parameters<typeof actual.callModel>[0]) => { dialed.models.push(p.modelId); return actual.callModel(p); },
  };
});

import { replaceUncondensedPlaceholders, writeUncondensedPlaceholders } from '../uncondensed-placeholder.js';
import { eligibleSummaryWriters, summaryWriterCandidates, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { insertMessage } from '../message-store.js';
import { runMigrations } from '../../db/migrations.js';
import { stoppedAgents, stopFencedRuns, activeAbortControllers, backgroundDrains } from '../../agent/shared-state.js';
import { clearClientCache } from '../../agent/model.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { __resetBreakersForTests } from '../../providers/billing-breaker.js';

vi.setConfig({ testTimeout: 20_000 });

const AGENT = 'agent-t149-stop';
const OWN = 'model-t149-own';
const SECOND = 'model-t149-second';
const THIRD = 'model-t149-third';
const db = (): Database.Database => mockDb.current!;

let server: http.Server;
let stubUrl = '';
/** 'hang' leaves the call in flight (headers, then silence); 'answer' replies with a summary. */
let ownMode: 'hang' | 'answer' = 'hang';
let openResponses: http.ServerResponse[] = [];
let wire: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const model = (JSON.parse(raw || '{}') as { model?: string }).model ?? '';
      wire.push(model);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (model === 'own' && ownMode === 'hang') { openResponses.push(res); return; }
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'The crew counted the depot and filed the manifests.' } })}\n`);
      res.end(`${JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 12 })}\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of openResponses) { try { r.end(); } catch { /* gone */ } }
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  clearClientCache();
  ownMode = 'hang'; openResponses = []; wire = [];
  dialed.models.length = 0; owner.cards.length = 0;
  backgroundDrains.clear(); stoppedAgents.clear(); stopFencedRuns.clear(); activeAbortControllers.clear();
  __resetBrakesForTests(); __resetBreakersForTests(); __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  const prov = db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES (?, ?, 'ollama', ?, 'none', 1)");
  for (const p of ['p-own', 'p-second', 'p-third']) prov.run(p, p, stubUrl);
  const model = db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
     VALUES (?, ?, ?, ?, 32000, 4096, '["text","tools"]', 1, ?, 0)`,
  );
  model.run(OWN, 'p-own', 'own', 'Own', 3);
  model.run(SECOND, 'p-second', 'second', 'Second', 0.1);
  model.run(THIRD, 'p-third', 'third', 'Third', 0.2);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, OWN);
  for (let t = 1; t <= 8; t++) {
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[u${t}] Which bay is the next crate for?`, turnNumber: t });
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[a${t}] Bay four, beside the ramp.`, turnNumber: t });
  }
  const through = (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
  expect(writeUncondensedPlaceholders(AGENT, through), 'precondition: rows under placeholder notes').toBeGreaterThan(0);
});
afterEach(() => {
  for (const r of openResponses) { try { r.end(); } catch { /* gone */ } }
  stoppedAgents.clear(); stopFencedRuns.clear(); activeAbortControllers.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

const placeholders = (): number =>
  (db().prepare("SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND kind = 'uncondensed'").get(AGENT) as { n: number }).n;
const untilInFlight = async (): Promise<void> => {
  for (let i = 0; i < 400 && !wire.includes('own'); i++) await new Promise((r) => setTimeout(r, 25));
  expect(wire, 'the first writer\'s call never reached the wire').toContain('own');
};

describe('t149 F3 — Stop during a background summary', () => {
  it.fails('cuts the call, marks no writer failed, walks no further and files no defect; the replacement resumes on its own later path', async () => {
    const { stopAgent } = await import('../../agent/runtime.js');
    const run = replaceUncondensedPlaceholders(AGENT);
    await untilInFlight();

    stopAgent(AGENT);                                   // the owner presses Stop — the real door
    await run;

    // The stop cut the in-flight call and nothing after it was asked.
    expect(dialed.models, 'after the cut call, no other writer was walked to').toEqual([OWN]);
    // No writer is marked: every candidate is still eligible, for this agent and for others.
    const all = summaryWriterCandidates(OWN);
    expect(all.length).toBe(3);
    expect(eligibleSummaryWriters(OWN, AGENT)).toEqual(all);
    expect(eligibleSummaryWriters(OWN, 'another-agent')).toEqual(all);
    // No "compaction is failing" card: the owner stopping the agent is not a defect.
    expect(owner.cards.filter((c) => c.code === 'COMPACTION_FAILING')).toEqual([]);
    expect(placeholders(), 'the notes stand; nothing was lost').toBeGreaterThan(0);

    // LATER: a person speaks (lifts the stop), the very same replacement runs and the first
    // writer is used again — nothing waited for a reset.
    stoppedAgents.delete(AGENT); stopFencedRuns.delete(AGENT);
    ownMode = 'answer';
    await replaceUncondensedPlaceholders(AGENT);
    expect(dialed.models.slice(1)[0]).toBe(OWN);
    expect(placeholders(), 'the notes were replaced by real summaries').toBe(0);
  });

  it('CONTROL: a writer that genuinely fails (answers 500) is still passed over', async () => {
    // The stub answers 'own' with an empty body: a real writer failure, no Stop involved.
    ownMode = 'answer';
    const failing = http.createServer((_req, res) => { res.writeHead(500); res.end('boom'); });
    await new Promise<void>((r) => failing.listen(0, '127.0.0.1', r));
    db().prepare('UPDATE providers SET base_url = ? WHERE id = ?').run(`http://127.0.0.1:${(failing.address() as AddressInfo).port}`, 'p-own');
    clearClientCache();
    try {
      await replaceUncondensedPlaceholders(AGENT);
    } finally { await new Promise<void>((r) => failing.close(() => r())); }
    expect(eligibleSummaryWriters(OWN, AGENT)).not.toContain(OWN);
    expect(placeholders(), 'the next writer replaced the note').toBe(0);
  });
});
