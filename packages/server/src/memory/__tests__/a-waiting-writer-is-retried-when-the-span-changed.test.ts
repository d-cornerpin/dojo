// A writer that cannot hold a span waits for that span (its key is the rows' ids and contents), and is asked again
// when the span changes: a refused merge rests the older note of its pair, a placeholder splits to its halves, a single
// row is kept whole behind its pointer, and none is dialled again until a note or row changes, or the agent gets a
// writer that has not refused it. Bounded dial counts with one writer: a pair 1; four notes 3 (each newer note one more
// partner); a four-row placeholder 1 + 2 + 4.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t269-unwritable', 'dojo.db'),
  };
});
vi.mock('../../logger.js', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => new Float32Array([1, 0, 0, 0]), queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'), isDreamerIgnored: vi.fn(() => false), getArchiveHighWaterMark: vi.fn(() => null) }));

/** A writer that can never write anything holding the word UNWRITABLE (its answer is always cut). */
const writer = vi.hoisted(() => ({
  dials: 0,
  /** Writers that CAN write it (fix round 2: a bigger writer the owner picks, or one back from an outage). */
  capable: new Set<string>(),
  write: async (p: { content: string; targetTokens: number; modelId?: string }) => {
    writer.dials += 1;
    if (p.content.includes('UNWRITABLE') && !writer.capable.has(p.modelId ?? '')) return { ok: false as const, reason: 'the summary was cut off by the output limit before it finished', tooBig: true as const };
    const text = `A short summary in ${p.targetTokens} tokens.`;
    return { ok: true as const, text, tokenCount: Math.ceil(text.length / 4) };
  },
}));
vi.mock('../summarize.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../summarize.js')>()), generateSummary: writer.write }));

// Imported FIRST: a module first loaded while the summariser's mock factory runs binds the unmocked writer.
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders } from '../out-of-view.js';
import { replacePlaceholdersInBackground } from '../out-of-view.js';
import { runMigrations } from '../../db/migrations.js';
import { createLeafSummary, updateSummaryContent } from '../dag.js';
import { mergeUntriedNotes } from '../merge-notes.js';
import { STANDARD_WRITER_MODEL } from '../../services/local-standard.js';
import { insertMessage } from '../message-store.js';
import { findToolResult } from '../kept-results.js';
import { __resetSummaryWriterHealthForTests, markWaiting, clearOn, providerOf, pickWriter } from '../writer.js';

const AGENT = 'agent-t269-unwritable';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  writer.dials = 0;
  writer.capable.clear();
  __resetSummaryWriterHealthForTests();
  mockDb.current = new Database(':memory:');
  db().pragma('foreign_keys = ON');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-w', 'W', 'openai-compatible', 'http://127.0.0.1:1', 'api_key', 1)").run();
  db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-w', 'p-w', 'w', 'w', '[\"chat\"]', 131072, 0, 1)").run();
  db().prepare("INSERT INTO agents (id, name, model_id, status, config, session_started_at) VALUES (?, 'Unwritable', 'm-w', 'idle', '{}', '1970-01-01')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

let n = 0;
function leaf(text: string): string {
  const ms = Date.UTC(2026, 8, 1) + (n += 1) * 60_000;
  db().prepare(`INSERT INTO messages (id, agent_id, role, lane, content, display_kind, display_tier, turn_number, provenance, authorized, token_count, created_at)
                VALUES (?, ?, 'user', 'owner', 'filler', 'agent-text', 'agent-only', 1, 'live', 1, 2, ?)`).run(`m-${n}`, AGENT, ms);
  const at = new Date(ms).toISOString();
  return createLeafSummary(AGENT, text, Math.ceil(text.length / 4), [`m-${n}`], at, at).id;
}
/** A merge run with the writer a compaction pass would pick; none runs when no writer can. */
const condense = async () => { const w = pickWriter(AGENT); return w ? mergeUntriedNotes(AGENT, w) : null; };

describe('t269 I1 — a merge no writer can write is dialled once, then left whole', () => {
  it('a pair: 1 dial, then no dial and no refusal on every later pass', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    const outs = [];
    for (let i = 0; i < 5; i += 1) outs.push(await condense());
    expect(writer.dials).toBe(1);
    expect(outs.map((o) => o?.stage)).toEqual([null, null, null, null, null]);
  });

  it('…until a note that rests changes: then it is offered again', async () => {
    const a = leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense(); await condense();
    expect(writer.dials).toBe(1);
    leaf('UNWRITABLE note three');
    await condense();
    expect(writer.dials, 'both notes of the refused pair rest: a fresh note has no partner').toBe(1);
    updateSummaryContent(a, 'note one, edited by the owner', 8);
    await condense();
    expect(writer.dials).toBe(2);
  });

  it('four notes: each refused pair rests both its notes (2 dials), then none', async () => {
    for (let i = 0; i < 4; i += 1) leaf(`UNWRITABLE note ${i}`);
    for (let i = 0; i < 4; i += 1) await condense();
    expect(writer.dials).toBe(2);
  });

  it('a save that signals a model change re-offers nothing the same writer refused', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense();
    clearOn({ kind: 'own-model-changed', agentId: AGENT });
    await condense();
    expect(writer.dials).toBe(1);
  });
});

describe('t269 I1 — a single row no writer can summarise is kept whole behind its pointer and marked', () => {
  const big = (tag: string): string => `${tag} ${'a long pasted document line. '.repeat(600)}`;
  const maxSeq = (): number => (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
  /** The newest row is always in view, so a row that leaves it has one after it. */
  const newestRow = (): void => { insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'ok', turnNumber: 9 }); };
  const notes = () => db().prepare("SELECT kind, content FROM summaries WHERE agent_id = ? ORDER BY earliest_at").all(AGENT) as Array<{ kind: string; content: string }>;

  it('one row: dialled once; then kept whole (its pointer reads the stored row); never dialled again', async () => {
    const row = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: big('UNWRITABLE-ROW'), turnNumber: 1 });
    const through = maxSeq();
    newestRow();
    expect(writeUncondensedPlaceholders(AGENT, through)).toBe(1);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writer.dials).toBe(1);
    const kept = notes();
    expect(kept.map((s) => s.kind)).toEqual(['kept_whole']);
    expect(kept[0].content).toContain(`msg:${row.id}`);
    expect(findToolResult(AGENT, `msg:${row.id}`)?.content).toBe(big('UNWRITABLE-ROW'));
    await replaceUncondensedPlaceholders(AGENT);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writer.dials, 'not dialled again').toBe(1);
  });

  it('four rows: split down to single rows (1 + 2 + 4 = 7 dials), each kept whole, then none', async () => {
    for (let t = 1; t <= 4; t += 1) insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `UNWRITABLE row ${t}: ${'filler words '.repeat(40)}`, turnNumber: t });
    const through = maxSeq();
    newestRow();
    writeUncondensedPlaceholders(AGENT, through);
    for (let i = 0; i < 4; i += 1) await replaceUncondensedPlaceholders(AGENT);
    expect(writer.dials).toBe(7);
    expect(notes().map((s) => s.kind)).toEqual(['kept_whole', 'kept_whole', 'kept_whole', 'kept_whole']);
  });

  it('…until the row changes: then it is a placeholder again and is summarised', async () => {
    const row = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: big('UNWRITABLE-ROW'), turnNumber: 1 });
    const through = maxSeq();
    newestRow();
    writeUncondensedPlaceholders(AGENT, through);
    await replaceUncondensedPlaceholders(AGENT);
    expect(notes().map((s) => s.kind)).toEqual(['kept_whole']);
    db().prepare('UPDATE messages SET content = ? WHERE id = ?').run('a short row the writer can summarise now', row.id);
    expect(replacePlaceholdersInBackground(AGENT)).toBe(true);
    await vi.waitFor(() => expect(notes().map((s) => s.kind)).toEqual(['leaf']));
    expect(writer.dials).toBe(2);
  });
});

// ── Fix round 2 (re-review N1, N2) ───────────────────────────────────────────────────────────
// v3.5 field fix 3 (edited throughout this block: the second writer was the owner's Settings pick, a setting the owner
// ruled must not exist): the writers are the agent's own model and, here, the Dojo's small writer.
describe('t269 fix round 2: the mark is the writers\' verdict, and a change of writer tries the span again (N1)', () => {
  /** The Dojo's small writer on the box's local Ollama: the fallback after the agent's own model. */
  const smallWriter = (): void => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-std', 'ollama-local', ?, ?, '[\"chat\"]', 131072, 0, 1)").run(STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
  };
  /** A second, bigger writer on its own provider (so its health is its own). */
  const bigWriter = (): void => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-big', 'B', 'openai-compatible', 'http://127.0.0.1:2', 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-big', 'p-big', 'b', 'b', '[\"chat\"]', 1000000, 1, 1)").run();
    writer.capable.add('m-big');
  };
  const parents = (): number => (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = 1').get(AGENT) as { n: number }).n;

  it('the owner gives the agent a bigger model: a span marked by the old writer is tried again, and merges', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense(); await condense();
    expect(writer.dials).toBe(1);
    bigWriter();
    db().prepare("UPDATE agents SET model_id = 'm-big' WHERE id = ?").run(AGENT);
    await condense();
    expect(parents(), 'merged by the new writer').toBe(1);
  });

  // The writer order: the agent's own model, then the small writer (no pick: v3.5 field fix 3).
  it('an outage: a writer passed over is never marked as refusing; when it answers again the span is tried, and merges', async () => {
    bigWriter();
    db().prepare("UPDATE agents SET model_id = 'm-big' WHERE id = ?").run(AGENT);   // the agent's own model: capable
    markWaiting(AGENT, 'm-big', '', 'not-answering');   // …but not answering: not eligible, and nothing else can write
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense();
    const afterOutage = writer.dials;
    await condense(); await condense();
    expect(writer.dials, 'the writer that refused is not dialled again over the same span').toBe(afterOutage);
    expect(parents()).toBe(0);
    clearOn({ kind: 'writer-answered', providerKey: providerOf('m-big'), summaryFor: AGENT });    // it answers again
    await condense();
    expect(parents(), 'tried by the writer that was out, and merged').toBe(1);
  });

  it('the own model cut it: marked, not handed to the small writer, and not dialled again', async () => {
    smallWriter();   // the own model, then the Dojo's small writer
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    for (let i = 0; i < 4; i += 1) await condense();
    expect(writer.dials, 'the own model once').toBe(1);
  });
});

// ── Rebase onto v35 (re-review 2, N6) ────────────────────────────────────────────────────────────
describe('t269 N6 — an oversize placeholder is split when every ANSWERING writer refused it; an out writer never blocks the split', () => {
  const maxSeq = (): number => (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
  const notes = () => db().prepare('SELECT kind, content FROM summaries WHERE agent_id = ? ORDER BY earliest_at').all(AGENT) as Array<{ kind: string; content: string }>;
  // v3.5 field fix 3 (edited: the out writer was the Settings pick): the out writer is the agent's own model, and the
  // Dojo's small writer (here unable to write the rows whole) is the one answering.
  it('the own model is out (server off): the small writer\'s refusals split the span to single rows, none kept whole; when the own model is back it writes them', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-big', 'B', 'openai-compatible', 'http://127.0.0.1:2', 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-big', 'p-big', 'b', 'b', '[\"chat\"]', 1000000, 1, 1)").run();
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', 'http://localhost:11434', 'none', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-std', 'ollama-local', ?, ?, '[\"chat\"]', 131072, 0, 1)").run(STANDARD_WRITER_MODEL.tag, STANDARD_WRITER_MODEL.tag);
    db().prepare("UPDATE agents SET model_id = 'm-big' WHERE id = ?").run(AGENT);
    writer.capable.add('m-big');
    markWaiting(AGENT, 'm-big', '', 'not-answering');   // the own model is out
    for (let t = 1; t <= 4; t += 1) insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `UNWRITABLE row ${t}: ${'filler words '.repeat(40)}`, turnNumber: t });
    const through = maxSeq();
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'ok', turnNumber: 9 });
    writeUncondensedPlaceholders(AGENT, through);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writer.dials, 'the small writer: 1 + 2 + 4').toBe(7);
    expect(notes().map((s) => s.kind), 'split to single rows, none kept whole: the own model has not been asked').toEqual(['uncondensed', 'uncondensed', 'uncondensed', 'uncondensed']);
    clearOn({ kind: 'writer-answered', providerKey: providerOf('m-big'), summaryFor: AGENT });
    await replaceUncondensedPlaceholders(AGENT);
    expect(notes().map((s) => s.kind), 'the own model, back, writes each row').toEqual(['leaf', 'leaf', 'leaf', 'leaf']);
  });
});

