// t268 ruling 1 — THE SUMMARY CHECK RUNS IN SHADOW UNDER B3'S POLICY, like every other decide() question.
// B5 (`overhaul-plans/v35-writer-measure.md`) measured the check against a careful reading of 40 summaries:
// it passed 2 of the 12 faithful ones, and its "left something out" question scored below chance. So every
// summary is checked and the verdict recorded in `decision_shadow`, but nothing is refused, rewritten or held
// on that verdict until the policy flips the question to `model` on measured accuracy. The writer is
// scripted; every /v1/systemone call is a scripted fetch.
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
import { SUMMARY_CHECK_NOTICE_CODE, summaryCheckRefusedSince, summaryChecksSettled } from '../summary-check.js';
import { summaryWriterStatus, spanKeys, recordRefusedSpan } from '../summary-check-ledger.js';
import { modeFor } from '../../agent/decision-policy.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';
import { proveSummaryCheck } from './summary-check-proven.js';

const AGENT = 'agent-shadow-check';
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
  db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'writer-small')").run();
  // The decision model: INVENTED → the "invented" question fails; PENDING → "stated_current" fails.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    return Response.json({ answers: {
      invented: { noul: state.summary.includes('INVENTED') ? 0.93 : 0.04 },
      dropped: { noul: 0.06 },
      stated_current: { noul: state.summary.includes('PENDING') ? 0.91 : 0.05 },
    } });
  }));
});
afterEach(async () => { await summaryChecksSettled(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });   // t268 fix round 2: late checks are queued; none outlives its case

let span = 0;
const write = (spanIds?: string[]) => generateSummary({ content: `${SOURCE}\n--- span ${span++}`, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds });
const checks = (): Array<{ outcome: string; invented: number | null }> =>
  db().prepare('SELECT outcome, invented FROM summary_checks ORDER BY id').all() as Array<{ outcome: string; invented: number | null }>;
const notices = () => cards.list.filter((c) => c.code === SUMMARY_CHECK_NOTICE_CODE);

describe('in shadow (no measured accuracy yet): the check is asked and recorded, and decides nothing', () => {
  it('the policy has the three questions in shadow on a box with no judged rows', () => {
    for (const q of ['invented', 'dropped', 'stated_current']) expect(modeFor('summary_check', q)).toBe('shadow');
  });

  it('a failing verdict → the summary is kept as written, the writer asked once, the verdict recorded', async () => {
    writer.outputs = ['INVENTED: the budget was sent and the task is closed.'];
    const r = await write();
    expect(r).toMatchObject({ ok: true, text: 'INVENTED: the budget was sent and the task is closed.' });
    expect(writer.prompts).toHaveLength(1);                                   // no rewrite
    expect(writer.prompts[0]).not.toContain('accuracy check');
    await summaryChecksSettled();   // fix round 1 (M-2): in shadow the check runs after the summary is kept
    expect(checks()).toEqual([{ outcome: 'ok', invented: 0.93 }]);            // kept as written, with its numbers
    const shadow = db().prepare("SELECT question, rule_said, model_said FROM decision_shadow WHERE purpose = 'summary_check' ORDER BY question").all() as
      Array<{ question: string; rule_said: string; model_said: string }>;
    expect(shadow.map((s) => s.question)).toEqual(['dropped', 'invented', 'stated_current']);
    expect(JSON.parse(shadow[1].model_said)).toEqual({ type: 'noul', noul: 0.93 });
  });

  it('failures that repeat fire no notice, and the Summarization card does not say the writer is failing', async () => {
    writer.outputs = ['INVENTED a.', 'INVENTED b.', 'INVENTED c.', 'INVENTED d.'];
    for (let i = 0; i < 4; i++) expect((await write()).ok).toBe(true);
    expect(notices()).toEqual([]);
    expect(summaryWriterStatus()).toMatchObject({ failing: false });
  });

  it('no failed-span hold: a span refused earlier is still written, and the fold is not stopped', async () => {
    const ids = ['msg-1', 'msg-2'];
    recordRefusedSpan(spanKeys({ content: 'x', agentId: AGENT, modelId: 'writer-small', spanIds: ids }));
    db().prepare("INSERT INTO summary_checks (agent_id, writer_model_id, outcome, created_at) VALUES (?, 'writer-small', 'not_kept', ?)").run(AGENT, Date.now());
    writer.outputs = ['The owner asked for the offsite budget.'];
    expect(await write(ids)).toMatchObject({ ok: true });
    expect(writer.prompts).toHaveLength(1);
    expect(summaryCheckRefusedSince(AGENT, 0)).toBe(false);
  });
});

describe('once the policy flips a question to `model` on measured accuracy, today\'s acting behaviour returns', () => {
  it('all three proven: a failing summary is rewritten once, then not kept; the notice fires when it repeats', async () => {
    proveSummaryCheck();
    for (const q of ['invented', 'dropped', 'stated_current']) expect(modeFor('summary_check', q)).toBe('model');
    writer.outputs = ['INVENTED a.', 'INVENTED b.', 'INVENTED c.', 'INVENTED d.'];
    const r = await write();
    expect(r.ok === false && r.checkFailed).toBe(true);
    expect(writer.prompts[1]).toContain('it stated something the input does not say');
    expect(checks().map((c) => c.outcome)).toEqual(['not_kept']);
    await write();
    expect(notices()).toHaveLength(1);
    expect(summaryWriterStatus()).toMatchObject({ failing: true });
  });

  it('per question: only a PROVEN question acts — "stated_current" proven, "invented" still shadow', async () => {
    proveSummaryCheck(['stated_current']);
    writer.outputs = ['INVENTED but not pending.'];
    expect(await write()).toMatchObject({ ok: true, text: 'INVENTED but not pending.' });   // its failing question is in shadow
    expect(writer.prompts).toHaveLength(1);
    writer.outputs = ['PENDING: the agent still owes the budget.', 'The owner asked for the budget; the agent drafted it.'];
    expect(await write()).toMatchObject({ ok: true, text: 'The owner asked for the budget; the agent drafted it.' });
    expect(writer.prompts[2]).toContain('it described something as currently pending or owed');
    expect(writer.prompts[2]).not.toContain('it stated something the input does not say');
    expect(checks().map((c) => c.outcome)).toEqual(['ok', 'rewritten_ok']);
  });
});
