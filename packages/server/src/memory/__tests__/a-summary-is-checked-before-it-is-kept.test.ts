// v3.5 B4 — OWNER RULING 2026-10-20: "Check each summary against the decision model. If there are
// significant summarization failures on a dojo, the user is encouraged to change the summarization
// model to another larger model." Whoever writes a summary, the decision model reads it against the
// rows it summarizes before the engine replaces those rows with it. The writer is scripted; every
// /v1/systemone call is a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-summary-check', 'dojo.db'),
  };
});
const cards = vi.hoisted(() => ({ list: [] as Array<{ type?: string; code?: string; error?: string; agentId?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: { type?: string; code?: string; error?: string }) => { cards.list.push(e); }, stampPersistedRow: (e: unknown) => e }));
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
import { writerPassedOver, __resetSummaryWriterHealthForTests } from '../summary-writer-health.js';
import { SUMMARY_CHECK_NOTICE_CODE, passMark } from '../summary-check.js';
import { summaryCheckLine, summaryWriterStatus } from '../summary-check-ledger.js';
import { recordShadow, recordTruth } from '../../agent/decision-shadow.js';
import { getDecisionScoreItems } from '../../agent/decision-policy.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-summary-check';
const SOURCE = '[USER · the owner · Oct 1, 2026] please draft the offsite budget\n---\n[ASSISTANT · the agent] drafting it now';
const db = (): Database.Database => mockDb.current!;
const decisions = { up: true, asked: 0 };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  __resetSummaryWriterHealthForTests();
  cards.list.length = 0;
  writer.outputs = [];
  writer.prompts = [];
  decisions.up = true;
  decisions.asked = 0;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://127.0.0.1:47124', 'none', 1)").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled) VALUES ('m-decision', 'ollama-local', ?, ?, '["decision"]', 1)`).run(STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.tag);
  for (const id of ['writer-small', 'writer-large']) {
    db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled) VALUES (?, 'ollama-local', ?, ?, '["chat"]', 32000, 1)`).run(id, id, id);
  }
  // The decision model: a summary carrying INVENTED states what the source does not say.
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    decisions.asked++;
    if (!decisions.up) throw new Error('fetch failed: ECONNREFUSED');
    const { state } = JSON.parse(init?.body ?? '{}') as { state: { summary: string } };
    const invented = state.summary.includes('INVENTED') ? 0.93 : 0.04;
    return Response.json({ answers: { invented: { noul: invented }, dropped: { noul: 0.06 }, stated_current: { noul: 0.05 } } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

let span = 0;   // each write is its own span (fix round 2: a span that failed is not tried again by anyone)
const write = (modelId = 'writer-small') => generateSummary({ content: `${SOURCE}\n--- span ${span++}`, depth: 0, targetTokens: 400, agentId: AGENT, modelId });
const checks = (): Array<{ outcome: string; invented: number | null }> =>
  db().prepare('SELECT outcome, invented FROM summary_checks ORDER BY id').all() as Array<{ outcome: string; invented: number | null }>;

describe('a summary is checked against its source before it is kept', () => {
  it('a summary that invents a closed task fails and is rewritten once; the rewrite that passes is kept', async () => {
    writer.outputs = ['The owner asked for the budget; INVENTED: the budget was sent and the task is closed.', 'The owner asked for the offsite budget; the agent began drafting it.'];
    const r = await write();
    expect(r).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget; the agent began drafting it.' });
    expect(writer.prompts).toHaveLength(2);
    expect(writer.prompts[1]).toContain('it stated something the input does not say');
    expect(writer.prompts[0]).not.toContain('accuracy check');
    expect(checks().map((c) => c.outcome)).toEqual(['rewritten_ok']);
  });

  it('a summary that passes the first time is kept as written, asked once', async () => {
    writer.outputs = ['The owner asked for the offsite budget.'];
    expect(await write()).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget.' });
    expect(writer.prompts).toHaveLength(1);
    expect(checks().map((c) => c.outcome)).toEqual(['ok']);
  });

  it('two failures keep the rows whole: nothing is kept, the failure is logged with its numbers, and the writer is not blamed as unreachable', async () => {
    writer.outputs = ['INVENTED one.', 'INVENTED two.'];
    const r = await write();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.tooBig).toBeFalsy();
    expect(checks()).toEqual([{ outcome: 'not_kept', invented: 0.93 }]);
    expect(writerPassedOver('writer-small', AGENT)).toBe(false);
  });

  it('decide() unavailable → the summary is kept and the check is logged unavailable', async () => {
    decisions.up = false;
    writer.outputs = ['INVENTED but nobody can tell.'];
    expect(await write()).toMatchObject({ ok: true });
    expect(checks().map((c) => c.outcome)).toEqual(['unavailable']);
  });

  it('the notice fires once with the numbers, and re-arms only when the writer changes', async () => {
    writer.outputs = ['INVENTED a.', 'INVENTED b.', 'fine', 'INVENTED c.', 'INVENTED d.'];
    await write();
    await write();
    await write();
    const notices = () => cards.list.filter((c) => c.code === SUMMARY_CHECK_NOTICE_CODE);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ type: 'chat:error', agentId: AGENT });
    expect(notices()[0].error).toBe(
      "This box's memory summaries keep failing the accuracy check (1 of the last 1). The small writer may be too small for this box's conversations; pick a larger model under Settings → Models → Summarization Model.",
    );
    writer.outputs = ['INVENTED e.', 'INVENTED f.'];
    await write('writer-large');
    expect(notices()).toHaveLength(2);
  });

  it('I-B4-2: the latch is per writer — two writers that fail in turn do not trade cards back and forth', async () => {
    const notices = () => cards.list.filter((c) => c.code === SUMMARY_CHECK_NOTICE_CODE);
    writer.outputs = ['INVENTED a.', 'INVENTED b.'];
    await write('writer-small');
    writer.outputs = ['INVENTED c.', 'INVENTED d.'];
    await write('writer-large');
    writer.outputs = ['INVENTED e.', 'INVENTED f.'];
    await write('writer-small');
    expect(notices()).toHaveLength(2);
  });

  it('I-B4-1: a summary that failed twice says so on its result, so no caller walks it to another writer', async () => {
    writer.outputs = ['INVENTED one.', 'INVENTED two.'];
    const r = await write();
    expect(r.ok === false && r.checkFailed).toBe(true);
  });

  it('(iv) the Summarization card is told when the current summary writer is failing', async () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'writer-small')").run();
    expect(summaryWriterStatus()).toEqual({ writer: 'writer-small', failed: 0, total: 0, failing: false });
    writer.outputs = ['fine', 'INVENTED x.', 'INVENTED y.'];
    await write(); await write();
    expect(summaryWriterStatus()).toEqual({ writer: 'writer-small', failed: 1, total: 2, failing: true });
  });

  it('the Healer section carries the running numbers', async () => {
    writer.outputs = ['fine', 'INVENTED x.', 'better', 'INVENTED y.', 'INVENTED z.'];
    await write(); await write(); await write();
    expect(summaryCheckLine()).toBe('Summary check (kept window): 3 checked, 1 kept as written, 1 kept after one rewrite, 1 left the rows whole, 0 unchecked (decision model unavailable).');
    expect(getDecisionScoreItems()[0].detail).toContain('Summary check (kept window): 3 checked');
  });
});

describe('I-B4-3: the pass mark', () => {
  it('with no recorded data it is the binary decision boundary, 0.5', () => {
    expect(passMark('invented')).toBe(0.5);
  });

  it('calibrated from recorded summary_check rows, and never a mark that fails everything', () => {
    // Every recorded summary was in truth FINE, and the model's least-right decile is [0.0, 0.1]: the old
    // "bottom of the weakest band" would have made the mark 0, failing every summary for ever.
    for (const [i, p] of [0.02, 0.03, 0.05, 0.08, 0.6].entries()) {
      recordShadow({ purpose: 'summary_check', question: 'invented', turnId: `c${i}`, ruleSaid: false, modelSaid: { type: 'noul', noul: p } });
      recordTruth(`c${i}`, 'invented', false, 'test');
    }
    const mark = passMark('invented');
    expect(mark).toBeGreaterThan(0.08);   // every truly fine one passes
    expect(mark).toBeLessThanOrEqual(1);
  });

  it('N6: every recorded probability at 1.0 does not throw; the mark is 0.5', () => {
    for (let i = 0; i < 3; i++) {
      recordShadow({ purpose: 'summary_check', question: 'stated_current', turnId: `s${i}`, ruleSaid: false, modelSaid: { type: 'noul', noul: 1 } });
      recordTruth(`s${i}`, 'stated_current', true, 'test');
    }
    expect(passMark('stated_current')).toBe(0.5);
  });

  it('with a clear separation in the record, the mark sits between the fine and the wrong', () => {
    for (const [i, [p, bad]] of ([[0.1, false], [0.2, false], [0.35, true], [0.4, true]] as const).entries()) {
      recordShadow({ purpose: 'summary_check', question: 'dropped', turnId: `d${i}`, ruleSaid: false, modelSaid: { type: 'noul', noul: p } });
      recordTruth(`d${i}`, 'dropped', bad, 'test');
    }
    const mark = passMark('dropped');
    expect(mark).toBeGreaterThan(0.2);
    expect(mark).toBeLessThanOrEqual(0.35);
  });

  it('every check is recorded in the shadow log, so the record can grow', async () => {
    writer.outputs = ['The owner asked for the offsite budget.'];
    await write();
    expect(db().prepare("SELECT COUNT(*) AS n FROM decision_shadow WHERE purpose = 'summary_check'").get()).toEqual({ n: 3 });
  });
});
