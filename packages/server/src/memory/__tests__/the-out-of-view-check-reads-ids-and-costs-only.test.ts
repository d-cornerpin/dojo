// A lived-in agent's turn does not read its whole session: the out-of-view check behind the assembly door weighs
// only the rows still owed a summary, by id and cost. Measured through the real door and the real assembler on a
// migrated database: the message text the turn pulls in stays level as the summarised history grows tenfold.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => undefined, storeEmbedding: async () => undefined, refreshEmbedding: () => undefined,
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'The owner asked which bay; bay four was named each time.', toolCalls: [], usage: {}, stopReason: 'stop' }),
  getContextWindow: () => 32_000, getModelOutputCap: () => 4096, getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary } from '../dag.js';
import { assembleContext } from '../assembler.js';
import { assembleWithNothingOutOfViewUnsummarised } from '../out-of-view.js';

const AGENT = 'agent-lived-in';
const OWN = 'model-own';

/** `turns` old exchanges all covered by one note, then a live tail whose last long row cuts older ones out of view. */
function seed(turns: number): void {
  const db = mockDb.current!;
  db.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p-own', 'Own', 'openai-compatible', 'api_key', 'http://127.0.0.1:1/v1')").run();
  db.prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled, input_cost_per_m, output_cost_per_m)
    VALUES (?, 'p-own', 'own', 'Own', 32000, 4096, '["text","tools"]', 1, 1, 1)`).run(OWN);
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Keeper', 'idle', ?, '{}')").run(AGENT, OWN);
  const ids: string[] = [];
  let n = 0;
  const row = (role: 'user' | 'assistant', content: string): string =>
    insertMessage({ agentId: AGENT, role, lane: 'owner', senderId: role === 'user' ? 'owner' : undefined, content, turnNumber: ++n }).id;
  for (let i = 0; i < turns; i++) ids.push(row('user', `old ask ${i} about bay ${i}`), row('assistant', `old answer ${i}: bay ${i} is clear`));
  createLeafSummary(AGENT, 'The owner asked about every bay; each was clear.', 12, ids, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
  for (let i = 0; i < 14; i++) row(i % 2 === 0 ? 'user' : 'assistant', `live line ${i}: which bay is the next crate for?`);
  row('assistant', 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(620));
}

/** Rows carrying message text that the database handed to the turn. */
async function textRowsReadByATurn(): Promise<number> {
  const db = mockDb.current!;
  const prepare = db.prepare.bind(db);
  let read = 0;
  const counted = (rows: unknown): unknown => {
    for (const r of Array.isArray(rows) ? rows : rows ? [rows] : []) if (r && typeof r === 'object' && 'content' in r) read++;
    return rows;
  };
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const stmt = prepare(sql);
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    return Object.assign(stmt, { all: (...a: unknown[]) => counted(all(...a)), get: (...a: unknown[]) => counted(get(...a)) });
  }) as typeof db.prepare);
  try {
    await assembleWithNothingOutOfViewUnsummarised(AGENT, 32_000, () => assembleContext(AGENT, OWN));
  } finally { spy.mockRestore(); }
  return read;
}

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the out-of-view check reads ids and costs only', () => {
  it('a history ten times longer, all summarised, costs the turn no more message text', async () => {
    seed(100);
    const short = await textRowsReadByATurn();
    mockDb.current!.close();
    mockDb.current = new Database(':memory:');
    runMigrations();
    seed(1_000);
    const long = await textRowsReadByATurn();
    const notes = (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM summaries').get() as { n: number }).n;
    expect(notes, 'non-vacuity: rows were cut out of view and folded').toBeGreaterThan(1);
    expect(short, 'non-vacuity: the turn reads its live tail').toBeGreaterThan(0);
    expect(long - short, 'text rows read beyond the short history').toBeLessThan(20);
  });
});
