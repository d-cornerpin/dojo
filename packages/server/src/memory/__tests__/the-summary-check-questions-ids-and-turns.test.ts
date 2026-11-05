// t268 fix round 1 (M-3, I-4, M-1): the summary check's questions, ids and part splitter, and its turn on Ollama.
// (M-2, "in shadow the summary is kept first, checked after", is gone: OR-AUDIT-ANSWERS (c) makes the check act,
// so it runs before the summary is kept; see a-failing-summary-is-rewritten-before-it-is-kept.test.ts.)
// · M-3: a question held to the rule (or a box with no decision model) never asks the model at all;
// · I-4: the shadow rows carry the check's id, derived from the kept summary's own text (`summaryCheckId`), so a
//   future truth source can join them to the summary row (none exists yet);
// · M-1: a part splitter with less than one character of byte room ends (no room, recorded), never spins.
// The writer is scripted; every /v1/systemone call is a scripted fetch.
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
import { checkSummary } from '../summary-check.js';
import { summaryCheckId, summaryCheckIdOfRow, recordSummaryTruth } from '../summary-check-ledger.js';
import { insertMessage } from '../message-store.js';
import { createLeafSummary, updateSummaryContent } from '../dag.js';
import { sourceParts } from '../summary-check-parts.js';
import { decideCountedBytes } from '../../agent/decide-sizing.js';
import { STANDARD_DECISION_MODEL } from '../../services/local-standard.js';

const AGENT = 'agent-shadow-first';
const SOURCE = '[USER · the owner] please draft the offsite budget\n---\n[ASSISTANT · the agent] drafting it now';
const db = (): Database.Database => mockDb.current!;
/** The decision model's door: closed, a check waits until the case opens it. */
const gate = { open: true, waiting: [] as Array<() => void> };
const asked: string[][] = [];

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
  gate.open = true; gate.waiting = []; asked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const { state, questions } = JSON.parse(init?.body ?? '{}') as { state: { summary: string }; questions: Record<string, unknown> };
    asked.push(Object.keys(questions));
    if (!gate.open) await new Promise<void>((r) => gate.waiting.push(r));
    return Response.json({ answers: {
      invented: { noul: state.summary.includes('INVENTED') ? 0.93 : 0.04 },
      dropped: { noul: 0.06 },
      stated_current: { noul: state.summary.includes('PENDING') ? 0.91 : 0.05 },
    } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });  


let span = 0;
const write = () => generateSummary({ content: `${SOURCE}\n--- span ${span++}`, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small' });
const shadowRows = (): Array<{ question: string; turn_id: string }> =>
  db().prepare("SELECT question, turn_id FROM decision_shadow WHERE purpose = 'summary_check' ORDER BY question").all() as Array<{ question: string; turn_id: string }>;

describe('M-3: a question held to the rule never asks the model', () => {
  it('all three held: no decision call at all, nothing recorded', async () => {
    for (const q of ['invented', 'dropped', 'stated_current']) db().prepare('INSERT INTO config (key, value) VALUES (?, ?)').run(`decision_mode.summary_check.${q}`, 'rule');
    writer.outputs = ['The owner asked for the budget.'];
    expect(await write()).toMatchObject({ ok: true });
    expect(asked).toEqual([]);
    expect(shadowRows()).toEqual([]);
  });

  it('one held: only the other two are asked', async () => {
    db().prepare("INSERT INTO config (key, value) VALUES ('decision_mode.summary_check.dropped', 'rule')").run();
    writer.outputs = ['The owner asked for the budget.'];
    await write();
    expect(asked).toEqual([['invented', 'stated_current']]);
    expect(shadowRows().map((s) => s.question)).toEqual(['invented', 'stated_current']);
  });
});

describe('I-4 (fix round 2): the check\'s id is the span it judged — agent + linked rows, read off the summary row', () => {
  const rowsFor = (n: number, tag: string): string[] => (db().prepare("INSERT OR IGNORE INTO agents (id, name, status, config) VALUES (?, 'A', 'idle', '{}')").run(AGENT), Array.from({ length: n }, (_, i) =>
    insertMessage({ agentId: AGENT, role: i % 2 ? 'assistant' : 'user', lane: 'owner', senderId: 'owner', content: `[${tag}${i}] the offsite budget`, turnNumber: i + 1 }).id));
  const keep = async (ids: string[], text: string): Promise<string> => {
    writer.outputs.push(text);
    const r = await generateSummary({ content: SOURCE, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds: ids });
    return createLeafSummary(AGENT, r.ok ? r.text : '', 10, ids, new Date().toISOString(), new Date().toISOString()).id;
  };

  it('deterministic, and it survives the stored text being rewritten (obligation notes, the hygiene pass)', async () => {
    const ids = rowsFor(4, 'a');
    const summaryId = await keep(ids, 'The owner asked for the offsite budget.');
    const id = summaryCheckIdOfRow(summaryId);
    expect(id.startsWith(summaryCheckId(AGENT, ids))).toBe(true);   // fix round 4 (N-D; edited): the span's key, plus its version
    expect(new Set(shadowRows().map((s) => s.turn_id))).toEqual(new Set([id]));
    updateSummaryContent(summaryId, 'The owner asked for the offsite budget. [obligation noted]', 12);
    expect(summaryCheckIdOfRow(summaryId)).toBe(id);
  });

  it('unique per span: two identical summaries of different spans have different ids, and one\'s truth labels only it', async () => {
    const one = await keep(rowsFor(2, 'b'), 'Checked in; nothing new.');
    const two = await keep(rowsFor(2, 'c'), 'Checked in; nothing new.');
    expect(summaryCheckIdOfRow(one)).not.toBe(summaryCheckIdOfRow(two));
    recordSummaryTruth(one, 'invented', false, 'test');
    const truths = db().prepare("SELECT turn_id, truth FROM decision_shadow WHERE question = 'invented' ORDER BY id").all() as Array<{ turn_id: string; truth: string | null }>;
    expect(truths).toEqual([{ turn_id: summaryCheckIdOfRow(one), truth: 'false' }, { turn_id: summaryCheckIdOfRow(two), truth: null }]);
  });

  // Fix round 4 (N-D): each text checked for a span is a version of its summary. A span summarised twice — the nightly
  // rebuild or a placeholder replaced over the same rows, the one rewrite in `model` mode — gets distinct ids, and a
  // truth label for the stored row lands on the verdict of the text that row holds.
  it('a span summarised twice: two ids, and truth for the stored row labels only the verdict on its current text', async () => {
    const ids = rowsFor(3, 'd');
    const summaryId = await keep(ids, 'The owner asked for the offsite budget.');
    const firstId = summaryCheckIdOfRow(summaryId);
    writer.outputs.push('The owner asked for the offsite budget, due Friday.');
    const again = await generateSummary({ content: SOURCE, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds: ids });
    updateSummaryContent(summaryId, again.ok ? again.text : '', 12);   // the rebuild rewrites the same row in place
    const secondId = summaryCheckIdOfRow(summaryId);
    expect(secondId).not.toBe(firstId);
    recordSummaryTruth(summaryId, 'invented', false, 'test');
    const truths = db().prepare("SELECT turn_id, truth FROM decision_shadow WHERE question = 'invented' AND turn_id IN (?, ?) ORDER BY id").all(firstId, secondId);
    expect(truths).toEqual([{ turn_id: firstId, truth: null }, { turn_id: secondId, truth: 'false' }]);
  });

  it('the one rewrite: the failed text and the kept rewrite have distinct ids; the row carries the rewrite\'s', async () => {
    const ids = rowsFor(3, 'e');
    writer.outputs.push('INVENTED: the owner approved a venue.', 'The owner asked for the offsite budget.');
    const r = await generateSummary({ content: SOURCE, depth: 0, targetTokens: 400, agentId: AGENT, modelId: 'writer-small', spanIds: ids });
    expect(r).toMatchObject({ ok: true, text: 'The owner asked for the offsite budget.' });
    const summaryId = createLeafSummary(AGENT, r.ok ? r.text : '', 10, ids, new Date().toISOString(), new Date().toISOString()).id;
    const base = summaryCheckId(AGENT, ids);
    const checked = [...new Set((db().prepare("SELECT turn_id FROM decision_shadow WHERE turn_id LIKE ? ORDER BY id").all(`${base}%`) as Array<{ turn_id: string }>).map((x) => x.turn_id))];
    expect(checked).toHaveLength(2);
    expect(summaryCheckIdOfRow(summaryId)).toBe(checked[1]);
  });
});

describe('M-1: the part splitter always ends', () => {
  it('less than one character of byte room: no parts (the check is recorded unavailable), never a spin', async () => {
    const Q = { invented: { type: 'noul' as const, instructions: 'x' } };
    const source = '€'.repeat(40);   // 3 bytes each
    const base = decideCountedBytes({ source_rows: '', summary: '', source_part: `${source.length} of ${source.length}` }, Q);
    const summary = 's'.repeat(64 * 1024 - base - 2);   // 2 bytes of room: less than one '€'
    expect(sourceParts(source, summary, 1_000_000, Q, 2.48)).toBeNull();
    const c = await checkSummary(source, summary, AGENT);
    expect(c.answers).toBeNull();
  });
});

// (Its second clause, "a shadow check waits behind an agent's own turn", went with the shadow: the check is part of
// the fold now, OR-AUDIT-ANSWERS (c), so it is no background ask.)
describe('fix round 2 (3): checks wait their turn, one at a time, each with its own clock', () => {
  it('10 summaries in one fold on a slow Ollama that answers one request at a time: 10 verdicts recorded', async () => {
    let busyUntil = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
      if (!_url.endsWith('/v1/systemone')) return new Response('', { status: 404 });   // its other routes (the runner look, proof-fix T) are not decision calls
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      // Ollama serves one request at a time: this one starts when the one before it is done, and takes 700 ms.
      const start = Math.max(Date.now(), busyUntil);
      busyUntil = start + 700;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, busyUntil - Date.now());
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
      return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: 0.05 }])) });
    }));
    for (let i = 0; i < 10; i++) { writer.outputs.push(`The owner asked for the budget, part ${i}.`); await write(); }
    const outcomes = db().prepare('SELECT outcome FROM summary_checks').all() as Array<{ outcome: string }>;
    expect(outcomes.map((o) => o.outcome)).toEqual(Array(10).fill('ok'));
  }, 60_000);
});
