// ════════════════════════════════════════════════════════════════════════════════════════
// t269 fix round 1 (review I1) — A SPAN NO WRITER CAN WRITE WHOLE IS DIALLED A BOUNDED NUMBER OF TIMES,
// THEN LEFT WHOLE AND MARKED, NEVER RE-DIALLED UNTIL ITS CONTENT CHANGES.
//
// The reviewer's probe: a depth-5 pair whose merge is always cut was dialled on EVERY forced pass
// ([4,1,1,1,1]) with a `summariser_refused` defect each time; a single row cut twice was covered by a
// placeholder note and re-dialled on every drain. The ruling:
//   (a) a span is split further, down to single rows (a condensed pair down to its two notes, which are
//       left whole); a single row that still cannot be summarised is kept verbatim behind the live view's
//       kept-row pointer (D18, `kept-row-view.ts`) and MARKED, so it is not dialled again until its content
//       changes — never a defect logged every pass.
//
// Bounded dial counts asserted below (one writer, as configured here):
//   · a pair: 1 dial, then 0 on every later pass;
//   · a batch of four: 1 + 2 (its halves) = 3, then 0;
//   · a four-row placeholder: 1 + 2 + 4 = 7 (halves down to single rows), then 0.
//
// All fixture text is invented filler; no real conversation, agent or person appears here.
// ════════════════════════════════════════════════════════════════════════════════════════
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
import { writeUncondensedPlaceholders, replaceUncondensedPlaceholders, replacePlaceholdersInBackground } from '../uncondensed-placeholder.js';
import { runMigrations } from '../../db/migrations.js';
import { createLeafSummary, updateSummaryContent } from '../dag.js';
import { condenseUntilFits } from '../condense-until-fits.js';
import { rebuildContextItems } from '../compaction.js';
import { insertMessage } from '../message-store.js';
import { findToolResult } from '../kept-results.js';
import { __resetSummaryWriterHealthForTests, noteSummaryWriterOutcome } from '../summary-writer-health.js';
import { condensableSummaries } from '../condense-until-fits.js';

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
  db().prepare("INSERT INTO config (key, value) VALUES ('compaction_model_id', 'm-w')").run();
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
const condense = () => condenseUntilFits({
  agentId: AGENT, modelId: 'm-w', minFanout: 4,
  measure: async () => ({ total: 1_000_000, summaryTokens: 0 }), rebuild: () => rebuildContextItems(AGENT),
});

describe('t269 I1 — a merge no writer can write is dialled once, then left whole', () => {
  it('a pair: 1 dial, then no dial and no refusal on every later pass', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    const outs = [];
    for (let i = 0; i < 5; i += 1) outs.push(await condense());
    expect(writer.dials).toBe(1);
    expect(outs.map((o) => o.refusedStage)).toEqual([null, null, null, null, null]);
  });

  it('…until a note of the pair changes: then it is tried again', async () => {
    const a = leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense(); await condense();
    expect(writer.dials).toBe(1);
    updateSummaryContent(a, 'note one, edited by the owner', 8);
    await condense();
    expect(writer.dials).toBe(2);
  });

  it('a batch of four: 1 + 2 halves = 3 dials, then none', async () => {
    for (let i = 0; i < 4; i += 1) leaf(`UNWRITABLE note ${i}`);
    for (let i = 0; i < 4; i += 1) await condense();
    expect(writer.dials).toBe(3);
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
describe('t269 fix round 2 — the mark is the writers\' verdict under the owner\'s writer setting (N1)', () => {
  /** A second, bigger writer on its own provider (so its health is its own). */
  const bigWriter = (): void => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-big', 'B', 'openai-compatible', 'http://127.0.0.1:2', 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-big', 'p-big', 'b', 'b', '[\"chat\"]', 1000000, 1, 1)").run();
    writer.capable.add('m-big');
  };
  const parents = (): number => (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ? AND depth = 1').get(AGENT) as { n: number }).n;

  it('the owner picks a bigger writer: a span marked under the old setting is tried again, and merges', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense(); await condense();
    expect(writer.dials).toBe(1);
    bigWriter();
    db().prepare("UPDATE config SET value = 'm-big' WHERE key = 'compaction_model_id'").run();
    await condense();
    expect(parents(), 'merged by the new writer').toBe(1);
  });

  // t268's one writer order: the Summarization pick, then the agent's own model (`m-w` here), then the small writer.
  it('an outage: a writer passed over is never marked as refusing; when it answers again the span is tried, and merges', async () => {
    bigWriter();
    db().prepare("UPDATE config SET value = 'm-big' WHERE key = 'compaction_model_id'").run();   // the pick: capable
    noteSummaryWriterOutcome('m-big', false);   // …but not answering: not eligible; the agent's own model is
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    await condense();
    const afterOutage = writer.dials;
    await condense(); await condense();
    expect(writer.dials, 'the writer that refused is not dialled again over the same span').toBe(afterOutage);
    expect(parents()).toBe(0);
    noteSummaryWriterOutcome('m-big', true);    // it answers again
    await condense();
    expect(parents(), 'tried by the writer that was out, and merged').toBe(1);
  });

  it('every candidate writer cut it: marked, and no writer is dialled again', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-2', 'W2', 'openai-compatible', 'http://127.0.0.1:3', 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-2', 'p-2', 'w2', 'w2', '[\"chat\"]', 131072, 1, 1)").run();
    db().prepare("UPDATE config SET value = 'm-2' WHERE key = 'compaction_model_id'").run();   // the pick, then the own model
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    for (let i = 0; i < 4; i += 1) await condense();
    expect(writer.dials, 'each of the two candidates once').toBe(2);
  });
});

describe('t269 fix round 2 — a span no writer is left for is not counted as mergeable (N2)', () => {
  it('a marked pair: condensableSummaries is 0, so the condense-only pass returns before any activity or brake', async () => {
    leaf('UNWRITABLE note one'); leaf('UNWRITABLE note two');
    expect(condensableSummaries(AGENT, { modelId: 'm-w', minFanout: 4 })).toBe(2);
    await condense();
    expect(condensableSummaries(AGENT, { modelId: 'm-w', minFanout: 4 })).toBe(0);
  });
});

// ── Rebase onto v35 (re-review 2, N6) ────────────────────────────────────────────────────────────
describe('t269 N6 — an oversize placeholder is split when every ANSWERING writer refused it; an out writer never blocks the split', () => {
  const maxSeq = (): number => (db().prepare('SELECT MAX(seq) AS s FROM messages WHERE agent_id = ?').get(AGENT) as { s: number }).s;
  const notes = () => db().prepare('SELECT kind, content FROM summaries WHERE agent_id = ? ORDER BY earliest_at').all(AGENT) as Array<{ kind: string; content: string }>;
  it('the pick is out (server off): the own model\'s refusals split the span to single rows, none kept whole; when the pick is back it writes them', async () => {
    db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('p-big', 'B', 'openai-compatible', 'http://127.0.0.1:2', 'api_key', 1)").run();
    db().prepare("INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, input_cost_per_m, is_enabled) VALUES ('m-big', 'p-big', 'b', 'b', '[\"chat\"]', 1000000, 1, 1)").run();
    db().prepare("UPDATE config SET value = 'm-big' WHERE key = 'compaction_model_id'").run();
    writer.capable.add('m-big');
    noteSummaryWriterOutcome('m-big', false);   // the pick is out
    for (let t = 1; t <= 4; t += 1) insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `UNWRITABLE row ${t}: ${'filler words '.repeat(40)}`, turnNumber: t });
    const through = maxSeq();
    insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: 'ok', turnNumber: 9 });
    writeUncondensedPlaceholders(AGENT, through);
    await replaceUncondensedPlaceholders(AGENT);
    expect(writer.dials, 'the own model: 1 + 2 + 4').toBe(7);
    expect(notes().map((s) => s.kind), 'split to single rows, none kept whole: the pick has not been asked').toEqual(['uncondensed', 'uncondensed', 'uncondensed', 'uncondensed']);
    noteSummaryWriterOutcome('m-big', true);
    await replaceUncondensedPlaceholders(AGENT);
    expect(notes().map((s) => s.kind), 'the pick, back, writes each row').toEqual(['leaf', 'leaf', 'leaf', 'leaf']);
  });
});

