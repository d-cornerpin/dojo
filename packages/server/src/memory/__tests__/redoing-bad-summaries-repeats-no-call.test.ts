// Summary-check round (owner ruling 1): only "stated_current" acts, so the failing fixture is PENDING (a summary that
// describes work as still owed); an INVENTED summary would now be a shadow verdict that decides nothing.
// ════════════════════════════════════════════════════════════════════════════════════════
// Re-review 2, S6: THE COST OF REDOING BAD SUMMARIES. With the check acting (OR-AUDIT-ANSWERS (c)), a failing span
// costs four model calls (write, check, rewrite, check). A span that failed twice was held only until new rows joined
// it, and on a busy conversation the open last chunk gains a row every pass, so a check that always fails re-ran the
// four calls on EVERY pass and compaction never landed.
// Now the refusal is a fact about the span's rows and its writer. A span is HANDLED for every pass after its refusal:
//   - the same rows, the same writer: held;
//   - an OPEN span (the last chunk, still growing) that holds a refused row: held, however many rows join;
//   - the span CLOSED (a later chunk exists, so its boundary is final) with new rows: tried once more;
//   - the agent's own model changed (the owner's pick): tried again. Another writer in the walk is NOT a signal
//     (fix round 2's ruling: a failed span is handed to no other writer).
// Counted below: writer calls and decision-model calls, across ten passes where the check always fails.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const cards = vi.hoisted(() => ({ list: [] as Array<{ code?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { code?: string }) => { cards.list.push(e); }, stampPersistedRow: (e: unknown) => e }));
const decisionCalls = { n: 0 };
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
import { modeFor } from '../../agent/decision-policy.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-s6-cost';
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
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('writer-other', 'ollama-local', 'o', 'o', '["chat"]', 32000, 1)`).run();
  decisionCalls.n = 0;
  db().prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES (?, 'A', 'writer-small', 'idle', '{}')").run(AGENT);
  // The decision model: INVENTED → the "invented" question fails; PENDING → "stated_current" fails.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    if (String(_url).endsWith('/v1/systemone')) decisionCalls.n += 1;
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    return Response.json({ answers: {
      invented: { noul: state.summary.includes('INVENTED') ? 0.93 : 0.04 },
      dropped: { noul: 0.06 },
      stated_current: { noul: state.summary.includes('PENDING') ? 0.91 : 0.05 },
    } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });  

let span = 0;
const write = (spanIds?: string[]) => generateSummary({ content: `${SOURCE}\n--- span ${span++}`, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds });
const checks = (): Array<{ outcome: string; invented: number | null }> =>
  db().prepare('SELECT outcome, invented FROM summary_checks ORDER BY id').all() as Array<{ outcome: string; invented: number | null }>;



let rows: string[] = [];
const pass = (opts: { open: boolean; modelId?: string }) => generateSummary({
  content: `${SOURCE}\n--- ${rows.join(',')}`, depth: 0, targetTokens: 400, agentId: AGENT,
  modelId: opts.modelId ?? 'writer-small', spanIds: [...rows], spanOpen: opts.open,
});
const calls = (): number => writer.prompts.length + decisionCalls.n;
const failing = () => { writer.outputs = Array.from({ length: 200 }, (_, i) => `PENDING ${i}.`); };

describe('S6: a span that failed its check is handled; ten passes of an always-failing check repeat no call', () => {
  it('the same span, ten passes: four calls on the first, none after', async () => {
    failing(); rows = ['r-1', 'r-2'];
    const perPass: number[] = [];
    for (let i = 0; i < 10; i++) { const before = calls(); await pass({ open: false }); perPass.push(calls() - before); }
    expect(perPass).toEqual([4, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('a busy conversation: a row joins the open last chunk every pass, and nothing is re-run', async () => {
    failing(); rows = ['b-1'];
    const perPass: number[] = [];
    for (let i = 0; i < 10; i++) { rows.push(`b-${i + 2}`); const before = calls(); await pass({ open: true }); perPass.push(calls() - before); }
    expect(perPass).toEqual([4, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('the real signals: the span closes with new rows (tried once more), the agent\'s own model changes (tried again)', async () => {
    failing(); rows = ['c-1', 'c-2'];
    await pass({ open: true });
    rows.push('c-3');
    let before = calls(); await pass({ open: false }); expect(calls() - before, 'closed with a new row: one more try').toBe(4);
    before = calls(); await pass({ open: false }); expect(calls() - before, 'and then held').toBe(0);
    db().prepare("UPDATE agents SET model_id = 'writer-other' WHERE id = ?").run(AGENT);   // the owner gives the agent another model
    before = calls(); await pass({ open: false, modelId: 'writer-other' }); expect(calls() - before, 'its own model changed: tried').toBe(4);
  });

  it('a check that passes costs the write and the check, nothing more', async () => {
    writer.outputs = ['The owner asked for the offsite budget.']; rows = ['p-1'];
    const r = await pass({ open: true });
    expect(r.ok).toBe(true);
    expect([writer.prompts.length, decisionCalls.n]).toEqual([1, 1]);
  });
});
