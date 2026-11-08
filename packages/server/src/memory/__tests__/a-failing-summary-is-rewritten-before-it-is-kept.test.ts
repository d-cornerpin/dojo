// Owner rulings "Check each summary against the decision model" and "Redo bad summaries": a summary the decision model
// reads as describing something as currently pending or owed is rewritten once by the agent's own model before it is
// kept, and no card is shown. It never loops: when the rewrite also fails, the rows stay whole and that span is tried
// again only on the next real signal (new rows join it, or its writer changes). The writer and the decision model are
// scripted (PENDING fails the check).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const cards = vi.hoisted(() => ({ list: [] as Array<{ code?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { code?: string }) => { cards.list.push(e); }, stampPersistedRow: (e: unknown) => e }));
const writer = vi.hoisted(() => ({ outputs: [] as string[], prompts: [] as string[] }));
vi.mock('../../agent/model.js', () => ({
  callModel: async (p: { systemPrompt: string }) => {
    writer.prompts.push(p.systemPrompt);
    return { content: writer.outputs.shift() ?? 'a plain summary', toolCalls: [], usage: {} };
  },
  getContextWindow: () => 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { runMigrations } from '../../db/migrations.js';
import { generateSummary } from '../summarize.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-redo-check';
const SOURCE = '[USER · the owner] please draft the offsite budget\n---\n[ASSISTANT · the agent] drafting it now';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  cards.list.length = 0;
  writer.outputs = [];
  writer.prompts = [];
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47131', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('writer-small', 'ollama-local', 'w', 'w', '["chat"]', 32000, 1)`).run();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    return Response.json({ answers: { stated_current: { noul: state.summary.includes('PENDING') ? 0.91 : 0.05 } } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });  

let span = 0;
const write = (spanIds?: string[]) => generateSummary({ content: `${SOURCE}\n--- span ${span++}`, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds });
const checks = (): Array<{ outcome: string }> => db().prepare('SELECT outcome FROM summary_checks ORDER BY id').all() as Array<{ outcome: string }>;


describe('a summary that fails the accuracy check is rewritten before it is kept (no proof needed, no card)', () => {
  it('a failing summary is rewritten once, and the rewrite that passes is kept', async () => {
    writer.outputs = ['PENDING: the budget was sent and the task is closed.', 'The owner asked for the offsite budget; the agent is drafting it.'];
    const r = await write(['m-1', 'm-2']);
    expect(r).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget; the agent is drafting it.' });
    expect(writer.prompts).toHaveLength(2);                                     // the one rewrite
    expect(writer.prompts[1]).toContain('it described something as currently pending or owed');
    expect(checks().map((c) => c.outcome)).toEqual(['rewritten_ok']);
  });

  it('a rewrite that also fails is not kept: the rows stay whole, and no card of any kind is sent', async () => {
    writer.outputs = ['PENDING a.', 'PENDING b.'];
    const r = await write(['m-3', 'm-4']);
    expect(r.ok === false && r.checkFailed).toBe(true);
    expect(writer.prompts).toHaveLength(2);                                     // never a third try in the same pass
    expect(checks().map((c) => c.outcome)).toEqual(['not_kept']);
    expect(cards.list).toEqual([]);
  });

  it('repeated failures send no card either', async () => {
    writer.outputs = ['PENDING a.', 'PENDING b.', 'PENDING c.', 'PENDING d.', 'PENDING e.', 'PENDING f.'];
    for (let i = 0; i < 3; i++) expect((await write([`r-${i}`])).ok).toBe(false);
    expect(cards.list).toEqual([]);
  });

  it('never loops: the same span is not handed to a writer again until a real signal (new rows join it)', async () => {
    writer.outputs = ['PENDING a.', 'PENDING b.'];
    expect((await write(['s-1', 's-2'])).ok).toBe(false);
    const again = await write(['s-1', 's-2']);                                  // the same rows, nothing changed
    expect(again.ok === false && again.checkFailed).toBe(true);
    expect(writer.prompts).toHaveLength(2);                                     // the writer was not asked
    writer.outputs = ['The owner asked for the offsite budget.'];
    expect(await write(['s-1', 's-2', 's-3'])).toMatchObject({ ok: true });     // a new row joined: tried again
  });

  it('a summary that passes is kept as written, the writer asked once', async () => {
    writer.outputs = ['The owner asked for the offsite budget.'];
    expect(await write(['p-1'])).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget.' });
    expect(writer.prompts).toHaveLength(1);
    expect(checks().map((c) => c.outcome)).toEqual(['ok']);
  });
});
