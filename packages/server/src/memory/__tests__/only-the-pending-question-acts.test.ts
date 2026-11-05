// ════════════════════════════════════════════════════════════════════════════════════════
// Summary-check round (owner rulings). 1: only the question that measured reliable ACTS: "does the summary describe
// something as currently pending or owed" (34 of 40 agreement, overhaul-plans/v35-writer-measure.md). A summary that
// fails only that question is rewritten by the agent's own model; "invented" and "dropped" are recorded as shadow
// verdicts and decide nothing. 2: the two unreliable questions are reworded with the owner's insight (a summary
// rewords by design; ask whether it introduces meaning, and whether it leaves out a decision, promise, name, date,
// number or unfinished task). The writer is scripted; INVENTED fails "invented", PENDING fails "stated_current".
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
const asked: Array<Record<string, { instructions?: string }>> = [];
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

const AGENT = 'agent-only-pending-acts';
const SOURCE = '[USER · the owner] please draft the offsite budget\n---\n[ASSISTANT · the agent] drafting it now';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  asked.length = 0;
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  cards.list.length = 0;
  writer.outputs = [];
  writer.prompts = [];
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47131', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES ('writer-small', 'ollama-local', 'w', 'w', '["chat"]', 32000, 1)`).run();
  // The decision model: INVENTED → the "invented" question fails; PENDING → "stated_current" fails.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { state: { summary: string }; questions?: Record<string, { instructions?: string }> };
    if (body.questions) asked.push(body.questions);
    const { state } = body;
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



describe('only the pending question acts; the other two are shadow', () => {
  it('a summary failing only "invented" is kept as written, the writer asked once, its verdict recorded', async () => {
    writer.outputs = ['INVENTED: the budget was sent.'];
    expect(await write(['i-1'])).toMatchObject({ ok: true, text: 'INVENTED: the budget was sent.' });
    expect(writer.prompts).toHaveLength(1);
    expect(checks()).toEqual([{ outcome: 'ok', invented: 0.93 }]);   // the shadow numbers are kept
  });

  it('a summary failing "pending" is rewritten by the agent\'s own model, and the passing rewrite is kept', async () => {
    writer.outputs = ['PENDING: the agent still owes the budget.', 'The owner asked for the offsite budget; the agent drafted it.'];
    expect(await write(['s-1'])).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget; the agent drafted it.' });
    expect(writer.prompts[1]).toContain('it described something as currently pending or owed');
    expect(writer.prompts[1]).not.toContain('introduced');
    expect(checks().map((c) => c.outcome)).toEqual(['rewritten_ok']);
  });

  it('the two shadow questions are asked in the owner\'s new wording', async () => {
    writer.outputs = ['The owner asked for the offsite budget.'];
    await write(['w-1']);
    const q = asked[0];
    expect(q.invented?.instructions).toBe('Does `summary` introduce a fact, concept or meaning that `source_rows` never included? Rewording or shortening what `source_rows` says is not a new fact.');
    expect(q.dropped?.instructions).toBe('Does `source_rows` contain a decision, a promise, a name, a date, a number or an unfinished task that `summary` does not mention?');
    expect(q.stated_current?.instructions).toBe('Does `summary` describe anything as currently pending or owed?');
  });
});
